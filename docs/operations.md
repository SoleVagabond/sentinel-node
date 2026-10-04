# Operations and recovery

## Local demonstration

Start `python scripts/demo.py` and walk through healthy → slow response → outage → pause telemetry → recover. The service requests are real loopback HTTP checks. The paused scenario deliberately adjusts the observation timestamp to demonstrate stale handling immediately rather than waiting.

Refreshing the dashboard fetches observations; it does not itself trigger a new live cloud check. Recovering the local demo triggers a fresh local check. Sample history resets on restart; incident checkpoints, pending deliveries, and receiver receipts persist in the selected state directory. Restarting into a healthy scenario can therefore resolve an incident from the prior run.

## Configure a live deployment

Keep the endpoint configuration private locally and use only endpoints intended for public status reporting. Configure up to eight unique IDs. Match the expected HTTP response codes to each health endpoint. Validate that a successful response actually represents the application behavior you care about; a 200 from a generic homepage is a limited signal.

Rebuild the package before planning infrastructure changes. Review both code and endpoint changes. For shared use, establish a protected remote Terraform state backend before multiple operators make changes. This starter uses local state by default; keep it out of Git and preserve it until cleanup is complete.

## When the dashboard says unknown or stale

1. Check the last completed observation and distinguish a service outage from absent telemetry.
2. Inspect the monitor's CloudWatch log group and Lambda invocation errors/throttles.
3. Check the EventBridge rule, invocation permission, package configuration, and bucket write permission.
4. Restore the failed component, then confirm a new snapshot timestamp and valid history data.
5. Confirm healthy service checks resolve incidents. Do not clear incident history merely to produce green status.

Pause scheduled checks through `monitor_enabled = false` in Terraform if intentional maintenance requires it. The dashboard should become stale after three missed one-minute intervals. Restoring the schedule should produce a fresh observation without manual editing of telemetry.

## Changes and costs

CloudFront serves a public HTTPS dashboard through a private S3 origin. The dashboard and telemetry caching policy prioritizes freshness over reduced requests. Keep the demo local until cloud operation is needed. Review AWS pricing for your region and account before applying a plan; no free-tier or cost estimate is assumed.

Incident webhooks and receiver failure/recovery are verified in the local lab. The standalone monitor enables delivery only with `--notify`. See [notification operations](notifications.md) for retry rules, private state, receiver deduplication, and failed-event inspection. Lambda notification delivery and an independent monitor-heartbeat alert are not enabled. Lambda execution failures remain visible in AWS logs, while the dashboard flags stale telemetry.

## Intentional cleanup

The bucket is configured with `force_destroy = false`. This protects retained observations from accidental deletion during an ordinary destroy.

When intentionally removing a deployment: disable scheduled checks, save any history needed, review a destroy plan, and remove retained objects from the **exact bucket returned by this deployment's Terraform output**. Only then destroy the resources. Never target a guessed bucket name or broad wildcard. Retain state until Terraform confirms cleanup.
