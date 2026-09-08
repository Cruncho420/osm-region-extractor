"""PURPOSE: Test partition safety and polygon decisions without native dependencies.
RESPONSIBILITY: Real .poly parsing and binary hardlinks; rectangle geometry fakes.
DEPENDENCIES: Python standard library only.
CONSUMERS: unittest discovery; these tests do not certify Shapely/native execution.
"""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("partition", Path(__file__).with_name("partition-valhalla-connected.py"))
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)


def rectangle(x1, y1, x2, y2):
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)]


def poly_text(rings):
    result = ["fixture"]
    for label, points in rings:
        result += [label] + [f"{x} {y}" for x, y in points] + ["END"]
    return "\n".join(result + ["END"])


class Rectangles:
    """Exact rectangle operations for bounded fake geometry tests, not Shapely."""
    def __init__(self, points=None, hole_rings=None, shells=None, holes=None):
        if points:
            xs, ys = zip(*points)
            shells = [(min(xs), min(ys), max(xs), max(ys))]
        if hole_rings:
            holes = [(min(x for x, _ in ring), min(y for _, y in ring),
                      max(x for x, _ in ring), max(y for _, y in ring)) for ring in hole_rings]
        self.shells, self.holes = shells or [], holes or []
        self.is_empty = not self.shells
        self.is_valid = all(a < c and b < d for a, b, c, d in self.shells)

    @staticmethod
    def inside(a, b):
        return a[0] < b[0] and a[1] < b[1] and a[2] > b[2] and a[3] > b[3]

    def contains(self, other):
        return all(any(self.inside(a, b) for a in self.shells) for b in other.shells)

    def difference(self, other):
        return Rectangles(shells=self.shells, holes=other.shells)

    def intersects(self, other):
        b = other.shells[0]
        overlap = any(a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]
                      for a in self.shells)
        return overlap and not any(self.inside(hole, b) for hole in self.holes)


class GraphId:
    def __init__(self, tile, level, index):
        self.tile, self._level = tile, level

    def is_valid(self):
        return self.tile >= 0

    def level(self):
        return self._level

    def __fspath__(self):
        return f"{self._level}/000/{self.tile:03}.gph"


ORIGINS = {1: (0.5, 0.5), 2: (2.5, 0.5), 3: (1.5, 0.5), 4: (9, 9)}
BINDINGS = {"graph_id": GraphId, "base": lambda gid: ORIGINS[gid.tile],
            "polygon": Rectangles,
            "union": lambda polys: Rectangles(shells=[shell for p in polys for shell in p.shells],
                                               holes=[hole for p in polys for hole in p.holes]),
            "box": lambda *bounds: Rectangles(shells=[bounds])}


