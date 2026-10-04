# Live application verification

On October 4, 2026, the packaged Sentinel application passed **35 real-network workflows** in live mode. These tests launched the portable archive with a new private workspace; demonstration controls were absent. The [machine-readable evidence](evidence/live-verification.json) records observations, assertions, timestamps, and the tested archive hash. Private operator databases, backups, screenshots, and unrelated service configurations are excluded from the published evidence.

## Actual websites and failure endpoints

| Target | Observed result |
| --- | --- |
| Portfolio website | HTTPS 200; healthy |
| Northline Cycle | HTTPS 200; healthy |
| HTTPbin status 204 | Healthy when 204 is explicitly expected |
| HTTPbin status 503 | Failed observation and an incident |
| HTTPbin redirect | Followed service redirect; final HTTP 200 |
| BadSSL self-signed certificate | TLS verification failure |
| Reserved nonexistent `.invalid` hostname | DNS failure |
| HTTPbin delayed response | Request timeout |

[HTTPbin](https://httpbin.org/) and [BadSSL](https://badssl.com/) provide deliberate response and certificate conditions. Public requests were bounded, one-shot checks rather than a load test. These observations establish the behavior at the recorded time, not continuing availability of another website.

## Complete workflows

Controlled loopback HTTP services and a local notification receiver exercised the rest of the application through its real HTTP interface:

- Malformed service and webhook URLs are rejected without changing saved configuration. A ninth configured service is rejected atomically.
- A slow response opens an incident; HTTP 503 escalates the same incident; HTTP 200 resolves it. Acknowledgement and an investigation note survive recovery. The receiver accepts opening, escalation, and recovery notifications in that order.
- A receiver accepts a test notification and closes before replying. Sentinel waits for its real 30-second retry time and repeats the original ID. Two accepted requests produce one unique receiver receipt. The observed completion time was 34.71 seconds.
- Test notifications leave monitored service health unchanged. A permanent HTTP 400 stops automatic retry; deliberate replay retains the original ID and total attempt count.
- Webhook redirects are rejected, and the redirect target receives no request. Malformed HTTP replies remain unconfirmed deliveries eligible for retry. A malformed monitored response fails only its own check while another service completes normally.
- Process termination and restart preserve configuration, observations, incident notes, and delivery records. Pending delivery resumes at its saved eligible time. A new browser session token is generated.
- Eight actual loopback services run concurrently. Seven responses wait 350 milliseconds; the collection completes in 0.392 seconds compared with 2.474 seconds of summed probe time. This verifies overlap, not Internet-scale capacity.
- Two simultaneous manual requests produce one completed check and one clear already-running response. A five-second schedule adds three observations during the recorded interval. Pausing stops scheduled observations; a manual check still works.
- CSV history and a consistent SQLite backup download successfully. Restoring the backup into a new directory retains notes while checks and delivery start paused. A second process cannot own the same workspace. Restored database integrity passes.
- A headers-only fixture verifies the documented measurement boundary: Sentinel measures response headers, not body correctness or download completion.

## Faults found and corrected

The first Windows launch could not create outbound connections because its execution environment denied network access with error 10013. Relaunching with authorized network access produced real successful observations. Sentinel now distinguishes a monitor permission failure from a service failure: it reports that the monitor needs attention, exports an unknown observation, and neither opens a fictitious service incident nor resolves an existing one. Regression tests cover both direct and wrapped permission errors.

DNS, TLS, timeout, and HTTP response failures have distinct diagnostics. Unexpected HTTP 401/403 is explained as access denied to the monitoring request; this does not establish that a website is unavailable to every visitor.

URLs containing spaces, control characters, unencoded non-ASCII characters, or invalid ports are rejected before saving. Previously a malformed URL could escape validation and interrupt collection. Malformed HTTP responses are now contained within the relevant probe or notification attempt.

Manual Windows browser checks also configured the two public project websites in the retained operator workspace, paused and resumed a service, and confirmed that polling does not overwrite an unsaved edit. Existing user configuration and history were retained.

## Repeat the verification

```console
python scripts/verify_live.py --allow-public-http
```

The explicit flag permits bounded outbound requests. Run from a normal environment that permits HTTP/HTTPS access. The script packages and launches the actual application, owns its local fixtures, and stops them afterward. It takes approximately two minutes, including real retry waits. Evidence, process logs, exports, and private test databases remain under a timestamped `work/live-verification-*` directory. This opt-in network exercise is separate from deterministic CI.

See [the regression verification record](validation.md) and [application operating limits](application.md). The evidence covers a single-operator application on Windows with Linux regression coverage. It does not claim a customer SLA, cloud deployment, installed process supervisor, or commercial traffic capacity.
