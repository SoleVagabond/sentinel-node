from contextlib import nullcontext
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from http.client import BadStatusLine
import json
from pathlib import Path
import sys
import tempfile
import socket
import ssl
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
import monitor
import demo
import package_lambda

ENDPOINT = {'id': 'api', 'name': 'API', 'url': 'http://127.0.0.1/health', 'timeout_seconds': .1, 'degraded_after_ms': 100}


class MonitorTests(unittest.TestCase):
    def test_local_store_concurrent_readers_and_writes_remain_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            store = monitor.LocalStore(directory)
            store.write('state.json', {'sequence': 0, 'payload': 'x' * 4096})
            def reader():
                for _ in range(300):
                    row = store.read('state.json')
                    self.assertIsInstance(row['sequence'], int)
                    self.assertEqual(row['payload'], 'x' * 4096)
            def writer():
                for sequence in range(100):
                    store.write('state.json', {'sequence': sequence, 'payload': 'x' * 4096})
            with ThreadPoolExecutor(max_workers=3) as pool:
                futures = [pool.submit(reader), pool.submit(reader), pool.submit(writer)]
                for future in futures:
                    future.result(timeout=10)
            self.assertEqual(store.read('state.json')['sequence'], 99)

    def probe(self, code=200, latency=.05, failure=None, endpoint=None):
        clock = iter([0, latency])
        def opener(request, timeout):
            self.assertEqual(request.full_url, (endpoint or ENDPOINT)['url'])
            self.assertGreater(timeout, 0)
            if failure: raise failure
            return nullcontext(type('Response', (), {'status': code})())
        return monitor.check_endpoint(endpoint or ENDPOINT, opener=opener, clock=lambda: next(clock))

    def test_fast_success(self):
        self.assertEqual(self.probe()['status'], 'Green')

    def test_slow_success(self):
        self.assertEqual(self.probe(latency=.2)['status'], 'Yellow')

    def test_unexpected_status(self):
        result = self.probe(code=503)
        self.assertEqual((result['status'], result['error']), ('Red', 'Unexpected HTTP 503'))

    def test_http_error_preserves_code(self):
        result = self.probe(failure=HTTPError(ENDPOINT['url'], 503, 'Unavailable', {}, None))
        self.assertEqual((result['status'], result['status_code']), ('Red', 503))

    def test_configured_error_status_can_be_expected(self):
        endpoint = dict(ENDPOINT, expected_statuses=[401])
        result = self.probe(endpoint=endpoint, failure=HTTPError(ENDPOINT['url'], 401, 'Unauthorized', {}, None))
        self.assertEqual(result['status'], 'Green')

    def test_timeout(self):
        self.assertEqual(self.probe(failure=TimeoutError())['error'], 'Connection timeout')

    def test_wrapped_timeout(self):
        self.assertEqual(self.probe(failure=URLError(TimeoutError()))['error'], 'Connection timeout')

    def test_connection_failure(self):
        self.assertEqual(self.probe(failure=URLError('DNS failure'))['status'], 'Red')

    def test_network_permission_is_monitor_failure_without_fictitious_incidents(self):
        for failure in (PermissionError(13, 'Blocked'), URLError(PermissionError(13, 'Blocked'))):
            blocked = self.probe(failure=failure)
            self.assertTrue(blocked['observer_error'])
            self.assertEqual(blocked['failure_kind'], 'network_permission')
            self.assertEqual(monitor.build_snapshot([blocked])['incidents'], [])
            prior = monitor.build_snapshot([self.probe(code=503)])
            self.assertIsNone(monitor.build_snapshot([blocked], prior)['incidents'][0]['resolved_at'])

    def test_dns_and_invalid_certificate_have_distinct_diagnostic_results(self):
        for failure, kind in [(socket.gaierror(-2, 'DNS failed'), 'dns'), (ssl.SSLCertVerificationError(1, 'Untrusted'), 'tls')]:
            row = self.probe(failure=URLError(failure))
            self.assertEqual(row['failure_kind'], kind)
            self.assertFalse(row.get('observer_error', False))

    def test_invalid_http_response_does_not_abort_other_probes(self):
        result = self.probe(failure=BadStatusLine('invalid HTTP'))
        self.assertEqual(result['failure_kind'], 'request')
        self.assertEqual(result['status'], 'Red')

    def test_url_controls_unicode_spaces_and_invalid_ports_are_rejected(self):
        for url in ['http://127.0.0.1/bad path', 'https://example.com/line\nbreak', 'https://example.com/caf\u00e9', 'https://example.com:bad/', 'https://example.com/\x7f']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                monitor.validate_config({'endpoints': [dict(ENDPOINT, url=url)]})

    def test_configuration_rejects_unsafe_or_unbounded_values(self):
        for field, value in [('url', 'file:///etc/passwd'), ('url', 'https://a:b@example.com'), ('url', 'https://example.com/?token=secret'), ('timeout_seconds', 11), ('timeout_seconds', float('nan')), ('degraded_after_ms', 0), ('expected_statuses', [True])]:
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                monitor.validate_config({'endpoints': [dict(ENDPOINT, **{field: value})]})
        for endpoints in ([], [ENDPOINT] * 2, [dict(ENDPOINT, id=str(i)) for i in range(9)]):
            with self.assertRaises(ValueError): monitor.validate_config({'endpoints': endpoints})

    def test_collection_is_concurrent_and_ordered(self):
        barrier = threading.Barrier(4, timeout=3)
        endpoints = [dict(ENDPOINT, id=str(i)) for i in range(4)]
        def checker(endpoint):
            barrier.wait()
            return endpoint
        self.assertEqual(monitor.collect(endpoints, checker), endpoints)

    def test_incident_opens_updates_and_recovers_without_duplicates(self):
        bad = self.probe(code=503)
        first = monitor.build_snapshot([bad], sampled_at='2026-01-01T00:00:00Z')
        second = monitor.build_snapshot([bad], first, sampled_at='2026-01-01T00:01:00Z')
        recovered = monitor.build_snapshot([self.probe()], second, sampled_at='2026-01-01T00:02:00Z')
        self.assertEqual(len(second['incidents']), 1)
        self.assertIsNone(first['incidents'][0]['resolved_at'])
        self.assertEqual(recovered['incidents'][0]['resolved_at'], '2026-01-01T00:02:00Z')
        new_failure = monitor.build_snapshot([bad], recovered, sampled_at='2026-01-01T00:03:00Z')
        self.assertEqual(len(new_failure['incidents']), 2)

    def test_history_is_bounded_and_repeated_snapshot_idempotent(self):
        history = {}
        for number in range(75):
            snapshot = monitor.build_snapshot([self.probe()], sampled_at=f'sample-{number}')
            history = monitor.extend_history(history, snapshot)
        self.assertEqual(len(history['samples']), 60)
        self.assertEqual(monitor.extend_history(history, snapshot), history)

    def test_local_store_round_trip_and_invalid_json_is_not_silently_discarded(self):
        with tempfile.TemporaryDirectory() as directory:
            store = monitor.LocalStore(directory)
            self.assertEqual(store.read('status_data.json'), {})
            store.write('status_data.json', {'value': 2})
            self.assertEqual(store.read('status_data.json'), {'value': 2})
            Path(directory, 'status_data.json').write_text('{broken')
            with self.assertRaises(json.JSONDecodeError): store.read('status_data.json')

    def test_lambda_requires_explicit_cloud_configuration(self):
        with patch.dict('os.environ', {}, clear=True), self.assertRaises(ValueError):
            monitor.lambda_handler({}, None)

    def test_package_has_only_selected_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            output = package_lambda.package(ROOT / 'backend/endpoints.example.json', Path(directory) / 'lambda.zip', install_dependencies=False)
            from zipfile import ZipFile
            with ZipFile(output) as archive:
                self.assertEqual(sorted(archive.namelist()), ['alerts.py', 'endpoints.json', 'monitor.py'])

    def test_package_is_reproducible_for_the_same_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            first = package_lambda.package(ROOT / 'backend/endpoints.example.json', Path(directory) / 'first/lambda.zip', install_dependencies=False)
            second = package_lambda.package(ROOT / 'backend/endpoints.example.json', Path(directory) / 'second/lambda.zip', install_dependencies=False)
            self.assertEqual(first.read_bytes(), second.read_bytes())


class DemoIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = demo.create_server(0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(3)

    def test_real_http_outage_stale_and_recovery(self):
        state = self.server.demo_state
        state.set_scenario('outage')
        api = next(row for row in state.snapshot['endpoints'] if row['id'] == 'api')
        self.assertEqual((api['status'], api['status_code']), ('Red', 503))
        self.assertEqual(sum(i['resolved_at'] is None for i in state.snapshot['incidents']), 1)
        state.set_scenario('stale')
        paused_time = state.snapshot['last_updated']
        state.sample()
        self.assertEqual(state.snapshot['last_updated'], paused_time)
        state.set_scenario('recovered')
        self.assertTrue(all(row['status'] == 'Green' for row in state.snapshot['endpoints']))
        self.assertTrue(state.snapshot['incidents'][-1]['resolved_at'])

    def test_slow_service_is_degraded(self):
        self.server.demo_state.set_scenario('degraded')
        api = next(row for row in self.server.demo_state.snapshot['endpoints'] if row['id'] == 'api')
        self.assertEqual(api['status'], 'Yellow')

    def test_cross_origin_scenario_change_is_denied(self):
        from urllib.request import Request, urlopen
        request = Request(f'http://127.0.0.1:{self.server.server_port}/api/scenario', data=b'{"scenario":"healthy"}', headers={'Content-Type': 'application/json', 'Origin': 'https://other.example'})
        with self.assertRaises(HTTPError) as raised: urlopen(request, timeout=2)
        self.assertEqual(raised.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
