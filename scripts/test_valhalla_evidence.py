"""Host-only evidence admission regressions; no download, Docker or graph build."""
import importlib.util
import json
from pathlib import Path
import tempfile
import io
import tarfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('valhalla-evidence.py'))
e = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(e)

class EvidenceTests(unittest.TestCase):
    def test_highway_decode_keeps_original_and_cleans_only_owned_xml(self):
        xml=b'<osm><node id="1" lat="1" lon="2"/><node id="2" lat="1.1" lon="2.1"/><way id="3"><nd ref="1"/><nd ref="2"/><tag k="highway" v="service"/><tag k="access" v="private"/></way></osm>'
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);pbf=root/'region.osm.pbf';pbf.write_bytes(b'FULL ORIGINAL PBF')
            def command(argv,**kwargs):
                self.assertEqual(argv,['osmium','tags-filter',str(pbf),'w/highway','-f','osm'])
                kwargs['stdout'].write(xml)
            with patch.object(e.subprocess,'run',side_effect=command):
                result,receipt=e.decode_highway_topology(pbf,root)
            self.assertEqual(result['ways'][0]['tags'],{'highway':'service','access':'private'})
            self.assertEqual(pbf.read_bytes(),b'FULL ORIGINAL PBF')
            self.assertEqual(receipt['xml']['sha256'],e.digest(xml))
            self.assertFalse((root/'evidence-highways.osm').exists())
            def failed(argv,**kwargs):kwargs['stdout'].write(b'partial');raise RuntimeError('decoder failed')
            with patch.object(e.subprocess,'run',side_effect=failed):
                with self.assertRaises(RuntimeError):e.decode_highway_topology(pbf,root)
            self.assertFalse((root/'evidence-highways.osm').exists())
            with patch.object(e.subprocess,'run',side_effect=command),patch.object(e,'XML_LIMIT',32):
                with self.assertRaises(ValueError):e.decode_highway_topology(pbf,root)
            self.assertFalse((root/'evidence-highways.osm').exists())
            def changed(argv,**kwargs):kwargs['stdout'].write(xml);pbf.write_bytes(b'changed')
            with patch.object(e.subprocess,'run',side_effect=changed):
                with self.assertRaisesRegex(ValueError,'Original PBF changed'):e.decode_highway_topology(pbf,root)
            self.assertFalse((root/'evidence-highways.osm').exists())
            existing=root/'evidence-highways.osm';existing.write_bytes(b'not ours')
            with self.assertRaises(FileExistsError):e.decode_highway_topology(pbf,root)
            self.assertEqual(existing.read_bytes(),b'not ours')

    def options(self):
        return dict(evidence_only=True, regions='europe-andorra', upload=False, prune_old_smoke=False,
                    pbf_url='https://download.geofabrik.de/europe/andorra-260912.osm.pbf',
                    pbf_sha256='1'*64, poly_sha256='2'*64,
                    valhalla_ref='ghcr.io/valhalla/valhalla@sha256:'+'3'*64,
                    valhalla_core_revision='4'*40)
    def policy(self):
        o=self.options()
        return {'schemaVersion':1,'approvedBuilders':[{'image':o['valhalla_ref'], 'coreRevision':o['valhalla_core_revision'],
                'authorityUrl':'https://github.com/valhalla/valhalla/actions/runs/123', 'authoritySha256':'5'*64}]}
    def test_admit_exact_reviewed_pins(self):
        self.assertEqual(e.admit(self.options(), self.policy())['coreRevision'], '4'*40)
    def test_unreviewed_builder_blocks_before_io(self):
        with self.assertRaisesRegex(ValueError,'builder authority'): e.admit(self.options(), {'schemaVersion':1,'approvedBuilders':[]})
    def test_publication_and_wrong_scope_rejected(self):
        for key,value in [('upload',True),('prune_old_smoke',True),('regions','andorra'),('regions','europe-andorra,europe-france'),('evidence_only','true')]:
            o=self.options();o[key]=value
            with self.assertRaises(ValueError,msg=key):e.admit(o,self.policy())
    def test_url_and_source_mismatches_rejected(self):
        for key,value in [('pbf_url','https://download.geofabrik.de/europe/andorra-latest.osm.pbf'),('pbf_url','https://evil.example/andorra-260912.osm.pbf'),('pbf_sha256','bad'),('poly_sha256',''),('valhalla_ref','ghcr.io/valhalla/valhalla:latest'),('valhalla_core_revision','6'*40)]:
            o=self.options();o[key]=value
            with self.assertRaises(ValueError,msg=key):e.admit(o,self.policy())
    def test_empty_or_duplicate_authority_rejected(self):
        for value in ['', 'not-url']:
            p=self.policy();p['approvedBuilders'][0]['authorityUrl']=value
            with self.assertRaises(ValueError):e.admit(self.options(),p)
        p=self.policy();p['approvedBuilders']*=2
        with self.assertRaises(ValueError):e.admit(self.options(),p)
    def test_topology_keeps_short_service_way_and_order(self):
        xml=b'<osm><node id="1" lat="42.5" lon="1.5" version="2"/><node id="2" lat="42.50001" lon="1.5"/><way id="9" version="3"><nd ref="2"/><nd ref="1"/><tag k="highway" v="service"/><tag k="access" v="private"/></way></osm>'
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input.osm';p.write_bytes(xml);t=e.topology(p)
        self.assertEqual(t['ways'][0]['nodes'],['2','1'])
        self.assertEqual(t['ways'][0]['coordinates'],[[42.50001,1.5],[42.5,1.5]])
        self.assertEqual(t['ways'][0]['tags']['access'],'private')
        self.assertEqual(t['ways'][0]['version'],'3')
    def test_missing_node_and_duplicate_id_fail(self):
        cases=[b'<osm><way id="9"><nd ref="1"/><nd ref="2"/><tag k="highway" v="service"/></way></osm>', b'<osm><node id="1" lat="42" lon="1"/><node id="1" lat="43" lon="1"/></osm>']
        for xml in cases:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'input.osm';p.write_bytes(xml)
                with self.assertRaises(ValueError):e.topology(p)
    def test_file_hash_size_and_symlink_fail(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'data';p.write_bytes(b'abcd')
            with self.assertRaises(ValueError):e.checked_file(p,3)
            link=Path(d)/'link';link.symlink_to(p)
            with self.assertRaises(ValueError):e.checked_file(link,10)
    def test_topology_rejects_invalid_coordinates_and_entity_declaration(self):
        for xml in [b'<osm><node id="1" lat="NaN" lon="1"/></osm>',b'<!DOCTYPE osm [<!ENTITY x "y">]><osm/>']:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'input.osm';p.write_bytes(xml)
                with self.assertRaises(ValueError):e.topology(p)
    def test_graph_inventory_binds_exact_entries_and_rejects_traversal(self):
        for bad in [False,True]:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'graph.tar.gz'
                with tarfile.open(p,'w:gz') as archive:
                    for name,data in [('index.bin',b'index'),('../outside' if bad else '2/1.gph',b'graph')]:
                        member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
                if bad:
                    with self.assertRaises(ValueError):e.graph_inventory(p)
                else:self.assertEqual(e.graph_inventory(p)['2/1.gph']['sha256'],e.digest(b'graph'))
    def test_every_graph_member_including_directories_is_admitted(self):
        for names in [['../outside/'], ['same/','same/'], [str(i)+'/' for i in range(8193)]]:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d)/'graph.tar.gz'
                with tarfile.open(p,'w:gz') as archive:
                    for name in names:
                        member=tarfile.TarInfo(name);member.type=tarfile.DIRTYPE;archive.addfile(member)
                    for name in ['index.bin','2/1.gph']:
                        member=tarfile.TarInfo(name);member.size=4;archive.addfile(member,io.BytesIO(b'test'))
                with self.assertRaises(ValueError):e.graph_inventory(p)
    def test_oversized_private_metadata_is_never_published(self):
        with tempfile.TemporaryDirectory() as d:
            private=Path(d)/'private';(private/'metadata').mkdir(parents=True);(private/'source').mkdir()
            (private/'metadata/too-large.json').write_bytes(b'x'*20)
            with patch.object(e,'BUNDLE_LIMIT',10):
                with self.assertRaises(ValueError):e.publish_evidence(private,Path(d)/'evidence')
            self.assertFalse((Path(d)/'evidence').exists())
    def test_failure_exposes_only_small_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            private=Path(d)/'evidence-private';private.mkdir();(private/'large').write_bytes(b'x'*10000)
            e.failure_receipt(Path(d),ValueError('x'*10000))
            files=list((Path(d)/'evidence').rglob('*'));regular=[f for f in files if f.is_file()]
            self.assertEqual([f.name for f in regular],['failure.json']);self.assertLess(regular[0].stat().st_size,4096)
            self.assertEqual((private/'large').stat().st_size,10000)
    def test_prepare_rejected_authority_creates_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,'builder authority'):e.prepare(Path(d),self.options())
            self.assertEqual(list(Path(d).iterdir()),[])
    def test_fetch_rejects_bad_hash_and_oversize_without_publishing_file(self):
        class Response(io.BytesIO):
            headers={'Content-Length':'4'}
        class Opener:
            def open(self,*args,**kwargs):return Response(b'abcd')
        with tempfile.TemporaryDirectory() as d, patch.object(e.urllib.request,'build_opener',return_value=Opener()):
            p=Path(d)/'out'
            for expected,limit in [('0'*64,10),(e.digest(b'abcd'),3)]:
                with self.assertRaises(ValueError):e.fetch('https://unused',p,expected,limit)
                self.assertFalse(p.exists())
            self.assertEqual(e.fetch('https://unused',p,e.digest(b'abcd'),10)['bytes'],4)
    def test_finish_binds_source_graph_and_leaves_runtime_unproven(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);metadata=root/'evidence-private/metadata';source=root/'evidence-private/source';work=root/'work'
            for folder in [metadata,source,work]:folder.mkdir(parents=True)
            policy=root/'policy.json';policy.write_text(json.dumps(self.policy()))
            for name in ['region.osm.pbf','region.poly']:(source/name).write_bytes(b'source')
            options=self.options();options['pbf_sha256']=e.digest(b'source');options['poly_sha256']=e.digest(b'source')
            receipt={'options':options,'builderAuthority':self.policy()['approvedBuilders'][0],
                     'pbf':{'sha256':e.digest(b'source')},'polygon':{'sha256':e.digest(b'source')},'files':{}}
            (metadata/'source.json').write_text(json.dumps(receipt))
            graph=root/'europe-andorra-valhalla.tar.gz'
            with tarfile.open(graph,'w:gz') as archive:
                for name in ['index.bin','2/1.gph']:
                    member=tarfile.TarInfo(name);member.size=4;archive.addfile(member,io.BytesIO(b'test'))
            report={'image':self.options()['valhalla_ref'],'sha256':e.checked_file(graph,e.GRAPH_LIMIT)['sha256']}
            (root/'valhalla-report-europe-andorra.json').write_text(json.dumps(report))
            for name in ['valhalla.json','valhalla-c1.json','valhalla-verify.json','valhalla-extract.json','admins.sqlite','tz_world.sqlite']:(work/name).write_bytes(b'test')
            (root/'europe-andorra-corridors.json').write_bytes(b'[]')
            with patch.object(e,'POLICY',policy):e.finish(root)
            final=json.loads((root/'evidence/metadata/receipt.json').read_text())
            self.assertFalse(final['nativeRuntimeProven']);self.assertEqual(final['installedGraphBoundary'],'UNRESOLVED')
            self.assertIn('source/region.poly',final['files'])
    def test_pax_metadata_counts_toward_expanded_archive_cap(self):
        with tempfile.TemporaryDirectory() as d:
            graph=Path(d)/'graph.gz'
            with tarfile.open(graph,'w:gz') as archive:
                for name in ['index.bin','2/1.gph']:
                    member=tarfile.TarInfo(name);member.size=1;member.pax_headers={'comment':'x'*40000}
                    archive.addfile(member,io.BytesIO(b'x'))
            with patch.object(e,'BUNDLE_LIMIT',32768):
                with self.assertRaises(ValueError):e.graph_inventory(graph)

    def test_graph_bundle_fails_before_output_on_missing_inputs(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises((ValueError,FileNotFoundError)):e.finish(Path(d))
            self.assertFalse((Path(d)/'evidence/metadata/receipt.json').exists())

if __name__=='__main__': unittest.main()
