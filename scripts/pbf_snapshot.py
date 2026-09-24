#!/usr/bin/env python3
"""Print an OSM PBF's snapshot id: the header's osmosis_replication_timestamp (ISO-8601 UTC).

PURPOSE: the "same OSM snapshot" check of RT-18 point 2. Geofabrik stamps every extract cut from
  one planet update with the same replication timestamp, so two PBFs with equal values were cut
  from the same OSM data. Stdlib only (reads the first blob; no osmium needed on the build box).
USAGE: pbf_snapshot.py <file.osm.pbf>        -> prints e.g. 2026-09-01T20:21:02Z, exit 1 if absent
       pbf_snapshot.py --self-check          -> runs the embedded check
"""
import datetime
import struct
import sys
import zlib


def _varint(buf, i):
    shift = value = 0
    while True:
        b = buf[i]
        i += 1
        value |= (b & 0x7F) << shift
        if b < 0x80:
            return value, i
        shift += 7


def _fields(buf):
    """Yield (field_number, value) for a protobuf message; length-delimited values are bytes."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _varint(buf, i)
        elif wire == 2:
            n, i = _varint(buf, i)
            value, i = buf[i:i + n], i + n
        elif wire == 1:
            value, i = buf[i:i + 8], i + 8
        elif wire == 5:
            value, i = buf[i:i + 4], i + 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        yield field, value


def snapshot_from_bytes(head):
    (header_len,) = struct.unpack(">I", head[:4])
    blob_header = dict(_fields(head[4:4 + header_len]))
    if blob_header.get(1) != b"OSMHeader":
        raise ValueError("first blob is not OSMHeader")
    start = 4 + header_len
    blob = dict(_fields(head[start:start + blob_header[3]]))
    data = zlib.decompress(blob[3]) if 3 in blob else blob[1]
    ts = dict(_fields(data)).get(32)  # HeaderBlock.osmosis_replication_timestamp
    if ts is None:
        return None
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _self_check():
    def v(n):
        out = b""
        while True:
            b, n = n & 0x7F, n >> 7
            out += bytes([b | (0x80 if n else 0)])
            if not n:
                return out
    ld = lambda f, b: v(f << 3 | 2) + v(len(b)) + b
    header_block = ld(4, b"OsmSchema-V0.6") + v(32 << 3) + v(1788300000)
    blob = v(2 << 3) + v(len(header_block)) + ld(3, zlib.compress(header_block))
    bh = ld(1, b"OSMHeader") + v(3 << 3) + v(len(blob))
    assert snapshot_from_bytes(struct.pack(">I", len(bh)) + bh + blob) == "2026-09-01T22:00:00Z"
    print("pbf_snapshot self-check OK")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-check"]:
        _self_check()
        sys.exit(0)
    with open(sys.argv[1], "rb") as f:
        head = f.read(1 << 20)
    snap = snapshot_from_bytes(head)
    if not snap:
        sys.exit("no osmosis_replication_timestamp in PBF header")
    print(snap)
