#!/usr/bin/env python3
"""Offline search index: <region>-search.sqlite.gz, the fifth file per region (Rods FEAT-090).

PURPOSE: lets the phone find towns, passes, streets, everyday places and (where they are cheap)
  OpenStreetMap house numbers inside a downloaded region with no signal. Owner decision
  2026-10-06: places + streets everywhere; house numbers only where the search file stays at or
  under HOUSENUMBER_MAX_SHARE of the region's download (road data + routing + map).
RESPONSIBILITY: osmium filter + export of one PBF, parse, rank, write the pinned SQLite contract
  (below), gzip it, decide A (no house numbers) vs B (with) from MEASURED sizes.
DEPENDENCIES: python3 stdlib (sqlite3 with FTS5), osmium-tool (only with --pbf), pbf_snapshot.py.
CONSUMERS: osm-extract.yml + region-slices-pilot.yml (one file per region / piece),
  generate-manifest.ts (searchSize/searchChecksum), test_search_index.py, humans (local builds).

FILE CONTRACT (schema_version 1 — the Rods app is written against it; change = bump + tell the app):
  p(id INTEGER PRIMARY KEY, name TEXT NOT NULL, alt TEXT, cls INTEGER, lat INTEGER, lon INTEGER,
    parent INTEGER, rank INTEGER)   lat/lon = degrees * 1e5 rounded; cls 1-9 place, 50 street,
    >=100 POI class from cls; parent = nearest settlement (cls <= 5) for streets/POIs, nearest
    city/town for smaller places; rank 0-99, higher = more important.
  cls(id INTEGER PRIMARY KEY, tag TEXT)
  f = fts5(name, alt, content='p', content_rowid='id', tokenize='unicode61 remove_diacritics 2',
    prefix='2 3'), optimized
  a(street INTEGER, hn TEXT, lat INTEGER, lon INTEGER, PRIMARY KEY(street, hn)) WITHOUT ROWID
    — only when has_housenumbers = 1
  meta(k TEXT PRIMARY KEY, v TEXT)
  ROW ORDER IS LOAD-BEARING: ids ascending = importance descending (places by rank, then POIs by
  rank, then streets by rank, then streets that exist only because an address names them). The
  phone ranks only the first 400 FTS hits in rowid order; this order is what makes that fast.

USAGE:
  search_index.py --region europe-estonia --pbf estonia.osm.pbf --out DIR \
      [--manifest manifest.json --manifest valhalla-manifest.json --manifest basemap.json]
      [--road-gz DIR/europe-estonia.sqlite.gz] [--today-bytes N] [--keep-sqlite]
  search_index.py --region test --geojsonseq features.geojsonseq --out DIR --today-bytes N
"""
import argparse
import datetime
import gzip
import hashlib
import importlib.util
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unicodedata
from pathlib import Path

SCHEMA_VERSION = 1
# Owner rule 2026-10-06: house numbers ship only if gz(file with them) <= 5 % of today's download.
HOUSENUMBER_MAX_SHARE = 0.05
GZIP_LEVEL = 9  # same as build-sqlite.ts uses for <region>.sqlite.gz
FTS_PREFIX = '2 3'

PLACE = {'city': 1, 'town': 2, 'municipality': 2, 'village': 3, 'hamlet': 4, 'suburb': 5, 'quarter': 6,
         'neighbourhood': 6, 'locality': 7, 'isolated_dwelling': 8, 'island': 9, 'islet': 9}
SETTLEMENT_MAX_CLS = 5
STREET_CLS = 50
ROADS_SKIP = {'footway', 'path', 'cycleway', 'steps', 'bridleway', 'corridor', 'platform', 'proposed',
              'construction', 'elevator', 'via_ferrata', 'bus_stop', 'abandoned', 'razed', 'no', 'services',
              'rest_area'}
POI_KEYS = ('mountain_pass', 'natural', 'tourism', 'historic', 'amenity', 'shop', 'leisure', 'aeroway', 'railway',
            'boundary')
