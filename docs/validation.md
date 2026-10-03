# Verification record

October 3, 2026

This release was checked locally on Windows with Python 3.13, Node.js, Terraform 1.13.5, AWS provider 5.100.0, and Random provider 3.9.1. The dependency lock includes the official Windows and Linux provider checksums.

## Passed

| Check | Result |
| --- | --- |
| Python unit and local HTTP integration tests | 19 passed |
| Frontend telemetry validation and freshness tests | 7 passed |
| Packaged AWS SDK/S3 contract tests using stubbed responses | 4 passed |
| JavaScript syntax check | Passed |
| Clean Lambda packaging | Passed; 2,208 files, pinned pure-Python SDK dependencies, no native Windows/Linux binaries |
| Reproducible ZIP format | Same source-only inputs produce identical archives |
| Terraform formatting and schema validation | Passed |
| Terraform security scenario using mocked providers | 1 passed, covering private bucket access, HTTPS, serialized writes, restricted S3 actions, and disabled old-event retries |

The Terraform scenario uses a simulated apply with mocked providers and dummy identifiers. It creates no real AWS resources. The S3 tests use dummy credentials and Botocore Stubber; they make no AWS calls.

## Browser workflows exercised

- Healthy local services show four operational endpoints.
- A slow HTTP response produces a degraded orders API status.
- HTTP 503 opens one active incident and updates the service card.
- Paused/aged telemetry changes all current statuses to unknown, hides current operational/incident counts, and labels prior observations.
- Recovery shows a fresh healthy observation and keeps the resolved incident in the timeline.
- Stopping the demo server produces “Telemetry unavailable” and unknown cards rather than leaving current health green.
- Restarting the server restores telemetry and a new local monitoring session.
- The desktop layout was visually inspected and showed no horizontal overflow at the checked 1,265-pixel viewport.

## Still to verify before a live portfolio release

- Actual AWS deployment, permissions, scheduled invocations, CloudFront delivery, and failure/recovery across the deployed components.
- Browser checks at mobile widths and a fuller accessibility review.
- Execution of the configured GitHub Actions workflow on Linux. Its configuration is provided, but it has not been published or run on GitHub.
- A small, representative set of authorized live endpoints and their expected response contracts.

The local demo is an interactive technical demonstration, not evidence of production uptime, customer usage, or traffic capacity.

## Reference choices

Python 3.13 is a supported [AWS Lambda runtime](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html). The package includes the AWS SDK rather than relying on an unspecified runtime SDK version; see [AWS Python packaging guidance](https://docs.aws.amazon.com/lambda/latest/dg/python-package.html).

Infrastructure tests use [Terraform provider mocking](https://developer.hashicorp.com/terraform/language/tests/mocking). The real AWS provider schema is loaded, but resource creation is simulated.
