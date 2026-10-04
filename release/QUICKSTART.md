# Start Sentinel

Sentinel monitors HTTP websites and services from your computer or server. Python 3.13 is required. Node.js, cloud accounts, and additional Python packages are not required to run it.

## Download and start

1. Download **Sentinel-1.0.0.zip** from the [GitHub release](https://github.com/SoleVagabond/sentinel-node/releases/tag/v1.0.0).
2. Extract the ZIP into a folder. Run the extracted files, not the ZIP preview.
3. Check that `python --version` reports Python 3.13. If Python is missing, install it from [python.org](https://www.python.org/downloads/) and reopen your terminal. On Windows, enable its PATH option.
4. On Windows, double-click **StartSentinel.cmd**. On other systems, open a terminal in the extracted folder and run `python3.13 sentinel.pyz --port 8799`.
5. Open **http://127.0.0.1:8799/**. Leave the program running while monitoring; Ctrl+C stops it.

If port 8799 is in use, run `python sentinel.pyz --port 8802` and open **http://127.0.0.1:8802/**. On Linux/macOS, replace `python` with `python3.13` in the commands below.

## Add your first website

Live mode starts empty. Choose **Add your first service**, enter a name and full HTTPS URL for an endpoint you operate or are authorized to monitor, and save. Advanced settings are optional. Choose **Check now** on Overview, then open History to inspect the HTTP result and response time. Checks run every 30 seconds by default; Settings lets you pause them or change the interval.

Services, observations, incident notes, and queued notifications survive restarts under `.sentinel` in your user directory. Notifications are optional and remain off until you configure and enable a webhook in Notifications. Use its test action before relying on delivery.

## Try controlled failures

Stop the live program, then run:

```console
python sentinel.pyz --demo --port 8799
```

This uses real local fixtures and a separate `.sentinel-demo` directory. Choose **API outage**, **Check now**, then acknowledge and annotate the incident. Choose **Healthy** and check again to see retained recovery history. The notification receiver can demonstrate unavailability and a lost reply without sending messages to anyone else.

## Backup and restore

Download a database backup in Settings. Restore into a new folder:

```console
python sentinel.pyz --restore sentinel-backup.db --state-dir restored-sentinel
python sentinel.pyz --state-dir restored-sentinel --port 8799
```

Restored scheduled checks and notifications start paused for inspection. Add `--demo` to the launch command when restoring a demonstration backup.

## Verify the download

The separate **Sentinel-1.0.0-SHA256.txt** release asset identifies the ZIP. On Windows, compare it with `Get-FileHash .\Sentinel-1.0.0.zip -Algorithm SHA256`; on Linux, use `sha256sum -c Sentinel-1.0.0-SHA256.txt`; on macOS, use `shasum -a 256 -c Sentinel-1.0.0-SHA256.txt`. The ZIP's **SHA256.txt** identifies the program itself.

Administration stays on loopback. For a remote server, use an SSH tunnel. The program does not install an operating-system service: closing its terminal or sleeping/shutting down its computer stops checks. It measures sampled HTTP response headers, not page contents or continuous uptime. It is a private single-operator application; the hosted portfolio preview is a separate recorded replay.

[Full guide](https://github.com/SoleVagabond/sentinel-node/blob/v1.0.0/docs/application.md) · [Source](https://github.com/SoleVagabond/sentinel-node/tree/v1.0.0) · [Verification](https://github.com/SoleVagabond/sentinel-node/blob/v1.0.0/docs/validation.md)
