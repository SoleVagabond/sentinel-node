from copy import deepcopy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.client import BadStatusLine
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
import alerts
import monitor
import demo

NOW = datetime(2026, 10, 4, tzinfo=timezone.utc)


def snapshot(status='Red', previous=None, tick=0, endpoint_id='api'):
    row = {'id': endpoint_id, 'name': 'Orders API', 'url': 'http://127.0.0.1/private',
           'status': status, 'status_code': 503 if status == 'Red' else 200,
           'latency_ms': 350 if status == 'Yellow' else 5, 'error': 'Unexpected HTTP 503' if status == 'Red' else None}
    return monitor.build_snapshot([row], previous, sampled_at=(NOW + timedelta(seconds=tick)).isoformat())


class OutboxTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = monitor.LocalStore(self.directory.name)

    def save(self, observation=None):
        state = alerts.reconcile(self.store.read(alerts.STATE_KEY), observation or snapshot())
        self.store.write(alerts.STATE_KEY, state)
        return state

    def test_healthy_session_has_no_notifications(self):
        self.assertEqual(self.save(snapshot('Green'))['deliveries'], [])

    def test_explicit_test_preserves_checkpoint_and_refuses_full_queue(self):
        original = self.save(snapshot('Green'))
        queued = alerts.enqueue_test(original, now=NOW)
        self.assertEqual(queued['checkpoint'], original['checkpoint'])
        self.assertEqual(original['deliveries'], [])
        self.assertEqual(queued['deliveries'][0]['event']['type'], 'test')
        for tick in range(1, alerts.PENDING_LIMIT):
            queued = alerts.enqueue_test(queued, now=NOW + timedelta(microseconds=tick))
        before = deepcopy(queued)
        with self.assertRaisesRegex(ValueError, 'queue full'):
            alerts.enqueue_test(queued, now=NOW + timedelta(seconds=1))
        self.assertEqual(queued, before)

    def test_open_escalate_recover_once_and_link_to_same_incident(self):
        slow = snapshot('Yellow')
        first = self.save(slow)
        bad = snapshot('Red', slow, 1)
        self.save(bad)
        again = snapshot('Red', bad, 2)
        self.save(again)
        # Flapping severity within the same incident does not send another escalation.
        slower = snapshot('Yellow', again, 3)
        self.save(slower)
        bad_again = snapshot('Red', slower, 4)
        self.save(bad_again)
        recovered = snapshot('Green', bad_again, 5)
        final = self.save(recovered)
        self.save(snapshot('Green', recovered, 6))
        events = [row['event'] for row in final['deliveries']]
        self.assertEqual([row['type'] for row in events], ['opened', 'escalated', 'recovered'])
        self.assertEqual(len({row['incident_id'] for row in events}), 1)
        self.assertNotIn('url', json.dumps(first))
        self.assertEqual(events[-1]['severity'], 'Green')

    def test_new_outage_after_recovery_is_a_new_incident(self):
        bad = snapshot()
        self.save(bad)
        good = snapshot('Green', bad, 1)
        self.save(good)
        final = self.save(snapshot('Red', good, 2))
        self.assertNotEqual(final['deliveries'][0]['event']['incident_id'], final['deliveries'][-1]['event']['incident_id'])

    def test_enabling_does_not_resend_historical_recoveries(self):
        good = snapshot('Green', snapshot(), 1)
        self.assertEqual(self.save(good)['deliveries'], [])

    def test_reconciliation_does_not_mutate_input(self):
        first = self.save()
        before = deepcopy(first)
        alerts.reconcile(first, snapshot('Green', snapshot(), 1))
        self.assertEqual(first, before)

    def test_success_is_durable_and_not_sent_again_after_restart(self):
        self.save()
        seen = []
        result = alerts.dispatch(self.store, lambda event: seen.append(event['id']) or 204, now=NOW)
        self.assertEqual(result['deliveries'][0]['status'], 'delivered')
        restarted = monitor.LocalStore(self.directory.name)
        alerts.dispatch(restarted, lambda event: seen.append(event['id']) or 200, now=NOW + timedelta(seconds=60))
        self.assertEqual(len(seen), 1)

    def test_backoff_due_times_and_attempt_limit(self):
        self.save()
        calls = []
        sender = lambda event: calls.append(event['id']) or 503
        first = alerts.dispatch(self.store, sender, now=NOW)
        self.assertEqual(first['deliveries'][0]['next_attempt_at'], (NOW + timedelta(seconds=30)).isoformat())
        alerts.dispatch(self.store, sender, now=NOW + timedelta(seconds=29))
        self.assertEqual(len(calls), 1)
        tick = 30
        for _ in range(4):
            state = alerts.dispatch(self.store, sender, now=NOW + timedelta(seconds=tick))
            tick = int((alerts.timestamp(state['deliveries'][0]['next_attempt_at']) - NOW).total_seconds())
        self.assertEqual((state['deliveries'][0]['attempts'], state['deliveries'][0]['status']), (5, 'failed'))
        alerts.dispatch(self.store, sender, now=NOW + timedelta(days=1))
        self.assertEqual(len(calls), 5)

    def test_429_and_408_retry_but_401_and_redirect_stop(self):
        for code, expected in [(429, 'pending'), (408, 'pending'), (401, 'failed'), (302, 'failed')]:
            with self.subTest(code=code):
                self.store.write(alerts.STATE_KEY, alerts.reconcile({}, snapshot()))
                state = alerts.dispatch(self.store, lambda event: code, now=NOW)
                self.assertEqual(state['deliveries'][0]['status'], expected)

    def test_recovery_waits_behind_pending_open_but_other_service_can_send(self):
        bad = snapshot()
        self.save(bad)
        good = snapshot('Green', bad, 1)
        state = self.save(good)
        other = snapshot(endpoint_id='identity', tick=2)
        state = alerts.reconcile(state, other)
        self.store.write(alerts.STATE_KEY, state)
        seen = []
        def sender(event):
            seen.append((event['endpoint_id'], event['type']))
            return 503 if event['endpoint_id'] == 'api' else 200
        alerts.dispatch(self.store, sender, now=NOW + timedelta(seconds=3))
        self.assertEqual(seen, [('api', 'opened'), ('identity', 'opened')])

    def test_delivery_batch_is_bounded(self):
        state = {}
        for n in range(8):
            state = alerts.reconcile(state, snapshot(endpoint_id=str(n), tick=n))
        self.store.write(alerts.STATE_KEY, state)
        seen = []
        result = alerts.dispatch(self.store, lambda event: seen.append(event) or 200, now=NOW + timedelta(seconds=10), max_sends=2)
        self.assertEqual(len(seen), 2)
        self.assertEqual(alerts.public_view(result)['summary']['pending'], 6)

    def test_drain_stops_when_time_budget_is_used(self):
        self.save()
        with patch('alerts.time.monotonic', side_effect=[0, 11]):
            result = alerts.dispatch(self.store, lambda event: self.fail('Budget exhausted'), now=NOW)
        self.assertEqual(result['deliveries'][0]['attempts'], 0)

    def test_escalation_latch_survives_delivery_history_retention(self):
        slow = snapshot('Yellow')
        state = alerts.reconcile({}, slow)
        bad = snapshot('Red', slow, 1)
        state = alerts.reconcile(state, bad)
        state['deliveries'] = []  # Simulate terminal history having aged out.
        slower = snapshot('Yellow', bad, 2)
        state = alerts.reconcile(state, slower)
        state = alerts.reconcile(state, snapshot('Red', slower, 3))
        self.assertEqual(state['deliveries'], [])

    def test_clock_regression_does_not_advance_checkpoint(self):
        state = self.save(snapshot(tick=10))
        with self.assertRaisesRegex(ValueError, 'precedes'):
            alerts.reconcile(state, snapshot(tick=9))

    def test_full_queue_fails_without_discarding_pending_events(self):
        state = {}
        for n in range(alerts.PENDING_LIMIT):
            state = alerts.reconcile(state, snapshot(endpoint_id=str(n), tick=n))
        saved = deepcopy(state)
        with self.assertRaisesRegex(ValueError, 'queue full'):
            alerts.reconcile(state, snapshot(endpoint_id='extra', tick=201))
        self.assertEqual(state, saved)

    def test_terminal_retention_is_bounded_and_preserves_pending(self):
        state = {}
        for n in range(110):
            state = alerts.reconcile(state, snapshot(endpoint_id=str(n), tick=n))
            state['deliveries'][-1]['status'] = 'delivered'
        state = alerts.reconcile(state, snapshot(endpoint_id='pending', tick=111))
        self.assertEqual(len(state['deliveries']), 101)
        self.assertEqual(alerts.public_view(state)['summary'], {'pending': 1, 'delivered': 100, 'failed': 0})

    def test_attempt_is_saved_before_network_and_write_failure_prevents_send(self):
        self.save()
        seen = []
        def sender(event):
            self.assertEqual(self.store.read(alerts.STATE_KEY)['deliveries'][0]['attempts'], 1)
            seen.append(event)
            return 200
        with patch.object(self.store, 'write', side_effect=OSError('Disk full')):
            with self.assertRaises(OSError): alerts.dispatch(self.store, sender, now=NOW)
        self.assertEqual(seen, [])
        alerts.dispatch(self.store, sender, now=NOW)

    def test_lost_acknowledgement_save_retries_identical_id(self):
        self.save()
        real_write = self.store.write
        writes, requests, accepted = [], [], set()
        def failing_write(key, data):
            writes.append(key)
            if len(writes) == 2: raise OSError('Failed to persist acknowledgement')
            real_write(key, data)
        def sender(event):
            requests.append(event['id'])
            accepted.add(event['id'])
            return 200
        with patch.object(self.store, 'write', side_effect=failing_write), self.assertRaises(OSError):
            alerts.dispatch(self.store, sender, now=NOW)
        alerts.dispatch(monitor.LocalStore(self.directory.name), sender, now=NOW + timedelta(seconds=30))
        self.assertEqual(len(requests), 2)
        self.assertEqual(len(accepted), 1)

    def test_corrupt_state_never_sends_or_silently_reinitializes(self):
        for state in [None, {'schema_version': 9, 'deliveries': []}, {'schema_version': 1, 'deliveries': [None]}]:
            self.store.write(alerts.STATE_KEY, state)
            with self.subTest(state=state), self.assertRaises(ValueError):
                alerts.dispatch(self.store, lambda event: self.fail('Must not send'), now=NOW)
            self.assertEqual(self.store.read(alerts.STATE_KEY), state)

    def test_partial_telemetry_write_keeps_stable_incident_and_event_identity(self):
        real_write = self.store.write
        row = snapshot()['endpoints'][0]
        def write(key, data):
            if key == 'status_data.json': raise OSError('Snapshot write failed')
            real_write(key, data)
        with patch('monitor.collect', return_value=[row]), patch.object(self.store, 'write', side_effect=write):
            with self.assertRaises(OSError): monitor.run_once([row], self.store, notifier=lambda event: self.fail('Telemetry did not complete'))
        event_id = self.store.read(alerts.STATE_KEY)['deliveries'][0]['event']['id']
        with patch('monitor.collect', return_value=[row]):
            monitor.run_once([row], self.store, notifier=lambda event: 200)
        state = self.store.read(alerts.STATE_KEY)
        self.assertEqual(len(state['deliveries']), 1)
        self.assertEqual(state['deliveries'][0]['event']['id'], event_id)

    def test_malformed_webhook_response_is_saved_as_unconfirmed_delivery(self):
        self.save()
        sender = alerts.Webhook('http://127.0.0.1/receiver')
        with patch.object(sender.opener, 'open', side_effect=BadStatusLine('not HTTP')):
            result = alerts.dispatch(self.store, sender, now=NOW)
        self.assertEqual(result['deliveries'][0]['status'], 'pending')
        self.assertEqual(result['deliveries'][0]['attempts'], 1)
        self.assertEqual(result['deliveries'][0]['last_error'], 'No acknowledgement')

    def test_destination_and_token_validation(self):
        for url in ['http://example.com/notify', 'https://u:p@example.com/', 'https://example.com/?token=a', 'file:///tmp/x', 'https://example.com:bad/', 'https://example.com/#a', 'http://127.0.0.1/bad path', 'https://example.com/line\nbreak', 'https://example.com/caf\u00e9']:
            with self.subTest(url=url), self.assertRaises(ValueError): alerts.Webhook(url)
        for timeout in [True, float('nan'), 0, 6]:
            with self.assertRaises(ValueError): alerts.Webhook('https://example.com/', timeout=timeout)
        with self.assertRaises(ValueError): alerts.Webhook('https://example.com/', token='a\r\nb')
        self.assertEqual(alerts.Webhook('http://127.0.0.1/notify').url, 'http://127.0.0.1/notify')


class ReceiverIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.server = demo.create_server(0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.state = self.server.demo_state

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.server.temporary_state.cleanup()

    def test_test_notification_http_controls_queue_retry_and_deduplicate_without_incidents(self):
        def post(route, data):
            request = Request(f'http://127.0.0.1:{self.server.server_port}{route}',
                              data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
            with urlopen(request, timeout=5) as response:
                return json.load(response)
        self.state.sample()
        before = deepcopy(self.state.snapshot)
        post('/api/receiver', {'mode': 'unavailable'})
        first = post('/api/test-notification', {})['delivery']
        self.assertEqual((first['event']['type'], first['status'], first['last_error']), ('test', 'pending', 'HTTP 503'))
        self.assertEqual(post('/api/retry', {})['attempted'], 0)
        post('/api/receiver', {'mode': 'available'})
        alerts.dispatch(self.state.store, self.state.sender, now=alerts.timestamp(first['next_attempt_at']), base_delay=1)
        post('/api/receiver', {'mode': 'lose-next-response'})
        second = post('/api/test-notification', {})['delivery']
        self.assertEqual((second['status'], second['last_error']), ('pending', 'No acknowledgement'))
        self.assertNotEqual(first['event']['id'], second['event']['id'])
        alerts.dispatch(self.state.store, self.state.sender, now=alerts.timestamp(second['next_attempt_at']), base_delay=1)
        view = self.state.alerts()
        self.assertEqual(view['summary'], {'pending': 0, 'delivered': 2, 'failed': 0})
        self.assertEqual([row['requests'] for row in view['receipts']], [1, 2])
        self.assertEqual(post('/api/retry', {})['summary']['pending'], 0)
        self.assertEqual(self.state.snapshot, before)
        self.assertEqual(self.state.snapshot['incidents'], [])

    def test_real_http_open_escalation_recovery_receipts(self):
        self.state.set_scenario('degraded')
        self.state.set_scenario('outage')
        self.state.set_scenario('outage')
        self.state.set_scenario('recovered')
        view = self.state.alerts()
        self.assertEqual([row['event']['type'] for row in view['receipts']], ['opened', 'escalated', 'recovered'])
        self.assertEqual(view['summary'], {'pending': 0, 'delivered': 3, 'failed': 0})

    def test_actual_saved_receipt_with_lost_http_reply_is_deduplicated(self):
        self.state.receiver_mode = 'lose-next-response'
        self.state.set_scenario('outage')
        before = self.state.alerts()
        self.assertEqual((before['summary']['pending'], len(before['receipts'])), (1, 1))
        now = alerts.timestamp(before['deliveries'][0]['next_attempt_at'])
        alerts.dispatch(self.state.store, self.state.sender, now=now, base_delay=1)
        after = self.state.alerts()
        self.assertEqual((after['summary']['delivered'], len(after['receipts']), after['receipts'][0]['requests']), (1, 1, 2))
        self.assertEqual(after['deliveries'][0]['attempts'], 2)

    def test_unavailable_receiver_keeps_health_separate_and_recovers_in_order(self):
        self.state.receiver_mode = 'unavailable'
        self.state.set_scenario('outage')
        self.state.set_scenario('recovered')
        self.assertTrue(all(row['status'] == 'Green' for row in self.state.snapshot['endpoints']))
        self.assertEqual(self.state.alerts()['summary']['pending'], 2)
        self.state.receiver_mode = 'available'
        alerts.dispatch(self.state.store, self.state.sender, now=datetime.now(timezone.utc) + timedelta(minutes=1), base_delay=1)
        self.assertEqual([row['event']['type'] for row in self.state.alerts()['receipts']], ['opened', 'recovered'])

    def test_receiver_identity_conflict_is_rejected(self):
        self.state.set_scenario('outage')
        event = self.state.alerts()['receipts'][0]['event']
        self.assertEqual(self.state.sender(dict(event, name='Different payload')), 409)
        self.assertEqual(len(self.state.alerts()['receipts']), 1)

    def test_restart_reads_notification_checkpoint_and_receipts(self):
        self.state.set_scenario('outage')
        directory = self.state.store.directory
        restarted = demo.DemoState(self.server.server_port, directory)
        restarted.scenario = 'outage'
        self.server.demo_state = restarted
        restarted.sample()
        self.assertEqual(len(restarted.alerts()['deliveries']), 1)
        self.assertEqual(restarted.alerts()['receipts'][0]['requests'], 1)
        restarted.set_scenario('recovered')
        self.assertEqual(len(restarted.alerts()['receipts']), 2)

    def test_webhook_redirect_does_not_forward_bearer_token(self):
        paths = []
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                paths.append(self.path)
                self.send_response(307)
                self.send_header('Location', '/other')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            sender = alerts.Webhook(f'http://127.0.0.1:{server.server_port}/redirect', token='fixture-only')
            event = alerts.reconcile({}, snapshot())['deliveries'][0]['event']
            self.assertEqual(sender(event), 307)
            self.assertEqual(paths, ['/redirect'])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
