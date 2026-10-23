#!/usr/bin/env python3
"""Check that this Python can run AstroviaBin's analyses, and say exactly why when it cannot.

Imports every analysis package one by one and reports its version and import time, or the full
error. On Windows, a "DLL load failed" error is followed by the DLLs the failing extension module
needs that are not found next to it, in the Python folder, in the wheels' ``*.libs`` folders or in
the system folder (e.g. VCOMP140.DLL, the Visual C++ OpenMP runtime).

Used by the desktop setup window, at every server start (written to the server log), by the
Windows installer and by the .deb post-install script.

Usage: check_analysis_env.py [--json] [--log FILE] [--ppxf DIR]
Exit status: 0 when every package imports, 1 otherwise.
"""

from __future__ import annotations

import argparse
import datetime
import importlib
import importlib.util
import json
import os
import platform
import struct
import sys
import time
import traceback
from pathlib import Path

PACKAGES = ("numpy", "scipy", "astropy", "matplotlib", "ccdproc", "photutils", "astroscrappy",
            "specutils", "specreduce", "astroquery", "astroalign")


def pe_imports(path: Path) -> list[str]:
    """Names of the DLLs a Windows PE file imports (its import directory)."""
    data = path.read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    sections, optional_size = struct.unpack_from("<H12xH", data, pe + 6)
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    import_rva = struct.unpack_from("<I", data, directories + 8)[0]
    table = []
    for index in range(sections):
        entry = optional + optional_size + 40 * index
        size, rva, raw_size, raw = struct.unpack_from("<IIII", data, entry + 8)
        table.append((rva, max(size, raw_size), raw))

    def offset(rva: int) -> int:
        for start, size, raw in table:
            if start <= rva < start + size:
                return raw + rva - start
        raise ValueError(f"RVA {rva:#x} is outside every section")

    names = []
    if not import_rva:
        return names
    descriptor = offset(import_rva)
    while True:
        name_rva = struct.unpack_from("<I", data, descriptor + 12)[0]
        if not name_rva:
            break
        start = offset(name_rva)
        names.append(data[start:data.index(b"\0", start)].decode("ascii", "replace"))
        descriptor += 20
    return names


def missing_dlls(package: str) -> list[str]:
    """DLLs imported by the package's extension modules that Windows would not find."""
    spec = importlib.util.find_spec(package)
    if not spec or not spec.submodule_search_locations:
        return []
    root = Path(next(iter(spec.submodule_search_locations)))
    site = root.parent
    system = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    search = [Path(sys.base_prefix), Path(sys.executable).parent, system, *site.glob("*.libs")]
    found = set()
    for folder in search:
        try:
            found.update(name.lower() for name in os.listdir(folder))
        except OSError:
            pass
    problems = []
    for module in list(root.rglob("*.pyd")) + list(root.rglob("*.dll")):
        try:
            imports = pe_imports(module)
        except (OSError, ValueError, struct.error):
            continue
        local = {name.lower() for name in os.listdir(module.parent)}
        for dll in imports:
            name = dll.lower()
            if name.startswith(("api-ms-win-", "ext-ms-")) or name in found or name in local:
                continue
            problems.append(f"{dll} (needed by {module.relative_to(site)})")
    return sorted(set(problems))


# DLLs every supported Windows (10 and 11, x64) has in System32. Anything else an extension module
# imports must ship in the bundle (e.g. the Visual C++ runtime: msvcp140.dll, vcomp140.dll).
WINDOWS_SYSTEM_DLLS = frozenset("""
advapi32 bcrypt bcryptprimitives cfgmgr32 comctl32 comdlg32 crypt32 d3d11 dbghelp dnsapi dwmapi
dxgi gdi32 imm32 iphlpapi kernel32 kernelbase mpr msvcrt mswsock ncrypt netapi32 ntdll ole32
oleaut32 opengl32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi sspicli ucrtbase
user32 userenv uxtheme version winhttp wininet winmm winspool ws2_32 wsock32 wtsapi32
""".split())