ALT = ('alt_name', 'old_name', 'official_name', 'short_name', 'name:en', 'int_name', 'loc_name', 'reg_name')
STREET_RANK = {'motorway': 9, 'trunk': 8, 'primary': 7, 'secondary': 6, 'tertiary': 5}
POI_RANK, POI_BONUS = 20, {'mountain_pass=yes': 10}  # a driving app: passes outrank cafés
FAME_BONUS = 5  # wikidata / wikipedia tag
ADDR_STREET_RANK = 10
LINK_RADIUS_DEG = 0.03
PLACE_DEDUP_DEG = 0.1    # ~10 km: a city's node vs the centre of its boundary area
POI_DEDUP_DEG = 0.005    # ~500 m: a fuel station's node vs its forecourt area
LINK_MAX_CANDIDATES = 64  # name fallback only for rare names; "Hauptstraße" would make it O(n^2)

# The objects variant A/B can contain (port of the 2026-10-06 measurement filter).
OSMIUM_FILTER = [
    'nwr/place', 'nwr/mountain_pass=yes',
    'nwr/natural=peak,saddle,volcano,cape,beach,bay,water,glacier,spring,cliff,arch',
    'nwr/tourism', 'nwr/historic', 'nwr/shop',
    'nwr/amenity=fuel,cafe,restaurant,fast_food,pub,bar,biergarten,charging_station,parking,hospital,pharmacy,'
    'townhall,place_of_worship,university,college,cinema,theatre,arts_centre,police,ferry_terminal,marketplace,'
    'library,ice_cream,car_wash,toilets',
    'nwr/leisure=park,stadium,marina,sports_centre,golf_course,nature_reserve,water_park,track',
    'nwr/aeroway=aerodrome', 'nwr/railway=station,halt', 'nwr/boundary=national_park',
    'w/highway', 'nwr/addr:housenumber',
]


def log(msg):
    print(f'[search] {msg}', file=sys.stderr, flush=True)


def norm(s):
    s = unicodedata.normalize('NFKD', s.lower())
    return ''.join(c for c in s if not unicodedata.combining(c)).replace('-', ' ').replace("'", ' ').strip()


