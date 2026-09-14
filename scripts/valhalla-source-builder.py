#!/usr/bin/env python3
"""Dispatch-only same-run source authority; no prebuilt Valhalla image admission."""
import argparse
import gzip
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import subprocess

SPEC=importlib.util.spec_from_file_location('evidence',Path(__file__).with_name('valhalla-evidence.py'))
e=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(e)
PINS=Path(__file__).with_name('valhalla-source-build-pins.json')
TOOLS=('valhalla_build_tiles','valhalla_build_admins','valhalla_service','valhalla_build_config','valhalla_build_extract','valhalla_build_timezones')


def workflow_identity(env):
    revision=env.get('GITHUB_SHA','');run=env.get('GITHUB_RUN_ID','')
    if not e.sha(revision,40) or not re.fullmatch(r'[0-9]+',run):raise ValueError('Exact workflow/run identity required')
    return {'workflowRevision':revision,'runId':run}


def parse_submodules(raw,expected):
    actual={}
    for line in raw.splitlines():
        match=re.fullmatch(r' ([0-9a-f]{40}) ([^ ]+)(?: .*|)',line)
        if not match or match[2] in actual:raise ValueError('Uninitialized, dirty, duplicate or invalid submodule')
        actual[match[2]]=match[1]
    if actual!=expected:raise ValueError('Recursive submodule manifest mismatch')
    return actual


def source_authority(receipt,identity):
    if not e.sha(receipt.get('sha256')):raise ValueError('Build receipt digest missing')
    workflow_identity({'GITHUB_SHA':identity.get('workflowRevision'),'GITHUB_RUN_ID':identity.get('runId')})
    return {'model':'same-run-clean-source','buildReceiptSha256':receipt['sha256'],**identity}


def run(argv,**kwargs):
    return subprocess.run([str(x) for x in argv],check=True,timeout=kwargs.pop('timeout',7200),**kwargs)


def git(core,*args):return run(['git','-c','safe.directory=*','-C',core,*args],capture_output=True,text=True).stdout


def verify_source(core,pins):
    if git(core,'rev-parse','HEAD').strip()!=pins['coreRevision']:raise ValueError('Core revision mismatch')
    if git(core,'status','--porcelain','--untracked-files=all').strip():raise ValueError('Core checkout is dirty')
    return parse_submodules(git(core,'submodule','status','--recursive'),pins['submodules'])


def generated_tz(core,complete):
    # --others intentionally includes ignored files: the pinned Makefile generates one.
    tz=Path(core)/'third_party/tz'
    names=git(tz,'ls-files','--others').splitlines()
    expected=['leapseconds'] if complete else []
    if names!=expected:raise ValueError('Unexpected or missing timezone source-tree generated files')
    return {name:e.checked_file(tz/name,1024*1024) for name in names}


def tool_hashes(build):
    build=Path(build).resolve();result={}
    for name in TOOLS:
        path=build/name
        if path.is_symlink() or path.resolve().parent!=build:raise ValueError('Tool outside fresh build output')
        result[name]=e.checked_file(path,256*1024*1024)
    return result


def decode_shape(shape):
    if not isinstance(shape,str) or not 0<len(shape)<=1000000:raise ValueError('Missing/bounded polyline6 shape required')
    values=[];value=0;shift=0
    for char in shape:
        part=ord(char)-63
        if not 0<=part<=63 or shift>30:raise ValueError('Invalid polyline6 encoding')
        value|=(part&31)<<shift
        if part&32:shift+=5;continue
        values.append(~(value>>1) if value&1 else value>>1);value=0;shift=0
        if len(values)>200000:raise ValueError('Geometry point count limit')
    if shift or len(values)<4 or len(values)%2:raise ValueError('Truncated/empty polyline6 geometry')
    lat=lon=0;points=[]
    for i in range(0,len(values),2):
        lat+=values[i];lon+=values[i+1]
        if abs(lat)>90000000 or abs(lon)>180000000:raise ValueError('Geometry coordinate outside globe')
        points.append((lat/1e6,lon/1e6))
    if not any(point!=points[0] for point in points[1:]):raise ValueError('Degenerate route geometry')
    return points


def valid_summary(summary):
    if not isinstance(summary,dict):raise ValueError('Route summary missing')
    for name in ('length','time'):
        value=summary.get(name)
        if type(value) not in (int,float) or not math.isfinite(value) or value<=0:raise ValueError('Finite positive route summary required')


