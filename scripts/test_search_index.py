"""Host-only tests for search_index.py (offline search file, Rods FEAT-090): no downloads.
Run: python3 -m unittest discover -s scripts -p 'test_search_index.py'"""
import gzip
import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

import importlib.util
SPEC = importlib.util.spec_from_file_location('search_index', Path(__file__).with_name('search_index.py'))
si = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(si)


def pt(x, y, **tags):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [x, y]}, 'properties': tags}


def line(coords, **tags):
    return {'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coords}, 'properties': tags}


FEATURES = [
    pt(21.30, 55.50, name='Šilutė', place='village', population='100'),
    pt(21.00, 55.70, name='Klaipėda', place='city', population='150000', wikidata='Q1'),
    pt(21.31, 55.51, name='Rusnė', place='hamlet'),
    {'type': 'Feature', 'properties': {'name': 'Klaipėda', 'place': 'city'},  # its boundary area: same city
     'geometry': {'type': 'Polygon', 'coordinates': [[[20.9, 55.6], [21.2, 55.6], [21.2, 55.8], [20.9, 55.6]]]}},
    pt(21.50, 55.40, name='Kalnų perėja', mountain_pass='yes', wikidata='Q2'),
    pt(21.01, 55.71, name='Kavinė', amenity='cafe'),
    pt(21.30, 55.52, name='Lietuvininkų degalinė', amenity='fuel'),
    line([[21.00, 55.70], [21.01, 55.70]], name='Taikos prospektas', highway='primary'),
    line([[21.01, 55.70], [21.02, 55.70]], name='Taikos prospektas', highway='residential'),
    line([[21.30, 55.50], [21.31, 55.50]], name='Lietuvininkų gatvė', highway='residential'),
    line([[21.30, 55.50], [21.31, 55.51]], name='Unnamed path', highway='footway'),
    pt(21.005, 55.70, **{'addr:street': 'Taikos prospektas', 'addr:housenumber': '10'}),
    pt(21.006, 55.70, **{'addr:street': 'Taikos prospektas', 'addr:housenumber': '12'}),
    pt(21.305, 55.50, **{'addr:street': 'Naujoji gatvė', 'addr:housenumber': '1'}),
    pt(21.306, 55.50, **{'addr:street': 'Naujoji gatvė', 'addr:housenumber': '3'}),
]
GROUP = lambda cls, rid, n_a: 0 if cls < 50 else 2 if cls == 50 and rid <= n_a else 3 if cls == 50 else 1


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.src = self.dir / 'in.geojsonseq'
        self.src.write_text('\n'.join(json.dumps(f) for f in FEATURES) + '\n')

    def tearDown(self):
        shutil.rmtree(self.dir)

    def build(self, today):
        with open(self.src) as fh:
            res = si.build('test-region', fh, self.dir / 'out', today, '2026-10-04T20:20:21Z', keep_sqlite=True)
        gz = self.dir / 'out' / 'test-region-search.sqlite.gz'
        db_path = self.dir / 'out' / 'test-region-search.sqlite'
        self.assertEqual(gzip.decompress(gz.read_bytes()), db_path.read_bytes())
        return res, sqlite3.connect(db_path)

    def test_schema_and_meta(self):
        res, db = self.build(10 ** 9)
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'f_%'")}
        self.assertEqual(tables, {'p', 'cls', 'f', 'meta', 'a'})
        cols = [r[1] for r in db.execute('PRAGMA table_info(p)')]
        self.assertEqual(cols, ['id', 'name', 'alt', 'cls', 'lat', 'lon', 'parent', 'rank'])
        fts = db.execute("SELECT sql FROM sqlite_master WHERE name='f'").fetchone()[0]
        for part in ("content='p'", "content_rowid='id'", 'remove_diacritics 2', "prefix='2 3'"):
            self.assertIn(part, fts)
        meta = dict(db.execute('SELECT k, v FROM meta'))
        self.assertEqual(meta['schema_version'], '1')
        self.assertEqual(meta['region'], 'test-region')
        self.assertEqual(meta['has_housenumbers'], '1')
        self.assertEqual(meta['osm_timestamp'], '2026-10-04T20:20:21Z')
        self.assertEqual(meta['rows'], str(db.execute('SELECT count(*) FROM p').fetchone()[0]))
        self.assertEqual(meta['addr_rows'], '4')
        self.assertEqual(meta['housenumbers_gz_bytes'], str(res['gz_with_housenumbers']))
        self.assertIn('built_at', meta)
        self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'delete')
        db.execute("INSERT INTO f(f) VALUES('integrity-check')")  # raises if the index disagrees with p
        # the footway is not a street; latitude/longitude are degrees x 1e5
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Unnamed path'").fetchone()[0], 0)
        self.assertEqual(db.execute("SELECT lat, lon FROM p WHERE name='Klaipėda'").fetchone(), (5570000, 2100000))
        self.assertEqual(dict(db.execute('SELECT tag, id FROM cls'))['mountain_pass=yes'] >= 100, True)

    def test_rows_most_important_first(self):
        res, db = self.build(10 ** 9)
        rows = db.execute('SELECT id, cls, rank FROM p ORDER BY id').fetchall()
        self.assertEqual([r[0] for r in rows], list(range(1, len(rows) + 1)))
        n_a = res['rows_a']
        keys = [(GROUP(c, i, n_a), -rank) for i, c, rank in rows]
        self.assertEqual(keys, sorted(keys), 'ids ascending must be importance descending within each group')
        self.assertEqual(rows[0][1], 1, 'the city comes first')
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Klaipėda'").fetchone()[0], 1, 'node + area = one row')
        # the address-only street is the very last row, and both segments of Taikos merged into one row
        self.assertEqual(db.execute('SELECT name FROM p ORDER BY id DESC LIMIT 1').fetchone()[0], 'Naujoji gatvė')
        self.assertEqual(db.execute("SELECT count(*), max(rank) FROM p WHERE name='Taikos prospektas'").fetchone(), (1, 17))
        # parents: streets/POIs point at a settlement; house numbers hang off their street
        par = db.execute("SELECT q.cls FROM p s JOIN p q ON q.id=s.parent WHERE s.name='Kavinė'").fetchone()[0]
        self.assertLessEqual(par, 5)
        hns = db.execute("SELECT a.hn FROM a JOIN p ON p.id=a.street WHERE p.name='Taikos prospektas' ORDER BY a.hn").fetchall()
        self.assertEqual(hns, [('10',), ('12',)])

    def test_housenumber_rule_drops_b_when_too_big(self):
        res_b, _ = self.build(10 ** 9)
        too_small_today = res_b['gz_with_housenumbers'] * 19  # gz(B) = 5.26 % of today
        res, db = self.build(too_small_today)
        self.assertEqual(res['variant'], 'A')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn('a', tables)
        meta = dict(db.execute('SELECT k, v FROM meta'))
        self.assertEqual((meta['has_housenumbers'], meta['addr_rows']), ('0', '0'))
        self.assertTrue(meta['decision'].startswith('A: '))
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Naujoji gatvė'").fetchone()[0], 0,
                         'address-only streets go with the house numbers')
        self.assertEqual(int(meta['rows']), res_b['rows_a'])
        # just under 5 % (meta timestamps move gz(B) by a few bytes between builds; the exact
        # boundary is test_keep_housenumbers_boundaries)
        res, _ = self.build(res_b['gz_with_housenumbers'] * 20 + 400)
        self.assertEqual(res['variant'], 'B')

    def test_keep_housenumbers_boundaries(self):
        self.assertTrue(si.keep_housenumbers(50, 1000))
        self.assertFalse(si.keep_housenumbers(51, 1000))
        self.assertFalse(si.keep_housenumbers(1, 0), 'unknown download size never ships house numbers')

    def test_diacritics_insensitive_prefix_match(self):
        _, db = self.build(10 ** 9)
        q = 'SELECT p.name FROM f JOIN p ON p.id=f.rowid WHERE f MATCH ? ORDER BY f.rowid LIMIT 400'
        self.assertIn(('Šilutė',), db.execute(q, ('"silute"',)).fetchall())
        self.assertIn(('Klaipėda',), db.execute(q, ('"kl"*',)).fetchall())
        self.assertIn(('Lietuvininkų gatvė',), db.execute(q, ('"lietuvininku" "gat"*',)).fetchall())

    def test_today_bytes_from_manifests(self):
        monthly = {'regions': {'r': {'sqliteSize': 100}, 's': {'sqliteSize': 7}}}
        valhalla = {'regions': {'r': {'valhallaSize': 20}}}
        basemap = {'regions': {'r-north': {'basemapSize': 3, 'pieceOf': 'r'}, 'r-south': {'basemapSize': 4, 'pieceOf': 'r'}}}
        self.assertEqual(si.today_bytes('r', [monthly, valhalla, basemap])[0], 127)
        pilot = {'p1': {'sqliteSize': 10, 'valhallaSize': 11, 'mapSize': 12}}
        self.assertEqual(si.today_bytes('p1', [pilot])[0], 33)
        road = self.dir / 'r.sqlite.gz'
        road.write_bytes(b'x' * 5)
        self.assertEqual(si.today_bytes('r', [monthly, valhalla], str(road))[0], 25)

    @unittest.skipUnless(shutil.which('osmium'), 'osmium-tool not installed')
    def test_pbf_end_to_end(self):
        opl = self.dir / 'in.opl'
        opl.write_text('\n'.join([
            'n1 v1 dV c0 t i0 u Tplace=town,name=Ąžuolynė,population=5000 x21.0 y55.0',
            'n2 v1 dV c0 t i0 u T x21.001 y55.0',
            'n3 v1 dV c0 t i0 u T x21.002 y55.0',
            'n4 v1 dV c0 t i0 u Taddr:street=Miško%20%gatvė,addr:housenumber=5 x21.0015 y55.0',
            'n5 v1 dV c0 t i0 u T x21.003 y55.001',
            'n6 v1 dV c0 t i0 u T x21.004 y55.001',
            'n7 v1 dV c0 t i0 u T x21.004 y55.002',
            'w10 v1 dV c0 t i0 u Thighway=residential,name=Miško%20%gatvė Nn2,n3',
            # a closed building way: osmium exports it as a LineString AND an area; one row, one address
            'w11 v1 dV c0 t i0 u Tbuilding=yes,amenity=cafe,name=Kavinė,addr:street=Miško%20%gatvė,'
            'addr:housenumber=7 Nn5,n6,n7,n5',
        ]) + '\n')
        pbf = self.dir / 'in.osm.pbf'
        subprocess.run(['osmium', 'cat', str(opl), '-o', str(pbf)], check=True)
        out = self.dir / 'pbfout'
        si.main(['--region', 'tiny', '--pbf', str(pbf), '--out', str(out), '--today-bytes', str(10 ** 9), '--keep-sqlite'])
        db = sqlite3.connect(out / 'tiny-search.sqlite')
        self.assertEqual(db.execute('SELECT name, cls FROM p ORDER BY id').fetchall(),
                         [('Ąžuolynė', 2), ('Kavinė', 100), ('Miško gatvė', 50)])
        self.assertEqual(db.execute('SELECT street, hn FROM a').fetchall(), [(3, '5'), (3, '7')])
        self.assertEqual(sorted(p.name for p in out.iterdir()), ['tiny-search.sqlite', 'tiny-search.sqlite.gz'])


if __name__ == '__main__':
    unittest.main()
