import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('package_extension', Path(__file__).parents[1] / 'scripts/package-extension.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PackageTests(unittest.TestCase):
    def fixture(self, root):
        dist = root / 'dist'
        dist.mkdir()
        files = ['pages/popup.html', 'pages/import.html', 'worker.js', 'icon.png', 'content.js', '_locales/en/messages.json']
        for name in files:
            path = dist / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{}' if name.endswith('.json') else 'synthetic')
        manifest = {'version': '1.1.0.1', 'action': {'default_popup': files[0]}, 'options_ui': {'page': files[1]}, 'background': {'service_worker': files[2]}, 'icons': {'16': files[3]}, 'content_scripts': [{'js': [files[4]]}], 'default_locale': 'en'}
        (dist / 'manifest.json').write_text(json.dumps(manifest))
        (root / 'LICENSE').write_text('synthetic license')
        return dist, manifest

    def test_exact_dist_license_and_deterministic_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            with patch.object(subprocess, 'check_output', return_value='a' * 40 + '\n'):
                first = module.package(root); second = module.package(root)
            self.assertEqual(first['sha256'], second['sha256'])
            self.assertEqual(first['tag'], 'v1.1.0.1-next.build.' + 'a' * 12)
            with zipfile.ZipFile(root / 'release-package' / first['artifact']) as archive:
                self.assertEqual(archive.read('LICENSE'), b'synthetic license')
                self.assertIn('manifest.json', archive.namelist())

    def test_missing_popup_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); dist, _ = self.fixture(root)
            (dist / 'pages/popup.html').unlink()
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)

    def test_symlink_not_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); dist, _ = self.fixture(root)
            (dist / 'alias').symlink_to(root / 'LICENSE')
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)

    def test_hidden_file_not_packaged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); dist, _ = self.fixture(root)
            (dist / '.env').write_text('synthetic')
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)

    def test_dist_root_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); dist, _ = self.fixture(root)
            dist.rename(root / 'real-dist'); dist.symlink_to(root / 'real-dist', target_is_directory=True)
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)

    def test_output_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            (root / 'outside').mkdir(); (root / 'release-package').symlink_to(root / 'outside', target_is_directory=True)
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)
            self.assertEqual(list((root / 'outside').iterdir()), [])

    def test_existing_archive_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); self.fixture(root)
            (root / 'release-package').mkdir()
            outside = root / 'outside'; outside.write_text('unchanged')
            (root / 'release-package' / ('Cookie-Editor-Next_' + 'a' * 12 + '_unpacked.zip')).symlink_to(outside)
            with patch.object(subprocess, 'check_output', return_value='a' * 40):
                with self.assertRaises(ValueError): module.package(root)
            self.assertEqual(outside.read_text(), 'unchanged')

    def test_missing_action_icon_and_resources_rejected(self):
        for kind in ('icon', 'resource'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory); dist, manifest = self.fixture(root)
                if kind == 'icon': manifest['action']['default_icon'] = {'16': 'missing.png'}
                else: manifest['web_accessible_resources'] = [{'resources': ['absent/*']}]
                (dist / 'manifest.json').write_text(json.dumps(manifest))
                with patch.object(subprocess, 'check_output', return_value='a' * 40):
                    with self.assertRaises(ValueError): module.package(root)

if __name__ == '__main__':
    unittest.main()
