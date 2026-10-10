#!/usr/bin/env python3
"""Exercise the release binary through real loopback HTTP and its local CLI.
Uses a private temporary database and never prints credentials or session tokens.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import sqlite3
import stat
import subprocess
import tempfile
import time


def run(binary: Path) -> None:
    with tempfile.TemporaryDirectory(prefix='travel-runtime-') as folder:
        root = Path(folder)
        password = secrets.token_urlsafe(24)
        replacement = secrets.token_urlsafe(24)
        pw = root / 'password'
        pw.write_text(password + '\n')
        pw.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        map_script = root / 'map-fixture.py'
        map_record = root / 'map-input.json'
        delay_flag = root / 'slow-map'
        started = root / 'map-started'
        map_script.write_text("""import json,sys,time
from pathlib import Path
root=Path(__file__).parent
request=json.load(sys.stdin)
assert set(request)=={'days'}
for d in request['days']:
 assert set(d)=={'id','events'}
 for e in d['events']:
  assert set(e).issubset({'lat','lng','to'})
  if 'to' in e: assert set(e['to'])=={'lat','lng'}
(root/'map-input.json').write_text(json.dumps(request))
if (root/'slow-map').exists():
 (root/'map-started').write_text('started')
 time.sleep(1.5)
pack={'url':'/map-packs/'+'a'*64+'.pmtiles','bounds':[0,0,1,1],'maxZoom':8}
cached='--cached-only' in sys.argv
print(json.dumps({'overview':None if cached else pack,'days':{} if cached else {d['id']:pack for d in request['days'] if d['events']},'missing':[{'id':d['id'],'reason':'not-cached' if d['events'] else 'no-events'} for d in request['days'] if cached or not d['events']]},separators=(',',':')))
""")
        env = dict(os.environ, TRAVEL_DB_PATH=str(root / 'travel.db'),
                   TRAVEL_BIND=f'127.0.0.1:{port}', TRAVEL_ORIGIN=origin,
                   TRAVEL_SECURE_COOKIE='false', TRAVEL_MAP_PACK_SCRIPT=str(map_script))

        def cli(*args: str, good: bool = True) -> None:
            result = subprocess.run([str(binary), *args], env=env, capture_output=True, text=True, timeout=20)
            assert (result.returncode == 0) == good, f'CLI failed: {args[0]}'
            assert password not in result.stdout + result.stderr
            assert replacement not in result.stdout + result.stderr

        def request(method: str, path: str, data=None, cookie=None, csrf=None, source=origin):
            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            headers = {'Content-Type': 'application/json'}
            if source is not None:
                headers['Origin'] = source
            if cookie:
                headers['Cookie'] = cookie
            if csrf:
                headers['X-CSRF-Token'] = csrf
            conn.request(method, path, body=json.dumps(data) if data is not None else None, headers=headers)
            response = conn.getresponse()
            status, raw_cookie = response.status, response.getheader('Set-Cookie')
            body = response.read()
            conn.close()
            return status, json.loads(body) if body else None, raw_cookie

        process = None

        def start():
            nonlocal process
            process = subprocess.Popen([str(binary)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(100):
                assert process.poll() is None, 'server exited during startup'
                try:
                    if request('GET', '/api/health')[0] == 200:
                        return
                except OSError:
                    pass
                time.sleep(.05)
            raise AssertionError('server startup timeout')

        def stop():
            nonlocal process
            if process is not None:
                process.send_signal(signal.SIGTERM)
                process.wait(timeout=10)
                assert process.returncode == 0, 'graceful shutdown failed'
                process = None

        cli('init-admin', '--username', 'admin', '--password-file', str(pw))
        cli('init-admin', '--username', 'admin', '--password-file', str(pw), good=False)
        assert stat.S_IMODE((root / 'travel.db').stat().st_mode) == 0o600
        legacy = root / 'schema1.db'
        with sqlite3.connect(legacy) as old:
            old.execute('PRAGMA user_version=1')
            old.execute('CREATE TABLE marker(value TEXT)')
            old.execute("INSERT INTO marker VALUES('legacy snapshot')")
        result = subprocess.run([str(binary), 'backup', '--output', str(root / 'schema1-backup.db')],
            env=dict(env, TRAVEL_DB_PATH=str(legacy)), capture_output=True, timeout=20)
        assert result.returncode == 0
        for database in [legacy, root / 'schema1-backup.db']:
            with sqlite3.connect(database) as snapshot:
                assert snapshot.execute('PRAGMA user_version').fetchone()[0] == 1
                assert snapshot.execute('SELECT value FROM marker').fetchone()[0] == 'legacy snapshot'
                assert snapshot.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='invites'").fetchone()[0] == 0
        try:
            start()
            assert request('GET', '/api/session')[1] == {'authenticated': False}
            assert request('GET', '/api/trips')[0] == 401
            assert request('POST', '/api/login', {'username': 'admin', 'password': password}, source=None)[0] == 403
            status, session, cookie = request('POST', '/api/login', {'username': 'admin', 'password': password})
            assert status == 200 and session['authenticated']
            assert cookie and 'HttpOnly' in cookie and 'SameSite=Strict' in cookie and cookie.startswith('travel_session=')
            cookie = cookie.split(';')[0]
            csrf = session['csrfToken']
            draft = {'name': 'Runtime smoke plan', 'destination': 'Germany', 'startDate': '2026-10-12',
                     'endDate': '2026-10-12', 'timezone': 'Europe/Berlin',
                     'days': [{'id': 'day-1', 'date': '2026-10-12', 'city': '', 'title': '', 'events': []}],
                     'packing': {'extraItems': [], 'checkedIds': [], 'hiddenBaseIds': [], 'notes': ''}}
            assert request('POST', '/api/trips', draft, cookie)[0] == 403
            assert request('POST', '/api/trips', draft, cookie, csrf, 'https://evil.test')[0] == 403
            status, trip, _ = request('POST', '/api/trips', draft, cookie, csrf)
            assert status == 201 and trip['version'] == 1 and trip['packing']['baseItems']
            api_path = '/api/trips/' + trip['id']
            draft['version'] = 1
            status, saved, _ = request('PUT', api_path, draft, cookie, csrf)
            assert status == 200 and saved['version'] == 2
            assert request('PUT', api_path, draft, cookie, csrf)[0] == 409
            assert session['role'] == 'admin'
            status, invites, _ = request('GET', '/api/invites', cookie=cookie)
            assert status == 200
            demo_alice = next(i for i in invites['invites'] if i['name'] == 'DemoAlice')
            assert not demo_alice['enabled'] and not demo_alice['hasCode']
            friend_code = secrets.token_urlsafe(24)
            status, invitation, _ = request('PUT', '/api/invites/' + demo_alice['id'],
                {'name': 'DemoAlice', 'enabled': True, 'version': demo_alice['version'], 'code': friend_code}, cookie, csrf)
            assert status == 200 and friend_code not in json.dumps(invitation)
            status, friend_session, friend_cookie = request('POST', '/api/invite-login', {'name': 'ｄｅｍｏａｌｉｃｅ', 'code': friend_code})
            assert status == 200 and friend_session['role'] == 'friend'
            friend_cookie = friend_cookie.split(';')[0]
            friend_csrf = friend_session['csrfToken']
            assert request('GET', api_path, cookie=friend_cookie)[0] == 404
            status, friend_list, _ = request('GET', '/api/trips', cookie=friend_cookie)
            assert status == 200 and len(friend_list['trips']) == 1
            friend_id = friend_list['trips'][0]['id']
            assert request('GET', '/api/trips/' + friend_id, cookie=cookie)[0] == 404
            map_api = '/api/trips/' + friend_id + '/map-pack'
            assert request('GET', map_api, cookie=cookie)[0] == 404
            assert not map_record.exists()
            status, manifest, _ = request('GET', map_api, cookie=friend_cookie)
            assert status == 200 and manifest['overview'] is None
            assert request('POST', map_api, {}, friend_cookie)[0] == 403
            status, manifest, _ = request('POST', map_api, {}, friend_cookie, friend_csrf)
            assert status == 200 and manifest['overview']['url'].startswith('/map-packs/')
            assert all(set(d) == {'id', 'events'} for d in json.loads(map_record.read_text())['days'])
            # Closing the request must not release the single download slot while its child runs.
            delay_flag.touch()
            disconnected = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            disconnected.request('POST', map_api, '{}', {'Cookie': friend_cookie, 'Origin': origin,
                'X-CSRF-Token': friend_csrf, 'Content-Type': 'application/json'})
            for _ in range(100):
                if started.exists():
                    break
                time.sleep(.02)
            assert started.exists()
            disconnected.close()
            assert request('POST', map_api, {}, friend_cookie, friend_csrf)[0] == 429
            time.sleep(1.7)
            delay_flag.unlink()
            assert request('POST', map_api, {}, friend_cookie, friend_csrf)[0] == 200
            assert request('GET', '/api/invites', cookie=friend_cookie)[0] == 403
            status, own_template, _ = request('GET', '/api/packing-template', cookie=friend_cookie)
            own_template['notes'] = 'friend private packing notes'
            assert request('PUT', '/api/packing-template', own_template, friend_cookie, friend_csrf)[0] == 200
            assert request('GET', '/api/packing-template', cookie=cookie)[1]['notes'] != own_template['notes']
            assert request('DELETE', '/api/trips/' + friend_id, {'version': 1}, friend_cookie, friend_csrf)[0] == 204
            assert request('POST', '/api/logout', cookie=friend_cookie, csrf=friend_csrf)[0] == 204
            status, friend_session, friend_cookie = request('POST', '/api/invite-login', {'name': 'DemoAlice', 'code': friend_code})
            assert status == 200
            friend_cookie = friend_cookie.split(';')[0]
            assert request('GET', '/api/trips', cookie=friend_cookie)[1]['trips'] == []
            cli('backup', '--output', str(root / 'backup.db'))
            cli('backup', '--output', str(root / 'backup.db'), good=False)
            assert stat.S_IMODE((root / 'backup.db').stat().st_mode) == 0o600
            with sqlite3.connect(root / 'backup.db') as backup:
                assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
                assert backup.execute('SELECT version FROM trips WHERE id=?', (trip['id'],)).fetchone()[0] == 2
            stop()
            start()
            status, restored, _ = request('GET', api_path, cookie=cookie)
            assert status == 200 and restored['version'] == 2
            pw.write_text(replacement)
            cli('reset-password', '--username', 'admin', '--password-file', str(pw))
            assert request('GET', api_path, cookie=cookie)[0] == 401
            assert request('GET', '/api/trips', cookie=friend_cookie)[0] == 200
            assert request('POST', '/api/login', {'username': 'admin', 'password': password})[0] == 401
            status, session, cookie = request('POST', '/api/login', {'username': 'admin', 'password': replacement})
            assert status == 200
            cookie = cookie.split(';')[0]
            assert request('DELETE', api_path, {'version': 2}, cookie, session['csrfToken'])[0] == 204
            assert request('GET', api_path, cookie=cookie)[0] == 404
            assert request('POST', '/api/logout', cookie=cookie, csrf=session['csrfToken'])[0] == 204
            assert request('GET', '/api/trips', cookie=cookie)[0] == 401
            for i in range(5):
                status = request('POST', '/api/login', {'username': f'unknown-{i}', 'password': 'wrong'})[0]
                assert status == (429 if i == 4 else 401)
            stop()
            start()
            assert request('POST', '/api/login', {'username': 'admin', 'password': replacement})[0] == 429
            assert request('POST', '/api/invite-login', {'name': 'DemoAlice', 'code': friend_code})[0] == 200
            for i in range(5):
                status = request('POST', '/api/invite-login', {'name': 'DemoAlice', 'code': 'wrong'})[0]
                assert status == (429 if i == 4 else 401)
            stop()
            start()
            assert request('POST', '/api/invite-login', {'name': 'DemoAlice', 'code': friend_code})[0] == 429
        finally:
            stop()
    print('PASS: CLI init/reset/backup, real HTTP auth/CSRF/owner CRUD/templates/invites/map supervision, no reseed, restart persistence, logout, persistent lockout')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, default=Path(__file__).resolve().parents[1] / 'target/release/travel-backend')
    run(parser.parse_args().binary.resolve())
