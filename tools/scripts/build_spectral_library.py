#!/usr/bin/env python3
"""Builds tools/data/spectral-library.fits from the Pickles (1998, PASP 110, 863) UVKLIB stellar library.

Source: the 131 pickles_uk_<n>.fits files distributed by STScI
(https://archive.stsci.edu/hlsps/reference-atlases/cdbs/grid/pickles/dat_uvk/). The optical/near-IR part
(3400-10500 A) is resampled to a common 5 A grid (the library's own sampling) and stored in one table
with the MK type, luminosity class, metallicity flag and an effective temperature for each spectrum.

Usage: build_spectral_library.py <directory with pickles_uk_N.fits> <output.fits>
"""

import re
import sys
from pathlib import Path

import numpy as np
from astropy.io import fits

GRID = np.arange(3400.0, 10500.0 + 1, 5.0)
SEQUENCE = "OBAFGKM"

# Effective temperature by MK type: dwarfs from Pecaut & Mamajek (2013, ApJS 208, 9, updated table);
# giants/supergiants of types G and later from the giant calibrations of van Belle et al. (1999) and
# Alonso et al. (1999); earlier giants are close to the dwarf scale.
DWARF = {
    "O5": 41400, "O6": 39000, "O7": 35100, "O8": 34000, "O9": 31900, "B0": 31400, "B1": 26000, "B2": 20600,
    "B3": 17000, "B4": 16400, "B5": 15700, "B6": 14500, "B7": 14000, "B8": 12300, "B9": 10700, "A0": 9700,
    "A1": 9300, "A2": 8800, "A3": 8600, "A4": 8250, "A5": 8100, "A6": 7910, "A7": 7650, "A8": 7500, "A9": 7440,
    "F0": 7220, "F1": 7020, "F2": 6810, "F3": 6720, "F4": 6640, "F5": 6510, "F6": 6340, "F7": 6240, "F8": 6170,
    "F9": 6060, "G0": 5920, "G1": 5880, "G2": 5770, "G3": 5720, "G4": 5680, "G5": 5660, "G6": 5600, "G7": 5550,
    "G8": 5490, "G9": 5340, "K0": 5280, "K1": 5170, "K2": 5040, "K3": 4830, "K4": 4600, "K5": 4410, "K6": 4220,
    "K7": 4070, "K8": 3940, "K9": 3870, "M0": 3850, "M1": 3660, "M2": 3560, "M3": 3430, "M4": 3210, "M5": 3060,
    "M6": 2810, "M7": 2680, "M8": 2570, "M9": 2380,
}
GIANT = {
    "G0": 5600, "G2": 5300, "G5": 5010, "G8": 4870, "K0": 4750, "K1": 4600, "K2": 4450, "K3": 4250, "K4": 4050,
    "K5": 3950, "M0": 3850, "M1": 3750, "M2": 3650, "M3": 3550, "M4": 3450, "M5": 3350, "M6": 3250, "M7": 3150,
    "M8": 3000, "M9": 2900, "M10": 2800,
}


def type_index(mk: str) -> float:
    """O5 -> 5, B0 -> 10 ... M9 -> 69: a continuous temperature-ordered axis."""
    return SEQUENCE.index(mk[0]) * 10 + float(mk[1:] or 0)


def interpolate(table: dict, mk: str) -> float:
    keys = sorted(table, key=type_index)
    xs = [type_index(key) for key in keys]
    return float(np.interp(type_index(mk), xs, [table[key] for key in keys]))


def parse(label: str) -> tuple[str, str, str]:
    """'K2III' -> ('K2', 'III', ''), 'G5Vw' -> ('G5', 'V', 'w'), 'M10III' -> ('M10', 'III', '')."""
    match = re.match(r"^([OBAFGKM])(\d+(?:\.\d+)?)(I{1,3}|IV|V)?([wr])?$", label.strip())
    if not match:
        raise ValueError(f"Unrecognised Pickles type {label!r}")
    letter, number = match.group(1), match.group(2)
    # Two digits are a range ("A47" = A4-7, "B12" = B1-2), except M10.
    if len(number) == 2 and "." not in number and not (letter == "M" and number == "10"):
        number = f"{(int(number[0]) + int(number[1])) / 2:g}"
    return f"{letter}{number}", match.group(3) or "V", match.group(4) or ""


def main(source: str, destination: str) -> int:
    rows = []
    fluxes = []
    for path in sorted(Path(source).glob("pickles_uk_*.fits"), key=lambda p: int(re.findall(r"\d+", p.stem)[0])):
        with fits.open(path) as hdus:
            label = str(hdus[0].header.get("COMMENT1", "")).split(":", 1)[1].strip()
            wave = np.asarray(hdus[1].data["WAVELENGTH"], dtype=float)
            flux = np.asarray(hdus[1].data["FLUX"], dtype=float)
            metal_note = str(hdus[0].header.get("COMMENT2", "")).lower()
        mk, luminosity, metallicity = parse(label)
        metallicity = metallicity or ("w" if "weak" in metal_note or "poor" in metal_note else "r" if "rich" in metal_note else "")
        giant = luminosity in ("I", "II", "III") and type_index(mk) >= type_index("G0")
        teff = interpolate(GIANT, mk) if giant else interpolate(DWARF, mk if type_index(mk) <= type_index("M9") else "M9")
        resampled = np.interp(GRID, wave, flux)
        fluxes.append((resampled / np.median(resampled[(GRID > 5400) & (GRID < 5600)])).astype(np.float32))
        rows.append((label, mk, luminosity, metallicity, type_index(mk), int(round(teff, -1))))
    columns = [
        fits.Column(name="LABEL", format="8A", array=[r[0] for r in rows]),
        fits.Column(name="MKTYPE", format="4A", array=[r[1] for r in rows]),
        fits.Column(name="LUMCLASS", format="3A", array=[r[2] for r in rows]),
        fits.Column(name="METAL", format="1A", array=[r[3] for r in rows]),
        fits.Column(name="TYPEINDEX", format="E", array=[r[4] for r in rows]),
        fits.Column(name="TEFF", format="J", unit="K", array=[r[5] for r in rows]),
        fits.Column(name="FLUX", format=f"{len(GRID)}E", array=np.array(fluxes)),
    ]
    table = fits.BinTableHDU.from_columns(columns, name="LIBRARY")
    table.header["WAVE0"] = (float(GRID[0]), "first wavelength (Angstrom, air)")
    table.header["DWAVE"] = (5.0, "wavelength step (Angstrom)")
    table.header["NWAVE"] = len(GRID)
    table.header["RESOL"] = (10.0, "approximate FWHM resolution (Angstrom)")
    primary = fits.PrimaryHDU()
    primary.header["ORIGIN"] = "AstroviaBin build_spectral_library.py"
    primary.header["REFERENC"] = "Pickles A. J. 1998, PASP 110, 863 (UVKLIB)"
    primary.header["SOURCE"] = "STScI reference atlases (CDBS grid/pickles/dat_uvk)"
    primary.header["TEFFREF"] = "Pecaut & Mamajek 2013; giants: van Belle+1999, Alonso+1999"
    fits.HDUList([primary, table]).writeto(destination, overwrite=True)
    print(f"{len(rows)} spectra, {len(GRID)} wavelengths -> {destination}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
