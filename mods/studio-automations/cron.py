"""Local crontab adapter. Commands are stored, never executed by this adapter."""
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

NAME = '# herdr-studio-name: '
DISABLED = '# herdr-studio-disabled: '
ALIASES = {'@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly'}


def read_crontab():
    result = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=10)
    if result.returncode and 'no crontab for' not in result.stderr.lower():
        raise ValueError(result.stderr.strip() or 'Cannot read crontab')
    return result.stdout if result.returncode == 0 else ''


def revision(text):
    return hashlib.sha256(text.encode()).hexdigest()


def entries(text):
    jobs = []
    lines = text.splitlines(keepends=True)
    for index, original in enumerate(lines):
        line = original.strip()
        enabled = not line.startswith(DISABLED)
        if not enabled:
            line = line[len(DISABLED):]
        if not line or line.startswith('#') or re.match(r'^\w+\s*=', line):
            continue
        parts = line.split(None, 1 if line.startswith('@') else 5)
        if len(parts) != (2 if line.startswith('@') else 6):
            continue
        schedule, command = ' '.join(parts[:-1]), parts[-1]
        named = index > 0 and lines[index - 1].startswith(NAME)
        name = json.loads(lines[index - 1][len(NAME):]) if named else command
        jobs.append(dict(id=str(index), name=name, schedule=schedule, command=command,
                         enabled=enabled, named=named))
    return jobs


def validate(schedule, command, name):
    if any(c in schedule for c in "\r\n\0"):
        raise ValueError("Enter a single-line schedule.")
    if not command.strip() or any(c in command for c in '\r\n\0'):
        raise ValueError('Enter a single-line command.')
    if not name.strip() or any(c in name for c in '\r\n\0'):
        raise ValueError('Enter a single-line name.')
    if schedule in ALIASES:
        return
    fields = schedule.split()
    if len(fields) != 5:
        raise ValueError('Use five cron fields: minute hour day month weekday.')
    for field, (low, high) in zip(fields, [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]):
        for term in field.split(','):
            match = re.fullmatch(r'(\*|\d+(?:-\d+)?)(?:/(\d+))?', term)
            if not match or (match[2] is not None and int(match[2]) < 1):
                raise ValueError('Use numeric cron fields with *, ranges, lists, or positive steps.')
            if match[1] != '*':
                values = [int(n) for n in match[1].split('-')]
                if any(n < low or n > high for n in values) or values != sorted(values):
                    raise ValueError(f'Cron field must be between {low} and {high}.')


def modify(text, request):
    if request.get('revision') != revision(text):
        raise ValueError('Crontab changed elsewhere. Refresh and try again.')
    lines = text.splitlines(keepends=True)
    action = request['action']
    job = next((j for j in entries(text) if j['id'] == request.get('id')), None)
    if request.get('id') is not None and job is None:
        raise ValueError('Job no longer exists. Refresh and try again.')
    if action == 'save':
        name, schedule, command = (request[k].strip() for k in ('name', 'schedule', 'command'))
        validate(schedule, command, name)
        enabled = job['enabled'] if job else False
        replacement = [NAME + json.dumps(name, ensure_ascii=False) + '\n',
                       ('' if enabled else DISABLED) + schedule + ' ' + command + '\n']
    elif action == 'toggle' and job:
        line = lines[int(job['id'])]
        replacement = [(DISABLED + line) if job['enabled'] else line.lstrip()[len(DISABLED):]]
    elif action == 'delete' and job:
        replacement = []
    else:
        raise ValueError('Unknown action')
    if job:
        end = int(job['id'])
        start = end - 1 if job['named'] and action != 'toggle' else end
        lines[start:end + 1] = replacement
    else:
        if lines and not lines[-1].endswith('\n'):
            lines[-1] += '\n'
        lines.extend(replacement)
    return ''.join(lines)


def main():
    request = json.loads(sys.argv[1])
    text = read_crontab()
    if request['action'] != 'list':
        updated = modify(text, request)
        # Keep a recovery copy before installing; never remove unrelated entries.
        backup = Path.home() / '.config/herdr-app/studio-automations/crontab.backup'
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(text)
        # A second read catches edits made while the update was being prepared.
        if read_crontab() != text:
            raise ValueError('Crontab changed elsewhere. Refresh and try again.')
        with tempfile.NamedTemporaryFile(mode='w', suffix='.cron') as file:
            file.write(updated)
            file.flush()
            result = subprocess.run(['crontab', file.name], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise ValueError(result.stderr.strip() or 'Cannot update crontab')
        text = read_crontab()
    print(json.dumps(dict(jobs=entries(text), revision=revision(text))))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
