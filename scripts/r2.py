#!/usr/bin/env python3
"""PURPOSE: Publish per-region download files (map PMTiles, Valhalla packs, OSM road data) to
   Cloudflare R2 bucket `rods-maps` with immutable versioned keys and a manifest written last.
RESPONSIBILITY: Bucket setup, SigV4 S3 upload (multipart above 64 MiB), post-upload size + SHA-256
   verification, manifest publication. Refuses any bucket not named rods-maps* so the website
   buckets (rods-creator-*, rods-vault-backup) can never be touched by mistake.
DEPENDENCIES: Python standard library only. Credentials come from the ENVIRONMENT only:
   R2_ACCOUNT_ID (required); CLOUDFLARE_API_TOKEN (bucket admin; also used to derive S3 keys) or
   R2_MAPS_ACCESS_KEY_ID + R2_MAPS_SECRET_ACCESS_KEY (bucket-scoped S3 keys, e.g. in CI).
   Never pass a secret on the command line, never print one.
CONSUMERS: .github/workflows/basemap-tiles.yml (`put`, `merge-pointer`). Copied from the Rods
   repo's tools/r2-maps/r2.py (FEAT-090 ME-13b plan); `put` and `merge-pointer` exist only here.

Layout (R3 section B):
  releases/<release>/<region>/<file>   immutable, Cache-Control: immutable, never overwritten
  releases/<release>/manifest.json     immutable copy of that release's manifest
  manifest.json                        the pointer the app reads; written LAST, short cache
"""
import argparse
import datetime
import hashlib
import hmac
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

BUCKET = os.environ.get("R2_MAPS_BUCKET", "rods-maps")
PART = 64 * 1024 * 1024
API = "https://api.cloudflare.com/client/v4"
IMMUTABLE = "public, max-age=31536000, immutable"
POINTER_CACHE = "public, max-age=300"


def die(msg):
    sys.exit(f"r2: {msg}")


def guard_bucket(name):
    if not name.startswith("rods-maps"):
        die(f"refusing bucket {name!r}: this tool only touches rods-maps*")
    return name


# ── Cloudflare REST (bucket admin) ────────────────────────────────────────────

def cf(method, path, body=None):
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or die("CLOUDFLARE_API_TOKEN not set")
    req = urllib.request.Request(
        f"{API}{path}", method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}") or {"success": False, "errors": [str(e.code)]}


def account():
    return os.environ.get("R2_ACCOUNT_ID") or die("R2_ACCOUNT_ID not set")


def s3_credentials():
    """Explicit S3 keys win. Otherwise derive them from the API token, as Cloudflare documents:
    access key id = token id, secret = sha256(token value)."""
    key, secret = os.environ.get("R2_MAPS_ACCESS_KEY_ID"), os.environ.get("R2_MAPS_SECRET_ACCESS_KEY")
    if key and secret:
        return key, secret
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or die("no S3 keys and no CLOUDFLARE_API_TOKEN")
    v = cf("GET", f"/accounts/{account()}/tokens/verify")
    if not v.get("success"):
        die(f"token verify failed: {v.get('errors')}")
    return v["result"]["id"], hashlib.sha256(token.encode()).hexdigest()


# ── SigV4 ────────────────────────────────────────────────────────────────────

def _hmac(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def sign(method, url, headers, payload_hash, creds, now=None, region="auto"):
    """Return headers with AWS SigV4 (service s3, region auto) added. Pure: testable."""
    key_id, secret = creds
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    u = urllib.parse.urlsplit(url)
    h = {k.lower(): str(v).strip() for k, v in headers.items()}
    h.update({"host": u.netloc, "x-amz-date": amz_date, "x-amz-content-sha256": payload_hash})
    q = sorted(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
    cq = "&".join(f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}" for k, v in q)
    names = sorted(h)
    canon = "\n".join([method, urllib.parse.quote(u.path, safe="/-_.~"), cq,
                       "".join(f"{n}:{h[n]}\n" for n in names), ";".join(names), payload_hash])
    scope = f"{day}/{region}/s3/aws4_request"
    sts = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canon.encode()).hexdigest()])
    k = _hmac(_hmac(_hmac(_hmac(("AWS4" + secret).encode(), day), region), "s3"), "aws4_request")
    sig = hmac.new(k, sts.encode(), hashlib.sha256).hexdigest()
    h["authorization"] = (f"AWS4-HMAC-SHA256 Credential={key_id}/{scope}, "
                          f"SignedHeaders={';'.join(names)}, Signature={sig}")
    return h


