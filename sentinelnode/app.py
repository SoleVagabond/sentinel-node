"""Single-operator monitoring application. Administration stays on loopback."""
import argparse
from contextlib import closing
import csv
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
import io
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid

SOURCE_BACKEND = Path(__file__).resolve().parents[1] / 'backend'
if SOURCE_BACKEND.is_dir():
    sys.path.insert(0, str(SOURCE_BACKEND))
from monitor import build_snapshot, collect, validate_config
from alerts import STATE_KEY, Webhook, dispatch, enqueue_test, reconcile, validate_destination, validate_state
from .storage import Database


def now():
    return datetime.now(timezone.utc).isoformat()


def bounded_number(value, label, low, high, integer=False):
    import math
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and type(value) is not int):
        raise ValueError(f'{label} must be between {low} and {high}.')
    return value


def checked_config(config):
    if not isinstance(config, dict) or config.get('schema_version') != 1:
        raise ValueError('Unsupported saved configuration.')
    bounded_number(config['interval_seconds'], 'Check interval', 5, 3600, True)
    bounded_number(config['retention_days'], 'History retention', 1, 30, True)
    if type(config['monitoring_enabled']) is not bool or type(config['notifications_enabled']) is not bool:
        raise ValueError('Settings must use true or false.')
    services = config['services']
    if not isinstance(services, list) or len(services) > 8:
        raise ValueError('Configure at most eight services.')
    if services:
        validate_config({'endpoints': services})
    for service in services:
        if not service['name'].strip() or len(service['name']) > 80 or len(service['url']) > 2048 or type(service['enabled']) is not bool:
            raise ValueError('Use a service name of 1–80 characters and a valid enabled setting.')
        try:
            urlsplit(service['url']).port
        except ValueError:
            raise ValueError('Use a valid service port.') from None
        if config['mode'] == 'demo' and urlsplit(service['url']).hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('The demonstration accepts loopback services only. Start the live application for real services.')
    if config['webhook_url']:
        validate_destination(config['webhook_url'])
        if config['mode'] == 'demo' and urlsplit(config['webhook_url']).hostname not in ('localhost', '127.0.0.1', '::1'):
            raise ValueError('Use a loopback receiver in the demonstration.')
    if config['notifications_enabled'] and not config['webhook_url']:
        raise ValueError('Set a webhook URL before enabling delivery.')
    return config


