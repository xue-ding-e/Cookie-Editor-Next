#!/usr/bin/env python3
"""Package only the built popup extension; never read browser profiles."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def package(root=ROOT):
    sha = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('Invalid source SHA')
    dist = root / 'dist'
    if dist.is_symlink() or not dist.is_dir():
        raise ValueError('Build output must be a real directory')
    manifest = json.loads((dist / 'manifest.json').read_text())
    version = manifest['version']
    if not re.fullmatch(r'\d+(?:\.\d+){0,3}', version):
        raise ValueError('Invalid extension version')
    paths = [manifest['action']['default_popup'], manifest['background']['service_worker'], manifest['options_ui']['page']]
    paths += list(manifest['icons'].values())
    action_icons = manifest['action'].get('default_icon', {})
    paths += [action_icons] if isinstance(action_icons, str) else list(action_icons.values())
    paths += [p for entry in manifest.get('content_scripts', []) for p in entry.get('js', []) + entry.get('css', [])]
    paths.append('_locales/' + manifest['default_locale'] + '/messages.json')
    for relative in paths:
        path = dist / relative
        if Path(relative).is_absolute() or '..' in Path(relative).parts or not path.is_file() or path.is_symlink():
            raise ValueError('Missing or unsafe manifest reference: ' + relative)
    if any(path.is_symlink() for path in dist.rglob('*')):
        raise ValueError('Symlinks are not allowed in the extension package')
    for resource in manifest.get('web_accessible_resources', []):
        for pattern in resource.get('resources', []):
            if Path(pattern).is_absolute() or '..' in Path(pattern).parts or not any(dist.glob(pattern)):
                raise ValueError('Missing or unsafe web-accessible resource: ' + pattern)
    output = root / 'release-package'
    if output.is_symlink():
        raise ValueError('Package output must not be a symlink')
    output.mkdir(exist_ok=True)
    name = f'Cookie-Editor-Next_{sha[:12]}_unpacked.zip'
    for filename in (name, 'build-provenance.json', 'SHA256SUMS'):
        if (output / filename).is_symlink():
            raise ValueError('Package file must not be a symlink')
    handle, temporary_name = tempfile.mkstemp(prefix='package-', suffix='.zip', dir=output)
    os.close(handle)
    temporary = Path(temporary_name)
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        files = [(p, p.relative_to(dist).as_posix()) for p in sorted(dist.rglob('*')) if p.is_file()]
        files.append((root / 'LICENSE', 'LICENSE'))
        for path, relative in files:
            if path.is_symlink() or any(part.startswith('.') for part in Path(relative).parts) or Path(relative).suffix in ('.pem', '.key', '.map'):
                raise ValueError('Unsafe packaged file: ' + relative)
            info = zipfile.ZipInfo(relative, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    temporary.replace(output / name)
    digest = hashlib.sha256((output / name).read_bytes()).hexdigest()
    tag = f'v{version}-next.build.{sha[:12]}'
    provenance = {'repository': 'xue-ding-e/Cookie-Editor-Next', 'source_sha': sha, 'manifest_version': version,
                  'artifact': name, 'sha256': digest, 'tag': tag, 'ci_run_id': os.environ.get('GITHUB_RUN_ID'),
                  'validation': 'source regression tests and build; native browser installation not verified',
                  'runtime_privacy': 'Retains optional upstream n8n, analytics and remote sharing; no real Cookies used.'}
    (output / 'build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(f'{digest}  {name}\n')
    with zipfile.ZipFile(output / name) as archive:
        if archive.testzip() is not None:
            raise ValueError('Corrupt ZIP')
    return provenance

if __name__ == '__main__':
    result = package()
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('tag=' + result['tag'] + '\n')
    print(json.dumps(result))