class S3:
    def __init__(self, bucket=BUCKET):
        self.bucket = guard_bucket(bucket)
        self.base = f"https://{account()}.r2.cloudflarestorage.com/{self.bucket}"
        self.creds = s3_credentials()

    def url(self, key, query=""):
        return f"{self.base}/{urllib.parse.quote(key, safe='/-_.~')}" + (f"?{query}" if query else "")

    def call(self, method, key, query="", body=b"", headers=None, stream=False):
        url = self.url(key, query)
        h = sign(method, url, headers or {}, hashlib.sha256(body).hexdigest(), self.creds)
        req = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None,
                                     method=method, headers=h)
        try:
            r = urllib.request.urlopen(req, timeout=600)
            return r if stream else (r.status, dict(r.headers), r.read())
        except urllib.error.HTTPError as e:
            if stream:
                raise
            return e.code, dict(e.headers), e.read()

    def head(self, key):
        status, headers, _ = self.call("HEAD", key)
        return {k.lower(): v for k, v in headers.items()} if status == 200 else None

    def put_small(self, key, body, headers):
        status, _, out = self.call("PUT", key, body=body, headers=headers)
        if status != 200:
            die(f"PUT {key}: {status} {out[:300]!r}")

    def put_multipart(self, path, key, headers):
        status, _, out = self.call("POST", key, "uploads=", headers=headers)
        if status != 200:
            die(f"create multipart {key}: {status} {out[:300]!r}")
        upload_id = ET.fromstring(out).find("{*}UploadId").text
        etags, n = [], 0
        try:
            with open(path, "rb") as f:
                while chunk := f.read(PART):
                    n += 1
                    q = urllib.parse.urlencode({"partNumber": n, "uploadId": upload_id})
                    for attempt in range(3):
                        status, h, out = self.call("PUT", key, q, body=chunk)
                        if status == 200:
                            break
                    else:
                        die(f"part {n} of {key}: {status} {out[:300]!r}")
                    etags.append((n, {k.lower(): v for k, v in h.items()}["etag"]))
                    print(f"  part {n} ok ({len(chunk)} B)", flush=True)
            xml = "<CompleteMultipartUpload>" + "".join(
                f"<Part><PartNumber>{i}</PartNumber><ETag>{e}</ETag></Part>" for i, e in etags
            ) + "</CompleteMultipartUpload>"
            status, _, out = self.call("POST", key, urllib.parse.urlencode({"uploadId": upload_id}),
                                       body=xml.encode())
            if status != 200 or b"<Error>" in out:
                die(f"complete {key}: {status} {out[:300]!r}")
        except BaseException:
            self.call("DELETE", key, urllib.parse.urlencode({"uploadId": upload_id}))
            raise

    def remote_sha256(self, key):
        h = hashlib.sha256()
        n = 0
        with self.call("GET", key, stream=True) as r:
            while chunk := r.read(1 << 20):
                h.update(chunk)
                n += len(chunk)
        return n, h.hexdigest()


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def upload_verified(s3, path, key, content_type="application/octet-stream"):
    """Upload once to an immutable key; verify size + SHA-256 by reading it back.
    An existing object with the same hash is accepted (re-runs are safe); a different one is fatal."""
    size, sha = os.path.getsize(path), file_sha256(path)
    existing = s3.head(key)
    if existing:
        if existing.get("x-amz-meta-sha256") != sha or int(existing["content-length"]) != size:
            die(f"{key} already exists with different content; immutable keys are never overwritten")
        print(f"= {key} already present, verified by metadata")
        return size, sha
    headers = {"Content-Type": content_type, "Cache-Control": IMMUTABLE, "x-amz-meta-sha256": sha}
    print(f"+ {key} ({size} B)", flush=True)
    if size > PART:
        s3.put_multipart(path, key, headers)
    else:
        with open(path, "rb") as f:
            s3.put_small(key, f.read(), headers)
    h = s3.head(key) or die(f"{key} missing after upload")
    if int(h["content-length"]) != size:
        die(f"{key}: size {h['content-length']} != {size}")
    got_size, got_sha = s3.remote_sha256(key)
    if (got_size, got_sha) != (size, sha):
        die(f"{key}: read-back {got_size}/{got_sha} != {size}/{sha}")
    print(f"  verified size + sha256 {sha[:16]}…")
    return size, sha


# ── manifest ─────────────────────────────────────────────────────────────────

