"""Record actual loopback notification failures and receipts; no simulated clocks."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from demo import create_server


def record(output):
    server = create_server(0)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    state = server.demo_state
    steps = []
    def capture(name):
        steps.append({'step': name, 'snapshot': state.snapshot, 'notifications': state.alerts()})
    def drain():
        deadline = time.monotonic() + 10
        while state.alerts()['summary']['pending'] and time.monotonic() < deadline:
            state.retry()
            time.sleep(.1)
        assert state.alerts()['summary']['pending'] == 0, 'Receiver did not acknowledge the queue.'
    try:
        state.sample()
        capture('healthy')
        state.receiver_mode = 'unavailable'
        state.set_scenario('degraded')
        state.set_scenario('outage')
        state.set_scenario('recovered')
        capture('healthy-services-unavailable-receiver')
        assert state.alerts()['summary']['pending'] == 3
        assert all(row['status'] == 'Green' for row in state.snapshot['endpoints'])
        state.receiver_mode = 'available'
        drain()
        capture('receiver-restored')
        assert [row['event']['type'] for row in state.alerts()['receipts']] == ['opened', 'escalated', 'recovered']
        state.receiver_mode = 'lose-next-response'
        state.set_scenario('outage')
        capture('accepted-with-lost-reply')
        event_id = state.alerts()['deliveries'][-1]['event']['id']
        assert state.alerts()['summary']['pending'] == 1
        assert state.alerts()['receipts'][-1]['requests'] == 1
        drain()
        capture('same-reference-retried')
        receipts = [row for row in state.alerts()['receipts'] if row['event']['id'] == event_id]
        assert len(receipts) == 1 and receipts[0]['requests'] == 2
        state.set_scenario('recovered')
        capture('confirmed-recovery')
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps({'environment': 'local notification lab',
            'notes': 'Actual HTTP probes and loopback webhook delivery. Receiver outages and a closed connection after saving a receipt are deliberate fixtures. Retry due times use the real clock. This is recorded evidence, not a live cloud observation.',
            'steps': steps}, indent=2) + '\n', encoding='utf-8')
        print(f'Recorded six steps: {output}; five unique notifications, six accepted requests.')
    finally:
        server.shutdown()
        server.server_close()
        worker.join(3)
        server.temporary_state.cleanup()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=Path('work/notification-delivery.json'))
    record(parser.parse_args().output)
