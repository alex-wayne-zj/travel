#!/usr/bin/python3
"""Bounded, serialized region extraction. Input is JSON {days: Day[]} on stdin."""
import argparse
import ctypes
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

MIB = 1024 * 1024
PACK_LIMIT = 16 * MIB
CACHE_LIMIT = 256 * MIB
JOB_LIMIT = 128 * MIB
FILE_LIMIT = 180
JOB_SECONDS = 180
PACK_SECONDS = 90
TILE_BUDGET = 128
FILE_NAME = re.compile(r'[a-f0-9]{64}\.pmtiles\Z')
HOSTS = {'build.protomaps.com', 'maps.protomaps.com'}

def source_config(path):
    meta = path.stat()
    if (not path.is_file() or meta.st_size > 4096 or meta.st_mode & 0o022
            or (path == Path('/etc/travel/map-source.json') and meta.st_uid != 0)):
        raise ValueError('Map source configuration must be a small, non-writable-by-others file')
    source = json.loads(path.read_text())
    if set(source) != {'url', 'version'}:
        raise ValueError('Map source configuration requires only url and version')
    url, version = source['url'], source['version']
    if not isinstance(url, str) or len(url) > 500 or not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', version):
        raise ValueError('Invalid fixed map source configuration')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not re.fullmatch(r'/[A-Za-z0-9_.-]+\.pmtiles', parsed.path)):
        raise ValueError('Map source must be a fixed official HTTPS PMTiles archive')
    return source

def coordinates(days):
    result = []
    for day in days:
        points = []
        events = day.get('events')
        if not isinstance(events, list) or len(events) > 40:
            raise ValueError('Each day requires at most 40 events')
        for event in events:
            if not isinstance(event, dict):
                raise ValueError('Invalid event')
            for place in [event] + ([event['to']] if 'to' in event and event['to'] is not None else []):
                if not isinstance(place, dict):
                    raise ValueError('Invalid location')
                lat, lng = place.get('lat'), place.get('lng')
                if (isinstance(lat, bool) or isinstance(lng, bool) or not isinstance(lat, (int, float))
                        or not isinstance(lng, (int, float)) or not math.isfinite(lat) or not math.isfinite(lng)
                        or abs(lat) > 90 or abs(lng) > 180):
                    raise ValueError('Coordinates must be finite and within geographic bounds')
                points.append((lng, max(-85.051128, min(85.051128, lat))))
        result.append(points)
    return result

def bounds_for(points):
    if not points:
        return None
    west, east = min(p[0] for p in points), max(p[0] for p in points)
    south, north = min(p[1] for p in points), max(p[1] for p in points)
    # A crossing of the date line uses a broad low-detail box, rather than an invalid wrapped bbox.
    padding_x = max(.018, (east - west) * .12)
    padding_y = max(.012, (north - south) * .12)
    return [round(max(-180, west - padding_x), 5), round(max(-85.051128, south - padding_y), 5),
            round(min(180, east + padding_x), 5), round(min(85.051128, north + padding_y), 5)]

def tile_count(bounds, zoom):
    west, south, east, north = bounds
    total = 0
    for z in range(zoom + 1):
        size = 2 ** z
        def x(lng):
            return max(0, min(size - 1, math.floor((lng + 180) / 360 * size)))
        def y(lat):
            r = math.radians(lat)
            return max(0, min(size - 1, math.floor((1 - math.asinh(math.tan(r)) / math.pi) / 2 * size)))
        total += (x(east) - x(west) + 1) * (y(south) - y(north) + 1)
    return total

def profile(points, source):
    bounds = bounds_for(points)
    if bounds is None:
        return None
    zoom = 14
    if bounds[2] - bounds[0] > 180:
        zoom = 3
    while zoom > 0 and tile_count(bounds, zoom) > TILE_BUDGET:
        zoom -= 1
    return pack_profile(bounds, zoom, source)

def pack_profile(bounds, zoom, source):
    encoded = json.dumps({'source': source, 'bounds': bounds, 'maxZoom': zoom, 'profile': 1}, sort_keys=True, separators=(',', ':'))
    name = hashlib.sha256(encoded.encode()).hexdigest()
    return {'url': '/map-packs/' + name + '.pmtiles', 'bounds': bounds, 'maxZoom': zoom, '_name': name}

def valid_pack(path):
    try:
        if path.is_symlink() or not path.is_file() or not 127 <= path.stat().st_size <= PACK_LIMIT:
            return False
        with path.open('rb') as f:
            return f.read(8) == b'PMTiles\x03'
    except FileNotFoundError:
        # A read-only cache lookup can overlap quota eviction by the serialized writer.
        return False

