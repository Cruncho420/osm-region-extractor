#!/usr/bin/env python3
"""Bounded Andorra graph evidence. Never publishes or treats clipping polygons as graph edges."""
import argparse
import datetime
import hashlib
import gzip
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import stat
import tarfile
import subprocess
import urllib.request
import xml.etree.ElementTree as ET

PBF_LIMIT=16*1024*1024
POLY_LIMIT=128*1024
XML_LIMIT=64*1024*1024
GRAPH_LIMIT=32*1024*1024
BUNDLE_LIMIT=128*1024*1024
POLY_URL='https://download.geofabrik.de/europe/andorra.poly'
POLICY=Path(__file__).with_name('valhalla-evidence-builders.json')


def digest(data):return hashlib.sha256(data).hexdigest()
def write_json(path,value):
    with Path(path).open('x') as f:json.dump(value,f,sort_keys=True,indent=2);f.write('\n')
def checked_file(path,limit):
    path=Path(path)
    if path.is_symlink():raise ValueError('Symlink evidence forbidden')
    before=path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_size>limit or before.st_size==0:raise ValueError('Evidence size/type limit')
    data=path.read_bytes();after=path.stat()
    if (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns):raise ValueError('Evidence changed during read')
    return {'sha256':digest(data),'bytes':len(data)}
def sha(value,n=64):return isinstance(value,str) and re.fullmatch('[0-9a-f]{'+str(n)+'}',value) is not None


def admit(options,policy):
    if options.get('evidence_only') is not True or options.get('upload') is not False or options.get('prune_old_smoke') is not False or options.get('regions')!='europe-andorra':
        raise ValueError('Evidence requires exact Andorra, evidence_only=true, upload=false, prune_old_smoke=false')
    if not re.fullmatch(r'https://download\.geofabrik\.de/europe/andorra-[0-9]{6}\.osm\.pbf',options.get('pbf_url','')):raise ValueError('Dated Andorra PBF URL required')
    for key in ['pbf_sha256','poly_sha256']:
        if not sha(options.get(key)):raise ValueError('Invalid '+key)
    image=options.get('valhalla_ref','')
    if not re.fullmatch(r'ghcr\.io/valhalla/valhalla@sha256:[0-9a-f]{64}',image):raise ValueError('Pinned builder digest required')
    revision=options.get('valhalla_core_revision')
    if not sha(revision,40):raise ValueError('Exact core source revision required')
    if policy.get('schemaVersion')!=1:raise ValueError('Unknown builder authority policy')
    approved=[p for p in policy.get('approvedBuilders',[]) if p.get('image')==image and p.get('coreRevision')==revision]
    if len(approved)!=1:raise ValueError('Independent reviewed builder authority missing/ambiguous; admission blocked')
    authority=approved[0]
    if not re.fullmatch(r'https://github\.com/valhalla/valhalla/actions/runs/[0-9]+',authority.get('authorityUrl','')) or not sha(authority.get('authoritySha256')):raise ValueError('Invalid builder authority receipt')
    return authority


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('Evidence source redirect forbidden')

