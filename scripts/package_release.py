"""Build a reproducible public download without private workspace files."""
import argparse
import hashlib
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from package_app import package

ROOT = Path(__file__).resolve().parents[1]


def build(output, version, source_commit):
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Use a numeric version such as 1.0.0.')
    if not re.fullmatch(r'[0-9a-f]{40}', source_commit):
        raise ValueError('Use the complete source commit SHA.')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    application = package(output / 'sentinel.pyz').read_bytes()
    files = {
        'sentinel.pyz': application,
        'SHA256.txt': f'{hashlib.sha256(application).hexdigest()}  sentinel.pyz\n'.encode(),
        'StartSentinel.cmd': (ROOT / 'release' / 'StartSentinel.cmd').read_bytes(),
        'QUICKSTART.md': (ROOT / 'release' / 'QUICKSTART.md').read_bytes(),
        'VERIFICATION.md': (ROOT / 'release' / 'VERIFICATION.md').read_text(encoding='utf-8')
            .replace('@VERSION@', version).replace('@SOURCE_COMMIT@', source_commit).encode(),
    }
    archive_path = output / f'Sentinel-{version}.zip'
    with ZipFile(archive_path, 'w', ZIP_DEFLATED) as archive:
        for name, content in sorted(files.items()):
            info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, content)
    checksum = output / f'Sentinel-{version}-SHA256.txt'
    checksum.write_text(f'{hashlib.sha256(archive_path.read_bytes()).hexdigest()}  {archive_path.name}\n', encoding='utf-8', newline='\n')
    return archive_path, checksum


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'work' / 'release')
    parser.add_argument('--version', required=True)
    parser.add_argument('--source-commit', required=True)
    args = parser.parse_args()
    for path in build(args.output, args.version, args.source_commit):
        print(path.resolve())
