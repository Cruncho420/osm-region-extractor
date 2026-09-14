#!/usr/bin/env python3
"""Pinned graph data census orchestration; never invokes actors or matchers."""
import argparse,gzip,hashlib,importlib.util,json,math,os,shutil,struct,subprocess,tarfile,zipfile
from pathlib import Path
HERE=Path(__file__).parent
spec=importlib.util.spec_from_file_location('source',HERE/'valhalla-source-builder.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s);e=s.e
GRAPH_SHA='d69510b46c5d1d2663ea0ac095039b80406ad51edb26db016401e7b80aa18c6c'
ZIP_SHA='4f15fea95e686b0924fc4e14a113f09101ea3ef562ee34682b6da34c771af6ea'
SOURCE_SHA='8d7a40f450e32efdec0c2c41863b768085593579'
def expected_headers(graph):
    if e.checked_file(graph,e.GRAPH_LIMIT)['sha256']!=GRAPH_SHA:raise ValueError('Pinned graph digest mismatch')
    e.graph_inventory(graph);result={}
    with tarfile.open(graph,'r:gz') as archive:
        for member in archive:
            if not member.name.endswith('.gph'):continue
            b=archive.extractfile(member).read(48)
            tile=struct.unpack_from('<Q',b,0)[0]&((1<<46)-1);counts=struct.unpack_from('<Q',b,40)[0]
            if tile in result:raise ValueError('Duplicate graph tile ID')
            result[tile]={'nodes':counts&((1<<21)-1),'edges':(counts>>21)&((1<<21)-1)}
    return result

def integer(value,maximum=(1<<64)-1):
    if type(value) is not int or not 0<=value<=maximum:raise ValueError('Invalid bounded integer')
    return value

def coordinate(point):
    if not isinstance(point,list) or len(point)!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in point) or abs(point[0])>90 or abs(point[1])>180:raise ValueError('Invalid coordinates')

