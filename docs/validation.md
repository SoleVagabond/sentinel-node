# Verification record

October 4, 2026

## Notification controls and Windows recovery: 99 checks passed

The notification control fix passed [GitHub Actions](https://github.com/SoleVagabond/sentinel-node/actions/runs/37180161026) at commit `f12c89a` on a fresh Linux checkout. All three jobs succeeded. All 48 backend tests also passed locally on Windows. No AWS resource or external notification recipient was used.

| Current release check | Result |
| --- | --- |
| Python unit and real loopback HTTP integration | 48 passed |
| Frontend telemetry validation and freshness | 10 passed |
| Packaged SDK/S3 contracts with stubbed responses | 4 passed |
| Browser workflows across desktop, 375px, and 320px | 36 passed |
| Mocked infrastructure security scenario | 1 passed |
| JavaScript syntax, clean packaging, Terraform formatting/schema validation | Passed |
| Independent notification recording | Six actual HTTP stages verified; five unique notifications from six accepted requests |

Notification checks exercise opening/escalation/recovery, ordered delivery, due-time backoff, retry exhaustion, permanent failures, restart recovery, checkpoint preservation after a partial telemetry write, bounded retention, queue saturation without eviction, malformed state, bearer-token redirect protection, and real connection loss after acceptance. The browser confirms that unavailable delivery history or a failed receiver does not hide valid current service health. It retains keyboard, layout, and automated accessibility coverage.

The lost-reply browser test waits for the completed incident observation before selecting its delivery, avoiding accidental inspection of an earlier notification. Receiver changes also disable scenario controls until the setting has finished. The passing suite has no automatic test retries or suppressed scan rules.

Receiver controls now confirm their setting, and a direct **Send test notification** exercises the actual local HTTP receiver without creating a service incident. Retry explains empty queues and due times, or reports attempted and acknowledged counts. The latest test result updates after a background acknowledgement. New browser cases exercise these controls and receipt deduplication at all three sizes.

Inspection of the original Windows session found that polling could hold an outbox file open during atomic replacement, raising `PermissionError` and stopping the sampling thread. LocalStore now serializes its reads and writes within the process; a regression test verifies complete concurrent reads during repeated writes. Background collection preserves prior state after a failed check and tries again on the next tick. The same local server on port 8796 was restarted with its retained state, all controls were exercised in the browser, and continuing fresh observations were confirmed. Existing failed records were preserved.

The [six-step notification recording](evidence/notification-delivery.json) uses real retry due times, not a simulated clock. Its final five unique receiver notifications come from six accepted requests. The [delivery design and operating limits](notifications.md) distinguish acknowledgement, finite retries, receiver deduplication, and remaining cloud integration.

## Earlier history-handling release

The current history-handling release was checked locally on Windows and in a fresh Linux checkout through [GitHub Actions](https://github.com/SoleVagabond/sentinel-node/actions/runs/37176167008), commit `8d17c87`. All three jobs passed. The development baseline is Python 3.13, Node.js 22, Terraform 1.13.5, AWS provider 5.100.0, and Random provider 3.9.1. The dependency lock includes the official Windows and Linux provider checksums.

## Passed

| Check | Result |
| --- | --- |
| Python unit and local HTTP integration tests | 19 passed |
| Frontend telemetry validation, freshness, and history tests | 10 passed |
| Packaged AWS SDK/S3 contract tests using stubbed responses | 4 passed |
| JavaScript syntax check | Passed |
| Clean Lambda packaging | Passed; 2,208 files, pinned pure-Python SDK dependencies, no native Windows/Linux binaries |
| Reproducible ZIP format | Same source-only inputs produce identical archives |
| Terraform formatting and schema validation | Passed |
| Terraform security scenario using mocked providers | 1 passed, covering private bucket access, HTTPS, serialized writes, restricted S3 actions, and disabled old-event retries |
| Browser scenarios on Linux/Chromium | 21 passed across 1280×900, 375×812, and 320×740 viewports |
| Mobile layout checks | No horizontal overflow in healthy, outage, and stale states at both phone widths |
| Keyboard checks | Skip link moves focus into main content; scenario controls retain focus after activation |
| Automated accessibility scans | No violations of the selected WCAG 2 A/AA and 2.1 AA rules in healthy, outage, stale, and recovered states at all three viewports |

The Terraform scenario uses a simulated apply with mocked providers and dummy identifiers. It creates no real AWS resources. The S3 tests use dummy credentials and Botocore Stubber; they make no AWS calls.

The [browser evidence artifact](https://github.com/SoleVagabond/sentinel-node/actions/runs/37176167008/artifacts/11293486776) contains screenshots, the HTML report, and accessibility JSON results. GitHub retains it until October 18, 2026; the checked-in browser suite can regenerate it. Automated scans and Chromium viewport emulation are not a full accessibility audit or physical-device/browser compatibility certification.

The first workflow run caught prohibited ARIA labels on the sampled history containers. The containers were given valid group roles, and the complete suite passed on the next fresh checkout. No scan rules were suppressed.

## Browser workflows exercised

- Null history, a null sample, and a null endpoint row leave a valid current observation operational, with history explicitly unavailable.
- A newer history sample paired with an older completed status snapshot is withheld. The dashboard shows only checks at or before its current observation.

The checked-in [local incident record](evidence/local-incident-sequence.json) retains full snapshots and history for healthy → HTTP 503 outage → deliberately aged telemetry → confirmed recovery. It was recorded through the demo's HTTP controls against a fresh loopback server. The outage opens one incident, and recovery keeps its resolved record.

- Healthy local services show four operational endpoints.
- A slow HTTP response produces a degraded orders API status.
- HTTP 503 opens one active incident and updates the service card.
- Paused/aged telemetry changes all current statuses to unknown, hides current operational/incident counts, and labels prior observations.
- Recovery shows a fresh healthy observation and keeps the resolved incident in the timeline.
- Stopping the demo server produces “Telemetry unavailable” and unknown cards rather than leaving current health green.
- Restarting the server restores telemetry and a new local monitoring session.
- The desktop layout was visually inspected and showed no horizontal overflow at the checked 1,265-pixel viewport.

## Deployment preflight and remaining cloud verification

A real, locally executed probe of the owner-operated [Northline Cycle website](https://northline-cycle-devin.netlify.app/) returned HTTP 200. The Lambda package was built with this operator configuration, which is excluded from Git. This is an authorized network preflight, not a deployed AWS observation.

An authenticated Terraform plan prepared 20 additions, zero changes, and zero removals. It was not applied. AWS CloudShell reported that account verification was in progress. The regional Lambda quota was 10; reserving one writer requires at least 101 under [AWS's concurrency rule](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html). No quota increase was submitted, and no deployment resources were created.

Still required: actual AWS deployment, permissions, scheduled invocations, CloudFront delivery, and service failure/recovery across the deployed components. Record a controlled outage on a dedicated owned verification endpoint, interrupt the monitoring schedule without editing timestamps, then confirm fresh telemetry and retained incident recovery. Resolve AWS account prerequisites before creating resources.

The local demo is an interactive technical demonstration, not evidence of production uptime, customer usage, or traffic capacity.

## Reference choices

Python 3.13 is a supported [AWS Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html). The package includes the AWS SDK rather than relying on an unspecified runtime SDK version; see [AWS Python packaging guidance](https://docs.aws.amazon.com/lambda/latest/dg/python-package.html).

Infrastructure tests use [Terraform provider mocking](https://developer.hashicorp.com/terraform/language/tests/mocking). The real AWS provider schema is loaded, but resource creation is simulated.
