#!/usr/bin/python3
"""Publish Travel's static files and private backend, with data-safe rollback."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATIC = Path('/var/www/travel')
BACKEND = Path('/opt/travel')
ENV_FILE = Path('/etc/travel/travel.env')
DATABASE = Path('/var/lib/travel/travel.db')
BACKUPS = Path('/var/backups/travel')
BINARY = ROOT / 'backend/target/release/travel-backend'
URL = 'https://localhost/'
RELEASE_NAME = re.compile(r'(?:[0-9]{16,20}|[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12})\Z')
BACKUP_NAME = re.compile(r'travel-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}\.db\Z')


def command(args, *, cwd=None, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def configuration():
    """Read our simple EnvironmentFile without sourcing executable shell text."""
    global URL
    values = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = shlex.split(line, comments=True, posix=True)
        if len(parts) != 1 or '=' not in parts[0]:
            raise RuntimeError('Unsupported travel.env line; use one NAME=value assignment per line')
        key, value = parts[0].split('=', 1)
        if not re.fullmatch(r'TRAVEL_[A-Z_]+', key):
            raise RuntimeError('Unexpected configuration key in travel.env')
        values[key] = value
    if values.get('TRAVEL_DB_PATH') != str(DATABASE):
        raise RuntimeError('TRAVEL_DB_PATH must point to the production Travel database')
    origin = values.get('TRAVEL_ORIGIN', '')
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.path or parsed.query
            or parsed.fragment or parsed.username is not None or parsed.password is not None
            or origin != f'https://{parsed.netloc}'):
        raise RuntimeError('Set TRAVEL_ORIGIN to the deployed HTTPS origin without a trailing slash')
    URL = origin + '/'
    if values.get('TRAVEL_SECURE_COOKIE', 'true') != 'true':
        raise RuntimeError('Production requires secure session cookies')
    bind = values.get('TRAVEL_BIND', '127.0.0.1:8078')
    if not re.fullmatch(r'127\.0\.0\.1:[0-9]{1,5}', bind):
        raise RuntimeError('Deployment health checks require TRAVEL_BIND=127.0.0.1:PORT')
    port = int(bind.rsplit(':', 1)[1])
    if not 1 <= port <= 65535:
        raise RuntimeError('Invalid backend port')
    # Ignore inherited TRAVEL_* values; backup must use exactly the service configuration.
    environment = {k: v for k, v in os.environ.items() if not k.startswith('TRAVEL_')}
    environment.update(values)
    return environment, f'http://{bind}/api/health'


def target(link):
    if not link.is_symlink():
        if link.exists():
            raise RuntimeError(f'{link} must be a managed symlink')
        return None
    path = link.resolve(strict=True)
    releases = (link.parent / 'releases').resolve()
    if path.parent != releases or not path.is_dir() or not RELEASE_NAME.fullmatch(path.name):
        raise RuntimeError(f'{link} points outside managed release directories')
    return path


def activate(link, path):
    """Each link is replaced atomically; the enclosing transaction restores both on failure."""
    if path is None:
        link.unlink(missing_ok=True)
        return
    temporary = link.parent / ('.switch-' + uuid.uuid4().hex)
    try:
        temporary.symlink_to(path)
        os.replace(temporary, link)
    finally:
        temporary.unlink(missing_ok=True)


def schema_version():
    if not DATABASE.is_file():
        raise RuntimeError('Production database missing; initialize the admin locally first')
    with sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
        return db.execute('PRAGMA user_version').fetchone()[0]


def fetch(url, timeout=10):
    request = urllib.request.Request(url, headers={
        'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity',
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200 or response.geturl() != url:
            raise RuntimeError('Unexpected HTTP status or redirect: ' + url)
        return response.read()


def retry(check, attempts, delay):
    failure = None
    for attempt in range(attempts):
        try:
            return check()
        except (OSError, ValueError, RuntimeError) as error:
            failure = error
            if attempt + 1 < attempts:
                time.sleep(delay)
    raise RuntimeError(f'Health verification failed after {attempts} attempts: {failure}') from failure


def api_health(url):
    if json.loads(fetch(url, timeout=3)) != {'ok': True}:
        raise RuntimeError('API health payload mismatch')


def public_health(release):
    marker = '?deployment=' + urllib.parse.quote(release.name)
    files = [release / 'index.html', *sorted((release / 'assets').rglob('*'))]
    for path in files:
        if not path.is_file():
            continue
        relative = '' if path.name == 'index.html' and path.parent == release else path.relative_to(release).as_posix()
        remote = fetch(URL + urllib.parse.quote(relative, safe='/') + marker)
        if hashlib.sha256(remote).digest() != hashlib.sha256(path.read_bytes()).digest():
            raise RuntimeError('HTTPS content mismatch: ' + (relative or 'index.html'))
    api_health(URL + 'api/health')


def consistent_backup(binary, environment):
    BACKUPS.mkdir(parents=True, exist_ok=True, mode=0o700)
    BACKUPS.chmod(0o700)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    output = BACKUPS / f'travel-{stamp}-{uuid.uuid4().hex[:12]}.db'
    pending = BACKUPS / ('.' + output.name + '.pending')
    try:
        command([str(binary), 'backup', '--output', str(pending)], env=environment)
        with sqlite3.connect(pending.as_uri() + '?mode=ro', uri=True) as backup:
            if backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise RuntimeError('SQLite backup integrity check failed; release not activated')
        if pending.stat().st_mode & 0o077:
            raise RuntimeError('Backup permissions are not private; release not activated')
        os.replace(pending, output)
    finally:
        # A failed, unverified backup must not occupy one of the three valid recovery points.
        pending.unlink(missing_ok=True)
    return output


def compatible_pair(static_release, binary_release):
    if static_release is None or binary_release is None or static_release.name != binary_release.name:
        raise RuntimeError('Recovery requires a matching frontend/backend release pair')
    try:
        static_meta = json.loads((static_release / 'release.json').read_text())
        binary_meta = json.loads((binary_release / 'release.json').read_text())
        binary = binary_release / 'travel-backend'
        if (static_meta != binary_meta or static_meta.get('format') != 1
                or static_meta.get('databaseSchema') != 2 or static_meta.get('releaseId') != static_release.name
                or binary.is_symlink() or not binary.is_file() or not os.access(binary, os.X_OK)
                or static_meta.get('binarySha256') != hashlib.sha256(binary.read_bytes()).hexdigest()):
            raise ValueError('incompatible metadata or binary')
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise RuntimeError('Release has no verified schema2 compatibility metadata; refusing unsafe recovery') from error


def stage_release(release_id, source=None, binary_source=None):
    source = ROOT / 'dist' if source is None else source
    if not (source / 'index.html').is_file() or not (source / 'assets').is_dir():
        raise RuntimeError('Missing frontend build; run npm run build before --skip-build')
    if any(path.is_symlink() for path in source.rglob('*')):
        raise RuntimeError('Frontend build may not contain symlinks')
    static_release = STATIC / 'releases' / release_id
    binary_release = BACKEND / 'releases' / release_id
    try:
        shutil.copytree(source, static_release)
        for path in static_release.rglob('*'):
            path.chmod(0o755 if path.is_dir() else 0o644)
        static_release.chmod(0o755)
        binary_release.mkdir(mode=0o755)
        binary_release.chmod(0o755)
        shutil.copy2(BINARY if binary_source is None else binary_source, binary_release / 'travel-backend')
        (binary_release / 'travel-backend').chmod(0o755)
        metadata = json.dumps({'format': 1, 'releaseId': release_id, 'databaseSchema': 2,
                               'binarySha256': hashlib.sha256((binary_release / 'travel-backend').read_bytes()).hexdigest()},
                              sort_keys=True) + '\n'
        for directory in (static_release, binary_release):
            (directory / 'release.json').write_text(metadata)
            (directory / 'release.json').chmod(0o644)
    except Exception:
        for path in (static_release, binary_release):
            if path.exists():
                shutil.rmtree(path)
        raise
    return static_release, binary_release


def prune_releases(base):
    keep = {target(base / 'current'), target(base / 'previous')}
    for path in (base / 'releases').iterdir():
        if path.is_dir() and not path.is_symlink() and RELEASE_NAME.fullmatch(path.name) and path.resolve() not in keep:
            shutil.rmtree(path)


def prune_backups():
    backups = sorted((p for p in BACKUPS.iterdir() if p.is_file() and not p.is_symlink() and BACKUP_NAME.fullmatch(p.name)),
                     key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
    for path in backups[3:]:
        path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rollback', action='store_true', help='activate both previous releases without reverting data')
    parser.add_argument('--skip-build', action='store_true', help='use frontend dist already tested/built; backend is always prebuilt')
    parser.add_argument('--frontend-only', action='store_true', help='reuse deployed backend without restart or database access')
    parser.add_argument('--previous-frontend', action='store_true', help='publish previous UI while keeping the current data-compatible backend')
    args = parser.parse_args()
    if args.previous_frontend and (not args.frontend_only or args.rollback):
        parser.error('--previous-frontend requires --frontend-only and cannot be combined with --rollback')
    if args.frontend_only and args.rollback:
        parser.error('--frontend-only cannot be combined with --rollback')
    if args.rollback and args.skip_build:
        parser.error('--rollback and --skip-build are mutually exclusive')
    if os.geteuid() != 0:
        raise RuntimeError('Run this deployment script as root')
    # Fail before tests, staging or touching active links if the backend artifact is absent.
    if not args.rollback and not args.frontend_only and (not BINARY.is_file() or not os.access(BINARY, os.X_OK)):
        raise RuntimeError('Verified release binary missing; run cargo build --release -j 1 --locked first')
    environment, local_health = configuration()
    STATIC.mkdir(parents=True, exist_ok=True)
    BACKEND.mkdir(parents=True, exist_ok=True)
    for base in (STATIC, BACKEND):
        base.chmod(0o755)
        (base / 'releases').mkdir(exist_ok=True)
        (base / 'releases').chmod(0o755)
    with (STATIC / '.deploy.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another Travel deployment is running') from error
        version = 2 if args.frontend_only else schema_version()
        if version not in (1, 2):
            raise RuntimeError('Only schema1 upgrade or schema2 deployment is supported; data will not be overwritten')
        links = [STATIC / 'current', BACKEND / 'current', STATIC / 'previous', BACKEND / 'previous']
        originals = {link: target(link) for link in links}
        old_static, old_binary = originals[STATIC / 'current'], originals[BACKEND / 'current']
        was_active = subprocess.run(['systemctl', 'is-active', '--quiet', 'travel'], check=False).returncode == 0
        if old_static is None or old_binary is None or old_static.name != old_binary.name:
            raise RuntimeError('Deployment requires an existing matching frontend/backend pair')
        if version == 2:
            compatible_pair(old_static, old_binary)
        if args.frontend_only:
            if not was_active:
                raise RuntimeError('Frontend-only deployment requires a running backend')
            api_health(local_health)
        if args.rollback:
            if version != 2:
                raise RuntimeError('Schema1 cannot use schema2 rollback; deploy the compatible bridge first')
            new_static, new_binary = originals[STATIC / 'previous'], originals[BACKEND / 'previous']
            if new_static is None or new_binary is None or not (new_binary / 'travel-backend').is_file():
                raise RuntimeError('Rollback requires both previous frontend and previous backend releases')
            compatible_pair(new_static, new_binary)
            backup_binary = old_binary / 'travel-backend' if old_binary else new_binary / 'travel-backend'
        else:
            if not args.skip_build and not args.previous_frontend:
                command(['npm', 'test'], cwd=ROOT)
                command(['npm', 'run', 'build'], cwd=ROOT)
            release_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:12]
            previous_source = originals[STATIC / 'previous'] if args.previous_frontend else None
            if args.previous_frontend:
                compatible_pair(previous_source, originals[BACKEND / 'previous'])
            new_static, new_binary = stage_release(release_id, source=previous_source, binary_source=old_binary / 'travel-backend' if args.frontend_only else None)
            backup_binary = BINARY
        switched = False
        bridge = None
        bridge_verified = False
        recovery_active = was_active
        try:
            backup_path = None
            if not args.frontend_only:
                backup_path = consistent_backup(backup_binary, environment)
                prune_backups()
            if version == 1:
                # The new binary is compatible with both schemas. Preserve the old UI,
                # but never restart its schema1 binary after migration may have begun.
                bridge_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:12]
                bridge = stage_release(bridge_id, source=old_static)
                compatible_pair(*bridge)
                originals = {STATIC / 'current': bridge[0], BACKEND / 'current': bridge[1],
                             STATIC / 'previous': None, BACKEND / 'previous': None}
                old_static, old_binary = bridge
                recovery_active = True
                switched = True
                for link, path in originals.items():
                    activate(link, path)
                command(['systemctl', 'restart', 'travel'])
                retry(lambda: api_health(local_health), attempts=15, delay=.5)
                if schema_version() != 2:
                    raise RuntimeError('Bridge did not finish the schema2 migration')
                retry(lambda: public_health(old_static), attempts=3, delay=1)
                bridge_verified = True
            compatible_pair(new_static, new_binary)
            switched = True
            activate(STATIC / 'current', new_static)
            activate(BACKEND / 'current', new_binary)
            if not args.frontend_only:
                command(['systemctl', 'restart', 'travel'])
            retry(lambda: api_health(local_health), attempts=15, delay=.5)
            if not args.frontend_only and schema_version() != 2:
                raise RuntimeError('Activated release does not use schema2')
            retry(lambda: public_health(new_static), attempts=3, delay=1)
            activate(STATIC / 'previous', old_static)
            activate(BACKEND / 'previous', old_binary)
        except BaseException as original_error:
            # Restore all four links even if the failure occurred while updating previous.
            recovery_errors = []
            if bridge is not None and not bridge_verified:
                recovery_errors.append('Compatible schema2 bridge retained after failed verification; schema1 binary will not be restored')
            for link, original in originals.items() if switched else ():
                try:
                    activate(link, original)
                except Exception as error:
                    recovery_errors.append(str(error))
            if switched and not args.frontend_only:
                try:
                    command(['systemctl', 'restart' if recovery_active else 'stop', 'travel'])
                    if recovery_active:
                        retry(lambda: api_health(local_health), attempts=15, delay=.5)
                except Exception as error:
                    recovery_errors.append(str(error))
            if not args.rollback:
                for path in (new_static, new_binary):
                    # Never delete a candidate if restoration left any managed link pointing at it.
                    if path not in {link.resolve() for link in links if link.is_symlink()}:
                        try:
                            shutil.rmtree(path)
                        except Exception as error:
                            recovery_errors.append(str(error))
            if recovery_errors:
                raise RuntimeError('Deployment failed (' + str(original_error) + ') and recovery needs attention: ' + '; '.join(recovery_errors)) from original_error
            raise
        prune_releases(STATIC)
        prune_releases(BACKEND)
        if not args.frontend_only:
            prune_backups()
        print(('Rollback' if args.rollback else 'Deploy') + ' OK: ' + URL)
        print('Frontend only: backend not restarted; database not accessed' if args.frontend_only else 'Consistent backup retained: ' + str(backup_path))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('Travel deployment failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