def validate_census(path,expected):
    e.checked_file(path,e.GRAPH_LIMIT);tiles={};nodes={};edges={};complete=None
    if not expected or len(expected)>8192 or sum(h['nodes'] for h in expected.values())>500000 or sum(h['edges'] for h in expected.values())>1000000:raise ValueError('Graph cardinality cap')
    with Path(path).open('rb') as f:
        while True:
            line=f.readline(4*1024*1024+1)
            if not line:break
            if len(line)>4*1024*1024:raise ValueError('Census record actual_bytes exceeds limit_bytes=4194304')
            row=json.loads(line)
            if not isinstance(row,dict):raise ValueError('Invalid record')
            kind=row.get('kind')
            if complete is not None:raise ValueError('Data after completion')
            if kind=='tile':
                tile=integer(row['tile'],(1<<25)-1)
                if tile in tiles or tile not in expected or {k:integer(row[k]) for k in ['nodes','edges']}!=expected[tile] or integer(row['level'],7)!=(tile&7):raise ValueError('Tile header mismatch/duplicate')
                tiles[tile]=row
            elif kind in ['node','edge']:
                tile=integer(row['tile']);index=integer(row['index']);key=(tile,index)
                target=nodes if kind=='node' else edges;countkey='nodes' if kind=='node' else 'edges'
                if key in target or tile not in tiles or index>=tiles[tile][countkey] or integer(row['id'])!=(tile|(index<<25)):raise ValueError('Invalid/duplicate graph record ID')
                if kind=='node':
                    integer(row['access'],4095);integer(row['type']);coordinate(row['coordinate'])
                    integer(row['edgeIndex'],tiles[tile]['edges']);integer(row['edgeCount'],tiles[tile]['edges'])
                    if row['edgeIndex']+row['edgeCount']>tiles[tile]['edges']:raise ValueError('Node edge range outside tile')
                    if not isinstance(row['transitions'],list) or len(row['transitions'])>255:raise ValueError('Invalid transitions')
                    for transition in row['transitions']:
                        integer(transition['endNode'],(1<<46)-1)
                        if type(transition['up']) is not bool:raise ValueError('Invalid transition direction')
                else:
                    for k in ['startNode','endNode']:integer(row[k],(1<<46)-1)
                    for k in ['wayId','use','roadClass','lengthMeters','restrictions','accessRestrictionMask','startRestrictionMask','endRestrictionMask']:integer(row[k])
                    for k in ['forwardAccess','reverseAccess']:integer(row[k],4095)
                    for k in ['endTilePresent','shortcut','forward','complexRestriction']:
                        if type(row.get(k)) is not bool:raise ValueError('Missing edge flag')
                    if row['opposingEdge'] is not None:integer(row['opposingEdge'],(1<<46)-1)
                    if not isinstance(row.get('accessRestrictions'),list) or len(row['accessRestrictions'])>65535:raise ValueError('Invalid access restrictions')
                    for restriction in row['accessRestrictions']:
                        integer(restriction['type']);integer(restriction['value']);integer(restriction['modes'],4095)
                        if type(restriction['exceptDestination']) is not bool:raise ValueError('Invalid access restriction flag')
                    shape=row.get('shape')
                    if not isinstance(shape,list) or not 2<=len(shape)<=100000:raise ValueError('Missing edge geometry')
                    for point in shape:coordinate(point)
                target[key]=row
            elif kind=='complete':complete=row
            else:raise ValueError('Unknown census record')
    if set(tiles)!=set(expected) or complete is None:raise ValueError('Missing tile/footer')
    node_ids={n['id']:n for n in nodes.values()};edge_ids={n['id']:n for n in edges.values()}
    from collections import Counter
    node_counts=Counter(k[0] for k in nodes);edge_counts=Counter(k[0] for k in edges)
    for tile,h in expected.items():
        if node_counts[tile]!=h['nodes'] or edge_counts[tile]!=h['edges']:raise ValueError('Census omits node/edge')
    covered=set()
    for (tile,_),node in nodes.items():
        for index in range(node['edgeIndex'],node['edgeIndex']+node['edgeCount']):
            key=(tile,index)
            if key in covered or key not in edges or edges[key]['startNode']!=node['id']:raise ValueError('Invalid edge ownership range')
            covered.add(key)
        for transition in node['transitions']:
            if (transition['endNode']&((1<<25)-1)) in expected and transition['endNode'] not in node_ids:raise ValueError('Transition endpoint omitted')
    if covered!=set(edges):raise ValueError('Edge start ownership missing')
    for edge in edges.values():
        present=(edge['endNode']&((1<<25)-1)) in expected
        if edge['endTilePresent']!=present or (present and edge['endNode'] not in node_ids):raise ValueError('Endpoint inventory mismatch')
        opp=edge['opposingEdge']
        if opp is not None and (opp not in edge_ids or edge_ids[opp]['endNode']!=edge['startNode'] or edge_ids[opp]['startNode']!=edge['endNode']):raise ValueError('Invalid opposing edge')
    counts={'tiles':len(tiles),'nodes':len(nodes),'edges':len(edges)}
    if any(integer(complete.get(k))!=v for k,v in counts.items()):raise ValueError('Footer count mismatch')
    return counts

