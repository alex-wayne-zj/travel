"""Exercise frontend-only deployment and failure recovery inside the project."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('deploy', ROOT / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class FrontendDeployment(unittest.TestCase):
    def exercise(self, fail, previous_frontend=False):
        with tempfile.TemporaryDirectory(dir=ROOT / '.artifacts') as temporary:
            root = Path(temporary)
            static, backend = root / 'static', root / 'backend'
            source = root / 'dist'
            (source / 'assets').mkdir(parents=True)
            (source / 'index.html').write_text('test frontend')
            binary = root / 'binary'
            binary.write_bytes(b'tested backend')
            binary.chmod(0o755)
            for base in (static, backend):
                (base / 'releases').mkdir(parents=True)
            with patch.multiple(deploy, STATIC=static, BACKEND=backend, BINARY=binary, ROOT=root):
                if previous_frontend:
                    (source / 'index.html').write_text('older frontend')
                    binary.write_bytes(b'older backend')
                    prior = deploy.stage_release('20261008T000000Z-bbbbbbbbbbbb')
                    for base, release in zip((static, backend), prior):
                        deploy.activate(base / 'previous', release)
                    (source / 'index.html').write_text('test frontend')
                    binary.write_bytes(b'tested backend')
                old = deploy.stage_release('20261009T000000Z-aaaaaaaaaaaa')
                for base, release in zip((static, backend), old):
                    deploy.activate(base / 'current', release)
                with patch('sys.argv', ['deploy.py', '--frontend-only', '--skip-build'] + (['--previous-frontend'] if previous_frontend else [])), \
                     patch.object(deploy, 'configuration', return_value=({}, 'http://test/health')), \
                     patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                     patch.object(deploy, 'schema_version', side_effect=AssertionError('Database accessed')), \
                     patch.object(deploy, 'consistent_backup', side_effect=AssertionError('Database backup')), \
                     patch.object(deploy, 'prune_backups', side_effect=AssertionError('Backup mutated')), \
                     patch.object(deploy, 'command', side_effect=AssertionError('Backend restarted')), \
                     patch.object(deploy, 'api_health'), \
                     patch.object(deploy, 'public_health', side_effect=RuntimeError('HTTPS failure') if fail else None), \
                     patch.object(deploy.time, 'sleep'):
                    if fail:
                        with self.assertRaisesRegex(RuntimeError, 'HTTPS failure'):
                            deploy.main()
                    else:
                        deploy.main()
                for base, release in zip((static, backend), old):
                    if fail:
                        self.assertEqual(deploy.target(base / 'current'), release)
                        if previous_frontend:
                            self.assertEqual(deploy.target(base / 'previous'), prior[0] if base == static else prior[1])
                        else:
                            self.assertIsNone(deploy.target(base / 'previous'))
                        self.assertEqual(len(list((base / 'releases').iterdir())), 2 if previous_frontend else 1)
                    else:
                        self.assertEqual(deploy.target(base / 'previous'), release)
                        self.assertNotEqual(deploy.target(base / 'current'), release)
                current = deploy.target(backend / 'current')
                self.assertEqual((current / 'travel-backend').read_bytes(), binary.read_bytes())
                deploy.compatible_pair(deploy.target(static / 'current'), current)
                if previous_frontend and not fail:
                    self.assertEqual((deploy.target(static / 'current') / 'index.html').read_text(), 'older frontend')
    def test_previous_frontend_preserves_current_backend(self): self.exercise(False, True)
    def test_previous_frontend_failure_restores_links(self): self.exercise(True, True)
    def test_success(self): self.exercise(False)
    def test_https_failure_restores_links(self): self.exercise(True)

if __name__ == '__main__': unittest.main()
