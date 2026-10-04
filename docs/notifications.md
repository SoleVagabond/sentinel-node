# Incident notification delivery

Sentinel's local lab sends actual JSON webhooks for incident opening, escalation from slow response to outage, and confirmed recovery. Delivery state and receiver receipts survive a restart in the chosen private state directory. The [six-step recording](evidence/notification-delivery.json) contains actual HTTP observations and receipts; it uses no simulated retry clock.

## Reproduce the failure cases

Use **Open notification lab ↓** beside the main demo controls to jump directly to notification controls. The shortcut moves keyboard focus into the panel as well as scrolling to it, so a long incident history does not hide the test action.

For a quick test entirely within the notification panel, select **Receiver unavailable**, then **Send test notification**. The result reports the HTTP 503 and shows a pending test record. Restore **Receiver available**, then retry after its displayed due time. With **Lose next reply** armed, a test is accepted but initially unacknowledged; a subsequent retry uses the same reference and the receiver retains one notification. Test messages are labelled `test` and do not create service incidents or change observed health. The action result updates when the latest test is acknowledged, including by the background loop.

Each receiver control confirms its setting and explains the next action. **Retry due deliveries** reports attempted and acknowledged counts, or explains that nothing is pending or due. Failed records remain visible and are not automatically replayed. The current receiver state is shown separately from the last action result.

Local reads and writes share a process lock so polling cannot hold a Windows file open during atomic replacement. A failed background check retains the prior observation and retries on the next tick; it does not silently stop the checking loop. One process must still own each state directory.

Run `python scripts/demo.py`, then open http://127.0.0.1:8791/. In **Notification delivery lab**, select **Receiver unavailable**, then **Slow response**, **API outage**, and **Recover** above. The services recover while three notifications remain queued. Restore **Receiver available** and use **Retry due deliveries** after the next due time. Opening, escalation, and recovery reach the receiver in order.

Next select **Lose next reply**, then trigger a fresh **API outage**. The receiver saves the notification and closes its connection without a reply. Sentinel leaves the delivery pending and retries the identical event ID. The receiver retains one notification with two accepted requests, and Sentinel records two attempts before marking it delivered. **Recover** sends a separate recovery event linked to the same incident.

The lab uses a one-second initial retry delay to keep this exercise short. Its background loop drains every five seconds, including while telemetry is deliberately paused. The retry button respects due times; it does not bypass backoff. Automatic delivery stops after five attempts. Start with a new `--state-dir work/another-session` for a fresh demonstration without deleting earlier evidence.

Generate independent recorded evidence with:

```console
python scripts/record_notifications.py
```

This starts a fresh loopback server, verifies five unique notifications from six accepted requests, and writes `work/notification-delivery.json`. It never contacts an external receiver or AWS.

## Operator-configured webhook

The standalone monitor supports `--notify`. Configure `SENTINEL_WEBHOOK_URL` and optionally `SENTINEL_WEBHOOK_TOKEN` in its process environment, then use:

```console
python backend/monitor.py --config backend/endpoints.json --output work/private-monitor --notify
```

Use a receiver you operate or are authorized to notify. HTTPS is required except for loopback development. Redirects are rejected, and the bearer token never appears in the saved queue, event payload, logs, or frontend. Credentials, query strings, and fragments are rejected in webhook URLs. Each request includes `Idempotency-Key` matching the payload's `id`.

The receiver must acknowledge with a 2xx response **after** durably accepting the event. It must enforce unique event IDs, returning a successful acknowledgement for an identical retry and rejecting a different payload with the same ID. A 2xx proves acknowledgement by that receiver, not delivery of an email or a human response. The fixture retains its latest 1,000 unique receipts; a production receiver needs a retention policy covering its replay window.

Run subsequent checks with the same output directory and destination. The monitor checks once and drains at most five due sends. It retries network errors, 408, 429, and 5xx responses using 30, 60, 120, and 240-second delays. Other non-2xx responses stop delivery. Five attempts produce a terminal failed record. The drain stops starting further sends after its ten-second budget; socket timeouts and DNS resolution are not a strict overall wall-clock guarantee.

## Persistence and failure behavior

`alert_state.json` stores incident checkpoints and delivery records together using a temporary file and atomic replacement. The checkpoint preserves an incident's original opening time even if a subsequent telemetry write fails. Each attempt is saved before its HTTP request. A crash or failed acknowledgement write may cause a repeated request with the same ID; receiver deduplication is therefore required. This is at-least-once delivery with a finite retry window, not an exactly-once transport guarantee.

Opening events precede escalation and recovery for the same incident while pending. One incident's delayed delivery does not block other incidents. A permanent failure permits later events to proceed; its failed record remains available for inspection. Repeated observations and repeated severity changes do not create another opening or escalation for the same incident, including after terminal delivery history ages out.

Pending records are capped at 200 and never silently evicted. A full queue refuses the next checkpoint, and the check reports an error. The latest 100 terminal records are retained alongside pending work. Invalid saved state fails explicitly without being replaced. Notification HTTP failures do not change observed service health. An independent monitor-heartbeat alert is outside this feature: a stopped monitor cannot send its own outage notification.

Use one writer per state directory. Preserve it across restarts and keep it private. Do not expose the standalone output directory through a static server: it includes notification metadata. A failed event needs operator inspection and deliberate repair; there is no automatic replay of terminal failures. The lab serves only its explicit public routes and never serves the private queue file.

## Cloud boundary

AWS notification delivery is not enabled by this feature. Lambda continues to write only its existing status/history objects; it does not read the outbox or call a webhook. The cloud permissions and dashboard policy do not establish a private notification store. Cloud notification integration requires a separate private storage path, secret configuration, serialized processing, and observed delivery verification before activation.