def scan_windows_bundle(root: Path) -> list[str]:
    """Imports of the bundle's DLLs and extension modules that neither the bundle nor Windows provide.

    Runs on any OS (the Linux build checks the Windows package with it before packaging).
    """
    bundled = {path.name.lower() for path in root.rglob("*") if path.suffix.lower() in (".dll", ".pyd")}
    problems = set()
    for module in root.rglob("*"):
        if module.suffix.lower() not in (".dll", ".pyd"):
            continue
        try:
            imports = pe_imports(module)
        except (OSError, ValueError, struct.error) as error:
            problems.add(f"{module.relative_to(root)}: unreadable PE file ({error})")
            continue
        for dll in imports:
            name = dll.lower()
            if (name.startswith(("api-ms-win-", "ext-ms-")) or name in bundled
                    or name.removesuffix(".dll") in WINDOWS_SYSTEM_DLLS):
                continue
            problems.add(f"{dll} (needed by {module.relative_to(root)})")
    return sorted(problems)


def check(ppxf: str | None) -> dict:
    if ppxf and os.path.isdir(ppxf):
        sys.path.append(ppxf)
    report = {
        "time": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "python": sys.version.split()[0], "executable": sys.executable,
        "platform": platform.platform(), "machine": platform.machine(),
        "flags": {"isolated": sys.flags.isolated, "dont_write_bytecode": sys.dont_write_bytecode},
        "path": sys.path, "packages": [],
    }
    for package in PACKAGES + (("ppxf", "capfit") if ppxf else ()):
        started = time.perf_counter()
        entry = {"name": package}
        try:
            module = importlib.import_module(package)
            entry.update(ok=True, version=str(getattr(module, "__version__", "?")))
        except BaseException as error:  # noqa: BLE001 - a broken package must not hide the others
            entry.update(ok=False, error=f"{type(error).__name__}: {error}",
                         traceback=traceback.format_exc())
            if os.name == "nt" and "DLL load failed" in str(error):
                entry["missing_dlls"] = missing_dlls(package)
        entry["seconds"] = round(time.perf_counter() - started, 2)
        report["packages"].append(entry)
    report["ok"] = all(entry["ok"] for entry in report["packages"])
    return report


def text(report: dict) -> str:
    lines = [f"AstroviaBin analysis environment check ({report['time']})",
             f"python {report['python']} at {report['executable']}",
             f"platform {report['platform']} ({report['machine']})"]
    for entry in report["packages"]:
        if entry["ok"]:
            lines.append(f"  ok    {entry['name']} {entry['version']} ({entry['seconds']} s)")
            continue
        lines.append(f"  FAIL  {entry['name']}: {entry['error']}")
        for dll in entry.get("missing_dlls", []):
            lines.append(f"        missing DLL: {dll}")
        lines.extend(f"        {line}" for line in entry["traceback"].rstrip().splitlines())
    failed = [entry["name"] for entry in report["packages"] if not entry["ok"]]
    lines.append("result: all analysis packages import" if not failed
                 else f"result: {len(failed)} package(s) failed: {', '.join(failed)}")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    parser.add_argument("--log", help="also append the text report to this file")
    parser.add_argument("--ppxf", help="folder with the separately installed pPXF and capfit")
    parser.add_argument("--scan-windows-bundle", metavar="DIR",
                        help="instead, check that every DLL the Windows Python in DIR needs is bundled")
    args = parser.parse_args()
    # The desktop app reads the output as UTF-8 (Windows error messages are localized).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.scan_windows_bundle:
        problems = scan_windows_bundle(Path(args.scan_windows_bundle))
        for problem in problems:
            print(f"missing DLL: {problem}")
        print("every DLL is bundled or part of Windows" if not problems else f"{len(problems)} missing DLL(s)")
        return 1 if problems else 0
    report = check(args.ppxf)
    summary = text(report)
    if args.log:
        try:
            Path(args.log).parent.mkdir(parents=True, exist_ok=True)
            with open(args.log, "a", encoding="utf-8") as handle:
                handle.write(summary + "\n")
        except OSError as error:
            print(f"could not write {args.log}: {error}", file=sys.stderr)
    sys.stdout.write(json.dumps(report) + "\n" if args.json else summary)
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
