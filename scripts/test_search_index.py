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
    pt(21.34, 55.51, name='Rusnė', place='hamlet'),  # a second, real hamlet 2 km away: not a twin
    {'type': 'Feature', 'properties': {'name': 'Klaipėda', 'place': 'city'},  # its boundary area: same city
     'geometry': {'type': 'Polygon', 'coordinates': [[[20.9, 55.6], [21.2, 55.6], [21.2, 55.8], [20.9, 55.6]]]}},
    pt(21.50, 55.40, name='Kalnų perėja', mountain_pass='yes', wikidata='Q2'),
    pt(21.01, 55.71, name='Kavinė', amenity='cafe'),
    pt(21.30, 55.52, name='Lietuvininkų degalinė', amenity='fuel'),
    pt(21.301, 55.52, name='Lietuvininkų degalinė', amenity='fuel'),  # same brand 60 m away: two stations
    line([[21.00, 55.70], [21.01, 55.70]], name='Taikos prospektas', highway='primary'),
    line([[21.01, 55.70], [21.02, 55.70]], name='Taikos prospektas', highway='residential'),
    line([[21.30, 55.50], [21.31, 55.50]], name='Lietuvininkų gatvė', highway='residential'),
    line([[21.30, 55.50], [21.31, 55.51]], name='Unnamed path', highway='footway'),
    pt(21.005, 55.70, **{'addr:street': 'Taikos prospektas', 'addr:housenumber': '10', 'addr:postcode': 'AB1 2CD'}),
    pt(21.006, 55.70, **{'addr:street': 'Taikos prospektas', 'addr:housenumber': '12', 'addr:postcode': 'ab1 2cd'}),
    pt(21.007, 55.70, **{'addr:postcode': 'AB1 2CD'}),  # no street, no number: still counts toward the code
    pt(21.30, 55.50, **{'addr:postcode': 'LT-99001', 'building': 'yes'}),
    pt(21.31, 55.52, **{'addr:postcode': 'LT-99001;LT-99002;not a code at all, really'}),
    {'type': 'Feature', 'properties': {'boundary': 'postal_code', 'postal_code': 'LT-99003', 'name': 'LT-99003'},
     'geometry': {'type': 'Polygon', 'coordinates': [[[21.4, 55.4], [21.6, 55.4], [21.6, 55.6], [21.4, 55.4]]]}},
    pt(21.52, 55.52, place='postcode', postal_code='LT-99004'),
    pt(21.305, 55.50, **{'addr:street': 'Naujoji gatvė', 'addr:housenumber': '1'}),
    pt(21.306, 55.50, **{'addr:street': 'Naujoji gatvė', 'addr:housenumber': '3'}),
]
GROUP = lambda cls, rid, n_a, pc: 0 if cls < 50 else 2 if cls == pc else 3 if cls == 50 and rid <= n_a else 4 if cls == 50 else 1


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
        self.assertEqual(tables, {'p', 'cls', 'f', 'meta', 'a', 'pc'})
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
        self.assertEqual(res['gz_bytes'], res['gz_with_housenumbers'], 'B ships exactly the bytes the rule measured')
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
        pc = db.execute("SELECT id FROM cls WHERE tag='postcode=yes'").fetchone()[0]
        self.assertGreaterEqual(pc, 100)
        keys = [(GROUP(c, i, n_a, pc), -rank) for i, c, rank in rows]
        self.assertEqual(keys, sorted(keys), 'ids ascending must be importance descending within each group')
        self.assertEqual(rows[0][1], 1, 'the city comes first')
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Klaipėda'").fetchone()[0], 1, 'node + area = one row')
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Rusnė'").fetchone()[0], 2, 'two nodes never merge')
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Lietuvininkų degalinė'").fetchone()[0], 2)
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
        smallest_b = min(t[2] for t in self.build(1)[0]['tried'] if t[0])  # house numbers, postcodes dropped
        too_small_today = smallest_b * 19  # gz(B) = 5.26 % of today
        res, db = self.build(too_small_today)
        self.assertEqual(res['variant'], 'A')
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn('a', tables)
        meta = dict(db.execute('SELECT k, v FROM meta'))
        self.assertEqual((meta['has_housenumbers'], meta['addr_rows']), ('0', '0'))
        self.assertTrue(meta['decision'].startswith('A: '))
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Naujoji gatvė'").fetchone()[0], 0,
                         'address-only streets go with the house numbers')
        self.assertEqual(int(meta['rows']), res['rows'])
        # just under 5 % (meta timestamps move gz(B) by a few bytes between builds; the exact
        # boundary is test_keep_housenumbers_boundaries)
        res, _ = self.build(smallest_b * 20 + 400)
        self.assertEqual(res['variant'], 'B')

    def test_postcode_only_objects_are_not_pois(self):
        # osmium_lines streams two extracts. The POI one is exactly the pre-22fdec6 filter result (its
        # objects keep their POI rows, even tags the filter never asks for, e.g. a tagged node of a kept
        # way); the postcode one feeds ONLY the postcode rows: a school there is not a POI.
        school = pt(21.0, 55.0, name='Gymnasium', amenity='school', **{'addr:postcode': 'ZZ9 9ZZ'})
        cafe = pt(21.0, 55.0, name='Kavinė', amenity='cafe', **{'addr:postcode': 'ZZ9 9ZZ'})
        slip = pt(21.0, 55.0, name='Slip', leisure='slipway')  # referenced node of a kept way: stays a POI
        both = [si.ONLY_POI + json.dumps(cafe), si.ONLY_POI + json.dumps(slip),
                si.ONLY_POSTCODE + json.dumps(school), si.ONLY_POSTCODE + json.dumps(cafe)]
        with tempfile.TemporaryFile('w+') as af:
            _, pois, _, _, classes, pcs = si.parse(both, af)
        self.assertEqual({nm for _, nm, *_ in pois}, {'Kavinė', 'Slip'})
        self.assertEqual(len(pcs['ZZ99ZZ'][1]), 2, 'school + cafe each counted once; the POI copy of the cafe adds none')
        # no marker (--geojsonseq of one export): one object does both jobs
        with tempfile.TemporaryFile('w+') as af:
            _, pois, _, _, _, pcs = si.parse([json.dumps(cafe)], af)
        self.assertEqual(([nm for _, nm, *_ in pois], len(pcs['ZZ99ZZ'][1])), (['Kavinė'], 1))

    def test_postcode_rows(self):
        res, db = self.build(10 ** 9)
        pc = db.execute("SELECT id FROM cls WHERE tag='postcode=yes'").fetchone()[0]
        rows = db.execute('SELECT name, alt, lat, lon, parent, rank FROM p WHERE cls=? ORDER BY name', (pc,)).fetchall()
        # AB1 2CD written two ways = one row (most common form wins, the tie goes to the later name);
        # LT-99001 from two objects = one row; the ';' list splits; junk text is no code; boundary and
        # place=postcode objects count; the boundary is NOT also a POI.
        self.assertEqual([r[0] for r in rows], ['AB1 2CD', 'LT-99001', 'LT-99002', 'LT-99003', 'LT-99004'])
        self.assertEqual(rows[0][1], 'AB12CD')
        self.assertIsNone(rows[1][1], 'no space, no alt')
        self.assertEqual((rows[0][2], rows[0][3]), (5570000, 2100600), 'median of 3 points')
        self.assertTrue(all(r[4] is not None and r[5] == si.POSTCODE_RANK for r in rows))
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='LT-99003' AND cls<>?", (pc,)).fetchone()[0], 0)
        self.assertEqual(dict(db.execute('SELECT k, v FROM meta'))['postcode_rows'], '5')
        self.assertEqual(res['postcode_rows'], 5)
        q = 'SELECT p.name FROM f JOIN p ON p.id=f.rowid WHERE f MATCH ?'
        self.assertEqual(db.execute(q, ('"AB12CD"',)).fetchall(), [('AB1 2CD',)], 'found without the space')
        self.assertEqual(db.execute(q, ('"ab1" "2cd"',)).fetchall(), [('AB1 2CD',)])

    def test_postcodes_count_inside_the_budget(self):
        extra = [pt(21.3 + i / 1e4, 55.5, **{'addr:street': 'Naujoji gatvė', 'addr:housenumber': str(100 + i)})
                 for i in range(60)]  # make house numbers clearly the bigger part than 5 postcodes
        self.src.write_text('\n'.join(json.dumps(f) for f in FEATURES + extra) + '\n')
        # today = 1 B: nothing fits, every candidate is measured, the last one ships
        res, _ = self.build(1)
        sz = {t[:2]: t[2] for t in res['tried']}
        self.assertEqual(list(sz), [(True, True), (True, False), (False, True), (False, False)])
        self.assertTrue(sz[(True, True)] > sz[(True, False)] > sz[(False, True)] > sz[(False, False)], sz)
        self.assertEqual((res['variant'], res['postcode_rows']), ('A', 0))

        def at(lo, hi):  # a "today" whose 5 % lies between two measured sizes
            return int((sz[lo] + sz[hi]) / 2 / si.HOUSENUMBER_MAX_SHARE)

        def meta(db):
            return dict(db.execute('SELECT k, v FROM meta'))

        res, db = self.build(10 ** 9)  # everything fits: house numbers + postcodes
        self.assertEqual((res['variant'], res['postcode_rows'], res['addr_rows']), ('B', 5, 64))
        res, db = self.build(at((True, True), (True, False)))  # postcodes alone tip it: they go, house numbers stay
        self.assertEqual((res['variant'], res['postcode_rows'], res['addr_rows']), ('B', 0, 64))
        self.assertIn('postcodes dropped', meta(db)['decision'])
        self.assertEqual(meta(db)['postcode_rows'], '0')
        self.assertEqual(db.execute("SELECT count(*) FROM cls WHERE tag='postcode=yes'").fetchone()[0], 0)
        # ids stay consistent without the postcode rows: every a.street and parent resolves
        self.assertEqual(db.execute('SELECT count(*) FROM a LEFT JOIN p ON p.id=a.street WHERE p.id IS NULL').fetchone()[0], 0)
        self.assertEqual(db.execute('SELECT count(*) FROM p c JOIN p q ON q.id=c.parent WHERE q.cls>5').fetchone()[0], 0)
        res, db = self.build(at((True, False), (False, True)))  # house numbers do not fit; postcodes do
        self.assertEqual((res['variant'], res['postcode_rows'], res['addr_rows']), ('A', 5, 0))
        self.assertEqual(db.execute("SELECT count(*) FROM p WHERE name='Naujoji gatvė'").fetchone()[0], 0)
        res, db = self.build(at((False, True), (False, False)))  # not even postcodes fit
        self.assertEqual((res['variant'], res['postcode_rows']), ('A', 0))
        self.assertIn('postcodes dropped', meta(db)['decision'])

    def test_poi_cells(self):
        res, db = self.build(10 ** 9)
        meta = dict(db.execute('SELECT k, v FROM meta'))
        c = round(float(meta['poi_cell_deg']) * 1e5)
        # every POI row once, no place / street / postcode row; cell from the stored integers
        want = sorted(db.execute("SELECT cls, ((lat + 9000000) / ?) * 65536 + (lon + 18000000) / ?, id FROM p "
                                 "WHERE cls >= 100 AND cls != (SELECT id FROM cls WHERE tag = 'postcode=yes')", (c, c)))
        self.assertEqual(sorted(db.execute('SELECT cls, cell, id FROM pc')), want)
        self.assertEqual(len(want), 4)  # pass, cafe, two fuel stations
        # the Python reading of the same rule: Klaipėda's cafe at (55.71, 21.01)
        cafe = db.execute("SELECT p.id, pc.cell FROM p JOIN pc ON pc.id = p.id WHERE p.name = 'Kavinė'").fetchone()
        self.assertEqual(cafe[1], ((5571000 + 9000000) // c) * 65536 + (2101000 + 18000000) // c)
        # west of Greenwich and south of the equator: the integers stay positive, so / is floor
        self.assertEqual(((-3456789 + 9000000) // c, (-12345678 + 18000000) // c), (1108, 1130))
        # a range seek on (cls, cell) is what the app runs
        plan = ' '.join(r[3] for r in db.execute('EXPLAIN QUERY PLAN SELECT id FROM pc WHERE cls = 1 AND cell BETWEEN 2 AND 3'))
        self.assertIn('PRIMARY KEY (cls=? AND cell>? AND cell<?)', plan)

    def test_grid_nearest_looks_past_a_far_hit_in_the_first_ring(self):
        g = si.Grid(1.0)
        g.add(1.99, 0.5, 'ring1-far')   # neighbouring cell, 1.98 away
        g.add(-1.5, 0.5, 'ring2-near')  # two cells away, 1.51 away
        self.assertEqual(g.nearest(0.01, 0.5), 'ring2-near')

    def test_dedup_twin_found_across_longitude_buckets_far_north(self):
        seen = {}
        self.assertFalse(si.dup(seen, ('x', 1), 0.99, 60.0, 1.0, False))
        # 1.02 deg of longitude at 60 N is 0.51 deg "metric": inside the radius, two buckets east
        self.assertTrue(si.dup(seen, ('x', 1), 2.01, 60.0, 1.0, True))

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
            'n4 v1 dV c0 t i0 u Taddr:street=Miško%20%gatvė,addr:housenumber=5,addr:postcode=12345 x21.0015 y55.0',
            'n5 v1 dV c0 t i0 u T x21.003 y55.001',
            'n6 v1 dV c0 t i0 u T x21.004 y55.001',
            'n7 v1 dV c0 t i0 u T x21.004 y55.002',
            'w10 v1 dV c0 t i0 u Thighway=residential,name=Miško%20%gatvė Nn2,n3',
            # a closed building way: osmium exports it as a LineString AND an area; one row, one address
            'w11 v1 dV c0 t i0 u Tbuilding=yes,amenity=cafe,name=Kavinė,addr:street=Miško%20%gatvė,'
            'addr:housenumber=7 Nn5,n6,n7,n5',
            # a closed area=no way (race track): osmium exports only the line, which must survive
            'w12 v1 dV c0 t i0 u Tleisure=track,area=no,name=Trasa Nn5,n6,n7,n5',
            # a postal boundary: a postcode row, never a POI
            'w13 v1 dV c0 t i0 u Tboundary=postal_code,postal_code=54321,name=54321 Nn5,n6,n7,n5',
        ]) + '\n')
        pbf = self.dir / 'in.osm.pbf'
        subprocess.run(['osmium', 'cat', str(opl), '-o', str(pbf)], check=True)
        out = self.dir / 'pbfout'
        si.main(['--region', 'tiny', '--pbf', str(pbf), '--out', str(out), '--today-bytes', str(10 ** 9), '--keep-sqlite'])
        db = sqlite3.connect(out / 'tiny-search.sqlite')
        self.assertEqual(db.execute('SELECT name, cls FROM p ORDER BY id').fetchall(),
                         [('Ąžuolynė', 2), ('Kavinė', 101), ('Trasa', 100), ('12345', 102), ('54321', 102), ('Miško gatvė', 50)])
        self.assertEqual(db.execute('SELECT street, hn FROM a').fetchall(), [(6, '5'), (6, '7')])
        self.assertEqual(sorted(p.name for p in out.iterdir()), ['tiny-search.sqlite', 'tiny-search.sqlite.gz'])


if __name__ == '__main__':
    unittest.main()
