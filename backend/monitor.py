"""Endpoint monitoring, bounded history, and incident transitions.

HTTP checks use the Python standard library. AWS dependencies load only on S3 use.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import logging
import math
import os
from pathlib import Path
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from alerts import STATE_KEY, Webhook, dispatch, reconcile, validate_state

LOGGER = logging.getLogger(__name__)
LOGGER.setLevel(logging.INFO)
CONFIG_PATH = Path(__file__).with_name('endpoints.json')
HISTORY_LIMIT = 60
INCIDENT_LIMIT = 100


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def validate_config(config):
    endpoints = config.get('endpoints')
    if not isinstance(endpoints, list) or not 1 <= len(endpoints) <= 8:
        raise ValueError('Configure between one and eight endpoints.')
    seen = set()
    for endpoint in endpoints:
        if not isinstance(endpoint, dict):
            raise ValueError('Each endpoint must be an object.')
        for key in ('id', 'name', 'url'):
            if not isinstance(endpoint.get(key), str) or not endpoint[key].strip():
                raise ValueError(f'Endpoint {key} is required.')
        if endpoint['id'] in seen:
            raise ValueError('Endpoint IDs must be unique.')
        seen.add(endpoint['id'])
        url = urlsplit(endpoint['url'])
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError('Use an HTTP(S) URL without credentials, query secrets, or fragments.')
        for key, default, low, high in [('timeout_seconds', 5, .05, 10), ('degraded_after_ms', 1000, 1, 30000)]:
            value = endpoint.get(key, default)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f'{key} must be between {low} and {high}.')
        expected = endpoint.get('expected_statuses', [200])
        if not isinstance(expected, list) or not expected or any(type(code) is not int or not 100 <= code <= 599 for code in expected):
            raise ValueError('expected_statuses must contain valid HTTP status codes.')
    return endpoints


def check_endpoint(endpoint, opener=urlopen, clock=time.perf_counter):
    started = clock()
    result = {key: endpoint[key] for key in ('id', 'name', 'url')}
    result.update(timestamp=utc_now(), status_code=None, latency_ms=None, error=None, status='Red')
    try:
        request = Request(endpoint['url'], headers={'User-Agent': 'SentinelNode/1.0'})
        with opener(request, timeout=endpoint.get('timeout_seconds', 5)) as response:
            result['status_code'] = response.status
        if result['status_code'] not in endpoint.get('expected_statuses', [200]):
            result['error'] = f"Unexpected HTTP {result['status_code']}"
        else:
            result['status'] = 'Green'
    except HTTPError as error:
        result['status_code'] = error.code
        if error.code in endpoint.get('expected_statuses', [200]):
            result['status'] = 'Green'
        else:
            result['error'] = f'Unexpected HTTP {error.code}'
        error.close()
    except (TimeoutError, socket.timeout):
        result['error'] = 'Connection timeout'
    except URLError as error:
        result['error'] = 'Connection timeout' if isinstance(error.reason, (TimeoutError, socket.timeout)) else 'DNS, TLS, or connection failure'
    except OSError:
        result['error'] = 'Connection failure'
    result['latency_ms'] = round(max(0, clock() - started) * 1000, 2)
    if result['status'] == 'Green' and result['latency_ms'] > endpoint.get('degraded_after_ms', 1000):
        result['status'] = 'Yellow'
    return result


def collect(endpoints, checker=check_endpoint):
    with ThreadPoolExecutor(max_workers=min(len(endpoints), 8)) as pool:
        return list(pool.map(checker, endpoints))


def build_snapshot(results, previous=None, mode='live', sampled_at=None, interval_seconds=60):
    sampled_at = sampled_at or utc_now()
    previous = previous or {}
    incidents = [dict(incident) for incident in previous.get('incidents', [])]
    for result in results:
        active = next((i for i in reversed(incidents) if i['endpoint_id'] == result['id'] and i['resolved_at'] is None), None)
        if result['status'] != 'Green':
            if active is None:
                incidents.append({'endpoint_id': result['id'], 'name': result['name'], 'opened_at': sampled_at, 'resolved_at': None, 'severity': result['status'], 'reason': result['error'] or 'Response exceeded latency threshold'})
            else:
                active.update(severity=result['status'], reason=result['error'] or 'Response exceeded latency threshold')
        elif active:
            active['resolved_at'] = sampled_at
    active_incidents = [i for i in incidents if i['resolved_at'] is None]
    closed_incidents = [i for i in incidents if i['resolved_at'] is not None]
    incidents = (closed_incidents[-max(0, INCIDENT_LIMIT - len(active_incidents)):] if len(active_incidents) < INCIDENT_LIMIT else []) + active_incidents
    summary = {status: sum(row['status'] == status for row in results) for status in ('Green', 'Yellow', 'Red')}
    return {'schema_version': 1, 'mode': mode, 'last_updated': sampled_at, 'interval_seconds': interval_seconds,
            'stale_after_seconds': max(15, interval_seconds * 3), 'endpoints': results, 'summary': summary, 'incidents': incidents}


def extend_history(history, snapshot):
    item = {'timestamp': snapshot['last_updated'], 'endpoints': [
        {key: row[key] for key in ('id', 'status', 'latency_ms', 'status_code')} for row in snapshot['endpoints']]}
    samples = list(history.get('samples', []))
    if samples and samples[-1]['timestamp'] == item['timestamp']:
        samples[-1] = item
    else:
        samples.append(item)
    return {'schema_version': 1, 'samples': samples[-HISTORY_LIMIT:]}


class LocalStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def read(self, key):
        path = self.directory / key
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding='utf-8'))

    def write(self, key, data):
        path = self.directory / key
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, indent=2), encoding='utf-8')
        temporary.replace(path)


class S3Store:
    def __init__(self, bucket):
        import boto3
        from botocore.config import Config
        self.client = boto3.client('s3', config=Config(connect_timeout=3, read_timeout=5, retries={'total_max_attempts': 2}))
        self.bucket = bucket

    def read(self, key):
        from botocore.exceptions import ClientError
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
            with response['Body'] as body:
                return json.loads(body.read())
        except ClientError as error:
            if error.response['Error']['Code'] in ('NoSuchKey', '404'):
                return {}
            raise

    def write(self, key, data):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=json.dumps(data).encode(), ContentType='application/json', CacheControl='no-store')


def run_once(endpoints, store, mode='live', interval_seconds=60, notifier=None):
    previous = store.read('status_data.json')
    history = store.read('history.json')
    alert_state = validate_state(store.read(STATE_KEY)) if notifier is not None else None
    if alert_state and alert_state['checkpoint']:
        previous = alert_state['checkpoint']
    started = time.perf_counter()
    snapshot = build_snapshot(collect(endpoints), previous, mode=mode, interval_seconds=interval_seconds)
    if notifier is not None:
        store.write(STATE_KEY, reconcile(alert_state, snapshot))
    store.write('history.json', extend_history(history, snapshot))
    store.write('status_data.json', snapshot)
    if notifier is not None:
        dispatch(store, notifier)
    LOGGER.info(json.dumps({'event': 'check_completed', 'duration_ms': round((time.perf_counter() - started) * 1000), 'counts': snapshot['summary']}))
    return snapshot


def lambda_handler(event, context):
    bucket = os.environ.get('BUCKET_NAME')
    if not bucket:
        raise ValueError('BUCKET_NAME must be configured for cloud runs.')
    endpoints = validate_config(json.loads(CONFIG_PATH.read_text(encoding='utf-8')))
    snapshot = run_once(endpoints, S3Store(bucket))
    return {'statusCode': 200, 'body': json.dumps({'checked': len(snapshot['endpoints']), 'last_updated': snapshot['last_updated']})}


def main():
    parser = argparse.ArgumentParser(description='Check explicitly configured endpoints and write dashboard telemetry.')
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output', type=Path, default=Path('work/telemetry'))
    parser.add_argument('--notify', action='store_true', help='Send to SENTINEL_WEBHOOK_URL; token comes from SENTINEL_WEBHOOK_TOKEN.')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    endpoints = validate_config(json.loads(args.config.read_text(encoding='utf-8')))
    if args.notify and not os.environ.get('SENTINEL_WEBHOOK_URL'):
        parser.error('--notify requires SENTINEL_WEBHOOK_URL.')
    notifier = Webhook(os.environ['SENTINEL_WEBHOOK_URL'], os.environ.get('SENTINEL_WEBHOOK_TOKEN')) if args.notify else None
    run_once(endpoints, LocalStore(args.output), notifier=notifier)


if __name__ == '__main__':
    main()