def validate_sanity(value):
    if any(key in value for key in ('error','error_code')):raise ValueError('Native route error')
    trip=value.get('trip')
    if not isinstance(trip,dict) or type(trip.get('status')) is not int or trip['status']!=0:raise ValueError('Native route success status required')
    valid_summary(trip.get('summary'))
    legs=trip.get('legs')
    if not isinstance(legs,list) or not 0<len(legs)<=16:raise ValueError('Actual route legs required')
    for leg in legs:
        if not isinstance(leg,dict):raise ValueError('Malformed route leg')
        valid_summary(leg.get('summary'));decode_shape(leg.get('shape'))
    return value


def parse_sanity(raw):
    decoder=json.JSONDecoder()
    for offset,char in enumerate(raw):
        if char!='{':continue
        try:value,_=decoder.raw_decode(raw[offset:])
        except ValueError:continue
        if isinstance(value,dict) and any(key in value for key in ('trip','error','error_code')):return validate_sanity(value)
    raise ValueError('No actual successful route JSON in native CLI output')


def bounded_output(argv,path,limit=8*1024*1024,**kwargs):
    with Path(path).open('xb') as output:
        run(argv,stdout=output,stderr=subprocess.STDOUT,preexec_fn=lambda:resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit)),**kwargs)
    e.checked_file(path,limit)


def build(root,core,build_dir,pins,identity):
    build_dir.mkdir() # Refuse pre-existing output: no installed tools or warm binary substitution.
    verify_source(core,pins);generated_tz(core,False)
    run(['cmake','-S',core,'-B',build_dir,'-DCMAKE_BUILD_TYPE=Release','-DENABLE_SERVICES=OFF','-DENABLE_TOOLS=ON','-DENABLE_DATA_TOOLS=ON','-DENABLE_TESTS=OFF','-DENABLE_PYTHON_BINDINGS=OFF','-DENABLE_CCACHE=OFF','-DENABLE_GEOTIFF=OFF'])
    run(['cmake','--build',build_dir,'--parallel','2','--target','valhalla_build_tiles','valhalla_build_admins','valhalla_service'])
    verify_source(core,pins)
    packages=root/'source-builder-packages.json';e.checked_file(packages,8*1024*1024)
    package_info=json.loads(packages.read_text())
    if package_info.get('policy')!=pins['dependencyPolicy'] or not package_info.get('archives') or not package_info.get('installedVersions'):raise ValueError('Signed apt dependency receipt missing')
    receipt={'schemaVersion':1,**identity,'coreRepository':pins['coreRepository'],'coreRevision':pins['coreRevision'],
        'submodules':pins['submodules'],'baseImage':pins['baseImage'],'platform':pins['platform'],
        'dependencyInstallationHermetic':False,'dependencies':package_info,'tools':tool_hashes(build_dir),
        'generatedSourceOutputs':generated_tz(core,True),'sourcePins':e.checked_file(PINS,1024*1024),'buildFiles':{name:e.checked_file(build_dir/name,32*1024*1024) for name in ['CMakeCache.txt','compile_commands.json']}}
    path=root/'source-build.json';e.write_json(path,receipt)
    return source_authority(e.checked_file(path,8*1024*1024),identity),receipt


