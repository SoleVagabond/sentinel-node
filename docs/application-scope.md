# Sentinel application v1

Sentinel is a single-operator HTTP monitoring application for a workstation or a server accessed through a local connection. Its complete workflow is: configure a service, observe scheduled checks, investigate and acknowledge an incident, confirm recovery, inspect webhook delivery, and preserve or export the evidence.

The live application starts with no services. Its explicit demonstration mode uses only its own loopback fixtures. Demonstration controls never appear in live mode.

Release acceptance:

- Add, edit, pause, resume, and remove up to eight HTTP services, with validated response codes, timeout, and latency threshold.
- Run scheduled checks and manual checks, retaining state across restart. Show paused, never-checked, stale, and failed monitoring states explicitly.
- Store observations, incidents, acknowledgement notes, configuration, and the notification outbox in a private SQLite database. Completed observations and their incident transitions commit together.
- Configure an opt-in webhook, send a test, inspect retry outcomes, and deliberately retry a terminal failure using its original reference. Secrets come from the process environment.
- Filter service history, export sampled observations, and download a consistent database backup. Document restoration and retention limits.
- Keep administration on loopback, protect mutation requests against cross-origin use, and prevent two app instances from sharing one state directory.
- Build a portable Python application archive, include an easy local demonstration, and verify real HTTP workflows at desktop and narrow screen sizes.

The scope is deliberately one operator and one monitor process. AWS deployment, teams, subscriptions, third-party email delivery, and claims of commercial uptime are separate decisions. These are not required to finish the application's stated workflow.
