#!/usr/bin/env python3
"""Install pPXF and capfit directly from their publisher's PyPI files.

The pPXF licence permits non-commercial use but prohibits redistributing its
code. This installer is shipped without pPXF; it fetches the publisher's wheel
on the end user's machine and verifies the exact release hash before unpacking.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path


PACKAGES = (
    ("ppxf", "9.5.2",
     "https://files.pythonhosted.org/packages/59/88/63bd1b01cda64a8861faad33f6514af25571cd38d0452297be0a01923593/ppxf-9.5.2-py3-none-any.whl",
     "7876fbc4e96359e1be321f475abe593ac3af983fc345d971162132e4ced14cd5"),
    ("capfit", "2.7.1",
     "https://files.pythonhosted.org/packages/d3/9f/70da0c10c85aade72b19adebd4047bb14242dc09f8e7cc8a61c2a2f1de4f/capfit-2.7.1-py3-none-any.whl",
     "9e7ef8745e65640ce1d46e434b04c38f6708f56af66ab90b820a7549b9934630"),
)


def install(destination: Path) -> None:
    destination = destination.resolve()
    if all((destination / f"{name}-{version}.dist-info" / "METADATA").is_file()
           and (destination / name / "LICENSE.txt").is_file() for name, version, _, _ in PACKAGES):
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="astroviabin-ppxf-") as temporary:
        temporary_path = Path(temporary)
        unpacked = temporary_path / "unpacked"
        unpacked.mkdir()
        for name, version, url, expected_hash in PACKAGES:
            wheel = temporary_path / f"{name}.whl"
            digest = hashlib.sha256()
            request = urllib.request.Request(url, headers={"User-Agent": "AstroviaBin-science-installer/1"})
            with urllib.request.urlopen(request, timeout=90) as response, wheel.open("wb") as output:
                while block := response.read(1024 * 1024):
                    digest.update(block)
                    output.write(block)
            if digest.hexdigest() != expected_hash:
                raise RuntimeError(f"{name} download checksum mismatch; the package was not installed")
            with zipfile.ZipFile(wheel) as archive:
                for item in archive.infolist():
                    relative = Path(item.filename)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError(f"Unsafe path in {name} wheel")
                    if relative.parts[0] not in (name, f"{name}-{version}.dist-info"):
                        raise RuntimeError(f"Unexpected content in {name} wheel")
                archive.extractall(unpacked)
            if not (unpacked / name / "LICENSE.txt").is_file() or not (unpacked / f"{name}-{version}.dist-info" / "METADATA").is_file():
                raise RuntimeError(f"Incomplete {name} wheel")

        # Atomic replacement on the same volume. Only this dedicated runtime
        # directory is replaced; no user database or image folders are touched.
        staging = destination.parent / f".{destination.name}-{os.getpid()}"
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(unpacked, staging)
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: install_ppxf.py <private-runtime-directory>")
    install(Path(sys.argv[1]))
    print("pPXF and capfit installed from PyPI and SHA-256 verified")
