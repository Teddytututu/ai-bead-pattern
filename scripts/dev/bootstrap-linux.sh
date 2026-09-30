#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  printf '%s\n' 'This bootstrap supports Linux x86_64.' >&2
  exit 1
fi
scope="${1:-all}"
if [[ "$scope" != all && "$scope" != core ]]; then
  printf '%s\n' 'Usage: bash scripts/dev/bootstrap-linux.sh [core|all]' >&2
  exit 1
fi
mkdir -p .tools/bootstrap/bin .tools/runtime .tools/downloads
python3 - <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request
import zipfile

root = Path.cwd()
downloads = root / '.tools/downloads'

def fetch(url, target, digest):
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
        return
    partial = target.with_suffix(target.suffix + '.part')
    print('Downloading ' + url, flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, partial.open('wb') as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    if hashlib.sha256(partial.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Checksum mismatch: ' + target.name)
    partial.replace(target)

node_version = '24.13.0'
archive_name = 'node-v' + node_version + '-linux-x64.tar.xz'
node_root = root / '.tools/runtime' / archive_name[:-7]
if not (node_root / 'bin/node').exists():
    base = 'https://nodejs.org/dist/v' + node_version + '/'
    checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
    digest = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == archive_name)
    archive = downloads / archive_name
    fetch(base + archive_name, archive, digest)
    subprocess.run(['tar', '-xJf', str(archive), '-C', str(root / '.tools/runtime')], check=True)

uv_version = '0.12.19'
uv_path = root / '.tools/bootstrap/bin/uv'
try:
    uv_ready = subprocess.check_output([str(uv_path), '--version'], text=True).strip() == 'uv ' + uv_version
except (OSError, subprocess.CalledProcessError):
    uv_ready = False
if not uv_ready:
    metadata = json.load(urllib.request.urlopen('https://pypi.org/pypi/uv/' + uv_version + '/json', timeout=30))
    wheels = [item for item in metadata['urls'] if item['filename'].endswith('.whl') and 'manylinux' in item['filename'] and 'x86_64' in item['filename']]
    if len(wheels) != 1:
        raise RuntimeError('Expected one Linux x86_64 uv wheel')
    item = wheels[0]
    wheel = downloads / item['filename']
    fetch(item['url'], wheel, item['digests']['sha256'])
    with zipfile.ZipFile(wheel) as archive:
        members = [name for name in archive.namelist() if name.endswith('/uv')]
        if len(members) != 1:
            raise RuntimeError('Expected one uv executable in wheel')
        staged_uv = uv_path.with_suffix('.new')
        staged_uv.write_bytes(archive.read(members[0]))
    staged_uv.chmod(0o755)
    staged_uv.replace(uv_path)
print('Bootstrap tools ready', flush=True)
PY
source scripts/dev/remote-env.sh
node --version
uv --version
if [[ ! -x .tools/pnpm/node_modules/.bin/pnpm ]] || [[ "$(.tools/pnpm/node_modules/.bin/pnpm --version)" != 11.19.0 ]]; then
  npm install --prefix .tools/pnpm --no-audit --no-fund pnpm@11.19.0
fi
pnpm --version
uv python install 3.11
pnpm install --frozen-lockfile
services=(sdxl-region-sidecar sam2-sidecar)
if [[ "$scope" == all ]]; then
  services+=(mmpose-sidecar pixel-proposal-sidecar openclip-sidecar dinov2-sidecar)
fi
for service in "${services[@]}"; do
  printf 'Installing %s\n' "$service"
  uv sync --frozen --project "services/$service" --python 3.11
done
pnpm build
printf '%s\n' 'Environment installed. Source scripts/dev/remote-env.sh in Bash before using this checkout.'
printf '%s\n' 'Download models explicitly with pnpm sdxl:prefetch and pnpm sam2:prefetch; this script does not start GPU jobs.'