def build_manifest(release, entries, uploaded):
    """entries: [{region, kind, file, github, extra?}]; uploaded: {file: (key, size, sha)}."""
    regions = {}
    for e in entries:
        key, size, sha = uploaded[e["file"]]
        regions.setdefault(e["region"], {})[e["kind"]] = {
            "key": key, "size": size, "sha256": sha, "github": e.get("github"), **e.get("extra", {})}
    return {"schema": "rods-maps/1", "release": release,
            "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "regions": dict(sorted(regions.items()))}


def publish(release, plan_path, pointer):
    plan = json.load(open(plan_path))
    base = os.path.dirname(os.path.abspath(plan_path))
    s3, uploaded = S3(), {}
    for e in plan:
        path = os.path.join(base, e["file"])
        key = f"releases/{release}/{e['region']}/{os.path.basename(e['file'])}"
        uploaded[e["file"]] = (key, *upload_verified(s3, path, key))
    manifest = json.dumps(build_manifest(release, plan, uploaded), indent=1).encode()
    mkey = f"releases/{release}/manifest.json"
    if s3.head(mkey):
        die(f"{mkey} exists; a release manifest is immutable — publish a new release id")
    s3.put_small(mkey, manifest, {"Content-Type": "application/json", "Cache-Control": IMMUTABLE})
    if pointer:  # last, only after every file above verified
        s3.put_small(pointer, manifest, {"Content-Type": "application/json", "Cache-Control": POINTER_CACHE})
        print(f"pointer {pointer} -> {release}")
    print(f"published {mkey}")


def merge_pointer(release, kind, entries_path):
    """Write releases/<release>/<kind>-manifest.json (immutable), then rewrite the root pointer
    with every region's <kind> entry replaced and every OTHER kind kept as it was, so a basemap
    release never drops the roads/routing copies the pointer already lists. Pointer last."""
    entries = json.load(open(entries_path))  # {region: {key, size, sha256, github, ...}}
    s3 = S3()
    for region, e in entries.items():
        h = s3.head(e["key"]) or die(f"{e['key']} missing; refusing to point at it")
        if int(h["content-length"]) != e["size"] or h.get("x-amz-meta-sha256") != e["sha256"]:
            die(f"{e['key']} does not match its entry")
    doc = {"schema": "rods-maps/1", "release": release, "kind": kind, "regions": entries}
    mkey = f"releases/{release}/{kind}-manifest.json"
    if s3.head(mkey):
        die(f"{mkey} exists; a release manifest is immutable")
    s3.put_small(mkey, json.dumps(doc, indent=1).encode(), {"Content-Type": "application/json", "Cache-Control": IMMUTABLE})
    status, _, body = s3.call("GET", "manifest.json")
    pointer = json.loads(body) if status == 200 else {"schema": "rods-maps/1", "regions": {}}
    if pointer.get("schema") != "rods-maps/1":
        die("existing pointer has an unknown schema; not overwriting it")
    for region, e in entries.items():
        pointer["regions"].setdefault(region, {})[kind] = e
    pointer["release"] = release
    pointer["generatedAt"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pointer["regions"] = dict(sorted(pointer["regions"].items()))
    s3.put_small("manifest.json", json.dumps(pointer, indent=1).encode(),
                 {"Content-Type": "application/json", "Cache-Control": POINTER_CACHE})
    print(f"pointer: {len(entries)} {kind} entries -> {release}; {len(pointer['regions'])} regions listed")


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-bucket")
    c.add_argument("--location", default="eeur")
    d = sub.add_parser("dev-url")
    d.add_argument("state", choices=["on", "off", "status"])
    sub.add_parser("custom-domains")
    pb = sub.add_parser("publish")
    pb.add_argument("release")
    pb.add_argument("plan", help="JSON list of {region, kind, file, github, extra}")
    pb.add_argument("--pointer", default="manifest.json", help="'' to skip the pointer")
    pt = sub.add_parser("put", help="upload one file to an immutable key, verified; prints its entry")
    pt.add_argument("file")
    pt.add_argument("key")
    mp = sub.add_parser("merge-pointer")
    mp.add_argument("release")
    mp.add_argument("kind", choices=["roads", "routing", "basemap"])
    mp.add_argument("entries", help="JSON {region: {key, size, sha256, github}}")
    a = p.parse_args()
    acct, b = account(), guard_bucket(BUCKET)
    if a.cmd == "create-bucket":
        r = cf("POST", f"/accounts/{acct}/r2/buckets",
               {"name": b, "locationHint": a.location, "storageClass": "Standard"})
        print(json.dumps({"success": r.get("success"), "errors": r.get("errors"), "result": r.get("result")}))
    elif a.cmd == "dev-url":
        path = f"/accounts/{acct}/r2/buckets/{b}/domains/managed"
        r = cf("GET", path) if a.state == "status" else cf("PUT", path, {"enabled": a.state == "on"})
        print(json.dumps({"success": r.get("success"), "errors": r.get("errors"), "result": r.get("result")}))
    elif a.cmd == "custom-domains":
        r = cf("GET", f"/accounts/{acct}/r2/buckets/{b}/domains/custom")
        print(json.dumps({"success": r.get("success"), "errors": r.get("errors"), "result": r.get("result")}))
    elif a.cmd == "publish":
        publish(a.release, a.plan, a.pointer)
    elif a.cmd == "put":
        size, sha = upload_verified(S3(), a.file, a.key)
        print(json.dumps({"key": a.key, "size": size, "sha256": sha}))
    elif a.cmd == "merge-pointer":
        merge_pointer(a.release, a.kind, a.entries)


if __name__ == "__main__":
    main()
