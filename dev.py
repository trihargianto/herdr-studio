"""Publish this workspace to a personal Herdr layout and watch for edits."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
HOME = Path.home() / '.config/herdr-app'
STATE = ROOT / '.published.json'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def sources():
    files = {str(p.relative_to(ROOT)): p.read_bytes()
            for folder in ('layouts', 'mods') for p in (ROOT / folder).rglob('*')
            if p.is_file() and not p.name.startswith('.')
            and p.name != 'jsconfig.json' and not p.name.endswith('.d.ts')}
    if (ROOT / 'keybindings.json').exists():
        files['keybindings.json'] = (ROOT / 'keybindings.json').read_bytes()
    return files

def publish(files):
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    # Never replace unrelated files or overwrite edits made directly in Herdr.
    for name in set(previous) | set(files):
        if name == 'keybindings.json':
            continue  # Source-only overrides are merged into keys.json below.
        target = HOME / name
        if target.exists():
            actual = digest(target.read_bytes())
            if actual != previous.get(name) and (name not in files or actual != digest(files[name])):
                raise RuntimeError(f'Conflicting file; preserve or move it first: {target}')
    changed_mods = {Path(name).parts[1] for name, data in files.items()
                    if name.startswith('mods/') and digest(data) != previous.get(name)}
    for mod in sorted(changed_mods):
        subprocess.run(['herdr-app', 'check', str(ROOT / 'mods' / mod)],
                       check=True, timeout=30)
    keys_target = HOME / 'keys.json'
    keys = json.loads(keys_target.read_text()) if keys_target.exists() else {}
    for section, bindings in json.loads(files.get('keybindings.json', b'{}')).items():
        keys.setdefault(section, {}).update(bindings)
    for name, data in files.items():
        if name == 'keybindings.json':
            continue
        target = HOME / name
        if not target.exists() or target.read_bytes() != data:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    for name in previous.keys() - files.keys():
        if name == 'keybindings.json':
            continue
        (HOME / name).unlink(missing_ok=True)
    if 'keybindings.json' in files:
        keys_text = json.dumps(keys, indent=2) + '\n'
        if not keys_target.exists() or keys_target.read_text() != keys_text:
            keys_target.write_text(keys_text)
    STATE.write_text(json.dumps({n: digest(d) for n, d in files.items()}, indent=2) + '\n')
    print('Published Studio.', flush=True)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--once', action='store_true', help='Publish and activate, then exit')
args = parser.parse_args()
files = sources()
publish(files)
subprocess.run(['herdr-app', 'do', 'layout.switch', '{"name":"studio"}'], check=True, timeout=15)
if not args.once:
    print('Watching workspace edits. Ctrl-C stops syncing; Herdr keeps the layout.', flush=True)
    try:
        while True:
            time.sleep(1)
            updated = sources()
            if updated != files:
                files = updated
                try:
                    publish(files)
                except (RuntimeError, subprocess.SubprocessError) as error:
                    print(f'Not published: {error}. Fix and save again.', flush=True)
    except KeyboardInterrupt:
        pass