class PartitionTests(unittest.TestCase):
    def test_real_shapely_preserves_outer_island_inside_hole(self):
        try:
            from shapely.geometry import Polygon, Point, box
            from shapely.ops import unary_union
        except ImportError:
            self.skipTest("Real Shapely unavailable; install runtime image dependency for topology regression")
        rings = proof.parse_poly(poly_text([("main", rectangle(0, 0, 10, 10)),
                                          ("!hole", rectangle(2, 2, 8, 8)),
                                          ("island", rectangle(4, 4, 6, 6))]))
        geometry = proof.polygon_geometry(rings, Polygon, unary_union)
        self.assertTrue(geometry.is_valid)
        self.assertEqual(geometry.area, 68)
        self.assertTrue(geometry.contains(Point(5, 5)))
        self.assertFalse(geometry.intersects(box(3, 3, 3.25, 3.25)))
        self.assertTrue(geometry.intersects(box(4.5, 4.5, 4.75, 4.75)))

    def test_poly_multiple_outer_rings_and_hole_are_preserved(self):
        text = poly_text([("1", rectangle(0, 0, 4, 4)), ("!1", rectangle(1, 1, 3, 3)),
                          ("2", rectangle(6, 0, 8, 2))])
        rings = proof.parse_poly(text)
        self.assertEqual([hole for hole, _ in rings], [False, True, False])
        geometry = proof.polygon_geometry(rings, Rectangles, BINDINGS["union"])
        self.assertFalse(geometry.intersects(Rectangles(shells=[(1.5, 1.5, 1.75, 1.75)])))
        self.assertTrue(geometry.intersects(Rectangles(shells=[(6.5, 0.5, 6.75, 0.75)])))

    def test_outside_hole_and_invalid_polygon_refused(self):
        for rings in ([(False, rectangle(0, 0, 1, 1)), (True, rectangle(2, 2, 3, 3))],
                      [(False, [(0, 0), (1, 0), (2, 0), (0, 0)])]):
            with self.assertRaises(ValueError):
                proof.polygon_geometry(rings, Rectangles, BINDINGS["union"])

    def test_malformed_poly_refused(self):
        good = poly_text([("1", rectangle(0, 0, 1, 1))])
        for text in (good + "\nextra", good.rsplit("END", 1)[0],
                     good.replace("0 0", "nan 0", 1), "name\n!1\n0 0\n1 0\n1 1\nEND\nEND"):
            with self.assertRaises(ValueError):
                proof.parse_poly(text)

    def test_classifies_exclusive_overlap_leftovers_and_coarse_tiles(self):
        first, second = Rectangles(rectangle(0, 0, 2, 2)), Rectangles(rectangle(1, 0, 3, 2))
        tiles = [(os.fspath(GraphId(i, 2, 0)), GraphId(i, 2, 0)) for i in range(1, 5)]
        tiles.append((os.fspath(GraphId(99, 0, 0)), GraphId(99, 0, 0)))
        groups = proof.classify(tiles, first, second, BINDINGS["base"], BINDINGS["box"])
        self.assertEqual(groups["firstOnly"], ["2/000/001.gph"])
        self.assertEqual(groups["secondOnly"], ["2/000/002.gph"])
        self.assertEqual(groups["leftovers"], ["2/000/004.gph"])
        self.assertEqual(len(groups["shared"]), 3)

    def test_boundary_touch_shared_and_no_exclusive_refused(self):
        first, second = Rectangles(rectangle(0, 0, 1, 2)), Rectangles(rectangle(1, 0, 2, 2))
        tile = BINDINGS["box"](0.75, 0.5, 1, 0.75)
        self.assertTrue(first.intersects(tile) and second.intersects(tile))
        with self.assertRaisesRegex(ValueError, "exclusive"):
            proof.classify([("2/000/001.gph", GraphId(1, 2, 0))], first, first,
                           BINDINGS["base"], BINDINGS["box"])

    def fixture(self, directory):
        base = Path(directory).resolve()
        source = base / "source"
        for i in range(1, 5):
            tile = source / f"2/000/{i:03}.gph"
            tile.parent.mkdir(parents=True, exist_ok=True)
            tile.write_bytes(bytes([i, 0, 255]))
        polygons = [base / "first.poly", base / "second.poly"]
        polygons[0].write_text(poly_text([("1", rectangle(0, 0, 2, 2))]))
        polygons[1].write_text(poly_text([("1", rectangle(1, 0, 3, 2))]))
        return source, *polygons, base / "first", base / "second"

    def test_actual_binary_files_are_unchanged_hardlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source, poly1, poly2, first, second = self.fixture(directory)
            result = proof.partition(source, poly1, poly2, first, second, BINDINGS)
            self.assertEqual(result["counts"], {"firstOnly": 1, "secondOnly": 1, "shared": 2, "leftovers": 1})
            for output in (first, second):
                for member in output.rglob("*.gph"):
                    original = source / member.relative_to(output)
                    self.assertTrue(os.path.samefile(original, member))
                    self.assertEqual(member.read_bytes(), original.read_bytes())
            with self.assertRaisesRegex(ValueError, "already exists"):
                proof.partition(source, poly1, poly2, first, second, BINDINGS)

    def test_symlink_and_noncanonical_source_refused_before_outputs(self):
        for bad in ("symlink", "path"):
            with tempfile.TemporaryDirectory() as directory:
                source, poly1, poly2, first, second = self.fixture(directory)
                member = source / ("2/000/009.gph" if bad == "symlink" else "2/9.gph")
                if bad == "symlink":
                    member.symlink_to(poly1)
                else:
                    member.write_bytes(b"bad")
                with self.assertRaises(ValueError):
                    proof.partition(source, poly1, poly2, first, second, BINDINGS)
                self.assertFalse(first.exists() or second.exists())

    def test_output_inside_source_and_traversal_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            source, poly1, poly2, first, second = self.fixture(directory)
            with self.assertRaisesRegex(ValueError, "overlap"):
                proof.partition(source, poly1, poly2, source / "output", second, BINDINGS)
            with self.assertRaisesRegex(ValueError, "traversal"):
                proof.safe_path(str(source) + "/../source", directory=True)


if __name__ == "__main__":
    unittest.main()