def fetch(root):
    inputs=root/'census-input';inputs.mkdir();archive=inputs/'source.zip';p=subprocess.Popen(['gh','api','repos/Cruncho420/osm-region-extractor/actions/artifacts/10341602724/zip'],stdout=subprocess.PIPE)
    try:
        with archive.open('xb') as f:
            count=0
            while True:
                b=p.stdout.read(65536)
                if not b:break
                count+=len(b)
                if count>16*1024*1024:raise ValueError('Source artifact cap')
                f.write(b)
        if p.wait()!=0 or e.checked_file(archive,16*1024*1024)['sha256']!=ZIP_SHA:raise ValueError('Source artifact identity mismatch')
    finally:
        if p.poll() is None:p.kill();p.wait()
    names={'osm-region-extractor/osm-region-extractor/evidence/source/graph.tar.gz':'graph.tar.gz','_temp/FQhma9/attestation.json':'attestation.json'}
    with zipfile.ZipFile(archive) as z:
        if len(z.infolist())!=5 or len({i.filename for i in z.infolist()})!=5:raise ValueError('ZIP member contract')
        for name,target in names.items():
            info=z.getinfo(name)
            if info.file_size>e.GRAPH_LIMIT:raise ValueError('ZIP member size')
            with (inputs/target).open('xb') as f:f.write(z.read(info))
    with (inputs/'graph-attestation-verification.json').open('x') as out:
        s.run(['gh','attestation','verify',inputs/'graph.tar.gz','--bundle',inputs/'attestation.json','--repo','Cruncho420/osm-region-extractor','--signer-workflow','Cruncho420/osm-region-extractor/.github/workflows/valhalla-source-evidence.yml','--source-digest',SOURCE_SHA,'--signer-digest',SOURCE_SHA,'--source-ref','refs/heads/codex/valhalla-evidence-only-20260914','--deny-self-hosted-runners','--format','json'],stdout=out)
    expected_headers(inputs/'graph.tar.gz')
    with gzip.open(inputs/'graph.tar.gz','rb') as src,(inputs/'graph.tar').open('xb') as dst:shutil.copyfileobj(src,dst)
    archive.unlink() # Verified input ZIP consumed; exact graph + signature/proof retained.

def verified_extract(inputs):
    expected_headers(inputs/'graph.tar.gz');h=hashlib.sha256();size=0
    with gzip.open(inputs/'graph.tar.gz','rb') as stream:
        for chunk in iter(lambda:stream.read(65536),b''):
            size+=len(chunk)
            if size>e.BUNDLE_LIMIT:raise ValueError(f'Extract actual_bytes={size} limit_bytes={e.BUNDLE_LIMIT}')
            h.update(chunk)
    identity={'sha256':h.hexdigest(),'bytes':size}
    if e.checked_file(inputs/'graph.tar',e.BUNDLE_LIMIT)!=identity:raise ValueError('Graph extract differs from authenticated compressed graph')
    return identity

