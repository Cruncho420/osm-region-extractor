"""Host-only tests for driving-side-repair.py: no Docker, no downloads."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('repair', Path(__file__).with_name('driving-side-repair.py'))
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)

TABLE = {'_comment': 'x',
         'great-britain': {'iso': 'GB', 'name': 'United Kingdom', 'driveOnRight': False},
         'ireland-and-northern-ireland': {'iso': 'IE', 'name': 'Ireland', 'driveOnRight': False},
         'france': {'iso': 'FR', 'name': 'France', 'driveOnRight': True},
         'china/hong-kong': {'iso': 'HK', 'name': 'Hong Kong', 'driveOnRight': False},
         'china': {'iso': 'CN', 'name': 'China', 'driveOnRight': True}}


def square(x, y, size=1):
    return {'type': 'Polygon', 'coordinates': [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]}


class RepairTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        path = Path(self.dir.name) / 'table.json'
        path.write_text(json.dumps(TABLE))
        self.table = r.load_table(path)

    def tearDown(self):
        self.dir.cleanup()

    def test_missing_own_country_gets_its_real_outline_not_a_box(self):
        ne = {'HK': square(114, 22, 0.5), 'CN': square(100, 20, 20)}
        sql, added = r.plan([], self.table, ne, (113.8, 22.1, 114.5, 22.6), ['HK'])
        self.assertEqual(added, ['CN', 'HK'])  # the neighbour in the extract's buffer gets ITS side too
        hk = next(s for s in sql if "'HK'" in s)
        self.assertIn("'Hong Kong', 'Hong Kong', 0,", hk)
        self.assertIn('ST_Buffer(GeomFromText(\'MULTIPOLYGON(((114.000000 22.000000', hk)
        self.assertIn("'China', 'China', 1,", next(s for s in sql if "'CN'" in s))

    def test_existing_rows_are_left_alone_and_far_countries_skipped(self):
        ne = {'GB': square(-8, 50, 10), 'FR': square(-5, 42, 13), 'IE': square(-11, 51, 5)}
        sql, added = r.plan([('GB', 0)], self.table, ne, (-9, 49, 2, 61), ['GB'])
        self.assertEqual(added, ['FR', 'IE'])
        sql, added = r.plan([('GB', 0)], self.table, {'FR': square(40, 40)}, (-9, 49, 2, 61), ['GB'])
        self.assertEqual(added, [])

    def test_a_required_country_without_any_outline_fails(self):
        with self.assertRaisesRegex(ValueError, "no row and no Natural Earth outline for \\['GB'\\]"):
            r.plan([], self.table, {}, (-9, 49, 2, 61), ['GB'])

    def test_check_corrects_wrong_sides_and_refuses_unknown_countries(self):
        fixes, unknown, anonymous = r.check([('GB', 1), ('FR', 1), ('ZZ', 1), (None, 0)], self.table)
        self.assertEqual(fixes, ["UPDATE admins SET drive_on_right=0 WHERE admin_level=2 AND iso_code='GB';"])
        self.assertEqual(unknown, ['ZZ'])
        self.assertEqual(anonymous, 1)

    def test_parse_rows_and_multipolygon_wkt(self):
        self.assertEqual(r.parse_rows('GB|0\n|1\n'), [('GB', 0), (None, 1)])
        multi = {'type': 'MultiPolygon', 'coordinates': [square(0, 0)['coordinates'], square(2, 2)['coordinates']]}
        self.assertTrue(r.geometry_wkt(multi).startswith('MULTIPOLYGON(((0.000000 0.000000'))
        self.assertEqual(r.geometry_wkt(multi).count('((('), 1)

    def test_real_table_has_one_side_per_iso(self):
        table = r.load_table(Path(__file__).with_name('country-driving-side.json'))
        self.assertFalse(table['GB'][1])
        self.assertTrue(table['FR'][1])



class PartBoxTests(unittest.TestCase):
    def test_a_country_spanning_the_globe_is_matched_by_its_parts_not_its_overall_box(self):
        us = {'type': 'MultiPolygon', 'coordinates': [square(-125, 25, 50)['coordinates'], square(172, 51, 7)['coordinates'],
                                                      square(-180, 51, 10)['coordinates']]}
        table = {'US': ('United States', True)}
        sql, added = r.plan([], table, {'US': us}, (19.9, 52.9, 27.8, 57.5), [])
        self.assertEqual(added, [])


if __name__ == '__main__':
    unittest.main()
