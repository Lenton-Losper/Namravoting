#!/usr/bin/env python3
"""Builds voting-app-release.zip: the repository files from git (LF line endings) plus the BUILT client and server.

    BASE_PATH=/voting-app npm run build
    python3 scripts/make-release.py [output.zip]

The zip is what the hosting team receives: Docker (docker compose build, no compile: Dockerfile.release) or `npm ci --omit=dev` + start.
It never contains secrets: no .env files, no node_modules, no uploads, and every file is scanned for secret-shaped text before it is zipped.
"""
import datetime, io, json, os, re, subprocess, sys, tarfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'voting-app-release.zip'))
BASE_PATH = os.environ.get('BASE_PATH', '/voting-app')

EXCLUDE_DIRS = ('.github/', 'worker/')                       # Cloudflare demo deployment + CI: not for the hosting team
SECRET_PATTERNS = [
    (r'napi_[A-Za-z0-9]{20,}', 'Neon API key'),
    (r'npg_[A-Za-z0-9]{8,}', 'Neon password'),
    (r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----', 'private key'),
    (r'AKIA[0-9A-Z]{16}', 'AWS access key'),
    (r'cfut_[A-Za-z0-9]{20,}', 'Cloudflare token'),
    (r'(?:postgres(?:ql)?|mysql)://[^:@/\s]+:(?!(?:OWNER_PASSWORD|APP_PASSWORD|PASSWORD|password|REDACTED|x|y|p|<)[@/])[^@\s<>$"\'`{}]{6,}@(?!(?:localhost|127\.0\.0\.1|db|DB_HOST|db\.internal)[:/])[A-Za-z0-9.-]+', 'database URL with a password'),
    (r'[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{30,}', 'Microsoft Entra client secret'),
    (r'(?:SESSION_SECRET|CSRF_SECRET|ENTRA_CLIENT_SECRET|NEON_API_KEY|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY)\s*=\s*(?!change-me|\s|<|\$)[^\s#]{12,}', 'secret setting with a value'),
]
# fixtures in tests are fake on purpose
SCAN_SKIP = ('server/tests/', 'client/src/', 'package-lock.json', 'client/public/')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout


def main():
    for d in ('client/dist', 'server/dist'):
        if not os.path.isfile(os.path.join(ROOT, d, 'index.html' if d.startswith('client') else 'index.js')):
            sys.exit(f'{d} is missing: run  BASE_PATH={BASE_PATH} npm run build  first')
    index = open(os.path.join(ROOT, 'client/dist/index.html'), encoding='utf8').read()
    m = re.search(r'(?:src|href)="([^"]*)/assets/', index)
    if not m or m.group(1) != BASE_PATH:
        sys.exit(f'client/dist was built for "{m.group(1) if m else "?"}", not "{BASE_PATH}": rebuild with BASE_PATH={BASE_PATH}')

    files = {}                                              # zip path -> bytes
    with tarfile.open(fileobj=io.BytesIO(git('archive', 'HEAD', '--format=tar')), mode='r:') as t:   # committed files, LF endings
        for mem in t.getmembers():
            if mem.isfile() and not mem.name.startswith(EXCLUDE_DIRS):
                files[mem.name] = t.extractfile(mem).read()
    for top in ('client/dist', 'server/dist'):
        for dp, _, fns in os.walk(os.path.join(ROOT, top)):
            for fn in fns:
                if fn.endswith('.tsbuildinfo'):
                    continue
                full = os.path.join(dp, fn)
                files[os.path.relpath(full, ROOT).replace(os.sep, '/')] = open(full, 'rb').read()

    # the compose file in the package builds from the prebuilt files (Dockerfile.release), not from source
    c = files['docker-compose.yml'].decode('utf8')
    assert '      context: .\n' in c, 'docker-compose.yml layout changed'
    files['docker-compose.yml'] = c.replace('      context: .\n', '      context: .\n      dockerfile: Dockerfile.release\n', 1).encode('utf8')

    sha = git('rev-parse', 'HEAD').decode().strip()
    files['RELEASE.txt'] = (f'NamRA Staff Voting release\ncommit:    {sha}\nbuilt:     {datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M} UTC\n'
                            f'BASE_PATH: {BASE_PATH}  (compiled into client/dist; changing it needs a rebuild)\nsee HOSTING.md\n').encode()

    # ---- no secrets
    problems = []
    for name, data in sorted(files.items()):
        base = os.path.basename(name)
        if base.startswith('.env') and base != '.env.example':
            problems.append(f'{name}: an env file')
        if '/node_modules/' in '/' + name or name.startswith(('uploads/', 'data/')) or name.endswith(('.dump', '.pem', '.key', '.pfx')):
            problems.append(f'{name}: must not be in a release')
        if name.startswith(SCAN_SKIP) or b'\0' in data[:4096]:
            continue
        text = data.decode('utf8', 'replace')
        for pat, what in SECRET_PATTERNS:
            for hit in re.finditer(pat, text):
                problems.append(f'{name}: looks like a {what}: {hit.group(0)[:12]}...')
    env = files['.env.example'].decode('utf8')
    for ln in env.splitlines():                             # .env.example: only placeholders, and the dev passwords that are public in the repo
        if re.match(r'(?:SESSION_SECRET|ENTRA_CLIENT_SECRET|NEON_API_KEY|CLOUDFLARE_API_TOKEN|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID)=.+', ln) and 'change-me' not in ln:
            problems.append(f'.env.example: {ln.split("=")[0]} has a value')
    if problems:
        sys.exit('REFUSING to build the release:\n  ' + '\n  '.join(problems))

    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = (0o644 << 16)
            z.writestr(zi, files[name])
    print(json.dumps({'zip': OUT, 'files': len(files), 'kb': round(os.path.getsize(OUT) / 1024), 'commit': sha}))


main()
