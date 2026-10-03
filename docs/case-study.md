# SentinelNode: making a status dashboard trustworthy

Self-directed systems and monitoring project. Current verification covers the local application and simulated infrastructure, with live deployment still pending.

## Problem

The starting project checked a few hardcoded endpoints and displayed their most recent status. A successful old snapshot could continue looking healthy after the monitor stopped. Checks ran sequentially, the cloud execution budget was shorter than the combined configured waits, and the deployment directory contained Windows-specific dependencies for a Linux runtime.

## Changes

The monitor now validates operator-defined endpoints, checks up to eight services concurrently, and distinguishes successful, slow, failed, and timed-out responses. It records incidents once, updates ongoing incidents, and resolves them after a healthy check. A small rolling history retains sampled status and latency observations.

The dashboard makes freshness a separate signal from service health. Old or unavailable observations become unknown, while the last observed result remains visible for diagnosis. Current success counts disappear when the data is no longer trustworthy.

A local incident lab provides actual HTTP services whose behavior can be changed deliberately. It demonstrates slow responses, HTTP failures, paused telemetry, and recovery without requiring cloud accounts or presenting sample data as live customer infrastructure.

The cloud configuration uses a private S3 origin behind CloudFront, uploads its frontend assets, restricts the monitor's S3 permissions to the telemetry objects, and serializes writes. A clean, pinned SDK package replaces the prebuilt platform-specific directory.

## Evidence and tradeoffs

Thirty application checks passed, alongside a Terraform security simulation. Browser checks exercised healthy, degraded, outage, stale, unavailable, and recovered states. The full [verification record](validation.md) distinguishes observed results from remaining deployment work.

The implementation deliberately keeps a small operational scope. It measures HTTP response headers and sampled availability rather than claiming full application correctness or continuous uptime. History is bounded and does not replace long-term observability storage. Notifications and multi-region monitoring remain outside this release.

## Next release gate

Complete mobile/accessibility checks, then verify an intentional cloud deployment with a representative authorized service. Demonstrate both a service outage and an interruption to the monitoring path before presenting the system as deployed monitoring work.
