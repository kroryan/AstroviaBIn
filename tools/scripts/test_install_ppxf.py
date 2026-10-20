"""The private pPXF downloader must verify integrity and remain inside its target."""

import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import install_ppxf  # noqa: E402


class PpxfInstaller(unittest.TestCase):
    def test_installs_verified_wheel_once_and_rejects_changed_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            packages = []
            for name, version in (("ppxf", "9.5.2"), ("capfit", "2.7.1")):
                wheel = directory / f"{name}.whl"
                with zipfile.ZipFile(wheel, "w") as archive:
                    archive.writestr(f"{name}/{name}.py", "VERSION = 'test'\n")
                    archive.writestr(f"{name}/LICENSE.txt", "publisher licence\n")
                    archive.writestr(f"{name}-{version}.dist-info/METADATA", f"Version: {version}\n")
                packages.append((name, version, wheel.as_uri(), hashlib.sha256(wheel.read_bytes()).hexdigest()))
            target = directory / "installed"
            with mock.patch.object(install_ppxf, "PACKAGES", tuple(packages)):
                install_ppxf.install(target)
                for name, *_ in packages:
                    (directory / f"{name}.whl").unlink()
                install_ppxf.install(target)
            self.assertTrue((target / "ppxf" / "LICENSE.txt").is_file())
            self.assertTrue((target / "capfit" / "LICENSE.txt").is_file())

            target = directory / "tampered"
            changed = (("ppxf", "9.5.2", (directory / "installed" / "ppxf" / "ppxf.py").as_uri(), packages[0][3]),)
            with mock.patch.object(install_ppxf, "PACKAGES", changed):
                with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                    install_ppxf.install(target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