class Application:
    def __init__(self, directory, port, demo=False, interval=None):
        self.store = Database(directory)
        self.port, self.demo = port, demo
        self.csrf = secrets.token_urlsafe(32)
        self.operation = threading.RLock()
        self.fixture_lock = threading.Lock()
        self.fixture = 'healthy'
        self.receiver = 'available'
        self.running = False
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.worker = None
        try:
            config = self.store.read('config')
            if not config:
                config = {'schema_version': 1, 'revision': 1, 'mode': 'demo' if demo else 'live', 'services': [],
                          'interval_seconds': interval or 30, 'retention_days': 7, 'monitoring_enabled': True,
                          'notifications_enabled': False, 'webhook_url': ''}
                if demo:
                    config['services'] = [{'id': key, 'name': name, 'url': f'http://127.0.0.1:{port}/fixtures/{key}',
                                           'enabled': True, 'timeout_seconds': 2, 'degraded_after_ms': 150,
                                           'expected_statuses': [200]} for key, name in [('api', 'Orders API'), ('worker', 'Worker health')]]
                    config.update(interval_seconds=interval or 5, notifications_enabled=True,
                                  webhook_url=f'http://127.0.0.1:{port}/fixtures/notifications')
                self.store.write('config', checked_config(config))
            checked_config(config)
            if config['mode'] != ('demo' if demo else 'live'):
                raise ValueError('Use separate state directories for the application and its demo.')
            if demo:
                for service in config['services']:
                    if urlsplit(service['url']).path == f"/fixtures/{service['id']}" and service['id'] in ('api', 'worker'):
                        service['url'] = f"http://127.0.0.1:{port}/fixtures/{service['id']}"
                if urlsplit(config['webhook_url']).path == '/fixtures/notifications':
                    config['webhook_url'] = f'http://127.0.0.1:{port}/fixtures/notifications'
                self.store.write('config', config)
            validate_state(self.store.read(STATE_KEY))
        except Exception:
            self.store.close()
            raise

    def sender(self, config=None):
        config = config or self.store.read('config')
        if not config['notifications_enabled']:
            return None
        return Webhook(config['webhook_url'], os.environ.get('SENTINEL_WEBHOOK_TOKEN'))

    def check(self):
        if not self.operation.acquire(blocking=False):
            raise ValueError('A check is already running. Wait for its result.')
        self.running = True
        try:
            config = self.store.read('config')
            services = [row for row in config['services'] if row['enabled']]
            if not services:
                self.store.write('runner', {'last_tick': now(), 'error': None})
                return self.store.read('snapshot')
            previous = self.store.read('snapshot')
            outbox = validate_state(self.store.read(STATE_KEY))
            snapshot = build_snapshot(collect(services), outbox['checkpoint'] or previous,
                                      mode='demo' if self.demo else 'live', interval_seconds=config['interval_seconds'])
            updated = reconcile(outbox if config['notifications_enabled'] else dict(outbox, deliveries=[]), snapshot)
            if not config['notifications_enabled']:
                updated['deliveries'] = outbox['deliveries']
            with self.store.transaction():
                self.store.write(STATE_KEY, updated)
                self.store.write('snapshot', snapshot)
                self.store.save_observation(snapshot, config['retention_days'])
                self.store.write('runner', {'last_tick': now(), 'error': None})
            self._drain(config)
            return snapshot
        except (OSError, ValueError, sqlite3.Error) as error:
            self.store.write('runner', {'last_tick': now(), 'error': f'Check failed ({type(error).__name__}). Previous observations are retained; the next scheduled check will try again.'})
            raise
        finally:
            self.running = False
            self.operation.release()

    def _drain(self, config=None):
        sender = self.sender(config)
        if sender is not None:
            return dispatch(self.store, sender, base_delay=1 if self.demo else 30)
        return validate_state(self.store.read(STATE_KEY))

    def start(self):
        def loop():
            next_check = 0
            while not self.stopping.is_set():
                config = {'monitoring_enabled': True, 'interval_seconds': 30}
                try:
                    config = self.store.read('config')
                    if config['monitoring_enabled'] and time.monotonic() >= next_check:
                        self.check()
                        next_check = time.monotonic() + config['interval_seconds']
                    with self.operation:
                        self._drain()
                except (OSError, ValueError, sqlite3.Error):
                    next_check = time.monotonic() + config['interval_seconds']
                if self.wake.wait(min(5, max(.1, next_check - time.monotonic())) if config['monitoring_enabled'] else 5):
                    self.wake.clear()
                    next_check = 0
        self.worker = threading.Thread(target=loop, name='sentinel-scheduler', daemon=True)
        self.worker.start()

    def state(self):
        with self.store.lock:
            config = self.store.read('config')
            outbox = validate_state(self.store.read(STATE_KEY))
            retained = {row['event']['id'] for row in outbox['deliveries']}
            return {'version': '1.0.0', 'csrf': self.csrf, 'config': config,
                    'snapshot': self.store.read('snapshot'), 'runner': dict(self.store.read('runner'), running=self.running),
                    'incidents': self.store.incidents(), 'deliveries': [dict(row, replayable=row['event']['id'] in retained) for row in self.store.deliveries()],
                    'token_configured': bool(os.environ.get('SENTINEL_WEBHOOK_TOKEN')),
                    'demo': {'scenario': self.fixture, 'receiver': self.receiver} if self.demo else None}

    def revise(self, payload, action):
        with self.operation, self.store.transaction():
            config = self.store.read('config')
            if payload.get('revision') != config['revision']:
                raise ValueError('Configuration changed in another view. Reload it before saving.')
            if action == 'service-save':
                service_id = payload.get('id') or uuid.uuid4().hex[:16]
                old = next((row for row in config['services'] if row['id'] == service_id), None)
                if payload.get('id') and old is None:
                    raise ValueError('Service no longer exists.')
                row = {key: payload[key] for key in ('name', 'url', 'timeout_seconds', 'degraded_after_ms', 'expected_statuses', 'enabled')}
                if not isinstance(row['name'], str) or not isinstance(row['url'], str):
                    raise ValueError('Enter a service name and HTTP URL.')
                row.update(id=service_id, name=row['name'].strip(), url=row['url'].strip())
                config['services'] = [row if item['id'] == service_id else item for item in config['services']] if old else config['services'] + [row]
                checked_config(config)
                if old and old['url'] != row['url']:
                    self.end_monitoring(service_id)
            elif action == 'service-action':
                old = next((row for row in config['services'] if row['id'] == payload['id']), None)
                if old is None or payload['action'] not in ('pause', 'resume', 'remove'):
                    raise ValueError('Choose an existing service and a valid action.')
                if payload['action'] == 'remove':
                    config['services'].remove(old)
                    self.end_monitoring(old['id'])
                else:
                    old['enabled'] = payload['action'] == 'resume'
            elif action == 'settings':
                for key in ('interval_seconds', 'retention_days', 'monitoring_enabled'):
                    config[key] = payload[key]
            elif action == 'webhook':
                if payload['webhook_url'].strip() != config['webhook_url'] and any(row['status'] == 'pending' for row in validate_state(self.store.read(STATE_KEY))['deliveries']):
                    raise ValueError('Pending notifications belong to the current receiver. Deliver them or cancel them before changing its URL.')
                config.update(webhook_url=payload['webhook_url'].strip(), notifications_enabled=payload['notifications_enabled'])
            else:
                raise ValueError('Unknown configuration action.')
            config['revision'] += 1
            self.store.write('config', checked_config(config))
        self.wake.set()

    def end_monitoring(self, service_id):
        snapshot = self.store.read('snapshot')
        if not snapshot:
            return
        snapshot['endpoints'] = [row for row in snapshot['endpoints'] if row['id'] != service_id]
        for incident in snapshot['incidents']:
            if incident['endpoint_id'] == service_id and incident['resolved_at'] is None:
                incident.update(resolved_at=now(), resolution='monitoring_stopped')
        outbox = validate_state(self.store.read(STATE_KEY))
        if outbox['checkpoint']:
            outbox['checkpoint']['incidents'] = snapshot['incidents']
        self.store.write(STATE_KEY, outbox)
        self.store.write('snapshot', snapshot)
        self.store.save_incidents(snapshot['incidents'])

    def notify(self, action, payload):
        with self.operation:
            config = self.store.read('config')
            if action != 'cancel-pending' and self.sender(config) is None:
                raise ValueError('Configure and enable a webhook before attempting delivery.')
            before = validate_state(self.store.read(STATE_KEY))
            if action == 'test':
                before = enqueue_test(before)
                target_id = before['deliveries'][-1]['event']['id']
                self.store.write(STATE_KEY, before)
            elif action == 'replay':
                row = next((item for item in before['deliveries'] if item['event']['id'] == payload['id']), None)
                if row is None or row['status'] != 'failed':
                    raise ValueError('Only a retained failed notification can be retried.')
                row.update(status='pending', attempts=0, next_attempt_at=now(), last_error=None,
                           manual_retries=row.get('manual_retries', 0) + 1)
                self.store.write(STATE_KEY, before)
            elif action == 'cancel-pending':
                for row in before['deliveries']:
                    if row['status'] == 'pending':
                        row.update(status='failed', last_error='Canceled by operator')
                self.store.write(STATE_KEY, before)
                return {'message': 'Pending deliveries canceled. Their records are retained.'}
            elif action != 'retry':
                raise ValueError('Unknown delivery action.')
            calls = []
            sender = self.sender(config)
            def record_send(event):
                code = sender(event)
                calls.append(code)
                return code
            after = dispatch(self.store, record_send, base_delay=1 if self.demo else 30)
            if action == 'test':
                row = next(row for row in after['deliveries'] if row['event']['id'] == target_id)
                return {'delivery': row, 'message': 'Test acknowledged by receiver.' if row['status'] == 'delivered' else 'Test saved in the delivery queue. Inspect its result below.'}
            pending = sum(row['status'] == 'pending' for row in after['deliveries'])
            return {'message': f'{len(calls)} attempted; {sum(code is not None and 200 <= code < 300 for code in calls)} acknowledged; {pending} pending.' if calls else 'No deliveries are due yet.' if pending else 'No pending deliveries.'}

    def receive(self, event):
        with self.fixture_lock:
            if self.receiver == 'unavailable':
                return 503
            receipts = self.store.read('receipts').get('items', [])
            previous = next((row for row in receipts if row['event']['id'] == event['id']), None)
            if previous and previous['event'] != event:
                return 409
            if previous:
                previous['requests'] += 1
            else:
                receipts.append({'event': event, 'requests': 1})
            self.store.write('receipts', {'items': receipts[-1000:]})
            if self.receiver == 'lose-next-response':
                self.receiver = 'available'
                return None
            return 200

    def close(self):
        self.stopping.set()
        self.wake.set()
        if self.worker:
            self.worker.join(15)
            if self.worker.is_alive():
                raise RuntimeError('A probe is still running. Wait before releasing the state directory.')
        self.store.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, value, status=200, content_type='application/json', filename=None):
        body = json.dumps(value).encode() if content_type == 'application/json' else value
        self.send_response(status)
        for key, item in {'Content-Type': content_type, 'Content-Length': str(len(body)), 'Cache-Control': 'no-store',
                          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}.items():
            self.send_header(key, item)
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def local_request(self):
        port = self.server.server_port
        if self.headers.get('Host') not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            self.respond({'error': 'Use the local Sentinel address.'}, 403)
            return False
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{port}', f'http://localhost:{port}'):
            self.respond({'error': 'Cross-origin access is not allowed.'}, 403)
            return False
        return True

    def do_GET(self):
        if not self.local_request():
            return
        parsed = urlsplit(self.path)
        app = self.server.application
        try:
            if parsed.path == '/api/state':
                self.respond(app.state())
            elif parsed.path in ('/api/history', '/api/export.csv'):
                params = parse_qs(parsed.query)
                hours = int(params.get('hours', ['24'])[0])
                if not 1 <= hours <= 720:
                    raise ValueError('Choose a history range between one hour and 30 days.')
                rows = app.store.history(hours, params.get('service', [None])[0], limit=500 if parsed.path == '/api/history' else 20000)
                if parsed.path == '/api/history':
                    self.respond({'samples': rows, 'limit': 500})
                else:
                    output = io.StringIO(newline='')
                    writer = csv.writer(output)
                    writer.writerow(['checked_at', 'service_id', 'service_name', 'status', 'http_code', 'latency_ms'])
                    for snapshot in rows:
                        for service in snapshot['endpoints']:
                            name = service['name']
                            if name.lstrip().startswith(('=', '+', '-', '@')):
                                name = "'" + name
                            writer.writerow([snapshot['last_updated'], service['id'], name, service['status'], service['status_code'], service['latency_ms']])
                    self.respond(output.getvalue().encode('utf-8-sig'), content_type='text/csv; charset=utf-8', filename='sentinel-observations.csv')
            elif parsed.path == '/api/backup':
                with tempfile.TemporaryDirectory() as directory:
                    backup = Path(directory) / 'sentinel.db'
                    app.store.backup(backup)
                    self.respond(backup.read_bytes(), content_type='application/octet-stream', filename='sentinel-backup.db')
            elif app.demo and parsed.path.startswith('/fixtures/'):
                name = parsed.path.rsplit('/', 1)[-1]
                if name not in ('api', 'worker'):
                    self.respond({'error': 'Not found'}, 404)
                    return
                with app.fixture_lock:
                    scenario = app.fixture
                if scenario == 'slow' and name == 'api':
                    time.sleep(.35)
                self.respond({'fixture': name}, 503 if scenario == 'outage' and name == 'api' else 200)
            elif app.demo and parsed.path == '/api/demo-receipts':
                self.respond(app.store.read('receipts'))
            elif parsed.path in ('/', '/index.html', '/app.js', '/style.css'):
                name = 'index.html' if parsed.path == '/' else parsed.path[1:]
                body = files('sentinelnode').joinpath('assets', name).read_bytes()
                content_type = {'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8'}[name]
                self.respond(body, content_type=content_type)
            else:
                self.respond({'error': 'Not found'}, 404)
        except (ValueError, KeyError, TypeError):
            self.respond({'error': 'Choose a valid local request.'}, 400)
        except (OSError, sqlite3.Error):
            self.respond({'error': 'Local storage is unavailable. Preserve the data directory and inspect the application.'}, 500)

    def do_POST(self):
        if not self.local_request():
            return
        app = self.server.application
        if self.path != '/fixtures/notifications' or not app.demo:
            if not secrets.compare_digest(self.headers.get('X-Sentinel-CSRF', ''), app.csrf):
                self.respond({'error': 'Session changed. Reload Sentinel before trying again.'}, 403)
                return
        try:
            if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                raise ValueError('Send a JSON request.')
            length = int(self.headers.get('Content-Length', '0'))
            if not 1 <= length <= 16384:
                raise ValueError('Request is empty or too large.')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('Request must be an object.')
            action = self.path.removeprefix('/api/')
            if action == 'check':
                app.check()
                result = {'message': 'Check completed. Results are saved.'}
            elif action in ('service-save', 'service-action', 'settings', 'webhook'):
                app.revise(payload, action)
                result = {'message': 'Settings saved.'}
            elif action == 'incident':
                if type(payload['acknowledge']) is not bool or not isinstance(payload['note'], str) or len(payload['note']) > 2000:
                    raise ValueError('Use a note of up to 2,000 characters and a valid acknowledgement.')
                app.store.annotate(payload['id'], payload['acknowledge'], payload['note'].strip())
                result = {'message': 'Incident note and acknowledgement saved.'}
            elif action.startswith('delivery/'):
                result = app.notify(action.split('/', 1)[1], payload)
            elif action == 'demo' and app.demo:
                with app.fixture_lock:
                    if 'scenario' in payload:
                        if payload['scenario'] not in ('healthy', 'slow', 'outage'):
                            raise ValueError('Unknown demo scenario.')
                        app.fixture = payload['scenario']
                    if 'receiver' in payload:
                        if payload['receiver'] not in ('available', 'unavailable', 'lose-next-response'):
                            raise ValueError('Unknown demo receiver.')
                        app.receiver = payload['receiver']
                result = {'message': 'Local fixture updated. Run a check or send a test.'}
            elif self.path == '/fixtures/notifications' and app.demo:
                if not isinstance(payload.get('id'), str) or len(payload['id']) != 64 or self.headers.get('Idempotency-Key') != payload['id']:
                    raise ValueError('A matching notification reference is required.')
                code = app.receive(payload)
                if code is None:
                    self.close_connection = True
                    self.connection.shutdown(__import__('socket').SHUT_RDWR)
                    self.connection.close()
                else:
                    self.respond({'accepted': code == 200}, code)
                return
            else:
                self.respond({'error': 'Not found'}, 404)
                return
            self.respond(dict(result, ok=True))
        except (ValueError, KeyError, TypeError) as error:
            self.respond({'error': str(error) if isinstance(error, ValueError) else 'Choose a complete, valid request.'}, 400)
        except (OSError, sqlite3.Error):
            self.respond({'error': 'The action could not be saved. Refresh before trying again.'}, 500)


