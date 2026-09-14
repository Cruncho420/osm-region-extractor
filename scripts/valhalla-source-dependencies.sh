#!/usr/bin/env bash
set -euo pipefail
# Ordinary Ubuntu signed repositories. Exact versions/archives are recorded, not locked.
export DEBIAN_FRONTEND=noninteractive
mkdir -p /build/deb-cache/partial
apt-get update
apt-get -o Dir::Cache::archives=/build/deb-cache -y --no-install-recommends install \
  build-essential cmake pkg-config git ca-certificates libboost-all-dev \
  libcurl4-openssl-dev liblz4-dev libprotobuf-dev protobuf-compiler libsqlite3-dev \
  libspatialite-dev libluajit-5.1-dev libgeos-dev libssl-dev zlib1g-dev python3 python3-shapely \
  python3-requests osmium-tool curl unzip jq spatialite-bin
python3 - <<'PY'
import hashlib,json,os,subprocess
from pathlib import Path

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):h.update(chunk)
    return {'sha256':h.hexdigest(),'bytes':path.stat().st_size}
archives={p.name:digest(p) for p in sorted(Path('/build/deb-cache').glob('*.deb'))}
if not archives:raise RuntimeError('Apt package archive capture empty')
versions=subprocess.check_output(['dpkg-query','-W','-f=${binary:Package}\t${Version}\t${Architecture}\n'],text=True)
commands={}
for name in ['cc','c++','cmake','protoc','osmium','spatialite_tool']:
    import shutil
    path=Path(shutil.which(name)).resolve();commands[name]={'path':str(path),**digest(path)}
receipt={'policy':'signed-apt-recorded-versions-and-archives-not-hermetic','hermetic':False,
         'installedVersions':versions,'archives':archives,'buildCommands':commands,
         'aptSources':{str(p):digest(p) for p in sorted(Path('/etc/apt/sources.list.d').glob('*')) if p.is_file()}}
with open('/job/source-builder-packages.json','x') as f:json.dump(receipt,f,sort_keys=True,indent=2);f.write('\n')
PY
exec python3 /job/scripts/valhalla-source-builder.py --root /job --core /job/source-core --build /build/core-output
