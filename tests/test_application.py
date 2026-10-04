"""Real HTTP, transactional persistence, and portable application verification."""
from copy import deepcopy
from datetime import timedelta
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'scripts'))
from sentinelnode.app import Application, create_server, restore
from sentinelnode.storage import Database
import alerts
import package_app


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.server = create_server(self.directory.name, 0, demo=True)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.app = self.server.application
        self.app.check()
        self.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join(3)
        self.app.close()
        self.directory.cleanup()

    def call(self, route, payload=None, headers=None):
        request_headers = {'X-Sentinel-CSRF': self.app.csrf, 'Content-Type': 'application/json'}
        request_headers.update(headers or {})
        request = Request(f'http://127.0.0.1:{self.server.server_port}{route}',
                          data=json.dumps(payload).encode() if payload is not None else None, headers=request_headers)
        try:
            response = urlopen(request, timeout=8)
        except HTTPError as error:
            response = error
        with response:
            body = response.read()
            return response.status, json.loads(body) if response.headers.get_content_type() == 'application/json' else body

    def config(self):
        return self.app.store.read('config')

    def service(self, **changes):
        value = {'revision': self.config()['revision'], 'name': 'Additional service',
                 'url': f'http://127.0.0.1:{self.server.server_port}/fixtures/worker', 'enabled': True,
                 'timeout_seconds': 1, 'degraded_after_ms': 500, 'expected_statuses': [200]}
        value.update(changes)
        return value

    def test_service_crud_pause_and_history_retention(self):
        self.assertEqual(self.call('/api/service-save', self.service())[0], 200)
        service_id = self.config()['services'][-1]['id']
        self.app.check()
        self.assertEqual(len(self.app.store.read('snapshot')['endpoints']), 3)
        self.assertEqual(self.call('/api/service-action', {'id': service_id, 'action': 'pause', 'revision': self.config()['revision']})[0], 200)
        self.app.check()
        self.assertEqual(len(self.app.store.read('snapshot')['endpoints']), 2)
        self.assertFalse(self.config()['services'][-1]['enabled'])
        self.assertEqual(self.call('/api/service-action', {'id': service_id, 'action': 'resume', 'revision': self.config()['revision']})[0], 200)
        self.assertEqual(self.call('/api/service-save', self.service(id=service_id, name='Renamed service'))[0], 200)
        self.assertEqual(self.config()['services'][-1]['name'], 'Renamed service')
        self.assertEqual(self.call('/api/service-action', {'id': service_id, 'action': 'remove', 'revision': self.config()['revision']})[0], 200)
        self.assertTrue(any(row['endpoints'] for row in self.app.store.history(service=service_id)))

    def test_invalid_and_stale_configuration_is_atomic(self):
        original = self.config()
        for changes in [{'url': 'file:///bad'}, {'timeout_seconds': True}, {'expected_statuses': [200.1]}, {'name': 123}, {'url': 'http://127.0.0.1:bad/'}, {'url': 'https://example.com/'}, {'revision': 0}]:
            with self.subTest(changes=changes):
                self.assertEqual(self.call('/api/service-save', self.service(**changes))[0], 400)
                self.assertEqual(self.config(), original)

    def test_origin_host_and_session_guards_prevent_mutation(self):
        original = self.config()
        for headers in [{'Origin': 'https://other.example'}, {'Host': 'evil.example'}, {'X-Sentinel-CSRF': 'wrong'}]:
            self.assertEqual(self.call('/api/service-save', self.service(), headers)[0], 403)
            self.assertEqual(self.config(), original)
        self.assertEqual(self.call('/application.lock')[0], 404)
        self.assertEqual(self.call('/sentinel.db')[0], 404)
        self.assertEqual(self.call('/api/state', headers={'Origin': 'https://other.example'})[0], 403)

    def test_permission_failure_records_monitor_attention_without_service_incident(self):
        results = deepcopy(self.app.store.read('snapshot')['endpoints'])
        for row in results:
            row.update(status='Red', status_code=None, observer_error=True,
                       failure_kind='network_permission', error='Monitor network access blocked by the operating system')
        with patch('sentinelnode.app.collect', return_value=results):
            self.app.check()
        self.assertIn('network access blocked', self.app.state()['runner']['error'])
        self.assertEqual(self.app.store.incidents(), [])
        self.assertEqual(self.app.store.deliveries(), [])
        self.assertIn(',Unknown,', self.call('/api/export.csv')[1].decode('utf-8-sig'))
        self.app.check()
        self.assertIsNone(self.app.state()['runner']['error'])

    def test_invalid_url_save_does_not_stop_scheduler_or_poison_healthy_services(self):
        self.app.start()
        for url in [f'http://127.0.0.1:{self.server.server_port}/bad path', f'http://127.0.0.1:{self.server.server_port}/line\nbreak']:
            self.assertEqual(self.call('/api/service-save', self.service(url=url))[0], 400)
        self.assertTrue(self.app.worker.is_alive())
        self.app.wake.set()
        deadline = time.monotonic() + 3
        while self.app.running and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(len(self.app.store.read('snapshot')['endpoints']), 2)

    def test_incident_acknowledgement_does_not_fake_recovery(self):
        self.app.fixture = 'outage'
        self.app.check()
        incident = self.app.store.incidents()[0]
        self.assertEqual(self.call('/api/incident', {'id': incident['id'], 'acknowledge': True, 'note': 'Investigated the service logs.'})[0], 200)
        acknowledged = self.app.store.incidents()[0]
        self.assertTrue(acknowledged['acknowledged_at'])
        self.assertIsNone(acknowledged['resolved_at'])
        self.app.fixture = 'healthy'
        self.app.check()
        recovered = self.app.store.incidents()[0]
        self.assertIsNotNone(recovered['resolved_at'])
        self.assertEqual(recovered['note'], 'Investigated the service logs.')
        self.assertEqual([row['event']['type'] for row in self.app.store.read('receipts')['items']], ['opened', 'recovered'])

    def test_remove_open_service_records_stopped_monitoring_not_recovery(self):
        self.app.fixture = 'outage'
        self.app.check()
        self.call('/api/service-action', {'id': 'api', 'action': 'remove', 'revision': self.config()['revision']})
        incident = self.app.store.incidents()[0]
        self.assertEqual(incident['resolution'], 'monitoring_stopped')
        self.assertIsNotNone(incident['resolved_at'])
        self.app.check()
        self.assertEqual([row['event']['type'] for row in self.app.store.read('receipts')['items']], ['opened'])

    def test_observation_and_outbox_transaction_roll_back_together(self):
        before = self.app.store.read('snapshot')
        outbox = self.app.store.read(alerts.STATE_KEY)
        history = self.app.store.history()
        self.app.fixture = 'outage'
        with patch.object(self.app.store, 'save_observation', side_effect=sqlite3.OperationalError('Write failed')):
            with self.assertRaises(sqlite3.OperationalError):
                self.app.check()
        self.assertEqual(self.app.store.read('snapshot'), before)
        self.assertEqual(self.app.store.read(alerts.STATE_KEY), outbox)
        self.assertEqual(self.app.store.history(), history)
        self.assertEqual(self.app.store.incidents(), [])
        self.assertTrue(self.app.store.read('runner')['error'])
        self.app.check()
        self.assertEqual(len(self.app.store.incidents()), 1)
        self.assertIsNone(self.app.store.read('runner')['error'])

    def test_lost_reply_real_receiver_deduplicates_test_and_retries(self):
        self.app.receiver = 'lose-next-response'
        status, result = self.call('/api/delivery/test', {})
        self.assertEqual(status, 200)
        self.assertEqual(result['delivery']['status'], 'pending')
        event_id = result['delivery']['event']['id']
        alerts.dispatch(self.app.store, self.app.sender(), now=alerts.timestamp(result['delivery']['next_attempt_at']), base_delay=1)
        receipts = self.app.store.read('receipts')['items']
        self.assertEqual((len(receipts), receipts[0]['requests']), (1, 2))
        self.assertEqual(self.app.store.deliveries()[0]['event']['id'], event_id)
        self.assertEqual(self.app.store.deliveries()[0]['total_attempts'], 2)
        self.assertEqual(self.app.store.incidents(), [])

    def test_terminal_replay_preserves_id_and_attempt_audit(self):
        self.app.receiver = 'unavailable'
        row = self.call('/api/delivery/test', {})[1]['delivery']
        for _ in range(4):
            state = alerts.dispatch(self.app.store, self.app.sender(), now=alerts.timestamp(row['next_attempt_at']), base_delay=1)
            row = state['deliveries'][0]
        self.assertEqual(row['status'], 'failed')
        self.app.receiver = 'available'
        self.assertEqual(self.call('/api/delivery/replay', {'id': row['event']['id']})[0], 200)
        final = self.app.store.deliveries()[0]
        self.assertEqual((final['status'], final['total_attempts'], final['manual_retries']), ('delivered', 6, 1))
        self.assertEqual(final['event'], row['event'])

    def test_receiver_change_requires_pending_queue_to_be_resolved(self):
        self.app.receiver = 'unavailable'
        self.call('/api/delivery/test', {})
        change = {'revision': self.config()['revision'], 'webhook_url': 'http://127.0.0.1:1/notify', 'notifications_enabled': True}
        self.assertEqual(self.call('/api/webhook', change)[0], 400)
        self.assertEqual(self.call('/api/delivery/cancel-pending', {})[0], 200)
        self.assertEqual(self.app.store.deliveries()[0]['last_error'], 'Canceled by operator')
        self.assertEqual(self.call('/api/webhook', change)[0], 200)

    def test_disabled_delivery_does_not_replay_unobserved_transitions_on_enable(self):
        config = self.config()
        config['notifications_enabled'] = False
        self.app.store.write('config', config)
        self.app.fixture = 'outage'
        self.app.check()
        config['notifications_enabled'] = True
        self.app.store.write('config', config)
        self.app.check()
        self.assertEqual(self.app.store.deliveries(), [])
        self.app.fixture = 'healthy'
        self.app.check()
        self.assertEqual([row['event']['type'] for row in self.app.store.deliveries()], ['recovered'])

    def test_scheduler_recovers_after_failed_check(self):
        real_check = self.app.check
        calls = []
        def flaky_check():
            calls.append(True)
            if len(calls) == 1:
                raise sqlite3.OperationalError('Transient failure')
            return real_check()
        with patch.object(self.app, 'check', side_effect=flaky_check):
            self.app.start()
            deadline = time.monotonic() + 3
            while not calls and time.monotonic() < deadline:
                time.sleep(.01)
            self.app.wake.set()
            while len(calls) < 2 and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertGreaterEqual(len(calls), 2)
            self.assertTrue(self.app.worker.is_alive())

    def test_second_application_owner_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Another Sentinel'):
            Database(self.directory.name)

    def test_restart_preserves_configuration_history_notes_and_pending_delivery(self):
        self.app.receiver = 'unavailable'
        self.app.fixture = 'outage'
        self.app.check()
        incident = self.app.store.incidents()[0]
        self.app.store.annotate(incident['id'], True, 'Saved before restart')
        original = self.app.state()
        observations = self.app.store.history()
        old_csrf = self.app.csrf
        self.app.close()
        self.app = Application(self.directory.name, self.server.server_port, demo=True)
        self.server.application = self.app
        current = self.app.state()
        self.assertNotEqual(current['csrf'], old_csrf)
        self.assertEqual(current['config'], original['config'])
        self.assertEqual(current['snapshot'], original['snapshot'])
        self.assertEqual(current['incidents'], original['incidents'])
        self.assertEqual(current['deliveries'], original['deliveries'])
        self.assertEqual(self.app.store.history(), observations)
        self.assertEqual(current['incidents'][0]['note'], 'Saved before restart')
        with self.app.operation:
            alerts.dispatch(self.app.store, self.app.sender(), now=alerts.timestamp(current['deliveries'][0]['next_attempt_at']), base_delay=1)
        self.assertEqual(self.app.state()['deliveries'][0]['status'], 'delivered')

    def test_backup_restore_preserves_notes_and_starts_paused(self):
        self.app.fixture = 'outage'
        self.app.check()
        incident = self.app.store.incidents()[0]
        self.app.store.annotate(incident['id'], True, 'Preserved note')
        status, backup = self.call('/api/backup')
        self.assertEqual(status, 200)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'backup.db'
            source.write_bytes(backup)
            destination = Path(directory) / 'restored'
            restore(source, destination)
            restored = Database(destination)
            try:
                self.assertEqual(restored.incidents()[0]['note'], 'Preserved note')
                self.assertFalse(restored.read('config')['monitoring_enabled'])
                self.assertFalse(restored.read('config')['notifications_enabled'])
                self.assertEqual(restored.history(), self.app.store.history())
            finally:
                restored.close()
            with self.assertRaisesRegex(ValueError, 'new state directory'):
                restore(source, destination)

    def test_history_filter_and_csv_escape_formula_names(self):
        self.call('/api/service-save', self.service(name='=UNSAFE()'))
        self.app.check()
        status, history = self.call('/api/history?hours=24&service=api')
        self.assertEqual(status, 200)
        self.assertTrue(all(all(row['id'] == 'api' for row in snapshot['endpoints']) for snapshot in history['samples']))
        status, output = self.call('/api/export.csv')
        self.assertEqual(status, 200)
        self.assertIn("'=UNSAFE()", output.decode('utf-8-sig'))
        self.assertNotIn('SENTINEL_WEBHOOK_TOKEN', output.decode('utf-8-sig'))

    def test_live_workspace_has_empty_onboarding_and_no_fixture_routes(self):
        with tempfile.TemporaryDirectory() as directory:
            server = create_server(directory, 0)
            try:
                self.assertEqual(server.application.state()['config']['services'], [])
                self.assertIsNone(server.application.state()['demo'])
                self.assertEqual(server.application.check(), {})
            finally:
                server.application.close()
                server.server_close()

    def test_portable_archive_is_reproducible_and_launches_without_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            one = package_app.package(Path(directory) / 'one.pyz')
            two = package_app.package(Path(directory) / 'two.pyz')
            self.assertEqual(one.read_bytes(), two.read_bytes())
            result = subprocess.run([sys.executable, str(one), '--help'], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('--restore', result.stdout)
            process = subprocess.Popen([sys.executable, str(one), '--demo', '--port', '0', '--state-dir', str(Path(directory) / 'archive-data')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                address = process.stdout.readline().strip().split('http://', 1)[-1]
                with urlopen(f'http://{address}/api/state', timeout=5) as response:
                    current = json.load(response)
                self.assertEqual(len(current['config']['services']), 2)
                with urlopen(f'http://{address}/', timeout=5) as response:
                    self.assertIn(b'Monitoring workspace', response.read())
            finally:
                process.terminate()
                process.wait(5)
                process.stdout.close()
                process.stderr.close()


if __name__ == '__main__':
    unittest.main()
