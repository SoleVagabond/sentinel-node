"""Build a portable Lambda ZIP from source and pure-Python wheels only."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]


def package(config, output, install_dependencies=True):
    sys.path.insert(0, str(ROOT / 'backend'))
    from monitor import validate_config
    validate_config(json.loads(config.read_text(encoding='utf-8')))
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.parent / 'lambda-staging'
    if staging.exists():
        if staging.resolve().parent != output.parent or staging.is_symlink():
            raise ValueError('Staging path must stay inside the build directory.')
        shutil.rmtree(staging)
    staging.mkdir()
    shutil.copyfile(ROOT / 'backend/monitor.py', staging / 'monitor.py')
    shutil.copyfile(ROOT / 'backend/alerts.py', staging / 'alerts.py')
    shutil.copyfile(config, staging / 'endpoints.json')
    if install_dependencies:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:',
                        '--platform', 'any', '--python-version', '3.13', '--implementation', 'py', '--abi', 'none',
                        '--no-compile', '--target', str(staging), '-r', str(ROOT / 'backend/requirements-lambda.txt')], check=True)
    files = sorted(path for path in staging.rglob('*') if path.is_file() and '__pycache__' not in path.parts)
    if any(path.suffix.lower() in ('.pyd', '.so', '.dll', '.exe') for path in files):
        raise ValueError('Platform-specific files cannot enter the portable Lambda package.')
    with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
        for path in files:
            info = ZipInfo(path.relative_to(staging).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = ZIP_DEFLATED
            archive.writestr(info, path.read_bytes())
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f'Package: {output}\nFiles: {len(files)}\nSHA256: {digest}')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'work/lambda.zip')
    args = parser.parse_args()
    package(args.config, args.output)
