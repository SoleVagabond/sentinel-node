"""Private SQLite persistence with one application owner per directory."""
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sqlite3
import threading


class Database:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.owner = (self.directory / 'application.lock').open('a+b')
        try:
            if (self.directory / 'application.lock').stat().st_size == 0:
                self.owner.write(b'0')
                self.owner.flush()
            self.owner.seek(0)
            if __import__('os').name == 'nt':
                import msvcrt
                msvcrt.locking(self.owner.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner.close()
            raise ValueError('Another Sentinel instance owns this state directory.') from None
        self.lock = threading.RLock()
        self.depth = 0
        try:
            self.connection = sqlite3.connect(self.directory / 'sentinel.db', check_same_thread=False, timeout=10)
            self.connection.row_factory = sqlite3.Row
            version = self.connection.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ValueError('Unsupported database version. Keep the file and use a compatible release.')
            application_id = self.connection.execute('PRAGMA application_id').fetchone()[0]
            tables = self.connection.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
            if (version == 1 and application_id != 1397642289) or (version == 0 and tables):
                raise ValueError('This directory contains a different database. Choose a new state directory.')
            self.connection.execute('PRAGMA journal_mode=WAL')
            self.connection.execute('PRAGMA synchronous=FULL')
            self.connection.executescript('''
                CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS observations (timestamp TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL,
                    value TEXT NOT NULL, acknowledged_at TEXT, note TEXT NOT NULL DEFAULT '');
                CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL,
                    value TEXT NOT NULL, total_attempts INTEGER NOT NULL);
                PRAGMA user_version=1;
                PRAGMA application_id=1397642289;
            ''')
        except Exception:
            if hasattr(self, 'connection'):
                self.connection.close()
            self.owner.close()
            raise

    @contextmanager
    def transaction(self):
        with self.lock:
            outer = self.depth == 0
            if outer:
                self.connection.execute('BEGIN IMMEDIATE')
            self.depth += 1
            try:
                yield self
                if outer:
                    self.connection.commit()
            except Exception:
                if outer:
                    self.connection.rollback()
                raise
            finally:
                self.depth -= 1

    def read(self, key):
        with self.lock:
            row = self.connection.execute('SELECT value FROM documents WHERE key=?', (key,)).fetchone()
            return json.loads(row['value']) if row else {}

    def write(self, key, data):
        with self.transaction():
            self.connection.execute('INSERT INTO documents VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                                    (key, json.dumps(data)))
            if key == 'alert_state.json':
                for row in data['deliveries']:
                    event = row['event']
                    previous = self.connection.execute('SELECT value,total_attempts FROM deliveries WHERE id=?', (event['id'],)).fetchone()
                    total = row['attempts'] if previous is None else previous['total_attempts'] + max(0, row['attempts'] - json.loads(previous['value'])['attempts'])
                    self.connection.execute('INSERT INTO deliveries VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,total_attempts=excluded.total_attempts',
                                            (event['id'], event['observed_at'], json.dumps(row), total))

    def save_observation(self, snapshot, retention_days):
        with self.transaction():
            self.connection.execute('INSERT OR REPLACE INTO observations VALUES (?,?)', (snapshot['last_updated'], json.dumps(snapshot)))
            self.save_incidents(snapshot['incidents'])
            cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
            self.connection.execute('DELETE FROM observations WHERE timestamp<?', (cutoff,))
            self.connection.execute('DELETE FROM observations WHERE timestamp NOT IN (SELECT timestamp FROM observations ORDER BY timestamp DESC LIMIT 20000)')

    def save_incidents(self, incidents):
        with self.transaction():
            for incident in incidents:
                from alerts import identity
                self.connection.execute('INSERT INTO incidents(id,observed_at,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                                        (identity(incident['endpoint_id'], incident['opened_at']), incident['opened_at'], json.dumps(incident)))

    def history(self, hours=24, service=None, limit=500):
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
        with self.lock:
            rows = self.connection.execute('SELECT value FROM observations WHERE timestamp>=? ORDER BY timestamp DESC LIMIT ?', (cutoff, limit)).fetchall()
        snapshots = [json.loads(row['value']) for row in reversed(rows)]
        if service:
            for snapshot in snapshots:
                snapshot['endpoints'] = [row for row in snapshot['endpoints'] if row['id'] == service]
        return snapshots

    def incidents(self, limit=200):
        with self.lock:
            rows = self.connection.execute("SELECT * FROM incidents ORDER BY (json_extract(value,'$.resolved_at') IS NULL) DESC,observed_at DESC LIMIT ?", (limit,)).fetchall()
        return [dict(json.loads(row['value']), id=row['id'], acknowledged_at=row['acknowledged_at'], note=row['note']) for row in rows]

    def annotate(self, incident_id, acknowledge, note):
        with self.transaction():
            existing = self.connection.execute('SELECT acknowledged_at FROM incidents WHERE id=?', (incident_id,)).fetchone()
            if existing is None:
                raise ValueError('Incident no longer exists.')
            acknowledged_at = existing['acknowledged_at'] or datetime.now(timezone.utc).isoformat() if acknowledge else None
            self.connection.execute('UPDATE incidents SET acknowledged_at=?,note=? WHERE id=?', (acknowledged_at, note, incident_id))

    def deliveries(self, limit=200):
        with self.lock:
            rows = self.connection.execute('SELECT * FROM deliveries ORDER BY observed_at DESC LIMIT ?', (limit,)).fetchall()
            visible = {row['id'] for row in rows}
            rows += [row for row in self.connection.execute("SELECT * FROM deliveries WHERE json_extract(value,'$.status')='pending' ORDER BY observed_at DESC").fetchall() if row['id'] not in visible]
        return [dict(json.loads(row['value']), total_attempts=row['total_attempts']) for row in rows]

    def backup(self, destination):
        with self.lock, closing(sqlite3.connect(destination)) as target:
            self.connection.backup(target)

    def close(self):
        with self.lock:
            self.connection.close()
            self.owner.close()
