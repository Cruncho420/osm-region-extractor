"""PURPOSE: Keep exact geometry proof mandatory while searching other native candidates.
RESPONSIBILITY: Reproduce run 34352602373's typed shape rejection and bounded continuation.
DEPENDENCIES: stdlib fake actor; no claim of native route success.
CONSUMERS: Producer proof unit test gate.
"""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('selector', Path(__file__).with_name('select-valhalla-crossing.py'))
selector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selector)
proof = selector.proof
PATHS = ['2/000/001.gph', '2/000/002.gph', '0/000/003.gph']
GROUPS = dict(zip(('firstOnly', 'secondOnly', 'shared'), ({p} for p in PATHS)))
POINTS = [{'lat': 1, 'lon': n, 'search_cutoff': 100} for n in (1, 2, 3)]


class GraphId:
    def __init__(self, value):
        self.value = value

    def tile_base(self):
        return self

    def __fspath__(self):
        return PATHS[self.value]


class Actor:
    def __init__(self, shapes):
        self.shapes = iter(shapes)
        self.calls = 0

    def route(self, request):
        self.calls += 1
        return {'trip': {'status': 0, 'legs': [{'shape': 'exact', 'summary': {'length': 12, 'time': 30}}]}}

    def trace_attributes(self, request):
        assert request['shape_match'] == 'edge_walk'
        return {'shape': next(self.shapes), 'edges': [{'id': n} for n in range(3)]}


class ShapeCandidateTests(unittest.TestCase):
    def test_exact_snapshot_still_rejects_native_shape_change(self):
        with self.assertRaises(proof.CrossingShapeMismatch):
            proof.snapshot(Actor(['changed']), {'locations': POINTS[:2]}, GraphId)

    def test_selector_continues_only_after_typed_shape_rejection(self):
        actor = Actor(['changed', 'exact'])
        reports = []
        result = selector.choose_route(actor, POINTS[:1], POINTS[1:], GROUPS, GraphId, 2,
                                       lambda **counts: reports.append(counts))
        self.assertEqual(actor.calls, 2)
        self.assertEqual(result['pairsAttempted'], 2)
        self.assertEqual(result['rejectedShapePairs'], 1)
        self.assertEqual(result['request']['locations'], [POINTS[0], POINTS[2]])
        self.assertEqual(result['routeEvidence']['legs'][0]['shape'], 'exact')
        self.assertEqual(result['usedOwnership'], {k: sorted(v) for k, v in GROUPS.items()})
        self.assertIn({'rejectedShapePairs': 1}, reports)

    def test_all_mismatches_exhaust_without_any_acceptance(self):
        actor = Actor(['changed', 'changed'])
        with self.assertRaisesRegex(ValueError, 'exhausted'):
            selector.choose_route(actor, POINTS[:1], POINTS[1:], GROUPS, GraphId, 2)
        self.assertEqual(actor.calls, 2)

    def test_pair_bound_remains_effective_after_mismatch(self):
        actor = Actor(['changed', 'exact'])
        with self.assertRaisesRegex(ValueError, 'exhausted'):
            selector.choose_route(actor, POINTS[:1], POINTS[1:], GROUPS, GraphId, 1)
        self.assertEqual(actor.calls, 1)

    def test_missing_or_invalid_trace_shape_is_not_a_skippable_candidate(self):
        for shape in (None, '', 123):
            actor = Actor([shape, 'exact'])
            with self.assertRaisesRegex(ValueError, 'Missing edge-walk shape'):
                selector.choose_route(actor, POINTS[:1], POINTS[1:], GROUPS, GraphId, 2)
            self.assertEqual(actor.calls, 1)

    def test_final_equivalence_checker_still_fails_on_a_shape_mismatch(self):
        with self.assertRaises(proof.CrossingShapeMismatch):
            proof.positive({'unsplit': {}, 'union': {}}, {'locations': POINTS[:2]}, GROUPS,
                           lambda config: Actor(['changed']), GraphId)
