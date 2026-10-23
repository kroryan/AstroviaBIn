"""The analysis environment check must name the DLLs a Windows package lacks, and report every import."""

import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_analysis_env  # noqa: E402


def pe_file(imports: list[str]) -> bytes:
    """A minimal PE32+ file whose import directory lists these DLLs."""
    pe, optional_size, rva, raw = 0x40, 240, 0x1000, 0x200
    descriptors = 20 * (len(imports) + 1)
    names, offsets = b"", []
    for name in imports:
        offsets.append(rva + descriptors + len(names))
        names += name.encode() + b"\0"
    section = bytearray(0x200)
    for index, offset in enumerate(offsets):
        struct.pack_into("<I", section, 20 * index + 12, offset)
    section[descriptors:descriptors + len(names)] = names
    header = bytearray(raw)
    header[0:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, pe)
    header[pe:pe + 4] = b"PE\0\0"
    struct.pack_into("<HH12xHH", header, pe + 4, 0x8664, 1, optional_size, 0x2022)
    optional = pe + 24
    struct.pack_into("<H", header, optional, 0x20B)
    struct.pack_into("<II", header, optional + 112 + 8, rva, descriptors)
    struct.pack_into("<8sIIII", header, optional + optional_size, b".idata", len(section), rva, len(section), raw)
    return bytes(header + section)


class WindowsBundle(unittest.TestCase):
    def test_reads_the_import_table(self):
        with tempfile.TemporaryDirectory() as temporary:
            module = Path(temporary) / "median_utils.pyd"
            module.write_bytes(pe_file(["VCOMP140.DLL", "KERNEL32.dll", "python313.dll"]))
            self.assertEqual(check_analysis_env.pe_imports(module), ["VCOMP140.DLL", "KERNEL32.dll", "python313.dll"])

    def test_reports_runtime_dlls_that_are_neither_bundled_nor_part_of_windows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "python313.dll").write_bytes(pe_file(["KERNEL32.dll", "VCRUNTIME140.dll"]))
            (root / "vcruntime140.dll").write_bytes(pe_file(["KERNEL32.dll"]))
            package = root / "Lib" / "site-packages" / "astroscrappy" / "utils"
            package.mkdir(parents=True)
            (package / "median_utils.pyd").write_bytes(pe_file(
                ["VCOMP140.DLL", "MSVCP140.dll", "python313.dll", "api-ms-win-crt-heap-l1-1-0.dll", "USER32.dll"]))
            problems = check_analysis_env.scan_windows_bundle(root)
            self.assertEqual([problem.split(" ")[0] for problem in problems], ["MSVCP140.dll", "VCOMP140.DLL"])
            self.assertIn("astroscrappy", problems[0])

            (root / "vcomp140.dll").write_bytes(pe_file(["KERNEL32.dll"]))
            (root / "msvcp140.dll").write_bytes(pe_file(["KERNEL32.dll"]))
            self.assertEqual(check_analysis_env.scan_windows_bundle(root), [])


class ImportReport(unittest.TestCase):
    def test_a_broken_package_is_reported_with_its_error_and_does_not_hide_the_others(self):
        real_import = check_analysis_env.importlib.import_module

        def fake_import(name):
            if name == "astroscrappy":
                raise ImportError("DLL load failed while importing median_utils")
            return real_import("json") if name == "numpy" else type(sys)(name)

        with mock.patch.object(check_analysis_env, "PACKAGES", ("numpy", "astroscrappy", "astropy")), \
                mock.patch.object(check_analysis_env.importlib, "import_module", fake_import), \
                mock.patch.object(check_analysis_env, "missing_dlls", lambda package: ["VCOMP140.DLL (needed by x.pyd)"]), \
                mock.patch.object(check_analysis_env.os, "name", "nt"):
            report = check_analysis_env.check(None)
        self.assertFalse(report["ok"])
        self.assertEqual([entry["ok"] for entry in report["packages"]], [True, False, True])
        broken = report["packages"][1]
        self.assertEqual(broken["error"], "ImportError: DLL load failed while importing median_utils")
        self.assertEqual(broken["missing_dlls"], ["VCOMP140.DLL (needed by x.pyd)"])
        text = check_analysis_env.text(report)
        self.assertIn("FAIL  astroscrappy", text)
        self.assertIn("missing DLL: VCOMP140.DLL", text)
        self.assertIn("result: 1 package(s) failed: astroscrappy", text)


if __name__ == "__main__":
    unittest.main()