def fetch(url,target,expected,limit):
    opener=urllib.request.build_opener(NoRedirect())
    with opener.open(url,timeout=60) as response:
        length=response.headers.get('Content-Length')
        if length is not None and (not length.isdigit() or int(length)>limit):raise ValueError('Download size limit')
        data=response.read(limit+1)
        if not data or len(data)>limit or digest(data)!=expected:raise ValueError('Source size/hash mismatch')
        if length is not None and len(data)!=int(length):raise ValueError('Truncated source')
        metadata={'url':url,'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'headers':{k:response.headers.get(k) for k in ['ETag','Last-Modified','Content-Length']},'sha256':expected,'bytes':len(data)}
    with Path(target).open('xb') as f:f.write(data)
    return metadata


def graph_inventory(path):
    checked_file(path,GRAPH_LIMIT)
    # Count every decompressed byte BEFORE tarfile can allocate PAX/GNU header payloads.
    # Streaming preflight also includes padding and trailing members, not only yielded files.
    expanded=0
    with gzip.open(path,'rb') as stream:
        while True:
            chunk=stream.read(min(65536,BUNDLE_LIMIT-expanded+1))
            if not chunk:break
            expanded+=len(chunk)
            if expanded>BUNDLE_LIMIT:raise ValueError('Entire expanded TAR size limit')
    entries={};total=0;seen=set();count=0
    with tarfile.open(path,'r|gz') as archive:
        for member in archive:
            name=member.name.removeprefix('./').rstrip('/')
            count+=1
            if count>8192:raise ValueError('Graph member count limit')
            if not name or name.startswith('/') or any(part in ('','..','.') for part in name.split('/')) or name in seen:raise ValueError('Unsafe/duplicate graph entry')
            seen.add(name)
            if member.isdir():continue
            if not member.isfile():raise ValueError('Non-regular graph entry')
            if member.size<=0 or member.size>GRAPH_LIMIT:raise ValueError('Graph entry size limit')
            total+=member.size
            if total>BUNDLE_LIMIT or len(entries)>=8192:raise ValueError('Expanded graph size/count limit')
            data=archive.extractfile(member).read(member.size+1)
            if len(data)!=member.size:raise ValueError('Truncated graph entry')
            entries[name]={'sha256':digest(data),'bytes':len(data)}
    if 'index.bin' not in entries or not any(name.endswith('.gph') for name in entries):raise ValueError('Graph lacks index or tiles')
    return entries


def topology(xml_path):
    checked_file(xml_path,XML_LIMIT)
    raw=Path(xml_path).read_bytes()
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():raise ValueError('XML declarations forbidden')
    nodes={};ways=[];way_ids=set()
    for element in ET.fromstring(raw):
        if element.tag=='node':
            key=element.attrib['id'];lat=float(element.attrib['lat']);lon=float(element.attrib['lon'])
            if key in nodes or not math.isfinite(lat) or not math.isfinite(lon) or abs(lat)>90 or abs(lon)>180:raise ValueError('Invalid/duplicate source node')
            nodes[key]={'coordinate':[lat,lon],'version':element.get('version'),'timestamp':element.get('timestamp')}
        elif element.tag=='way':
            key=element.attrib['id']
            if key in way_ids:raise ValueError('Duplicate way id')
            way_ids.add(key)
            tags={child.attrib['k']:child.attrib['v'] for child in element if child.tag=='tag'}
            if 'highway' not in tags:continue
            refs=[child.attrib['ref'] for child in element if child.tag=='nd']
            if len(refs)<2:raise ValueError('Degenerate highway way')
            ways.append({'id':key,'version':element.get('version'),'timestamp':element.get('timestamp'),'nodes':refs,'tags':tags})
        if len(nodes)>500000 or len(way_ids)>100000:raise ValueError('Topology cardinality limit')
    if not ways:raise ValueError('No highway topology')
    retained_nodes={}
    for way in ways:
        if any(ref not in nodes for ref in way['nodes']):raise ValueError('Missing referenced highway node')
        way['coordinates']=[nodes[ref]['coordinate'] for ref in way['nodes']]
        for ref in way['nodes']:retained_nodes[ref]=nodes[ref]
    return {'schemaVersion':1,'source':'exact-retained-pbf','scope':'all highway ways; no length/access/type filter',
            'polygonIsGraphEdge':False,'ways':sorted(ways,key=lambda w:int(w['id'])),'nodes':retained_nodes,
            'negativeLabels':'UNRESOLVED: freeze separate candidate gaps and compare against every retained segment; absence is not engine refusal'}


def decode_highway_topology(pbf,work):
    # Osmium includes referenced nodes by default. No omit-reference, value, access or length filter.
    pbf=Path(pbf);original=checked_file(pbf,PBF_LIMIT)
    xml=Path(work)/'evidence-highways.osm';created=False
    argv=['osmium','tags-filter',str(pbf),'w/highway','-f','osm']
    try:
        with xml.open('xb') as out:
            created=True
            subprocess.run(argv,stdout=out,check=True,timeout=120,
                preexec_fn=lambda:resource.setrlimit(resource.RLIMIT_FSIZE,(XML_LIMIT,XML_LIMIT)))
        xml_info=checked_file(xml,XML_LIMIT)
        result=topology(xml)
        if checked_file(pbf,PBF_LIMIT)!=original:raise ValueError('Original PBF changed during topology extraction')
        return result,{'command':argv,'fullSourcePbf':original,'xml':xml_info,
            'scope':'All highway-tagged ways and referenced nodes; not exhaustive graph edges',
            'referencedNodesIncluded':True,'xmlRetained':False,'graphInput':'exact full original PBF'}
    finally:
        if created:xml.unlink() # Only our exclusive-created disposable XML, including partial failures.


def prepare(root,options):
    authority=admit(options,json.loads(POLICY.read_text())) # BEFORE mkdir, network, Docker or build.
    return prepare_sources(root,options,authority)


def prepare_sources(root,options,authority):
    # Shared bounded capture; each CLI authenticates its own authority model before calling.
    root=Path(root);evidence=root/'evidence-private';evidence.mkdir()
    source=evidence/'source';source.mkdir();metadata=evidence/'metadata';metadata.mkdir()
    pbf=fetch(options['pbf_url'],source/'region.osm.pbf',options['pbf_sha256'],PBF_LIMIT)
    poly=fetch(POLY_URL,source/'region.poly',options['poly_sha256'],POLY_LIMIT)
    # Exact source retained before the existing production packaging step removes work/region.osm.pbf.
    work=root/'work';work.mkdir(exist_ok=True);shutil.copyfile(source/'region.osm.pbf',work/'region.osm.pbf')
    with (metadata/'pbf-fileinfo.json').open('xb') as out:
        subprocess.run(['osmium','fileinfo','-e','-j',str(source/'region.osm.pbf')],stdout=out,check=True,timeout=120,preexec_fn=lambda:resource.setrlimit(resource.RLIMIT_FSIZE,(1024*1024,1024*1024)))
    checked_file(metadata/'pbf-fileinfo.json',1024*1024)
    info=json.loads((metadata/'pbf-fileinfo.json').read_text())
    # This is the exact header, not a date inferred from filename or HTTP modification time.
    if not info.get('header',{}).get('option',{}).get('osmosis_replication_timestamp'):raise ValueError('PBF replication timestamp missing')
    highway_topology,derivation=decode_highway_topology(source/'region.osm.pbf',work)
    write_json(metadata/'retained-highways.json',highway_topology)
    checked_file(metadata/'retained-highways.json',32*1024*1024)
    write_json(metadata/'source.json',{'schemaVersion':1,'pbf':pbf,'polygon':poly,'builderAuthority':authority,
        'workflowSourceRevision':os.environ.get('GITHUB_SHA'),'runId':os.environ.get('GITHUB_RUN_ID'),
        'clippingSemantics':'Geofabrik complete crossing ways/multipolygons; polygon is selection definition, NOT installed graph edge',
        'polygonPbfHistoricalAssociation':'NOT ASSERTED: independently retrieved source inputs, retained by exact hash',
        'topologyDerivation':derivation,'options':options,'files':{name:checked_file(metadata/name,32*1024*1024) for name in ['retained-highways.json','pbf-fileinfo.json']}})
    return pbf


def finish(root):
    root=Path(root);receipt=json.loads((root/'evidence-private/metadata/source.json').read_text())
    return finish_with_authority(root,admit(receipt['options'],json.loads(POLICY.read_text())))


def finish_with_authority(root,authority):
    root=Path(root);evidence=root/'evidence-private';metadata=evidence/'metadata';source=evidence/'source'
    receipt=json.loads((metadata/'source.json').read_text())
    if authority!=receipt['builderAuthority']:raise ValueError('Builder authority changed')
    for name,key,limit in [('region.osm.pbf','pbf',PBF_LIMIT),('region.poly','polygon',POLY_LIMIT)]:
        actual=checked_file(source/name,limit)
        pin='pbf_sha256' if key=='pbf' else 'poly_sha256'
        if actual['sha256']!=receipt[key]['sha256'] or actual['sha256']!=receipt['options'][pin]:raise ValueError('Retained source changed')
    for name,expected in receipt['files'].items():
        if checked_file(metadata/name,32*1024*1024)!=expected:raise ValueError('Retained topology/header changed')
    report_path=root/'valhalla-report-europe-andorra.json';checked_file(report_path,1024*1024)
    report=json.loads(report_path.read_text())
    if authority.get('model')=='same-run-clean-source':
        if report.get('sourceBuildReceiptSha256')!=authority.get('buildReceiptSha256') or checked_file(metadata/'source-build.json',GRAPH_LIMIT)['sha256']!=authority['buildReceiptSha256']:raise ValueError('Same-run build receipt mismatch')
    elif report.get('image')!=receipt['options']['valhalla_ref']:raise ValueError('Built graph image differs from admitted source')
    graph=root/'europe-andorra-valhalla.tar.gz';graph_info=checked_file(graph,GRAPH_LIMIT)
    if graph_info['sha256']!=report.get('sha256'):raise ValueError('Graph report hash mismatch')
    write_json(metadata/'graph-inventory.json',graph_inventory(graph))
    write_json(metadata/'build-input-hashes.json',{name:checked_file(root/'work'/name,256*1024*1024) for name in ['admins.sqlite','tz_world.sqlite']})
    for original,name in [(graph,'graph.tar.gz'),(report_path,'graph-report.json'),(root/'work/valhalla.json','build-config.json'),(root/'work/valhalla-c1.json','retry-config.json'),(root/'work/valhalla-verify.json','verify-config.json'),(root/'work/valhalla-extract.json','extract-config.json'),(root/'europe-andorra-corridors.json','native-sanity-corridors.json')]:
        checked_file(original,GRAPH_LIMIT)
        target=(source if name=='graph.tar.gz' else metadata)/name
        with original.open('rb') as src,target.open('xb') as dst:shutil.copyfileobj(src,dst)
    for log in ['build-attempt1.log','build-attempt2.log','route-stdout.log','route-stderr.log']:
        original=root/'work'/log
        if original.exists():
            checked_file(original,8*1024*1024)
            with original.open('rb') as src,(metadata/log).open('xb') as dst:shutil.copyfileobj(src,dst)
    files={}
    for folder in [source,metadata]:
        for file in sorted(folder.iterdir()):files[str(file.relative_to(evidence))]=checked_file(file,GRAPH_LIMIT)
    if sum(v['bytes'] for v in files.values())>BUNDLE_LIMIT:raise ValueError('Evidence bundle limit exceeded')
    write_json(metadata/'receipt.json',{'schemaVersion':1,'status':'SOURCE_GRAPH_CAPTURED_NOT_NATIVE_RUNTIME_ACCEPTED',
        'files':files,'graph':graph_info,'installedGraphBoundary':'UNRESOLVED','nativeRuntimeProven':False,
        'historicalMatrixComparison':'Separate new source cohort; historical fixtures unchanged'})
    publish_evidence(evidence,root/'evidence')


def publish_evidence(private,public):
    private=Path(private);public=Path(public)
    if private.is_symlink() or not private.is_dir():raise ValueError('Real private evidence directory required')
    if public.exists() or public.is_symlink():raise ValueError('Evidence destination already exists')
    total=0;count=0
    for file in private.rglob('*'):
        if file.is_symlink():raise ValueError('Symlink publication forbidden')
        if file.is_dir():continue
        count+=1
        if count>128:raise ValueError('Evidence publication file count limit')
        total+=checked_file(file,GRAPH_LIMIT)['bytes']
        if total>BUNDLE_LIMIT:raise ValueError('Evidence publication total size limit')
    if not (private/'metadata/receipt.json').is_file():raise ValueError('Complete success receipt required')
    private.rename(public) # Same-volume atomic directory publication, after every bound is checked.


def failure_receipt(root,error):
    public=Path(root)/'evidence'
    if public.exists():return # Never change a published success or an earlier failure receipt.
    metadata=public/'metadata';metadata.mkdir(parents=True)
    write_json(metadata/'failure.json',{'status':'EVIDENCE_PREPARATION_FAILED','errorClass':type(error).__name__,
               'message':str(error)[:1024],'nativeRuntimeProven':False,'privateStagingUploaded':False})


def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['admit','prepare','finish','failure']);parser.add_argument('--root',default='.');args=parser.parse_args()
    options=json.loads(os.environ.get('EVIDENCE_INPUTS','{}'))
    if args.action=='admit':admit(options,json.loads(POLICY.read_text()))
    elif args.action=='prepare':
        pbf=prepare(args.root,options)
        with open(os.environ['GITHUB_OUTPUT'],'a') as out:out.write(f'pbf_bytes={pbf["bytes"]}\npbf_mb={pbf["bytes"]//1024//1024}\n')
    elif args.action=='finish':finish(args.root)
    else:failure_receipt(args.root,RuntimeError('Workflow stopped before complete evidence publication'))

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Only a small failure receipt reaches the always-upload directory; private partials never do.
        import sys
        root='.'
        if '--root' in sys.argv:root=sys.argv[sys.argv.index('--root')+1]
        failure_receipt(root,error)
        raise