def create_server(directory, port=8798, demo=False, interval=None):
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    try:
        server.application = Application(directory, server.server_port, demo, interval)
    except Exception:
        server.server_close()
        raise
    return server


def restore(source, directory):
    directory = Path(directory)
    if (directory / 'sentinel.db').exists():
        raise ValueError('Restore into a new state directory; the existing database will not be overwritten.')
    with closing(sqlite3.connect(f'{Path(source).resolve().as_uri()}?mode=ro', uri=True)) as backup:
        if backup.execute('PRAGMA user_version').fetchone()[0] != 1 or backup.execute('PRAGMA application_id').fetchone()[0] != 1397642289 or backup.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('This is not a valid Sentinel backup.')
        config = backup.execute("SELECT value FROM documents WHERE key='config'").fetchone()
        checked_config(json.loads(config[0]))
        state = backup.execute('SELECT value FROM documents WHERE key=?', (STATE_KEY,)).fetchone()
        validate_state(json.loads(state[0]) if state else {})
        target = Database(directory)
        try:
            with target.lock:
                backup.backup(target.connection)
            config = target.read('config')
            config.update(monitoring_enabled=False, notifications_enabled=False, revision=config['revision'] + 1)
            target.write('config', config)
        finally:
            target.close()


def main():
    parser = argparse.ArgumentParser(description='Run the private Sentinel monitoring application.')
    parser.add_argument('--port', type=int, default=8798)
    parser.add_argument('--state-dir', type=Path, help='Private data directory; defaults to ~/.sentinel or ~/.sentinel-demo.')
    parser.add_argument('--demo', action='store_true', help='Use local fixtures in a separate demo state directory.')
    parser.add_argument('--interval', type=int, help='Initial check interval, 5–3600 seconds.')
    parser.add_argument('--restore', type=Path, help='Restore a backup into a new state directory, with checks and delivery paused.')
    args = parser.parse_args()
    if args.interval is not None:
        bounded_number(args.interval, 'Interval', 5, 3600, True)
    directory = args.state_dir or Path.home() / ('.sentinel-demo' if args.demo else '.sentinel')
    if args.restore:
        restore(args.restore, directory)
        print(f'Backup restored to {directory}. Scheduled checks and delivery are paused.', flush=True)
        return
    server = create_server(directory, args.port, args.demo, args.interval)
    server.application.start()
    print(f'Sentinel {"demonstration" if args.demo else "application"}: http://127.0.0.1:{server.server_port}', flush=True)
    print(f'Private data: {directory.resolve()}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.application.close()
        server.server_close()


if __name__ == '__main__':
    main()
