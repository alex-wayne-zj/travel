#!/usr/bin/python3
"""Install a checksum-pinned official PMTiles CLI; no compiler or daemon required."""
import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import tarfile
import tempfile

VERSION = '1.31.2'
ASSETS = {
    'x86_64': ('go-pmtiles_1.31.2_Linux_x86_64.tar.gz', '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f'),
    'aarch64': ('go-pmtiles_1.31.2_Linux_arm64.tar.gz', 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1'),
}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('/usr/local/bin/travel-pmtiles'))
    args = parser.parse_args()
    if platform.system() != 'Linux' or platform.machine() not in ASSETS:
        raise RuntimeError('Only Linux x86_64 and aarch64 have pinned official assets')
    name, expected = ASSETS[platform.machine()]
    url = f'https://github.com/protomaps/go-pmtiles/releases/download/v{VERSION}/{name}'
    with tempfile.TemporaryDirectory(prefix='travel-map-tool-') as directory:
        archive = Path(directory) / name
        subprocess.run(['curl', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
                        '--max-time', '90', '--max-filesize', '33554432', '--silent', '--show-error',
                        '--output', str(archive), url], check=True, timeout=95)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Official PMTiles asset checksum mismatch; nothing installed')
        with tarfile.open(archive) as tar:
            binaries = [member for member in tar.getmembers()
                        if member.isfile() and Path(member.name).name == 'pmtiles']
            if len(binaries) != 1 or binaries[0].size > 64 * 1024 * 1024:
                raise RuntimeError('Unexpected official archive layout')
            data = tar.extractfile(binaries[0]).read()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix='.travel-pmtiles-', dir=args.output.parent)
        try:
            with os.fdopen(fd, 'wb') as out:
                out.write(data)
                out.flush()
                os.fsync(out.fileno())
            os.chmod(temporary, 0o755)
            result = subprocess.run([temporary, 'version'], check=True, capture_output=True, text=True, timeout=5)
            if VERSION not in result.stdout + result.stderr:
                raise RuntimeError('PMTiles binary version mismatch')
            os.replace(temporary, args.output)
        finally:
            Path(temporary).unlink(missing_ok=True)
    print(f'Installed official PMTiles v{VERSION}: {args.output}; SHA256 {expected}; source {url}')

if __name__ == '__main__':
    main()
