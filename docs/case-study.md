# SentinelNode: making a status dashboard trustworthy

Self-directed systems and monitoring project. Verification covers the local application, desktop and phone-width browser workflows, and simulated infrastructure on Windows and fresh Linux checkouts. Live deployment is pending.

## Problem

The starting project checked a few hardcoded endpoints and displayed their most recent status. A successful old snapshot could continue looking healthy after the monitor stopped. Checks ran sequentially, the cloud execution budget was shorter than the combined configured waits, and the deployment directory contained Windows-specific dependencies for a Linux runtime.

## Changes

The monitor now validates operator-defined endpoints, checks up to eight services concurrently, and distinguishes successful, slow, failed, and timed-out responses. It records incidents once, updates ongoing incidents, and resolves them after a healthy check. A small rolling history retains sampled status and latency observations.

The dashboard makes freshness a separate signal from service health. Old or unavailable observations become unknown, while the last observed result remains visible for diagnosis. Current success counts disappear when the data is no longer trustworthy.

A local incident lab provides actual HTTP services whose behavior can be changed deliberately. It demonstrates slow responses, HTTP failures, paused telemetry, and recovery without requiring cloud accounts or presenting sample data as live customer infrastructure.

The cloud configuration uses a private S3 origin behind CloudFront, uploads its frontend assets, restricts the monitor's S3 permissions to the telemetry objects, and serializes writes. A clean, pinned SDK package replaces the prebuilt platform-specific directory.

## Evidence and tradeoffs

A review found two history failure cases: malformed optional history could make a valid current observation unavailable, and a partially completed write could show history newer than the displayed status snapshot. History now has its own validation and timestamp boundary. The new unit and browser checks demonstrate that valid current health remains available when optional history fails, without implying that a newer check completed.

Thirty-three application checks, twenty-one browser scenarios, and one Terraform security simulation passed. The browser scenarios cover healthy, degraded, outage, stale, unavailable, and recovered states across desktop and two phone widths. Keyboard checks and automated accessibility scans exercise focus behavior and WCAG A/AA rules. The full [verification record](validation.md) links the independently executed Linux workflow and distinguishes observed results from remaining deployment work.

The implementation deliberately keeps a small operational scope. It measures HTTP response headers and sampled availability rather than claiming full application correctness or continuous uptime. History is bounded and does not replace long-term observability storage. Notifications and multi-region monitoring remain outside this release.

## Next release gate

Verify an intentional cloud deployment with a representative authorized service after AWS account prerequisites are resolved. Demonstrate both a service outage and an interruption to the monitoring path before presenting the system as deployed monitoring work. The local incident lab demonstrates these transitions but does not replace that cloud evidence.