def graph(root,core,build_dir,pins,authority,build_receipt):
    options={'evidence_only':True,'upload':False,'prune_old_smoke':False,'regions':'europe-andorra',
        'pbf_url':pins['pbfUrl'],'pbf_sha256':pins['pbfSha256'],'poly_sha256':pins['polySha256'],
        'valhalla_core_revision':pins['coreRevision'],'authority_model':'same-run-clean-source'}
    e.prepare_sources(root,options,authority)
    metadata=root/'evidence-private/metadata';shutil.copyfile(root/'source-build.json',metadata/'source-build.json')
    work=root/'work';config=work/'valhalla.json'
    # The timezone script is pinned with core; its fixed release data is NOT a locked dependency.
    # It runs in a new private directory because upstream removes its own temporary filenames.
    tz_dir=root/'timezone-build';tz_dir.mkdir()
    with (work/'tz_world.sqlite').open('xb') as output:
        run([build_dir/'valhalla_build_timezones'],cwd=tz_dir,stdout=output,
            preexec_fn=lambda:resource.setrlimit(resource.RLIMIT_FSIZE,(256*1024*1024,256*1024*1024)))
    e.checked_file(work/'tz_world.sqlite',256*1024*1024)
    result=run([build_dir/'valhalla_build_config'],capture_output=True,text=True)
    conf=json.loads(result.stdout);conf['mjolnir'].update({'tile_dir':str(work/'valhalla_tiles'),'tile_extract':str(work/'unused.tar'),
        'admin':str(work/'admins.sqlite'),'timezone':str(work/'tz_world.sqlite'),'concurrency':2})
    e.write_json(config,conf);e.write_json(work/'valhalla-c1.json',conf)
    bounded_output([build_dir/'valhalla_build_admins','-c',config,work/'region.osm.pbf'],work/'admin-build.log')
    bounded_output([build_dir/'valhalla_build_tiles','-c',config,work/'region.osm.pbf'],work/'build-attempt1.log')
    extract=work/'valhalla_extract.tar';conf['mjolnir']['tile_extract']=str(extract)
    e.write_json(work/'valhalla-extract.json',conf)
    bounded_output([build_dir/'valhalla_build_extract','-c',work/'valhalla-extract.json','-v'],work/'extract-build.log')
    e.checked_file(extract,e.BUNDLE_LIMIT)
    graph_path=root/'europe-andorra-valhalla.tar.gz'
    with extract.open('rb') as src,graph_path.open('xb') as dst:
        with gzip.GzipFile(fileobj=dst,mode='wb',mtime=0) as compressed:shutil.copyfileobj(src,compressed)
    graph_info=e.checked_file(graph_path,e.GRAPH_LIMIT);e.graph_inventory(graph_path)
    verified_extract=work/'verified-extract.tar'
    with gzip.open(graph_path,'rb') as src,verified_extract.open('xb') as dst:shutil.copyfileobj(src,dst)
    if e.checked_file(verified_extract,e.BUNDLE_LIMIT)!=e.checked_file(extract,e.BUNDLE_LIMIT):raise ValueError('Packaged extract roundtrip mismatch')
    conf['mjolnir']['tile_extract']=str(verified_extract);conf['mjolnir']['tile_dir']=str(work/'absent-loose-tiles')
    e.write_json(work/'valhalla-verify.json',conf)
    topology=json.loads((metadata/'retained-highways.json').read_text())
    candidates=[w for w in topology['ways'] if w['tags'].get('highway') in ('primary','secondary','tertiary') and w['coordinates'][0]!=w['coordinates'][-1] and w['tags'].get('access') not in ('private','no')]
    if not candidates:raise ValueError('No independent source road for smoke route')
    way=candidates[0]
    request={'locations':[{'lat':p[0],'lon':p[1]} for p in (way['coordinates'][0],way['coordinates'][-1])],'costing':'auto','units':'kilometers','shape_format':'polyline6'}
    bounded_output([build_dir/'valhalla_service',work/'valhalla-verify.json','route',json.dumps(request)],work/'route-stdout.log',timeout=120)
    response=parse_sanity((work/'route-stdout.log').read_text())
    e.write_json(root/'europe-andorra-corridors.json',[{'name':'source-selected-road-smoke','sourceWayId':way['id'],'request':request,'response':response,'expectedRoadSequence':'NOT LABELLED: smoke only'}])
    if tool_hashes(build_dir)!=build_receipt['tools']:raise ValueError('Fresh graph tools changed')
    verify_source(core,pins)
    if generated_tz(core,True)!=build_receipt['generatedSourceOutputs']:raise ValueError('Generated timezone input changed after build')
    e.write_json(root/'valhalla-report-europe-andorra.json',{'sha256':graph_info['sha256'],'sourceBuildReceiptSha256':authority['buildReceiptSha256'],
        'coreRevision':pins['coreRevision'],'timezoneDependency':'Fixed upstream release URL in source script; archive not locked; output DB hash retained',
        'nativeConsumerFormatProven':False})
    e.finish_with_authority(root,authority)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--core',required=True);parser.add_argument('--build',required=True);args=parser.parse_args()
    root=Path(args.root).resolve();core=Path(args.core).resolve();build_dir=Path(args.build).resolve()
    try:
        pins=json.loads(PINS.read_text());identity=workflow_identity(os.environ)
        if os.environ.get('SOURCE_BUILDER_BASE')!=pins['baseImage']:raise ValueError('Dispatch base digest mismatch')
        authority,receipt=build(root,core,build_dir,pins,identity)
        graph(root,core,build_dir,pins,authority,receipt)
    except Exception as error:
        e.failure_receipt(root,error);raise
if __name__=='__main__':main()
