"""Durable incident outbox. Delivery is at least once; receivers deduplicate IDs."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

STATE_KEY = 'alert_state.json'
PENDING_LIMIT = 200
TERMINAL_LIMIT = 100
MAX_ATTEMPTS = 5


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('An alert timestamp must be a string.')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Alert timestamps must include a timezone.')
    return parsed


def identity(endpoint_id, opened_at, kind='incident'):
    return hashlib.sha256(json.dumps([endpoint_id, opened_at, kind]).encode()).hexdigest()


def validate_state(state):
    if state == {}:
        return {'schema_version': 1, 'checkpoint': None, 'deliveries': []}
    if not isinstance(state, dict) or state.get('schema_version') != 1 or not isinstance(state.get('deliveries'), list):
        raise ValueError('Invalid alert state; repair the saved file before delivery.')
    if len(state['deliveries']) > PENDING_LIMIT + TERMINAL_LIMIT:
        raise ValueError('Alert state exceeds the retention limit.')
    checkpoint = state.get('checkpoint')
    if checkpoint is not None:
        if not isinstance(checkpoint, dict) or not isinstance(checkpoint.get('incidents'), list):
            raise ValueError('Invalid alert checkpoint.')
        timestamp(checkpoint['last_updated'])
        for incident in checkpoint['incidents']:
            if not isinstance(incident, dict) or not isinstance(incident.get('endpoint_id'), str) or incident.get('severity') not in ('Yellow', 'Red'):
                raise ValueError('Invalid checkpoint incident.')
            timestamp(incident['opened_at'])
            if incident['resolved_at'] is not None:
                timestamp(incident['resolved_at'])
    seen = set()
    for row in state['deliveries']:
        if not isinstance(row, dict) or row.get('status') not in ('pending', 'delivered', 'failed'):
            raise ValueError('Invalid delivery record.')
        event = row.get('event')
        if not isinstance(event, dict) or event.get('type') not in ('opened', 'escalated', 'recovered', 'test'):
            raise ValueError('Invalid delivery event.')
        if not all(isinstance(event.get(key), str) and event[key] for key in ('id', 'incident_id', 'endpoint_id', 'name', 'opened_at', 'observed_at')):
            raise ValueError('Missing event fields.')
        timestamp(event['opened_at'])
        timestamp(event['observed_at'])
        if event['id'] != identity(event['endpoint_id'], event['opened_at'], event['type']) or event['incident_id'] != identity(event['endpoint_id'], event['opened_at']):
            raise ValueError('Event identity does not match its incident.')
        if event['id'] in seen or type(row.get('attempts')) is not int or not 0 <= row['attempts'] <= MAX_ATTEMPTS:
            raise ValueError('Invalid or duplicate delivery attempts.')
        seen.add(event['id'])
        timestamp(row['next_attempt_at'])
    return deepcopy(state)


def trim(state):
    pending = [row for row in state['deliveries'] if row['status'] == 'pending']
    if len(pending) > PENDING_LIMIT:
        raise ValueError('Notification queue full; no pending events have been discarded.')
    terminal = [row for row in state['deliveries'] if row['status'] != 'pending'][-TERMINAL_LIMIT:]
    keep = {row['event']['id'] for row in pending + terminal}
    state['deliveries'] = [row for row in state['deliveries'] if row['event']['id'] in keep]
    return state


def reconcile(state, snapshot):
    """Save events and their observation checkpoint together, before any HTTP send."""
    state = validate_state(state)
    previous = state['checkpoint']
    if previous and timestamp(snapshot['last_updated']) < timestamp(previous['last_updated']):
        raise ValueError('Observation precedes the saved alert checkpoint.')
    old = {(i['endpoint_id'], i['opened_at']): i for i in (previous or {}).get('incidents', [])}
    known = {row['event']['id'] for row in state['deliveries']}
    for incident in snapshot['incidents']:
        prior = old.get((incident['endpoint_id'], incident['opened_at']))
        # Historical recoveries present when alerts are first enabled are not new events.
        kind = ('opened' if incident['resolved_at'] is None else None) if prior is None else (
            'recovered' if prior['resolved_at'] is None and incident['resolved_at'] is not None else
            'escalated' if prior['resolved_at'] is None and incident['resolved_at'] is None and prior['severity'] == 'Yellow' and incident['severity'] == 'Red' and not prior.get('alert_escalated', False) else None)
        if kind is None:
            continue
        event_id = identity(incident['endpoint_id'], incident['opened_at'], kind)
        if event_id in known:
            continue
        event = {'id': event_id, 'incident_id': identity(incident['endpoint_id'], incident['opened_at']),
                 'type': kind, 'endpoint_id': incident['endpoint_id'], 'name': incident['name'],
                 'opened_at': incident['opened_at'], 'observed_at': snapshot['last_updated'],
                 'severity': 'Green' if kind == 'recovered' else incident['severity'], 'reason': incident['reason']}
        state['deliveries'].append({'event': event, 'status': 'pending', 'attempts': 0,
                                    'next_attempt_at': snapshot['last_updated'], 'last_attempt_at': None,
                                    'delivered_at': None, 'last_error': None})
        known.add(event_id)
    # Only incident metadata is needed for transitions; endpoint URLs stay out of the outbox.
    state['checkpoint'] = {'last_updated': snapshot['last_updated'], 'incidents': deepcopy(snapshot['incidents'])}
    for incident in state['checkpoint']['incidents']:
        prior = old.get((incident['endpoint_id'], incident['opened_at']), {})
        incident['alert_escalated'] = prior.get('alert_escalated', False) or incident['severity'] == 'Red'
    return trim(state)


def enqueue_test(state, now=None):
    """Queue an explicitly labelled lab message without altering service observations."""
    state = validate_state(state)
    observed_at = (now or datetime.now(timezone.utc)).isoformat()
    event = {'id': identity('notification-test', observed_at, 'test'),
             'incident_id': identity('notification-test', observed_at), 'type': 'test',
             'endpoint_id': 'notification-test', 'name': 'Notification test',
             'opened_at': observed_at, 'observed_at': observed_at, 'severity': 'Unknown',
             'reason': 'Manual local delivery test; no service incident.'}
    if any(row['event']['id'] == event['id'] for row in state['deliveries']):
        raise ValueError('Duplicate test notification timestamp.')
    state['deliveries'].append({'event': event, 'status': 'pending', 'attempts': 0,
                                'next_attempt_at': observed_at, 'last_attempt_at': None,
                                'delivered_at': None, 'last_error': None})
    return trim(state)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def validate_destination(url):
    parts = urlsplit(url)
    try:
        parts.port
    except ValueError:
        raise ValueError('Invalid webhook port.') from None
    if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('Use a webhook URL without embedded credentials, queries, or fragments.')
    if parts.scheme != 'https' and not (parts.scheme == 'http' and parts.hostname in ('127.0.0.1', 'localhost', '::1')):
        raise ValueError('Webhooks require HTTPS, except for a loopback receiver.')
    return url


class Webhook:
    def __init__(self, url, token=None, timeout=3):
        self.url = validate_destination(url)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not .05 <= timeout <= 5:
            raise ValueError('Webhook timeout must be between .05 and 5 seconds.')
        if token and ('\r' in token or '\n' in token):
            raise ValueError('Invalid webhook token.')
        self.token, self.timeout = token, timeout
        self.opener = build_opener(NoRedirects)

    def __call__(self, event):
        headers = {'Content-Type': 'application/json', 'Idempotency-Key': event['id'], 'User-Agent': 'SentinelNode/1.0'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = Request(self.url, data=json.dumps(event).encode(), headers=headers, method='POST')
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status
        except HTTPError as error:
            code = error.code
            error.close()
            return code
        except (URLError, OSError, TimeoutError):
            return None


def dispatch(store, sender, now=None, base_delay=30, max_sends=5, time_budget=10):
    """One bounded drain. Persist an attempt before sending; never retry in a sleep loop."""
    state = validate_state(store.read(STATE_KEY))
    now = now or datetime.now(timezone.utc)
    started = time.monotonic()
    sends = 0
    blocked = set()
    for row in state['deliveries']:
        incident_id = row['event']['incident_id']
        if row['status'] != 'pending':
            continue
        if incident_id in blocked:
            continue
        blocked.add(incident_id)
        if timestamp(row['next_attempt_at']) > now:
            continue
        if row['attempts'] >= MAX_ATTEMPTS:
            row.update(status='failed', last_error='Attempts exhausted after an unconfirmed delivery')
            store.write(STATE_KEY, trim(state))
            continue
        if sends >= max_sends or time.monotonic() - started >= time_budget:
            break
        row['attempts'] += 1
        row['last_attempt_at'] = now.isoformat()
        row['next_attempt_at'] = (now + timedelta(seconds=min(900, base_delay * 2 ** (row['attempts'] - 1)))).isoformat()
        store.write(STATE_KEY, state)
        # A timeout can mean the receiver accepted the event but its reply was lost.
        code = sender(deepcopy(row['event']))
        sends += 1
        if code is not None and 200 <= code < 300:
            row.update(status='delivered', delivered_at=now.isoformat(), last_error=None)
        else:
            retryable = code is None or code in (408, 429) or code >= 500
            row['last_error'] = 'No acknowledgement' if code is None else f'HTTP {code}'
            if not retryable or row['attempts'] >= MAX_ATTEMPTS:
                row['status'] = 'failed'
        if row['status'] != 'pending':
            blocked.remove(incident_id)
        store.write(STATE_KEY, trim(state))
    return state


def public_view(state):
    state = validate_state(state)
    return {'schema_version': 1, 'deliveries': state['deliveries'],
            'summary': {status: sum(row['status'] == status for row in state['deliveries'])
                        for status in ('pending', 'delivered', 'failed')}}
