# Sentinel @VERSION@ verification

Source commit: `@SOURCE_COMMIT@`. The public archive is rebuilt from this source without operator databases, saved configuration, or local workspace files. Its only files are the program, Windows launcher, quick-start guide, program checksum, and this verification record.

Release downloads are attached by GitHub Actions only after the application, browser, and infrastructure jobs pass on the release tag. See [Project checks](https://github.com/SoleVagabond/sentinel-node/actions/workflows/checks.yml) for the corresponding release run.

The application previously passed **163 regression checks**: 72 Python, 11 frontend, four packaged-SDK contracts, 75 desktop/mobile browser workflows, and one mocked infrastructure scenario. The [verification record](https://github.com/SoleVagabond/sentinel-node/blob/v1.0.0/docs/validation.md) describes evidence and boundaries. Browser coverage includes first-service setup, service editing, incidents and notes, notification prerequisites, retry timing, shortcuts, history inspection, keyboard access, backups, and exports at three screen sizes.

An earlier package separately passed **35 live workflows**, including actual HTTPS sites, deliberate HTTP/TLS/DNS/timeout failures, escalation/recovery, real retry delays and deduplication, restart persistence, concurrent probes, scheduler behavior, backups, and restoration. Only controlled local receivers received notifications. That [live report](https://github.com/SoleVagabond/sentinel-node/blob/v1.0.0/docs/live-verification.md) preserves its original package hash; it is not a claim that this newer archive was used in that earlier run. The intervening interface update leaves the monitoring backend unchanged.

The ZIP checksum is published separately; SHA256.txt inside the ZIP identifies sentinel.pyz. Checksums detect a mismatched download and are not a code-signing certificate.

Runtime requires Python 3.13. This is a private single-operator application. Automated scans do not establish complete accessibility conformance. Hosted accounts, installed process supervision, live AWS deployment, customer adoption, and commercial uptime are not claimed.
