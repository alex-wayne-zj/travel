#!/usr/bin/env python3
"""Exercise the release binary through real loopback HTTP and its local CLI.
Uses a private temporary database and never prints credentials or session tokens.
"""
import argparse
from datetime import datetime, timezone
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
            draft['days'][0]['events'] = [
                {'id': f'place-{index}', 'title': kind, 'kind': kind,
                 'slot': 'morning' if index % 2 == 0 else 'afternoon',
                 'lat': -33.86, 'lng': 151.21, 'note': ''}
                for index, kind in enumerate(['nature', 'visit', 'shopping', 'activity'])]
            assert request('POST', '/api/trips', draft, cookie)[0] == 403
            assert request('POST', '/api/trips', draft, cookie, csrf, 'https://evil.test')[0] == 403
            status, trip, _ = request('POST', '/api/trips', draft, cookie, csrf)
            assert status == 201 and trip['version'] == 1 and trip['packing']['baseItems']
            assert trip['days'] == draft['days']
            api_path = '/api/trips/' + trip['id']
            draft['version'] = 1
            draft['days'][0]['events'].reverse()
            save_started = time.perf_counter()
            status, saved, _ = request('PUT', api_path, draft, cookie, csrf)
            print(f'Save HTTP latency: {(time.perf_counter()-save_started)*1000:.1f} ms')
            assert status == 200 and saved['version'] == 2
            assert saved['days'] == draft['days']
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
            # Template + current packing are one transaction, preserving this trip's choices.
            own_template = request('GET', '/api/packing-template', cookie=friend_cookie)[1]
            friend_trip = request('GET', '/api/trips/' + friend_id, cookie=friend_cookie)[1]
            original = json.loads(json.dumps(friend_trip))
            sibling_input = {k: v for k, v in draft.items() if k != 'version'}
            status, sibling, _ = request('POST', '/api/trips', sibling_input, friend_cookie, friend_csrf)
            assert status == 201
            packing = friend_trip['packing']
            kept, removed = own_template['items'][:2]
            packing.update(extraItems=[{'id': 'private-extra', 'label': 'Private', 'category': 'Extra'}],
                           checkedIds=[kept['id'], removed['id'], 'private-extra'],
                           hiddenBaseIds=[kept['id'], removed['id']], notes='unsaved private reminder')
            own_template['items'] = [{**kept, 'label': 'Updated'}, {'id': 'new-base', 'label': 'New', 'category': 'Base'}]
            own_template['notes'] = 'Updated shared reminder'
            payload = {**own_template, 'currentTrip': {'id': friend_id, 'version': 999, 'packing': packing}}
            assert request('PUT', '/api/packing-template', payload, friend_cookie, friend_csrf)[0] == 409
            assert request('GET', '/api/packing-template', cookie=friend_cookie)[1]['version'] == own_template['version']
            payload['currentTrip']['version'] = original['version']
            payload['version'] -= 1
            assert request('PUT', '/api/packing-template', payload, friend_cookie, friend_csrf)[0] == 409
            assert request('GET', '/api/trips/' + friend_id, cookie=friend_cookie)[1] == original
            payload['version'] += 1
            payload['currentTrip']['id'] = trip['id']
            assert request('PUT', '/api/packing-template', payload, friend_cookie, friend_csrf)[0] == 404
            payload['currentTrip']['id'] = friend_id
            status, applied, _ = request('PUT', '/api/packing-template', payload, friend_cookie, friend_csrf)
            assert status == 200 and applied['trip']['version'] == original['version'] + 1
            result = applied['trip']['packing']
            assert result['baseItems'] == own_template['items'] and result['baseNotes'] == own_template['notes']
            assert result['checkedIds'] == [kept['id'], 'private-extra'] and result['hiddenBaseIds'] == [kept['id']]
            assert result['extraItems'] == packing['extraItems'] and result['notes'] == packing['notes']
            assert request('GET', '/api/trips/' + sibling['id'], cookie=friend_cookie)[1] == sibling
            assert request('DELETE', '/api/trips/' + sibling['id'], {'version': 1}, friend_cookie, friend_csrf)[0] == 204
            future = {k: v for k, v in draft.items() if k != 'version'}
            status, created, _ = request('POST', '/api/trips', future, friend_cookie, friend_csrf)
            assert status == 201 and created['packing']['baseItems'] == own_template['items']
            assert created['packing']['baseNotes'] == own_template['notes']
            assert request('GET', api_path, cookie=cookie)[1] == saved
            assert request('DELETE', '/api/trips/' + created['id'], {'version': 1}, friend_cookie, friend_csrf)[0] == 204
            assert request('DELETE', '/api/trips/' + friend_id, {'version': applied['trip']['version']}, friend_cookie, friend_csrf)[0] == 204
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
            # Preseed today's persistent forecast, then restart the actual process.
            today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
            weather_updated = int(time.time()) - 23 * 3600
            weather_body = {'updated': weather_updated, 'retry_after': 0, 'data': {'daily': {
                'time': ['2026-10-12'], 'weather_code': [3], 'temperature_2m_min': [12],
                'temperature_2m_max': [19], 'precipitation_probability_max': [30]}}}
            with sqlite3.connect(root / 'travel.db') as cache_db:
                weather_trip = json.loads(cache_db.execute('SELECT body FROM trips WHERE id=?', (trip['id'],)).fetchone()[0])
                weather_trip['days'][0]['date'] = today
                weather_body['data']['daily']['time'] = [today]
                cache_db.execute('UPDATE trips SET body=? WHERE id=?', (json.dumps(weather_trip), trip['id']))
                cache_db.execute('INSERT INTO weather_cache VALUES(?,?,?)', ('-33.860,151.210', weather_updated, json.dumps(weather_body)))
            stop()
            start()
            weather_started = time.perf_counter()
            status, forecast, _ = request('GET', api_path + '/weather/day-1', cookie=cookie)
            assert status == 200 and forecast['status'] == 'ready' and forecast['updatedAt'] == weather_updated
            assert forecast['low'] == 12 and forecast['high'] == 19 and not forecast['stale']
            assert time.perf_counter() - weather_started < 1, 'persisted forecast should not contact provider'
            with sqlite3.connect(root / 'travel.db') as cache_db:
                cache_db.execute('UPDATE trips SET body=? WHERE id=?', (json.dumps(saved), trip['id']))
            print('PASS: 23-hour forecast survives process restart without refreshing')
            status, restored, _ = request('GET', api_path, cookie=cookie)
            assert status == 200 and restored['version'] == 2
            assert restored['days'] == draft['days']
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
