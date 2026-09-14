import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('census',Path(__file__).with_name('valhalla-edge-census.py'));c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class CensusTests(unittest.TestCase):
    def rows(self):
        tile=10;a=10;b=10+(1<<25)
        nodes=[dict(kind='node',tile=tile,index=i,id=n,access=4095,type=0,coordinate=[42+i/1000,1],edgeIndex=i,edgeCount=1,transitions=[]) for i,n in enumerate([a,b])]
        edges=[dict(kind='edge',tile=tile,index=i,id=n,startNode=n,endNode=other,endTilePresent=True,opposingEdge=other,wayId=123,forwardAccess=1,reverseAccess=4095,use=0,roadClass=0,shortcut=False,forward=(i==0),lengthMeters=100,restrictions=0,accessRestrictionMask=0,startRestrictionMask=0,endRestrictionMask=0,complexRestriction=False,accessRestrictions=[],shape=[[42,1],[42.001,1]]) for i,(n,other) in enumerate([(a,b),(b,a)])]
        return [dict(kind='tile',tile=tile,level=2,nodes=2,edges=2),*nodes,*edges,dict(kind='complete',tiles=1,nodes=2,edges=2)]
    def validate(self,rows):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'census.jsonl';p.write_text(''.join(json.dumps(r)+'\n' for r in rows));return c.validate_census(p,{10:{'nodes':2,'edges':2}})
    def test_complete_all_modes_and_directions(self):
        self.assertEqual(self.validate(self.rows()),dict(tiles=1,nodes=2,edges=2))
    def test_missing_edge_not_hidden_by_footer(self):
        r=self.rows();del r[3]
        with self.assertRaises(ValueError):self.validate(r)
    def test_duplicate_edge(self):
        r=self.rows();r.insert(4,copy.deepcopy(r[3]))
        with self.assertRaises(ValueError):self.validate(r)
    def test_rejects_invalid_fields(self):
        for index,key,value in [(1,'coordinate',[100,0]),(1,'edgeCount',1000000000),(1,'access',-1),(1,'transitions',[{'endNode':10,'up':'true'}]),(3,'endTilePresent',False),(3,'id',11),(3,'lengthMeters',-1),(3,'opposingEdge',True),(3,'accessRestrictions',[{'type':0,'modes':99999,'value':1,'exceptDestination':False}]),(3,'shape',[[42,1],[float('nan'),1]])]:
            with self.subTest(key=key):
                r=self.rows();r[index][key]=value
                with self.assertRaises(ValueError):self.validate(r)
    def test_missing_tile_and_false_header(self):
        for mutation in ['tile','header','footer','after']:
            r=self.rows()
            if mutation=='tile':r.pop(0)
            if mutation=='header':r[0]['edges']=1
            if mutation=='footer':r.pop()
            if mutation=='after':r.append(r[1])
            with self.assertRaises(ValueError):self.validate(r)
    def test_opposing_and_ownership_completeness(self):
        for index,key,value in [(3,'opposingEdge',999),(2,'edgeIndex',0),(4,'startNode',10),(3,'endNode',999)]:
            r=self.rows();r[index][key]=value
            with self.assertRaises(ValueError):self.validate(r)

    def test_invalid_graph_digest_rejected_before_decode(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'graph.tar.gz';p.write_bytes(b'not the authenticated graph')
            with self.assertRaisesRegex(ValueError,'digest'):c.expected_headers(p)
    def test_record_size_bound(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'census.jsonl';p.write_text('x'*(4*1024*1024+1))
            with self.assertRaisesRegex(ValueError,'limit_bytes'):c.validate_census(p,{10:{'nodes':2,'edges':2}})
    def test_missing_endpoint_tile_retained_without_boundary_claim(self):
        r=self.rows();r[3]['endNode']=11;r[3]['endTilePresent']=False;r[3]['opposingEdge']=None;r[4]['opposingEdge']=None
        self.assertEqual(self.validate(r)['edges'],2)
    def test_failed_private_capture_never_published(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);private=root/'census-private';private.mkdir();(private/'directed-edges.jsonl').write_text('incomplete')
            c.e.failure_receipt(root,ValueError('bounded failure'))
            self.assertEqual([p.name for p in (root/'evidence/metadata').iterdir()],['failure.json'])
            self.assertLess((root/'evidence/metadata/failure.json').stat().st_size,2048)