def build(root):
    extract=verified_extract(root/'census-input')
    core=root/'source-core';out=Path('/build/core-output');out.mkdir();pins=json.loads(s.PINS.read_text());identity=s.workflow_identity(os.environ)
    if os.environ.get('SOURCE_BUILDER_BASE')!=pins['baseImage']:raise ValueError('Base digest mismatch')
    s.verify_source(core,pins);s.generated_tz(core,False)
    s.run(['cmake','-S',core,'-B',out,'-DCMAKE_BUILD_TYPE=Release','-DENABLE_SERVICES=OFF','-DENABLE_TOOLS=ON','-DENABLE_DATA_TOOLS=ON','-DENABLE_TESTS=OFF','-DENABLE_PYTHON_BINDINGS=OFF','-DENABLE_CCACHE=OFF','-DENABLE_GEOTIFF=OFF','-DCMAKE_PROJECT_INCLUDE='+str(HERE/'valhalla-edge-census.cmake')])
    s.run(['cmake','--build',out,'--parallel','2','--target','rods_edge_census'])
    s.verify_source(core,pins);generated=s.generated_tz(core,True)
    private=root/'census-private';private.mkdir();tool=out/'rods_edge_census'
    conf={'mjolnir':{'tile_extract':str(root/'census-input/graph.tar'),'tile_dir':str(root/'absent-loose-tiles'),'concurrency':1}}
    e.write_json(private/'config.json',conf)
    # File bytes are capped independently of C++ stream checks, including on crashes.
    import resource
    s.run([tool,private/'config.json',private/'directed-edges.jsonl'],timeout=120,preexec_fn=lambda:resource.setrlimit(resource.RLIMIT_FSIZE,(e.GRAPH_LIMIT,e.GRAPH_LIMIT)))
    counts=validate_census(private/'directed-edges.jsonl',expected_headers(root/'census-input/graph.tar.gz'))
    if verified_extract(root/'census-input')!=extract:raise ValueError('Graph extract changed during census')
    s.verify_source(core,pins)
    if s.generated_tz(core,True)!=generated:raise ValueError('Generated TZ changed')
    def hashed(path):return e.checked_file(path,256*1024*1024)
    archives={p.name:hashed(p) for p in Path('/build/deb-cache').glob('*.deb')}
    if not archives:raise ValueError('Dependency archives missing')
    receipt={**identity,'coreRevision':pins['coreRevision'],'submodules':pins['submodules'],'baseImage':pins['baseImage'],'graphSha256':GRAPH_SHA,'extract':extract,'sourceArtifactSha256':ZIP_SHA,'sourceGraphWorkflowSha':SOURCE_SHA,'counts':counts,'generatedSourceOutputs':generated,'tool':hashed(tool),'censusSource':hashed(HERE/'valhalla-edge-census.cc'),'cmakeInjection':hashed(HERE/'valhalla-edge-census.cmake'),'cmakeCache':hashed(out/'CMakeCache.txt'),'compileCommands':hashed(out/'compile_commands.json'),'buildCommands':{name:{'path':str(Path(shutil.which(name)).resolve()),**hashed(Path(shutil.which(name)).resolve())} for name in ['cc','c++','cmake','protoc']},'dependencyInstallationHermetic':False,'packageArchives':archives,'installedPackages':s.run(['dpkg-query','-W','-f=${binary:Package} ${Version} ${Architecture}\n'],capture_output=True,text=True).stdout,'nativeMatcherExecuted':False,'boundaryOracle':'UNRESOLVED','conditionalTraversalEligibility':'UNRESOLVED: complex restriction flags/references only; original graph retained'}
    e.write_json(private/'build-receipt.json',receipt)

def finish(root):
    private=root/'census-private';counts=validate_census(private/'directed-edges.jsonl',expected_headers(root/'census-input/graph.tar.gz'))
    receipt=json.loads((private/'build-receipt.json').read_text());pins=json.loads(s.PINS.read_text())
    if receipt['coreRevision']!=pins['coreRevision'] or receipt['submodules']!=pins['submodules'] or receipt['baseImage']!=pins['baseImage'] or receipt['graphSha256']!=GRAPH_SHA or receipt['counts']!=counts or receipt['nativeMatcherExecuted'] is not False:raise ValueError('Build receipt authority mismatch')
    if {k:receipt[k] for k in ['workflowRevision','runId']}!=s.workflow_identity(os.environ):raise ValueError('Cross-run census receipt')
    public_stage=root/'evidence-private';metadata=public_stage/'metadata';metadata.mkdir(parents=True)
    for p in private.iterdir():e.checked_file(p,e.GRAPH_LIMIT);shutil.copyfile(p,metadata/p.name)
    for name in ['attestation.json','graph-attestation-verification.json']:shutil.copyfile(root/'census-input'/name,metadata/('input-'+name))
    e.write_json(metadata/'receipt.json',{'status':'SOURCE_CENSUS_CAPTURED_LABELS_NOT_ADMITTED','counts':counts,'graphSha256':GRAPH_SHA,'files':{p.name:e.checked_file(p,e.GRAPH_LIMIT) for p in metadata.iterdir()},'nativeMatcherExecuted':False,'outsideSourceContinuation':'UNRESOLVED'})
    e.publish_evidence(public_stage,root/'evidence')
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['fetch','build','finish','failure']);parser.add_argument('--root',default='.');args=parser.parse_args();root=Path(args.root).resolve()
    try:
        if args.action=='failure':e.failure_receipt(root,RuntimeError('Census workflow failed before full publication'))
        else:globals()[args.action](root)
    except Exception as error:e.failure_receipt(root,error);raise
