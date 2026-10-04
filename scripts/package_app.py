"""Create a deterministic, dependency-free Python application archive."""
import argparse
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]


def package(output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    sources = {f'sentinelnode/{path.relative_to(ROOT / "sentinelnode").as_posix()}': path.read_bytes()
               for path in (ROOT / 'sentinelnode').rglob('*') if path.is_file() and '__pycache__' not in path.parts}
    for name in ('monitor.py', 'alerts.py'):
        sources[name] = (ROOT / 'backend' / name).read_bytes()
    sources['__main__.py'] = b'from sentinelnode.app import main\nmain()\n'
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for name, content in sorted(sources.items()):
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, content)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'work' / 'sentinel.pyz')
    print(package(parser.parse_args().output).resolve())