def controlled_files(cache):
    return [p for p in cache.iterdir() if FILE_NAME.fullmatch(p.name) and p.is_file() and not p.is_symlink()]

def prune(cache, protected, needed=0, new_files=0):
    files = controlled_files(cache)
    size = sum(p.stat().st_size for p in files)
    count = len(files)
    for path in sorted(files, key=lambda p: (p.stat().st_mtime_ns, p.name)):
        if size + needed <= CACHE_LIMIT and count + new_files <= FILE_LIMIT:
            break
        if path.name in protected:
            continue
        old_size = path.stat().st_size
        path.unlink()
        size -= old_size
        count -= 1
    if size + needed > CACHE_LIMIT or count + new_files > FILE_LIMIT:
        raise RuntimeError('Map cache quota exhausted by the requested regions')

def child_limits(parent_pid):
    # Rust can kill this Python process with SIGKILL on cancellation. Make Linux kill
    # the downloader too, before the global lock is released for another request.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), 'Cannot enforce downloader parent-death termination')
    if os.getppid() != parent_pid:
        os.kill(os.getpid(), signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_FSIZE, (PACK_LIMIT, PACK_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
    os.setsid()

def cli_run(arguments, timeout):
    environment = os.environ.copy()
    environment.update({'GOMEMLIMIT': '64MiB', 'GOMAXPROCS': '2'})
    # Logs are bounded by the same file-size limit; never expose a private journey in diagnostics.
    with tempfile.TemporaryFile() as log:
        parent_pid = os.getpid()
        process = subprocess.Popen(arguments, stdout=log, stderr=log, env=environment,
                                   preexec_fn=lambda: child_limits(parent_pid))
        try:
            status = process.wait(timeout=timeout)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        if status:
            log.seek(0)
            detail = log.read(2048).decode(errors='replace').strip()
            raise RuntimeError(f'PMTiles command failed ({status}): {detail}')
        log.seek(0)
        return log.read(65536).decode(errors='replace')

def find_cached(pack, source, cache):
    # A prior extraction may have lowered detail to respect the byte limit.
    for zoom in range(pack['maxZoom'], -1, -1):
        candidate = pack_profile(pack['bounds'], zoom, source)
        if valid_pack(cache / (candidate['_name'] + '.pmtiles')):
            pack.update(candidate)
            return True
    return False

def create_pack(pack, source, cache, tool, deadline, protected):
    destination = cache / (pack['_name'] + '.pmtiles')
    if valid_pack(destination):
        os.utime(destination, None)
        return 0
    if destination.exists() or destination.is_symlink():
        raise RuntimeError('Existing managed map pack is invalid; inspect it before retrying')
    prune(cache, protected, PACK_LIMIT, 1)
    if shutil.disk_usage(cache).free < PACK_LIMIT + 32 * MIB:
        raise RuntimeError('Insufficient free disk space for a bounded map extraction')
    pack_deadline = min(deadline, time.monotonic() + PACK_SECONDS)
    remaining = pack_deadline - time.monotonic()
    if remaining <= 1:
        raise RuntimeError('Map extraction job exceeded 180 seconds')
    fd, temporary = tempfile.mkstemp(prefix='.travel-map-', suffix='.pmtiles.tmp', dir=cache)
    os.close(fd)
    pending = Path(temporary)
    pending.unlink()  # CLI creates its own output; only the containing cache directory is trusted.
    try:
        while True:
            remaining = pack_deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError('Map extraction exceeded its time budget')
            estimate = cli_run([str(tool), 'extract', source['url'], str(pending),
                               '--bbox=' + ','.join(str(n) for n in pack['bounds']),
                               '--maxzoom=' + str(pack['maxZoom']), '--download-threads=2',
                               '--overfetch=0', '--dry-run'], remaining)
            match = re.search(r'archive size of ([0-9.]+)\s*(B|kB|MB|GB)\b', estimate)
            if not match:
                raise RuntimeError('Pinned CLI did not report the extraction size')
            estimated_bytes = float(match[1]) * {'B': 1, 'kB': 1000, 'MB': 1000000, 'GB': 1000000000}[match[2]]
            # CLI rounds estimates; leave space for header/index and that rounding.
            if estimated_bytes <= 14 * MIB:
                break
            if pack['maxZoom'] == 0:
                raise RuntimeError('Even the coarsest map exceeds the per-pack byte budget')
            pack.update(pack_profile(pack['bounds'], pack['maxZoom'] - 1, source))
        destination = cache / (pack['_name'] + '.pmtiles')
        protected.add(destination.name)
        if valid_pack(destination):
            os.utime(destination, None)
            return 0
        if destination.exists() or destination.is_symlink():
            raise RuntimeError('Existing managed map pack is invalid; inspect it before retrying')
        remaining = pack_deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Map extraction exceeded its time budget')
        cli_run([str(tool), 'extract', source['url'], str(pending),
                 '--bbox=' + ','.join(str(n) for n in pack['bounds']), '--maxzoom=' + str(pack['maxZoom']),
                 '--download-threads=2', '--overfetch=0'], min(PACK_SECONDS, remaining))
        if not valid_pack(pending):
            raise RuntimeError('Downloaded map pack has an invalid header or exceeds 16 MiB')
        remaining = pack_deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('Map extraction exceeded its time budget')
        cli_run([str(tool), 'verify', str(pending)], min(10, remaining))
        size = pending.stat().st_size
        os.chmod(pending, 0o644)
        with pending.open('rb') as f:
            os.fsync(f.fileno())
        os.replace(pending, destination)
        return size
    finally:
        pending.unlink(missing_ok=True)

def run(args):
    raw = sys.stdin.buffer.read(MIB + 1)
    if len(raw) > MIB:
        raise ValueError('Map request exceeds 1 MiB')
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {'days'}:
        raise ValueError('Input requires only days')
    days = request['days']
    if not isinstance(days, list) or not 1 <= len(days) <= 60:
        raise ValueError('Map request requires 1 to 60 days')
    ids = set()
    for day in days:
        if not isinstance(day, dict) or not isinstance(day.get('id'), str) or not re.fullmatch(r'[A-Za-z0-9_.:-]{1,80}', day['id']) or day['id'] in ids:
            raise ValueError('Invalid or duplicate day ID')
        ids.add(day['id'])
    source = source_config(args.config)
    points = coordinates(days)
    overview = profile([p for ps in points for p in ps], source)
    profiles = {d['id']: profile(ps, source) for d, ps in zip(days, points)}
    all_profiles = [p for p in [overview, *profiles.values()] if p]
    for pack in all_profiles:
        find_cached(pack, source, args.cache)
    unique = {p['_name']: p for p in all_profiles}
    # Share canonical objects so overview/day duplicates also receive adaptive zoom changes.
    if overview:
        overview = unique[overview['_name']]
    profiles = {identifier: unique[pack['_name']] if pack else None for identifier, pack in profiles.items()}
    result = {'overview': None, 'days': {}, 'missing': []}
    def collect():
        for is_overview, identifier, pack in [(True, 'overview', overview),
                                               *((False, identifier, pack) for identifier, pack in profiles.items())]:
            if pack and valid_pack(args.cache / (pack['_name'] + '.pmtiles')):
                public = {key: value for key, value in pack.items() if not key.startswith('_')}
                if is_overview:
                    result['overview'] = public
                else:
                    result['days'][identifier] = public
            else:
                result['missing'].append({'id': identifier, 'reason': 'not-cached' if pack else 'no-events'})
    if args.cached_only:
        collect()
        return result
    if not args.tool.is_file() or not os.access(args.tool, os.X_OK):
        raise RuntimeError('Pinned PMTiles CLI is not installed')
    args.cache.mkdir(parents=True, exist_ok=True, mode=0o755)
    if args.cache.is_symlink():
        raise RuntimeError('Map cache must be a real managed directory')
    with (args.cache / '.map-pack.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise RuntimeError('Another map extraction job is running; retry later') from e
        deadline = time.monotonic() + JOB_SECONDS
        # A killed job can leave its disposable output; the lock guarantees no active writer.
        for pending in args.cache.iterdir():
            if (re.fullmatch(r'\.travel-map-[a-z0-9_]{8}\.pmtiles\.tmp', pending.name)
                    and pending.is_file() and not pending.is_symlink()):
                pending.unlink()
        job_bytes = 0
        protected = {name + '.pmtiles' for name in unique}
        prune(args.cache, protected)
        for pack in unique.values():
            if not valid_pack(args.cache / (pack['_name'] + '.pmtiles')) and job_bytes + PACK_LIMIT > JOB_LIMIT:
                raise RuntimeError('Map extraction would exceed the 128 MiB job budget')
            job_bytes += create_pack(pack, source, args.cache, args.tool, deadline, protected)
        collect()
    return result

def main():
    def interrupted(signum, frame):
        raise RuntimeError('Map extraction interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cached-only', action='store_true')
    parser.add_argument('--cache', type=Path, default=Path('/var/cache/travel/maps'))
    parser.add_argument('--config', type=Path, default=Path('/etc/travel/map-source.json'))
    parser.add_argument('--tool', type=Path, default=Path('/usr/local/bin/travel-pmtiles'))
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False, separators=(',', ':')))
    except Exception as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
