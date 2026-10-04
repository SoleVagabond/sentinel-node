# Sentinel application 1.0

Sentinel is a private, single-operator HTTP monitoring workspace. It has a complete service-to-incident workflow and an explicit local demonstration. It is intended for a computer or server you control, with Python 3.13. It requires no runtime dependencies, subscription, or cloud resources.

## Start and stop

From a source checkout:

```console
python scripts/run_app.py
```

From the portable archive produced by `python scripts/package_app.py`:

```console
python sentinel.pyz
```

Open **http://127.0.0.1:8798/**. Leave the process running for scheduled checks. Stop with **Ctrl+C** and start it again to resume the saved workspace. Closing the browser does not stop monitoring; turning off or suspending the computer does. This release does not install an operating-system background service.

Live mode starts empty, with scheduled checks every 30 seconds and notifications disabled. Add a service through **Services**, using an authorized HTTP/HTTPS URL, expected response codes, timeout, and slow-response threshold. Up to eight services can be configured. A completed check establishes their health; configuration alone does not.

Use `--port 8799` for a different browser port and `--state-dir PATH` for a different private directory. The initial `--interval` flag accepts 5–3600 seconds. Saved settings take precedence on subsequent launches. **Settings** changes the ongoing schedule and retention. **Check now** performs a manual check even when the schedule is paused.

Default live data is `~/.sentinel/`; demonstration data is `~/.sentinel-demo/`. One process may own each directory. A second instance is rejected instead of competing to write its history. Different workspaces need different ports and state directories.

## Five-minute demonstration

```console
python sentinel.pyz --demo
```

Or use `python scripts/run_app.py --demo` from source. This starts two real HTTP services and a webhook receiver on loopback, with checks every five seconds. The demonstration rejects external service and webhook URLs. Its fixture controls are absent in live mode.

1. Choose **API outage**, apply it, and use **Check now**. Orders API returns HTTP 503; an incident opens.
2. Open **Incidents**, respond to the incident, acknowledge it, and save an investigation note. Its health remains failed until a successful check.
3. Apply **Healthy** and check again. The incident becomes recovered; the note and acknowledgement remain.
4. Under **Receiver behavior**, apply **Lose next reply once**. Open **Notifications** and send a test. The receiver saves the notification before losing its HTTP reply. Retrying acknowledges the same notification ID; the receiver keeps one unique receipt.
5. Apply an unavailable receiver and send another test. Delivery stays pending while service health remains operational. Restore availability, or inspect and cancel the pending queue before deliberately retrying the failed record.
6. Open **History** to filter and export observations, then **Settings** to download a backup. Restart to confirm that saved configuration, notes, and delivery history remain.

Fixture behavior returns to healthy/available when the demonstration restarts. Saved monitoring records and queued deliveries persist. Receipts are retained for up to 1,000 unique notifications. This demonstration is evidence of controlled local behavior, not customer traffic or cloud uptime.

## Incident and notification behavior

Acknowledgement records operator attention. It never changes observed service health. Recovery requires a healthy observation. Pausing retains data and marks current readings unavailable for that service. Removing a service closes its active incident as **Monitoring stopped**, without emitting a fictitious recovery. Changing its URL also ends monitoring of the previous endpoint.

Set an HTTPS webhook URL in **Notifications** and enable delivery. Loopback HTTP is allowed for a receiver on the same machine. URLs cannot contain embedded credentials, query parameters, or fragments. Optional bearer authentication comes from the process environment:

```powershell
$env:SENTINEL_WEBHOOK_TOKEN = '<your receiver token>'
python sentinel.pyz
```

The token stays out of the database, UI, exports, and source repository. Restart to change it. The receiver must accept Sentinel's JSON payload and deduplicate its `event.id`, also supplied as the `Idempotency-Key` header. Arbitrary third-party webhook formats may require an adapter. See the [payload contract and retry behavior](notifications.md).

Test notifications exercise delivery without creating incidents. Failed deliveries use bounded exponential retries, with at most five attempts per cycle. Live retries start at 30 seconds; the demonstration starts at one second. Retry due deliveries respects their eligible time. Permanent failures stop automatically. A deliberate **Retry failed notification** starts another finite cycle with the original ID and retains total attempt counts. Acknowledgement means an HTTP acceptance, not proof that a person received a message.

Pausing delivery preserves the pending queue, which resumes when enabled. Transitions observed while delivery is disabled are not retroactively announced. Cancel pending deliveries before changing the receiver URL. Canceled records remain visible as failed; inspection should precede any manual replay. The durable working queue has bounded capacity. Older terminal records remain in the database journal, but only records still retained in the working outbox can be replayed through the interface.

## Storage and backup

The private directory contains `sentinel.db`, its SQLite WAL files while active, and a process-ownership lock. A completed observation, incident transitions, and newly queued notifications commit together. Delivery results commit after the HTTP attempt. If an observation fails, its transaction rolls back and the previous completed observation remains available; the scheduler continues trying.

Observations retain 1–30 days, subject to a maximum of 20,000 snapshots. At a five-second interval that cap is roughly 28 hours, even if more days are selected. Retention is applied after completed checks. The chart loads up to 500 snapshots; CSV exports up to 20,000. A removed service's observations remain in **All services** history until retention removes them. Incident notes and delivery journals persist independently; the interface shows the latest 200 records plus open incidents and pending deliveries. Journal storage can grow over time. Make backups and check available disk space.

Use **Settings → Download database backup** for a consistent SQLite backup while running. The downloaded file includes private URLs, observations, incident notes, and notification payloads. Store it privately. Copying only an active `sentinel.db` file can omit uncheckpointed WAL data.

Restore into a **new directory**:

```console
python sentinel.pyz --restore sentinel-backup.db --state-dir restored-sentinel
python sentinel.pyz --state-dir restored-sentinel
```

Restoration validates the database and refuses to overwrite an existing workspace. Both scheduled checks and notification delivery start paused. Inspect service URLs, notes, and pending deliveries, then enable them deliberately. Restoring a demo backup also requires `--demo` when launching it. Preserve a backup before switching application versions; incompatible database versions are rejected.

## Server access and boundaries

The admin server binds only to `127.0.0.1`. Local-host and origin checks plus a session token protect browser mutations. It serves only an explicit asset/API allowlist and never serves the database directory. This is a trusted local operator interface, without accounts, team roles, or Internet-facing login.

For a server, keep administration on loopback and use an SSH tunnel:

```console
ssh -L 8798:127.0.0.1:8798 operator@your-server
```

Open the same local URL. Monitoring runs from the server, so its network access determines which configured services it can reach. For unattended operation, an operator should separately configure the operating system's process supervisor and environment. Process supervision and external monitor-heartbeat alerts are outside this release.

Checks measure response headers, not body correctness or continuous uptime. Socket timeouts do not guarantee a strict wall-clock limit on DNS lookup. A stopped or failing monitor makes readings stale rather than green. There is no claimed SLA, customer adoption, traffic capacity, or verified AWS deployment. The separate cloud dashboard and original incident lab retain their own storage/deployment constraints.

## Verification

The [release scope](application-scope.md) defines the bounded application. Tests use real loopback HTTP for configuration, incident transitions, persistence, retries, deduplication, exports, and portable launch. The browser suite covers desktop and two phone widths, native dialogs and keyboard focus, automated accessibility rules, and both empty live onboarding and the demonstration. See the [verification record](validation.md) for actual completed runs.