def coord(g):
    t, c = g.get('type'), g.get('coordinates')
    if not c:
        return None
    if t == 'Point':
        return c
    if t == 'LineString':
        return c[len(c) // 2]
    if t == 'MultiLineString':
        return c[0][len(c[0]) // 2]
    if t == 'Polygon':
        ring = c[0]
    elif t == 'MultiPolygon':
        ring = c[0][0]
    else:
        return None
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2]


class Grid:
    """Nearest item by equirectangular distance, searching rings of up to 8 cells. A hit in ring r is
    only final once nothing outside the ring can be closer (r cells, east-west shrunk by cos(lat))."""

    def __init__(self, cell):
        self.c, self.g = cell, {}

    def add(self, lon, lat, item):
        self.g.setdefault((int(lon // self.c), int(lat // self.c)), []).append((lon, lat, item))

    def nearest(self, lon, lat):
        cx, cy = int(lon // self.c), int(lat // self.c)
        k = math.cos(math.radians(lat)) ** 2
        best, bd = None, 1e18
        for r in (1, 2, 3, 5, 8):
            for x in range(cx - r, cx + r + 1):
                for y in range(cy - r, cy + r + 1):
                    for a, b, it in self.g.get((x, y), ()):
                        d = (a - lon) ** 2 * k + (b - lat) ** 2
                        if d < bd:
                            bd, best = d, it
            if best is not None and bd <= (r * self.c) ** 2 * k:
                return best
        # ponytail: past 8 cells (~40 km settlements, ~200 km towns) the best seen is good enough as
        # a "near X" label, or None; an unbounded search only matters for empty wilderness.
        return best


def clean(s):
    return ' '.join(s.split())


def alts(p, name):
    out = []
    for k in ALT:
        v = p.get(k)
        if v and v != name and v not in out:
            out.append(clean(v))
    return ';'.join(out) or None


def famous(p):
    return 'wikidata' in p or 'wikipedia' in p


def parse(lines, addr_out):
    """geojsonseq lines -> (places, pois, streets, n_addr, classes). Addresses stream to addr_out (TSV)."""
    places, pois, streets, classes, n_addr = [], [], {}, {}, 0
    for line in lines:
        line = line.strip().lstrip('\x1e')
        if not line:
            continue
        f = json.loads(line)
        p, g = f.get('properties') or {}, f.get('geometry') or {}
        # osmium export (no config) emits every closed way twice, as LineString AND as area: keep
        # only the area, except for roads (a closed residential loop is a street, not a place).
        if g.get('type') == 'LineString' and 'highway' not in p and len(g['coordinates']) > 3 \
                and g['coordinates'][0] == g['coordinates'][-1]:
            continue
        c = None
        hn, st = p.get('addr:housenumber'), p.get('addr:street') or p.get('addr:place')
        if hn and st:
            c = coord(g)
            if c:
                addr_out.write(f'{clean(st)}\t{clean(hn)}\t{c[0]:.5f}\t{c[1]:.5f}\n')
                n_addr += 1
        nm = p.get('name')
        if not nm:
            continue
        nm = clean(nm)
        fame = FAME_BONUS if famous(p) else 0
        pl = p.get('place')
        if pl in PLACE:
            c = c or coord(g)
            if c:
                pop = str(p.get('population', '0')).replace(',', '').replace(' ', '')
                try:
                    pop = max(0, int(float(pop)))
                except ValueError:
                    pop = 0
                cl = PLACE[pl]
                rank = max(0, min(99, 40 - 4 * cl + int(math.log10(pop + 1) * 6) + fame))
                places.append((rank, pop, nm, alts(p, nm), cl, c[0], c[1], g.get('type') != 'Point'))
                continue
        hw = p.get('highway')
        if hw and hw not in ROADS_SKIP and g.get('type') in ('LineString', 'MultiLineString', 'Polygon'):
            c = c or coord(g)
            if c:
                rank = 10 + STREET_RANK.get(hw, 3)
                streets.setdefault(norm(nm), []).append((rank, nm, alts(p, nm), c[0], c[1]))
            continue
        for k in POI_KEYS:
            v = p.get(k)
            if v and v != 'no':
                c = c or coord(g)
                if c:
                    tag = 'shop' if k == 'shop' else f'{k}={v}'
                    if tag not in classes:
                        classes[tag] = 100 + len(classes)
                    rank = min(99, POI_RANK + POI_BONUS.get(tag, 0) + fame)
                    pois.append((rank, nm, alts(p, nm), classes[tag], c[0], c[1], g.get('type') != 'Point'))
                break
    return places, pois, streets, n_addr, classes


def dup(seen, key, x, y, deg, area):
    """True if this is the other half of a node + area pair already kept: same name and class, the
    other geometry kind, within deg (OSM often maps one town or fuel station as both). Two nodes or
    two areas are never merged — same-named villages or chain cafés nearby are real, separate rows.
    Bucketed by deg-sized cells, so a chain with thousands of same-named branches stays O(1)."""
    cos = max(math.cos(math.radians(y)), 0.1)  # polar cap: |lat| > ~84 is not in any region
    cx, cy, k = int(x // deg), int(y // deg), cos * cos
    nx = math.ceil(1 / cos)  # the radius spans 1/cos(lat) longitude buckets
    for i in range(cx - nx, cx + nx + 1):
        for j in (cy - 1, cy, cy + 1):
            if any((a - x) ** 2 * k + (b - y) ** 2 < deg * deg for a, b in seen.get((key, deg, not area, i, j), ())):
                return True
    seen.setdefault((key, deg, area, cx, cy), []).append((x, y))
    return False


class Index:
    """Rows in contract order. row = [id, name, alt, cls, lat_e5, lon_e5, parent, rank]."""

    def __init__(self, places, pois, streets):
        self.rows = []
        town, self.settle = Grid(0.25), Grid(0.05)
        # Ties: bigger population, then name — deterministic output for the same OSM input.
        seen = {}
        for rank, pop, nm, al, cl, x, y, area in sorted(places, key=lambda t: (-t[0], -t[1], t[2], t[5], t[6], t[7])):
            if dup(seen, (norm(nm), cl), x, y, PLACE_DEDUP_DEG, area):
                continue
            rid = self._add(nm, al, cl, x, y, None, rank)
            if cl <= 2:
                town.add(x, y, rid)
            if cl <= SETTLEMENT_MAX_CLS:
                self.settle.add(x, y, rid)
        for r in self.rows:
            if r[3] > 2:
                r[6] = town.nearest(r[5] / 1e5, r[4] / 1e5)
        for rank, nm, al, cl, x, y, area in sorted(pois, key=lambda t: (-t[0], t[1], t[4], t[5], t[6])):
            if dup(seen, (norm(nm), cl), x, y, POI_DEDUP_DEG, area):
                continue
            self._add(nm, al, cl, x, y, self.settle.nearest(x, y), rank)
        # One street row per (normalised name, nearest settlement): segments of a street merge,
        # same-named streets of different villages stay apart. Highest-ranked segment wins.
        merged = {}
        for key, segs in streets.items():
            for rank, nm, al, x, y in segs:
                k = (key, self.settle.nearest(x, y))
                cur = merged.get(k)
                if cur is None or rank > cur[0]:
                    merged[k] = (rank, nm, al or (cur[2] if cur else None), x, y)
        self.skey, self.by_name = {}, {}
        for (key, par), (rank, nm, al, x, y) in sorted(merged.items(), key=lambda kv: (-kv[1][0], kv[1][1], kv[0][1] or 0)):
            self._street(key, par, nm, al, x, y, rank)
        self.n_a = len(self.rows)

    def _add(self, nm, al, cl, x, y, parent, rank):
        rid = len(self.rows) + 1
        self.rows.append([rid, nm, al, cl, round(y * 1e5), round(x * 1e5), parent, rank])
        return rid

    def _street(self, key, par, nm, al, x, y, rank):
        rid = self._add(nm, al, STREET_CLS, x, y, par, rank)
        self.skey[(key, par)] = rid
        self.by_name.setdefault(key, []).append((x, y, rid))
        return rid

    def link(self, addr_lines):
        """Address TSV -> sorted [(street_id, hn, lat, lon)]; unknown streets become rows after n_a."""
        out = []
        for line in addr_lines:
            st, hn, x, y = line.rstrip('\n').split('\t')
            x, y = float(x), float(y)
            key, par = norm(st), self.settle.nearest(x, y)
            rid = self.skey.get((key, par))
            if rid is None:
                cands = self.by_name.get(key, ())
                if 0 < len(cands) <= LINK_MAX_CANDIDATES:
                    k = math.cos(math.radians(y)) ** 2
                    bx, by, brid = min(cands, key=lambda c: (c[0] - x) ** 2 * k + (c[1] - y) ** 2)
                    if (bx - x) ** 2 * k + (by - y) ** 2 < LINK_RADIUS_DEG ** 2:
                        rid = brid
                if rid is None:
                    rid = self._street(key, par, st, None, x, y, ADDR_STREET_RANK)
                self.skey[(key, par)] = rid
            out.append((rid, hn, round(y * 1e5), round(x * 1e5)))
        out.sort()
        return out


def write_db(path, rows, classes, addrs, meta):
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.executescript(f"""
    PRAGMA page_size=4096; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
    CREATE TABLE p(id INTEGER PRIMARY KEY, name TEXT NOT NULL, alt TEXT, cls INTEGER, lat INTEGER, lon INTEGER,
                   parent INTEGER, rank INTEGER);
    CREATE TABLE cls(id INTEGER PRIMARY KEY, tag TEXT);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE VIRTUAL TABLE f USING fts5(name, alt, content='p', content_rowid='id',
                                      tokenize='unicode61 remove_diacritics 2', prefix='{FTS_PREFIX}');
    """)
    db.executemany('INSERT INTO p VALUES (?,?,?,?,?,?,?,?)', rows)
    db.executemany('INSERT INTO cls VALUES (?,?)', sorted((v, k) for k, v in classes.items()))
    db.execute('INSERT INTO f(rowid, name, alt) SELECT id, name, alt FROM p')
    n_addr = 0
    if addrs is not None:
        db.execute('CREATE TABLE a(street INTEGER, hn TEXT, lat INTEGER, lon INTEGER, PRIMARY KEY(street, hn)) WITHOUT ROWID')
        db.executemany('INSERT OR IGNORE INTO a VALUES (?,?,?,?)', addrs)
        n_addr = db.execute('SELECT count(*) FROM a').fetchone()[0]
    meta = dict(meta, rows=len(rows), addr_rows=n_addr)
    db.executemany('INSERT INTO meta VALUES (?,?)', sorted((k, str(v)) for k, v in meta.items()))
    db.execute("INSERT INTO f(f) VALUES('optimize')")
    db.commit()
    db.execute('VACUUM')
    db.execute('PRAGMA journal_mode=DELETE')
    db.close()
    return n_addr


def gzip_file(src, dst):
    """Reproducible gzip (no name, mtime 0); returns compressed bytes."""
    with open(src, 'rb') as fi, open(dst, 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=GZIP_LEVEL, mtime=0) as fo:
            shutil.copyfileobj(fi, fo, 1 << 20)
    return os.path.getsize(dst)


def keep_housenumbers(gz_b, today):
    """The owner rule. Unknown today (0) cannot prove <= 5 %, so it ships without."""
    return today > 0 and gz_b <= HOUSENUMBER_MAX_SHARE * today


def today_bytes(region, manifests, road_gz=None):
    """Today's download for a region = road data + routing + map, read from the manifests the app
    reads (monthly manifest.json: sqliteSize; valhalla-manifest.json: valhallaSize; basemap
    manifest.json: basemapSize, split countries as pieceOf rows; slices-pilot-sizes.json: top-level
    piece ids with sqliteSize/valhallaSize/mapSize). road_gz, when given, replaces sqliteSize."""
    road = os.path.getsize(road_gz) if road_gz else 0
    routing = mapb = 0
    for m in manifests:
        regs = m.get('regions', m)
        e = regs.get(region) or {}
        if not road_gz:
            road = road or e.get('sqliteSize', 0)
        routing = routing or e.get('valhallaSize', 0)
        mapb = mapb or e.get('basemapSize', 0) or e.get('mapSize', 0)
        if not mapb:
            mapb = sum(v.get('basemapSize', 0) for v in regs.values() if isinstance(v, dict) and v.get('pieceOf') == region)
    return road + routing + mapb, {'road': road, 'routing': routing, 'map': mapb}


def osm_snapshot(pbf):
    spec = importlib.util.spec_from_file_location('pbf_snapshot', Path(__file__).with_name('pbf_snapshot.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    with open(pbf, 'rb') as f:
        return mod.snapshot_from_bytes(f.read(1 << 20)) or ''


def require_fts5():
    try:
        sqlite3.connect(':memory:').execute("CREATE VIRTUAL TABLE t USING fts5(a, tokenize='unicode61 remove_diacritics 2')")
    except sqlite3.OperationalError as e:
        sys.exit(f'sqlite {sqlite3.sqlite_version} has no usable FTS5 ({e})')


def build(region, lines, out_dir, today, osm_timestamp='', keep_sqlite=False):
    require_fts5()
    t0 = time.time()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f'{region}-search-', dir=out_dir))
    try:
        addr_tsv = work / 'addr.tsv'
        with open(addr_tsv, 'w', encoding='utf-8') as af:
            places, pois, streets, n_addr, classes = parse(lines, af)
        idx = Index(places, pois, streets)
        del places, pois, streets
        base = {'schema_version': SCHEMA_VERSION, 'region': region, 'osm_timestamp': osm_timestamp,
                'built_at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'today_download_bytes': today, 'housenumber_max_share': HOUSENUMBER_MAX_SHARE}
        db_path, gz_path = work / 'search.sqlite', out_dir / f'{region}-search.sqlite.gz'
        gz_b, addr_rows, variant = None, 0, 'A'
        if n_addr:
            with open(addr_tsv, encoding='utf-8') as fa:
                addrs = idx.link(fa)
            # meta is final before gzip, so gz_b is exactly the file that ships if B is kept
            addr_rows = write_db(db_path, idx.rows, classes, addrs, dict(
                base, has_housenumbers=1, variant='B', decision=f'B: gz <= {HOUSENUMBER_MAX_SHARE} x {today}'))
            del addrs
            gz_b = gzip_file(db_path, gz_path)
            if keep_housenumbers(gz_b, today):
                variant = 'B'
            else:
                addr_rows = 0
        if variant == 'A':
            why = (f'A: {gz_b} > {HOUSENUMBER_MAX_SHARE} x {today}' if gz_b is not None and today
                   else 'A: no house numbers in OSM' if gz_b is None else 'A: today\'s download unknown')
            write_db(db_path, idx.rows[:idx.n_a], classes, None,
                     dict(base, has_housenumbers=0, variant='A', housenumbers_gz_bytes=gz_b or '', decision=why))
        gz = gz_b if variant == 'B' else gzip_file(db_path, gz_path)
        sqlite_bytes = os.path.getsize(db_path)
        if keep_sqlite:
            shutil.move(db_path, out_dir / f'{region}-search.sqlite')
        db_rows = idx.n_a if variant == 'A' else len(idx.rows)
        with open(gz_path, 'rb') as fh:
            sha = hashlib.file_digest(fh, 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(fh.read()).hexdigest()
        res = {'region': region, 'variant': variant, 'rows': db_rows, 'rows_a': idx.n_a, 'addr_rows': addr_rows,
               'osm_addresses': n_addr, 'sqlite_bytes': sqlite_bytes, 'gz_bytes': gz, 'gz_with_housenumbers': gz_b,
               'today_download_bytes': today, 'share_pct': round(100 * gz / today, 2) if today else None,
               'share_with_housenumbers_pct': round(100 * gz_b / today, 2) if today and gz_b else None,
               'checksum': sha[:16], 'sha256': sha, 'osm_timestamp': osm_timestamp, 'seconds': round(time.time() - t0, 1)}
        log(f"{region}: variant {variant} ({res['share_pct']} % of today {today} B; with house numbers "
            f"{gz_b} B = {res['share_with_housenumbers_pct']} %), {db_rows} rows, {addr_rows} addresses, "
            f"{gz} B gz, sha256 {sha[:16]}, {res['seconds']} s")
        return res
    finally:
        shutil.rmtree(work, ignore_errors=True)


def osmium_lines(pbf, work):
    """Filter the PBF to what the index can hold, then stream it out as GeoJSON lines."""
    filtered = Path(work) / 'search-filtered.osm.pbf'
    subprocess.run(['osmium', 'tags-filter', str(pbf), *OSMIUM_FILTER, '-o', str(filtered), '-O', '--no-progress'],
                   check=True)
    proc = subprocess.Popen(['osmium', 'export', str(filtered), '-f', 'geojsonseq', '-x', 'print_record_separator=false',
                             '-o', '-', '--no-progress'], stdout=subprocess.PIPE, text=True, encoding='utf-8')
    try:
        yield from proc.stdout
    finally:
        proc.stdout.close()
        rc = proc.wait()
        filtered.unlink(missing_ok=True)
        if rc:
            raise RuntimeError(f'osmium export exited {rc}')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--region', required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--pbf')
    src.add_argument('--geojsonseq', help="file, or '-' for stdin")
    ap.add_argument('--out', required=True)
    ap.add_argument('--today-bytes', type=int)
    ap.add_argument('--manifest', action='append', default=[], help='manifest JSON(s) to read today\'s download from')
    ap.add_argument('--road-gz', help="this run's <region>.sqlite.gz (replaces the manifest's sqliteSize)")
    ap.add_argument('--osm-timestamp', default='')
    ap.add_argument('--keep-sqlite', action='store_true', help='also leave the unzipped .sqlite in --out')
    ap.add_argument('--summary', help='write the result JSON here too')
    a = ap.parse_args(argv)
    if a.today_bytes is not None:
        today, parts = a.today_bytes, {}
    else:
        manifests = []
        for m in a.manifest:
            try:
                manifests.append(json.loads(Path(m).read_text()))
            except (OSError, ValueError) as e:
                log(f'WARNING: manifest {m} unreadable ({e}); today\'s download will be smaller, so A is likelier')
        today, parts = today_bytes(a.region, manifests, a.road_gz)
    log(f"{a.region}: today's download {today} B {parts}")
    if a.pbf:
        ts = a.osm_timestamp or osm_snapshot(a.pbf)
        work = tempfile.mkdtemp(prefix='search-osmium-', dir=a.out if os.path.isdir(a.out) else None)
        try:
            res = build(a.region, osmium_lines(a.pbf, work), a.out, today, ts, a.keep_sqlite)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    else:
        fh = sys.stdin if a.geojsonseq == '-' else open(a.geojsonseq, encoding='utf-8')
        with fh:
            res = build(a.region, fh, a.out, today, a.osm_timestamp, a.keep_sqlite)
    res['today_parts'] = parts
    if a.summary:
        Path(a.summary).write_text(json.dumps(res, indent=1))
    print(json.dumps(res))


if __name__ == '__main__':
    main()
