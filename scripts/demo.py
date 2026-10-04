"""Loopback-only demonstration with actual local HTTP probes, never cloud writes."""
import argparse
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import socket
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from monitor import build_snapshot, collect, extend_history, LocalStore
from alerts import STATE_KEY, Webhook, dispatch, reconcile, validate_state, public_view

SCENARIOS = ('healthy', 'degraded', 'outage', 'stale', 'recovered')


class DemoState:
    def __init__(self, port, directory):
        self.scenario = 'healthy'
        self.lock = threading.Lock()
        self.collection_lock = threading.Lock()
        self.receiver_lock = threading.Lock()
        self.receiver_mode = 'available'
        self.store = LocalStore(directory)
        self.sender = Webhook(f'http://127.0.0.1:{port}/api/notifications')
        self.snapshot = {}
        self.history = {}
        self.endpoints = [{'id': key, 'name': name, 'url': f'http://127.0.0.1:{port}/fixtures/{key}', 'timeout_seconds': 2, 'degraded_after_ms': 150}
                          for key, name in [('storefront', 'Storefront'), ('api', 'Orders API'), ('identity', 'Identity service'), ('queue', 'Worker health')]]

    def sample(self):
        with self.collection_lock:
            with self.lock:
                if self.scenario == 'stale' and self.snapshot:
                    return
                previous = self.snapshot
            alert_state = validate_state(self.store.read(STATE_KEY))
            previous = alert_state['checkpoint'] or previous
            snapshot = build_snapshot(collect(self.endpoints), previous, mode='demo', interval_seconds=5)
            self.store.write(STATE_KEY, reconcile(alert_state, snapshot))
            with self.lock:
                self.snapshot = snapshot
                self.history = extend_history(self.history, snapshot)
            dispatch(self.store, self.sender, base_delay=1)

    def retry(self):
        with self.collection_lock:
            return dispatch(self.store, self.sender, base_delay=1)

    def alerts(self):
        with self.receiver_lock:
            receipts = self.store.read('receiver_receipts.json').get('receipts', [])
            mode = self.receiver_mode
        return dict(public_view(self.store.read(STATE_KEY)), receiver_mode=mode, receipts=receipts)

    def receive(self, event):
        with self.receiver_lock:
            if self.receiver_mode == 'unavailable':
                return 503
            records = self.store.read('receiver_receipts.json').get('receipts', [])
            existing = next((row for row in records if row['event']['id'] == event['id']), None)
            if existing and existing['event'] != event:
                return 409
            if existing:
                existing['requests'] += 1
            else:
                records.append({'event': event, 'requests': 1})
            self.store.write('receiver_receipts.json', {'receipts': records[-1000:]})
            if self.receiver_mode == 'lose-next-response':
                self.receiver_mode = 'available'
                return None
            return 200

    def set_scenario(self, scenario):
        if scenario not in SCENARIOS:
            raise ValueError('Unknown demo scenario.')
        with self.collection_lock:
            with self.lock:
                self.scenario = scenario
                if scenario == 'stale' and self.snapshot:
                    self.snapshot = dict(self.snapshot)
                    self.snapshot['last_updated'] = (datetime.now(timezone.utc) - timedelta(seconds=45)).isoformat()
        if scenario != 'stale':
            self.sample()


class DemoHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'frontend'), **kwargs)

    def log_message(self, *_):
        pass

    def json_response(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        route = urlsplit(self.path).path
        state = self.server.demo_state
        if route.startswith('/fixtures/'):
            key = route.rsplit('/', 1)[-1]
            with state.lock:
                scenario = state.scenario
            if scenario == 'degraded' and key == 'api':
                time.sleep(.35)
            self.json_response({'service': key}, 503 if scenario == 'outage' and key == 'api' else 200)
        elif route == '/alerts.json':
            self.json_response(state.alerts())
        elif route in ('/status_data.json', '/history.json', '/demo-config.json'):
            with state.lock:
                data = {'mode': 'demo', 'scenario': state.scenario} if route == '/demo-config.json' else state.snapshot if route == '/status_data.json' else state.history
            self.json_response(data)
        elif route in ('/', '/index.html', '/app.js', '/telemetry.js', '/style.css'):
            super().do_GET()
        else:
            self.json_response({'error': 'Not found'}, 404)

    def do_POST(self):
        if self.path not in ('/api/scenario', '/api/receiver', '/api/retry', '/api/notifications'):
            self.json_response({'error': 'Not found'}, 404)
            return
        origin = self.headers.get('Origin')
        allowed_origins = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'}
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json' or (origin and origin not in allowed_origins):
            self.json_response({'error': 'Same-origin JSON requests required'}, 403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 8192:
                raise ValueError('Request too large or empty.')
            payload = json.loads(self.rfile.read(length))
            state = self.server.demo_state
            if self.path == '/api/scenario':
                state.set_scenario(payload['scenario'])
                self.json_response({'ok': True, 'scenario': payload['scenario']})
            elif self.path == '/api/receiver':
                if payload['mode'] not in ('available', 'unavailable', 'lose-next-response'):
                    raise ValueError('Invalid receiver mode.')
                with state.receiver_lock:
                    state.receiver_mode = payload['mode']
                self.json_response({'ok': True})
            elif self.path == '/api/retry':
                state.retry()
                self.json_response({'ok': True})
            else:
                if not isinstance(payload.get('id'), str) or len(payload['id']) != 64 or self.headers.get('Idempotency-Key') != payload['id']:
                    raise ValueError('A matching event ID is required.')
                code = state.receive(payload)
                if code is None:
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                else:
                    self.json_response({'accepted': code == 200}, code)
        except (ValueError, KeyError, TypeError):
            self.json_response({'error': 'Choose a valid local lab request.'}, 400)


def create_server(port=8791, directory=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), DemoHandler)
    if directory is None:
        server.temporary_state = tempfile.TemporaryDirectory(prefix='sentinel-lab-')
        directory = server.temporary_state.name
    server.demo_state = DemoState(server.server_port, directory)
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--state-dir', type=Path, help='Private durable notification state; defaults to work/lab-<port>.')
    args = parser.parse_args()
    server = create_server(args.port, args.state_dir or ROOT / 'work' / f'lab-{args.port}')
    stopping = threading.Event()
    def sample_loop():
        while not stopping.is_set():
            server.demo_state.sample()
            server.demo_state.retry()
            stopping.wait(5)
    worker = threading.Thread(target=sample_loop, daemon=True)
    worker.start()
    print(f'Sentinel local demo: http://127.0.0.1:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stopping.set()
        server.server_close()


if __name__ == '__main__':
    main()
