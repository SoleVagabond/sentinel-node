"""Explicit, bounded live-network verification of the portable application.

This is not part of the offline test suite. Public HTTP requests require the
--allow-public-http flag. Notifications go only to this script's local receiver.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import package_app


class Control:
    def __init__(self, output):
        self.lock = threading.RLock()
        self.behavior = 'healthy'
        self.receiver = 'available'
        self.receipts = {}
        self.trap_requests = 0
        self.output = output


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body=b'{}', **headers):
        try:
            self.send_response(code)
            for name, value in headers.items():
                self.send_header(name.replace('_', '-'), value)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        control = self.server.control
        if self.path == '/malformed':
            self.wfile.write(b'NOT HTTP\r\n\r\n')
            self.close_connection = True
            return
        if self.path == '/headers-only':
            self.send(200, b'', Content_Length='10000000')
            return
        if self.path == '/trap':
            control.trap_requests += 1
        with control.lock:
            behavior = control.behavior
        if behavior in ('slow', 'concurrency'):
            time.sleep(.35)
        elif behavior == 'timeout':
            time.sleep(2)
        self.send(503 if behavior == 'outage' else 200)

    def do_POST(self):
        control = self.server.control
        with control.lock:
            event = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.headers.get('Idempotency-Key') != event['id'] or self.headers.get('Authorization') != 'Bearer local-verification-token':
                self.send(400)
                return
            if control.receiver == 'unavailable':
                self.send(503)
                return
            if control.receiver == 'permanent':
                self.send(400)
                return
            if control.receiver == 'redirect':
                self.send(302, Location=f'http://127.0.0.1:{self.server.server_port}/trap')
                return
            if control.receiver == 'malformed':
                self.wfile.write(b'NOT HTTP\r\n\r\n')
                self.close_connection = True
                return
            previous = control.receipts.get(event['id'])
            if previous and previous['event'] != event:
                self.send(409)
                return
            row = control.receipts.setdefault(event['id'], {'event': event, 'requests': 0})
            row['requests'] += 1
            control.output.write_text(json.dumps(control.receipts, indent=2), encoding='utf-8')
            if control.receiver == 'lose':
                control.receiver = 'available'
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send(200)


class Audit:
    def __init__(self, output):
        self.output = output
        self.report = {'started_at': datetime.now(timezone.utc).isoformat(), 'mode': 'live', 'checks': [], 'public_observations': []}
        self.processes = []

    def record(self, name, passed, **detail):
        self.report['checks'].append({'name': name, 'passed': bool(passed), **detail})
        print(f'{"PASS" if passed else "FAIL"}: {name}', flush=True)
        self.save()
        if not passed:
            raise AssertionError(name)

    def save(self):
        (self.output / 'report.json').write_text(json.dumps(self.report, indent=2), encoding='utf-8')

    def start(self, archive, directory):
        env = dict(os.environ, SENTINEL_WEBHOOK_TOKEN='local-verification-token')
        log = (self.output / f'process-{len(self.processes)}.log').open('w', encoding='utf-8')
        process = subprocess.Popen([sys.executable, str(archive), '--port', '0', '--state-dir', str(directory)], stdout=subprocess.PIPE, stderr=log, text=True, env=env)
        self.processes.append((process, log))
        line = process.stdout.readline().strip()
        if not line.startswith('Sentinel application: http://'):
            raise RuntimeError(f'Application did not start; see {log.name}')
        process.stdout.readline()
        self.url = line.split(': ', 1)[1]
        self.process = process
        return self.get('state')

    def stop(self):
        self.process.terminate()
        self.process.wait(10)

    def get(self, route):
        with urlopen(f'{self.url}/api/{route}', timeout=20) as response:
            body = response.read()
            return json.loads(body) if response.headers.get_content_type() == 'application/json' else body

    def post(self, route, payload, expected=200):
        state = self.get('state')
        request = Request(f'{self.url}/api/{route}', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json', 'X-Sentinel-CSRF': state['csrf']})
        try:
            response = urlopen(request, timeout=25)
        except HTTPError as error:
            response = error
        with response:
            result = json.load(response)
            if response.status != expected:
                raise AssertionError(f'{route}: expected {expected}, received {response.status}: {result}')
            return result

    def revise(self, route, **payload):
        payload['revision'] = self.get('state')['config']['revision']
        return self.post(route, payload)

    def add(self, name, url, **options):
        self.revise('service-save', name=name, url=url, expected_statuses=options.pop('expected_statuses', [200]), timeout_seconds=options.pop('timeout_seconds', 8), degraded_after_ms=options.pop('degraded_after_ms', 3000), enabled=True, **options)
        return self.get('state')['config']['services'][-1]['id']

    def check(self):
        self.post('check', {})
        return self.get('state')

    def wait_delivery(self, event_id):
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            row = next(row for row in self.get('state')['deliveries'] if row['event']['id'] == event_id)
            if row['status'] != 'pending':
                return row
            time.sleep(.5)
        raise AssertionError('Real scheduled delivery did not finish within 45 seconds')


def run(output):
    output.mkdir(parents=True, exist_ok=False)
    audit = Audit(output)
    archive = package_app.package(output / 'sentinel.pyz')
    audit.report['archive_sha256'] = sha256(archive.read_bytes()).hexdigest()
    control = Control(output / 'receiver-receipts.json')
    fixture = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    fixture.daemon_threads = True
    fixture.control = control
    fixture_thread = threading.Thread(target=fixture.serve_forever, daemon=True)
    fixture_thread.start()
    local = f'http://127.0.0.1:{fixture.server_port}'
    directory = output / 'state'
    try:
        state = audit.start(archive, directory)
        audit.record('Portable live mode starts empty without demonstration controls', state['demo'] is None and not state['config']['services'])
        audit.revise('settings', monitoring_enabled=False, interval_seconds=3600, retention_days=7)
        config_before = audit.get('state')['config']
        audit.post('webhook', {'revision': config_before['revision'], 'webhook_url': local + '/bad path', 'notifications_enabled': True}, expected=400)
        audit.record('Malformed webhook URL is rejected without changing configuration', audit.get('state')['config'] == config_before)
        cases = [
            ('Portfolio HTTPS', 'https://solevagabond.github.io/', 'Green', 200, None, {}),
            ('Northline HTTPS', 'https://northline-cycle-devin.netlify.app/', 'Green', 200, None, {}),
            ('Expected HTTP 204', 'https://httpbin.org/status/204', 'Green', 204, None, {'expected_statuses': [204]}),
            ('Public HTTP 503', 'https://httpbin.org/status/503', 'Red', 503, 'http_status', {}),
            ('Public redirect', 'https://httpbin.org/redirect/1', 'Green', 200, None, {}),
            ('Untrusted TLS certificate', 'https://self-signed.badssl.com/', 'Red', None, 'tls', {}),
            ('Nonexistent DNS name', 'https://sentinel-check.invalid/', 'Red', None, 'dns', {}),
            ('Public response timeout', 'https://httpbin.org/delay/3', 'Red', None, 'timeout', {'timeout_seconds': .75}),
        ]
        ids = [audit.add(name, url, **options) for name, url, *_rest, options in cases]
        state = audit.check()
        audit.report['public_observations'] = state['snapshot']['endpoints']
        for case, row in zip(cases, state['snapshot']['endpoints']):
            name, _url, status, code, failure, _options = case
            audit.record(name, row['status'] == status and row['status_code'] == code and (not failure or row.get('failure_kind') == failure), observation=row)
        config = state['config']
        audit.post('service-save', {'revision': config['revision'], 'name': 'Ninth', 'url': local, 'enabled': True, 'expected_statuses': [200], 'timeout_seconds': 1, 'degraded_after_ms': 1000}, expected=400)
        audit.record('Ninth service is rejected atomically', audit.get('state')['config'] == config)
        for service_id in ids:
            audit.revise('service-action', id=service_id, action='remove')
        local_id = audit.add('Controlled HTTP service', local + '/health', timeout_seconds=3, degraded_after_ms=100)
        audit.add('Header-only contract', local + '/headers-only', timeout_seconds=1)
        state = audit.check()
        audit.record('Response-header contract returns without reading the announced body', all(row['status'] == 'Green' for row in state['snapshot']['endpoints']))
        audit.revise('webhook', webhook_url=local + '/receiver', notifications_enabled=True)
        control.behavior = 'slow'
        state = audit.check()
        incident = next(row for row in state['incidents'] if row['endpoint_id'] == local_id and not row['resolved_at'])
        audit.record('Actual slow response opens a degraded incident', incident['severity'] == 'Yellow')
        audit.post('incident', {'id': incident['id'], 'acknowledge': True, 'note': 'Controlled real-HTTP investigation note'})
        control.behavior = 'outage'
        state = audit.check()
        incidents = [row for row in state['incidents'] if row['endpoint_id'] == local_id]
        audit.record('HTTP 503 escalates the same incident without duplication', len(incidents) == 1 and incidents[0]['severity'] == 'Red' and not incidents[0]['resolved_at'])
        control.behavior = 'healthy'
        state = audit.check()
        recovered = next(row for row in state['incidents'] if row['id'] == incident['id'])
        events = [row['event']['type'] for row in state['deliveries'] if row['event']['endpoint_id'] == local_id]
        accepted_types = [row['event']['type'] for row in control.receipts.values() if row['event']['endpoint_id'] == local_id]
        audit.record('Recovery preserves acknowledgement and note and sends ordered transitions', recovered['resolved_at'] and recovered['acknowledged_at'] and recovered['note'] == 'Controlled real-HTTP investigation note' and sorted(events) == ['escalated', 'opened', 'recovered'] and accepted_types == ['opened', 'escalated', 'recovered'])
        snapshot_before = state['snapshot']
        control.receiver = 'lose'
        result = audit.post('delivery/test', {})
        event_id = result['delivery']['event']['id']
        audit.record('Receiver saves notification before losing its HTTP reply', result['delivery']['status'] == 'pending' and control.receipts[event_id]['requests'] == 1)
        print('Waiting for the real 30-second retry window...', flush=True)
        started = time.monotonic()
        delivered = audit.wait_delivery(event_id)
        audit.record('Real scheduled retry keeps one receipt from two requests', delivered['status'] == 'delivered' and delivered['attempts'] == 2 and control.receipts[event_id]['requests'] == 2, elapsed_seconds=round(time.monotonic() - started, 2))
        audit.record('Test delivery leaves service observations unchanged', audit.get('state')['snapshot'] == snapshot_before)
        control.receiver = 'unavailable'
        pending = audit.post('delivery/test', {})['delivery']
        old = audit.get('state')
        audit.stop()
        restarted = audit.start(archive, directory)
        audit.record('Restart preserves services, history, notes, and pending delivery', restarted['config'] == old['config'] and restarted['snapshot'] == old['snapshot'] and restarted['incidents'] == old['incidents'] and restarted['deliveries'] == old['deliveries'] and restarted['csrf'] != old['csrf'])
        control.receiver = 'available'
        print('Waiting for the persisted retry due time after restart...', flush=True)
        delivered = audit.wait_delivery(pending['event']['id'])
        audit.record('Queued delivery resumes after process restart', delivered['status'] == 'delivered' and delivered['event']['id'] == pending['event']['id'])
        control.receiver = 'permanent'
        failed = audit.post('delivery/test', {})['delivery']
        audit.record('Permanent receiver rejection stops automatic retry', failed['status'] == 'failed' and failed['attempts'] == 1)
        control.receiver = 'available'
        audit.post('delivery/replay', {'id': failed['event']['id']})
        replayed = next(row for row in audit.get('state')['deliveries'] if row['event']['id'] == failed['event']['id'])
        audit.record('Deliberate replay preserves identity and total attempt audit', replayed['status'] == 'delivered' and replayed['manual_retries'] == 1 and replayed['total_attempts'] == 2)
        control.receiver = 'redirect'
        redirect = audit.post('delivery/test', {})['delivery']
        audit.record('Webhook redirect is rejected without forwarding bearer authentication', redirect['status'] == 'failed' and control.trap_requests == 0)
        control.receiver = 'malformed'
        malformed_delivery = audit.post('delivery/test', {})['delivery']
        audit.record('Malformed receiver response is retained as a pending delivery', malformed_delivery['status'] == 'pending' and malformed_delivery['attempts'] == 1)
        audit.post('delivery/cancel-pending', {})
        control.receiver = 'available'
        malformed_id = audit.add('Malformed response', local + '/malformed', timeout_seconds=1)
        state = audit.check()
        audit.record('Malformed HTTP response does not abort the healthy endpoint', any(row['id'] == malformed_id and row['failure_kind'] == 'request' for row in state['snapshot']['endpoints']) and any(row['id'] == local_id and row['status'] == 'Green' for row in state['snapshot']['endpoints']))
        audit.revise('service-action', id=malformed_id, action='remove')
        control.behavior = 'concurrency'
        concurrency_ids = [audit.add(f'Concurrent local service {index}', local + '/health', timeout_seconds=3, degraded_after_ms=1000) for index in range(6)]
        started = time.monotonic()
        parallel_state = audit.check()
        elapsed = time.monotonic() - started
        summed_latencies = sum(row['latency_ms'] for row in parallel_state['snapshot']['endpoints']) / 1000
        audit.record('Eight configured services execute concurrently', len(parallel_state['snapshot']['endpoints']) == 8 and elapsed < summed_latencies / 2, elapsed_seconds=round(elapsed, 3), sum_probe_seconds=round(summed_latencies, 3))
        for service_id in concurrency_ids:
            audit.revise('service-action', id=service_id, action='remove')
        with ThreadPoolExecutor(max_workers=2) as pool:
            def check_request():
                try:
                    audit.post('check', {})
                    return 'completed'
                except AssertionError as error:
                    return 'already running' if 'already running' in str(error) else str(error)
            results = list(pool.map(lambda _: check_request(), range(2)))
        audit.record('Overlapping manual checks have one writer and a clear rejection', sorted(results) == ['already running', 'completed'])
        control.behavior = 'healthy'
        audit.revise('settings', monitoring_enabled=True, interval_seconds=5, retention_days=7)
        before = audit.get('history')['samples']
        time.sleep(12)
        after = audit.get('history')['samples']
        audit.record('Scheduler produces repeated fresh observations', len(after) >= len(before) + 2 and not audit.get('state')['runner']['error'], added_snapshots=len(after) - len(before))
        audit.revise('settings', monitoring_enabled=False, interval_seconds=5, retention_days=7)
        paused = audit.get('state')['snapshot']['last_updated']
        time.sleep(6)
        audit.record('Paused schedule stops new observations', audit.get('state')['snapshot']['last_updated'] == paused)
        state = audit.check()
        audit.record('Manual check still works with schedule paused', state['snapshot']['last_updated'] != paused)
        backup = audit.get('backup')
        (output / 'sentinel-backup.db').write_bytes(backup)
        csv = audit.get('export.csv')
        (output / 'observations.csv').write_bytes(csv)
        audit.record('Consistent SQLite backup and CSV include actual observations', backup.startswith(b'SQLite format 3\0') and b'Controlled HTTP service' in csv)
        target = output / 'restored'
        restored_result = subprocess.run([sys.executable, str(archive), '--restore', str(output / 'sentinel-backup.db'), '--state-dir', str(target)], capture_output=True, text=True, timeout=15)
        audit.record('Restore command succeeds into a new directory', restored_result.returncode == 0)
        audit.stop()
        restored = audit.start(archive, target)
        audit.record('Restored workspace retains notes and starts with checks and delivery paused', restored['incidents'] == state['incidents'] and not restored['config']['monitoring_enabled'] and not restored['config']['notifications_enabled'])
        second = subprocess.run([sys.executable, str(archive), '--port', '0', '--state-dir', str(target)], capture_output=True, text=True, timeout=10)
        audit.record('Second process cannot share a state directory', second.returncode != 0 and 'Another Sentinel' in second.stderr)
        with sqlite3.connect(target / 'sentinel.db') as database:
            audit.record('Restored database integrity is intact', database.execute('PRAGMA integrity_check').fetchone()[0] == 'ok')
        audit.report['completed_at'] = datetime.now(timezone.utc).isoformat()
    except Exception as error:
        audit.report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        audit.save()
        for process, log in audit.processes:
            if process.poll() is None:
                process.terminate()
                process.wait(10)
            process.stdout.close()
            log.close()
        fixture.shutdown()
        fixture.server_close()
        fixture_thread.join(3)
    print(f'Completed {len(audit.report["checks"])} live verification workflows. Evidence: {output}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-public-http', action='store_true', help='Explicitly allow bounded requests to the named public verification targets.')
    parser.add_argument('--output', type=Path, default=ROOT / 'work' / datetime.now().strftime('live-verification-%Y%m%d-%H%M%S'))
    args = parser.parse_args()
    if not args.allow_public_http:
        parser.error('Public network verification requires --allow-public-http.')
    run(args.output.resolve())
