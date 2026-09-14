import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
SPEC=importlib.util.spec_from_file_location('source',Path(__file__).with_name('valhalla-source-builder.py'))
s=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(s)
class SourceBuilderTests(unittest.TestCase):
    def test_no_oci_allowlist_dependency_or_pretended_image_authority(self):
        authority=s.source_authority({'sha256':'1'*64},{'workflowRevision':'2'*40,'runId':'123'})
        self.assertEqual(authority['model'],'same-run-clean-source')
        self.assertNotIn('image',authority)
        self.assertEqual(authority['buildReceiptSha256'],'1'*64)
    def test_exact_submodule_set_and_revisions_required(self):
        expected={'third_party/a':'1'*40}
        self.assertEqual(s.parse_submodules(' '+'1'*40+' third_party/a (v1)\n',expected),expected)
        for raw in ['', '+'+'1'*40+' third_party/a\n',' '+'2'*40+' third_party/a\n',' '+'1'*40+' third_party/a\n '+'1'*40+' third_party/a\n']:
            with self.assertRaises(ValueError):s.parse_submodules(raw,expected)
    def test_workflow_identity_required(self):
        for env in [{},{'GITHUB_SHA':'x','GITHUB_RUN_ID':'123'},{'GITHUB_SHA':'1'*40,'GITHUB_RUN_ID':'../x'}]:
            with self.assertRaises(ValueError):s.workflow_identity(env)
    def test_tool_not_in_fresh_output_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);outside=root/'installed';outside.write_bytes(b'fake');build=root/'build';build.mkdir();(build/'valhalla_build_tiles').symlink_to(outside)
            with self.assertRaises(ValueError):s.tool_hashes(build)
    def test_dirty_or_wrong_core_rejected_before_build(self):
        pins={'coreRevision':'1'*40,'submodules':{}}
        for outputs in [['2'*40],['1'*40,' M changed']]:
            with patch.object(s,'git',side_effect=outputs):
                with self.assertRaises(ValueError):s.verify_source(Path('/unused'),pins)
    def test_source_authority_rejects_unbound_receipt(self):
        with self.assertRaises(ValueError):s.source_authority({}, {'workflowRevision':'2'*40,'runId':'123'})

    def test_generated_tz_contract_rejects_extra_or_stale_files(self):
        with tempfile.TemporaryDirectory() as d:
            core=Path(d);tz=core/'third_party/tz';tz.mkdir(parents=True)
            with patch.object(s,'git',return_value=''):
                self.assertEqual(s.generated_tz(core,False),{})
            for raw,complete in [('leapseconds\n',False),('',True),('leapseconds\nleapseconds.out\n',True),('unexpected\n',True)]:
                with patch.object(s,'git',return_value=raw):
                    with self.assertRaises(ValueError):s.generated_tz(core,complete)
            (tz/'leapseconds').write_text('generated leap seconds')
            with patch.object(s,'git',return_value='leapseconds\n'):
                self.assertIn('sha256',s.generated_tz(core,True)['leapseconds'])

    def route(self):
        # Polyline6 [(0,0),(0.001,0.001)] supplies geometry, never road labels.
        return {'trip':{'status':0,'summary':{'length':0.157,'time':20},
                        'legs':[{'shape':'??o}@o}@','summary':{'length':0.157,'time':20}}]}}
    def test_geometry_decoder_rejects_overflow_and_out_of_bounds(self):
        def encode(value):
            value=value<<1 if value>=0 else ~(value<<1);result=''
            while value>=32:result+=chr(((value&31)|32)+63);value>>=5
            return result+chr(value+63)
        for shape in ['_'*9, '???', chr(127), encode(91000000)+'?'+encode(1)+'?']:
            with self.subTest(shape=shape):
                with self.assertRaises(ValueError):s.decode_shape(shape)
        self.assertEqual(s.decode_shape('??o}@o}@'),[(0,0),(0.001,0.001)])

    def test_sanity_requires_actual_parsed_route(self):
        route=self.route()
        self.assertEqual(s.parse_sanity('noise\n'+json.dumps(route)+'\n'),route)
        bad=[{'trip':{'legs':'yes'}},{'trip':{'legs':[{}]}},{'error':'No route'},
             {'trip':{'status':1,'legs':[{}]}}]
        for mutation in [lambda r:r['trip'].update(status=True),lambda r:r['trip'].update(status=1),
                         lambda r:r.update(error='No route'),lambda r:r['trip'].update(legs=[]),
                         lambda r:r['trip'].update(legs='yes'),lambda r:r['trip']['summary'].update(time=float('nan')),
                         lambda r:r['trip']['summary'].update(length=0),lambda r:r['trip']['legs'][0].update(shape=''),
                         lambda r:r['trip']['legs'][0].update(shape='??'),lambda r:r['trip']['legs'][0].update(shape='????'),
                         lambda r:r['trip']['legs'][0].update(shape='~~'),lambda r:r['trip']['legs'][0].update(shape='!'),
                         lambda r:r['trip']['legs'][0]['summary'].update(time=float('inf'))]:
            r=self.route();mutation(r);bad.append(r)
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):s.parse_sanity(json.dumps(value))
        with self.assertRaises(ValueError):s.parse_sanity('Found route')
if __name__=='__main__':unittest.main()
