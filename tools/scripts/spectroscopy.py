#!/usr/bin/env python3
"""AstroviaBin stellar spectroscopy: every usable star of a slitless (Star Analyser) FITS, or a 1-D spectrum.

Pipeline (one JSON config in, result.json + CSV + FITS + PDF out):

  1. ccdproc     bias / dark / flat / bad-pixel calibration and L.A.Cosmic cosmic-ray cleaning (2-D frames)
  2. photutils   background model, zero-order (star) detection and centroids; the dispersion direction and the
                 first-order trace of every star are measured from the image itself
  3. extraction  each field trace is extracted with local sky; overlaps, saturation and frame edges
                 are flagged. Slitless wavelength identification requires an independently measured
                 dispersion for the optical setup. Spectrum strips without zero order use the FITS
                 spectral WCS; otherwise only pixel/flux extraction is reported.
  4. specutils   continuum fit, equivalent widths and centroids of a line catalogue (H, He, Ca, Na, Mg,
                 Fe, CH, TiO, C2, O, telluric O2): detected lines, compatible elements (not abundances),
                 closest stellar template and a broad temperature/type range. Radial velocity is withheld
                 until higher-resolution templates and independent validation are available.
  5. outputs     result.json for the web interface, summary.csv (one row per star), star-N.csv,
                 spectra.fits, and report.pdf (field with every star marked, one page per star)
  6. catalogues  only when the user ran "known" first: which stars already have spectroscopy (SIMBAD,
                 Gaia DR3 XP/RVS, SDSS DR18), and the comparison of our results with it, in the same PDF

1-D spectra (SDSS spec/spec-lite tables, IRAF/wcs1d images, tabular FITS) skip steps 1-3.

Usage:
  spectroscopy.py analyse <config.json>    (config: {"input", "work", "settings", "wcs", "metadata"})
  spectroscopy.py known <config.json>      before analysing: which stars already have spectroscopy
  spectroscopy.py detect <file.fits>       prints {"kind": "spectrum1d" | "slitless" | "image2d" | "unknown", ...}
  spectroscopy.py to-image <in> <out>      rewrites a 1-D spectrum as a 1xN primary image for the gallery
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
import traceback
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits

# The official pPXF wheel is fetched on the user's machine during installation. It is
# deliberately absent from the source tree and binary installers (publisher's licence).
_ppxf_dir = os.environ.get("ASTROVIABIN_PPXF_DIR")
if _ppxf_dir and Path(_ppxf_dir).is_dir():
    sys.path.insert(0, _ppxf_dir)



def require_ppxf() -> None:
    """pPXF/capfit are downloaded by AstroviaBin's installer; say how to repair a failed download."""
    try:
        import ppxf.ppxf  # noqa: F401
        import capfit  # noqa: F401
    except ImportError:
        fail("pPXF is not installed. AstroviaBin downloads it from PyPI during installation (it may not be "
             "redistributed); that download failed or was skipped. Reconnect to the Internet and repair the "
             "installation: on Linux run 'sudo dpkg --configure -a' or 'sudo dpkg-reconfigure astroviabin' (or reinstall the .deb), on Windows "
             "run the AstroviaBin installer again, or restart the desktop app.")


warnings.simplefilter("ignore")
try:
    from astropy import log as _astropy_log
    _astropy_log.setLevel("ERROR")
except Exception:  # pragma: no cover
    pass

C_KMS = 299_792.458

# ------------------------------------------------------------------------------------------------
# Line catalogue (air wavelengths, Angstrom). kind: stellar absorption features, emission lines,
# molecular bands (measured as band depth), or telluric (Earth's atmosphere, never a stellar element).

@dataclass(frozen=True)
class Feature:
    key: str
    label: str
    element: str
    wave: float          # rest wavelength (air, A); for bands the band head / centre
    kind: str            # "absorption" | "emission" | "band" | "telluric"
    half_width: float    # measurement half window (A) at high resolution


FEATURES: list[Feature] = [
    Feature("H9", "H9", "H", 3835.38, "absorption", 12),
    Feature("H8", "H8", "H", 3889.05, "absorption", 12),
    Feature("CaK", "Ca II K", "Ca", 3933.66, "absorption", 10),
    Feature("CaH_He", "Ca II H + Hε", "Ca/H", 3969.0, "absorption", 12),
    Feature("HeI4026", "He I 4026", "He", 4026.19, "absorption", 5),
    Feature("Hd", "Hδ", "H", 4101.74, "absorption", 20),
    Feature("CaI4227", "Ca I 4227", "Ca", 4226.73, "absorption", 5),
    Feature("Gband", "G band (CH)", "C", 4300.0, "absorption", 15),
    Feature("Hg", "Hγ", "H", 4340.47, "absorption", 20),
    Feature("FeI4383", "Fe I 4383", "Fe", 4383.55, "absorption", 5),
    Feature("HeI4471", "He I 4471", "He", 4471.48, "absorption", 5),
    Feature("MgII4481", "Mg II 4481", "Mg", 4481.13, "absorption", 4),
    Feature("HeII4686", "He II 4686", "He", 4685.70, "absorption", 5),
    Feature("Hb", "Hβ", "H", 4861.33, "absorption", 20),
    Feature("OIII4959", "[O III] 4959", "O", 4958.91, "emission", 6),
    Feature("OIII5007", "[O III] 5007", "O", 5006.84, "emission", 6),
    Feature("Mgb", "Mg I b", "Mg", 5175.0, "absorption", 16),
    Feature("FeI5270", "Fe I 5270", "Fe", 5269.54, "absorption", 6),
    Feature("FeI5335", "Fe I 5335", "Fe", 5328.04, "absorption", 6),
    Feature("HeI5876", "He I 5876", "He", 5875.62, "absorption", 5),
    Feature("NaD", "Na I D", "Na", 5892.9, "absorption", 10),
    Feature("TiO6159", "TiO 6159", "TiO", 6159.0, "band", 0),
    Feature("NII6548", "[N II] 6548", "N", 6548.05, "emission", 5),
    Feature("Ha", "Hα", "H", 6562.80, "absorption", 20),
    Feature("NII6583", "[N II] 6583", "N", 6583.45, "emission", 5),
    Feature("HeI6678", "He I 6678", "He", 6678.15, "absorption", 5),
    Feature("SII6716", "[S II] 6716", "S", 6716.44, "emission", 5),
    Feature("SII6731", "[S II] 6731", "S", 6730.82, "emission", 5),
    Feature("O2B", "O₂ B band (telluric)", "telluric", 6880.0, "telluric", 20),
    Feature("TiO7054", "TiO 7054", "TiO", 7054.0, "band", 0),
    Feature("O2A", "O₂ A band (telluric)", "telluric", 7605.0, "telluric", 25),
    Feature("OI7774", "O I 7774", "O", 7773.4, "absorption", 6),
    Feature("CaT8498", "Ca II 8498", "Ca", 8498.02, "absorption", 6),
    Feature("CaT8542", "Ca II 8542", "Ca", 8542.09, "absorption", 7),
    Feature("CaT8662", "Ca II 8662", "Ca", 8662.14, "absorption", 7),
    Feature("C2_5165", "C₂ Swan 5165", "C", 5165.0, "band", 0),
]
FEATURE = {feature.key: feature for feature in FEATURES}
BALMER_EMISSION = {"Ha", "Hb", "Hg", "Hd"}

# Molecular band depth: band window vs a nearby pseudo-continuum window (A).
BANDS = {
    "TiO6159": ((6180, 6250), (6100, 6140)),
    "TiO7054": ((7060, 7150), (7020, 7050)),
    "C2_5165": ((5130, 5165), (5170, 5210)),
}

# Telluric (Earth's atmosphere) absorption bands, masked when fitting stellar templates (A).
TELLURIC = [(6860, 6960), (7160, 7340), (7590, 7700), (8130, 8350), (8940, 9800)]
LIBRARY_RESOLUTION = 10.0  # A FWHM of the Pickles spectra
TYPE_SYSTEMATIC = 8.0  # broad guard band: observed SDSS A0/G2 spectra differ by up to 7 subclasses

def fail(message: str) -> None:
    raise ValueError(message)


def finite(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def vacuum_to_air(wave: np.ndarray) -> np.ndarray:
    """Ciddor/Morton vacuum -> air conversion (A); SDSS wavelengths are in vacuum."""
    sigma2 = (1e4 / wave) ** 2
    factor = 1 + 0.0000834254 + 0.02406147 / (130 - sigma2) + 0.00015998 / (38.9 - sigma2)
    return np.where(wave > 2000, wave / factor, wave)


# ------------------------------------------------------------------------------------------------
# 1-D spectra

@dataclass
class Spectrum1D:
    wave: np.ndarray        # air, A
    flux: np.ndarray
    error: np.ndarray       # 1-sigma; inf where unknown
    flux_calibrated: bool
    resolution: float       # FWHM in A
    label: str
    meta: dict[str, Any]


def _column(table: Any, *names: str) -> np.ndarray | None:
    columns = {name.lower(): name for name in table.columns.names}
    for name in names:
        if name in columns:
            return np.asarray(table[columns[name]], dtype=float)
    return None


def read_spectrum1d(path: str) -> Spectrum1D | None:
    """A 1-D spectrum from SDSS tables, generic tabular FITS, an AstroviaBin SPECTRUM extension or a 1-D image."""
    with fits.open(path, memmap=False) as hdus:
        primary = hdus[0].header
        meta: dict[str, Any] = {}
        for key in ("OBJECT", "RA", "DEC", "PLUG_RA", "PLUG_DEC", "DATE-OBS", "TELESCOP", "INSTRUME", "MJD"):
            if key in primary:
                meta[key] = primary[key]
        vacuum = bool(primary.get("VACUUM", False))
        for hdu in hdus[1:]:
            if not isinstance(hdu, fits.BinTableHDU):
                continue
            table = hdu.data
            if table is None or len(table) == 0:
                continue
            loglam = _column(table, "loglam")
            wave = 10 ** loglam if loglam is not None else _column(table, "wave", "wavelength", "lambda", "wavelength_a", "wave_a")
            flux = _column(table, "flux", "flux_density", "spec", "intensity")
            if wave is None or flux is None or wave.ndim != 1 or len(wave) < 20:
                continue
            ivar = _column(table, "ivar")
            error = _column(table, "error", "err", "flux_err", "sigma")
            if error is None and ivar is not None:
                error = np.where(ivar > 0, 1 / np.sqrt(np.where(ivar > 0, ivar, 1)), np.inf)
            if error is None:
                error = np.full_like(flux, np.inf)
            unit = str(hdu.header.get("TUNIT2", "") or primary.get("BUNIT", "")).lower()
            if hdu.header.get("WAVEUNIT", "").lower() == "nm" or (np.nanmedian(wave) < 1500 and np.nanmax(wave) < 2500):
                wave = wave * 10
            if loglam is not None:
                vacuum = True  # SDSS log-lambda grids are vacuum wavelengths
            wdisp = _column(table, "wdisp")
            resolution = estimate_resolution(wave, wdisp)
            # SDSS meta (class, subclass, z) from the SPALL/SPECOBJ table.
            for other in hdus[1:]:
                if isinstance(other, fits.BinTableHDU) and other.name in ("SPALL", "SPECOBJ") and other.data is not None:
                    for key in ("CLASS", "SUBCLASS", "Z", "Z_ERR", "PLUG_RA", "PLUG_DEC", "SN_MEDIAN_ALL"):
                        if key in other.columns.names:
                            value = other.data[key][0]
                            meta[f"SDSS_{key}"] = value.strip() if isinstance(value, str) else (float(value) if np.ndim(value) == 0 else None)
            calibrated = "erg" in unit or "1e-17" in unit or "jy" in unit or loglam is not None
            if hdu.name == "SPECTRUM":  # written by to-image: keep its own flags
                vacuum = bool(hdu.header.get("VACUUM", False))
                calibrated = bool(hdu.header.get("FLUXCAL", False))
            return finish_spectrum(wave, flux, error, vacuum, calibrated, resolution, meta, Path(path).name)
        # 1-D image (or N x 1) with a spectral WCS.
        data = hdus[0].data
        header = primary
        if data is None or not (data.ndim == 1 or (data.ndim == 2 and data.shape[0] == 1)):
            return None
        flux = np.asarray(data, dtype=float).ravel()
        crval, crpix = finite(header.get("CRVAL1")), finite(header.get("CRPIX1"), 1.0)
        delta = finite(header.get("CDELT1")) or finite(header.get("CD1_1"))
        if crval is None or not delta:
            return None
        pixels = np.arange(len(flux)) + 1 - crpix
        ctype = str(header.get("CTYPE1", "")).upper()
        if "LOG" in ctype or header.get("DC-FLAG") == 1:
            wave = 10 ** (crval + pixels * delta) if crval < 10 else np.exp(crval + pixels * delta)
        else:
            wave = crval + pixels * delta
        if str(header.get("CUNIT1", "")).lower() in ("nm", "nanometer"):
            wave = wave * 10
        if np.nanmedian(wave) < 1500:
            return None
        return finish_spectrum(wave, flux, np.full_like(flux, np.inf), bool(header.get("VACUUM", False)),
                               "erg" in str(header.get("BUNIT", "")).lower(), estimate_resolution(wave, None), meta, Path(path).name)


def estimate_resolution(wave: np.ndarray, wdisp: np.ndarray | None) -> float:
    step = float(np.nanmedian(np.abs(np.diff(wave))))
    if wdisp is not None and np.isfinite(np.nanmedian(wdisp)) and np.nanmedian(wdisp) > 0:
        # SDSS: wdisp is the Gaussian sigma in units of the log-lambda pixel.
        return float(2.355 * np.nanmedian(wdisp) * step)
    return 2.5 * step


def finish_spectrum(wave, flux, error, vacuum, calibrated, resolution, meta, label) -> Spectrum1D:
    order = np.argsort(wave)
    wave, flux, error = wave[order], flux[order], error[order]
    good = np.isfinite(wave) & np.isfinite(flux)
    wave, flux, error = wave[good], flux[good], error[good]
    if vacuum:
        wave = vacuum_to_air(wave)
    error = np.where(np.isfinite(error) & (error > 0), error, np.inf)
    return Spectrum1D(wave, flux, error, calibrated, resolution, label, meta)


# ------------------------------------------------------------------------------------------------
# Analysis of one spectrum (specutils)

def continuum_normalise(spectrum: Spectrum1D) -> np.ndarray:
    """Fit the continuum with Specutils, excluding catalogued features."""
    import astropy.units as u
    from specutils import Spectrum, SpectralRegion
    from specutils.fitting import fit_generic_continuum

    wave, flux = spectrum.wave, spectrum.flux
    exclude = []
    for feature in FEATURES:
        if feature.kind == "band":
            low, high = BANDS[feature.key][0]
        else:
            half = max(feature.half_width * 2, 2.5 * spectrum.resolution)
            low, high = feature.wave - half, feature.wave + half
        if low > wave[0] and high < wave[-1]:
            exclude.append((low, high))
    exclude.sort()
    merged: list[list[float]] = []
    for low, high in exclude:
        if merged and low <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], high)
        else:
            merged.append([low, high])
    smooth = max(3, int(round(spectrum.resolution / max(np.median(np.diff(wave)), 1e-6))) | 1)
    try:
        spec = Spectrum(flux=np.nan_to_num(flux) * u.Unit("adu"), spectral_axis=wave * u.AA)
        regions = SpectralRegion([(low * u.AA, high * u.AA) for low, high in merged]) if merged else None
        model = fit_generic_continuum(spec, median_window=smooth, exclude_regions=regions)
        continuum = np.asarray(model(wave * u.AA).value, dtype=float)
    except Exception:
        continuum = np.full_like(flux, np.nan)
    if not np.all(np.isfinite(continuum)) or np.nanmedian(continuum) <= 0:
        continuum = np.nanmedian(flux) * np.ones_like(flux)
    return np.where(continuum > 0, continuum, np.nan)


def occupied_mask(wave: np.ndarray, resolution: float, skip: str) -> np.ndarray:
    """Pixels inside the measurement window of any other strong absorption feature or band."""
    mask = np.zeros_like(wave, dtype=bool)
    for other in FEATURES:
        if other.key == skip or other.kind == "emission":
            continue
        if other.kind == "band":
            band_low, band_high = BANDS[other.key][0]
        else:
            half = max(other.half_width, 1.5 * resolution)
            band_low, band_high = other.wave - half, other.wave + half
        mask |= (wave >= band_low) & (wave <= band_high)
    return mask


def measure_feature(feature: Feature, wave, norm, norm_err, resolution) -> dict[str, Any] | None:
    """Equivalent width (specutils) and centroid of one catalogue feature, with its 1-sigma error."""
    import astropy.units as u
    from specutils import Spectrum, SpectralRegion
    from specutils.analysis import centroid, equivalent_width

    if feature.kind == "band":
        band, reference = BANDS[feature.key]
        # At low resolution the windows widen by the resolution so each holds several resolution elements.
        pad = max(0.0, resolution - 15.0)
        band = (band[0], band[1] + pad)
        reference = (reference[0] - pad, reference[1]) if reference[1] <= band[0] else (reference[0], reference[1] + pad)
        if band[0] < wave[0] or reference[1] > wave[-1] or reference[0] < wave[0] or band[1] > wave[-1]:
            return None
        in_band = (wave >= band[0]) & (wave <= band[1])
        in_ref = (wave >= reference[0]) & (wave <= reference[1])
        if in_band.sum() < 2 or in_ref.sum() < 2:
            return None
        band_level, ref_level = np.nanmedian(norm[in_band]), np.nanmedian(norm[in_ref])
        if not (np.isfinite(band_level) and np.isfinite(ref_level) and ref_level > 0):
            return None
        depth = 1 - band_level / ref_level
        noise = np.nanmedian(norm_err[in_band]) / max(math.sqrt(in_band.sum()), 1)
        error = float(noise / ref_level) if np.isfinite(noise) else 0.05
        return {"value": float(depth), "error": max(error, 0.01), "observed": None, "unit": "depth"}

    half = max(feature.half_width, 1.5 * resolution)
    low, high = feature.wave - half, feature.wave + half
    if low < wave[0] or high > wave[-1]:
        return None
    inside = (wave >= low) & (wave <= high)
    if inside.sum() < 3:
        return None
    # Local pseudo-continuum from side bands (Lick-index style): a straight line through the median
    # levels just outside the window, so the global continuum fit cannot create false lines.
    free = ~occupied_mask(wave, resolution, feature.key)
    for reach in (2.0, 3.0, 4.0):
        blue = (wave >= low - reach * half) & (wave < low - 0.2 * half) & free
        red = (wave > high + 0.2 * half) & (wave <= high + reach * half) & free
        if blue.sum() >= 2 and red.sum() >= 2:
            break
    if feature.kind == "emission" and (blue.sum() < 2 or red.sum() < 2):
        return None
    if blue.sum() >= 2 and red.sum() >= 2:
        blue_level, red_level = np.nanmedian(norm[blue]), np.nanmedian(norm[red])
        if np.isfinite(blue_level) and np.isfinite(red_level) and blue_level > 0 and red_level > 0:
            blue_wave, red_wave = np.nanmedian(wave[blue]), np.nanmedian(wave[red])
            pseudo = blue_level + (red_level - blue_level) * (wave - blue_wave) / max(red_wave - blue_wave, 1e-6)
            norm = norm / pseudo
            norm_err = norm_err / pseudo
    try:
        spec = Spectrum(flux=np.nan_to_num(norm, nan=1.0) * u.dimensionless_unscaled, spectral_axis=wave * u.AA)
        ew = float(equivalent_width(spec, continuum=1, regions=SpectralRegion(low * u.AA, high * u.AA)).to_value(u.AA))
    except Exception:
        return None
    step = np.gradient(wave)[inside]
    error_terms = np.where(np.isfinite(norm_err[inside]), norm_err[inside], np.nan)
    noise = float(np.sqrt(np.nansum((error_terms * step) ** 2))) if np.isfinite(error_terms).any() else float("nan")
    if not np.isfinite(noise) or noise <= 0:
        # Unknown errors: the scatter of the normalised spectrum around 1 outside the lines.
        noise = float(np.nanstd(norm[~inside][: 200]) * np.sqrt(inside.sum()) * np.median(step)) if (~inside).sum() > 20 else 0.5
    depth = np.clip((1 - norm[inside]) * (1 if ew >= 0 else -1), 0, None)
    observed = None
    if np.any(depth > 0):
        try:
            line = Spectrum(flux=depth * u.dimensionless_unscaled, spectral_axis=wave[inside] * u.AA)
            observed = float(centroid(line).to_value(u.AA))
        except Exception:
            pass
    return {"value": ew, "error": max(noise, 1e-3), "observed": observed, "unit": "A"}


# Measurement priority when features are closer than the resolution: the first one keeps the window.
PRIORITY = ["Ha", "Hb", "Hg", "Hd", "CaK", "CaH_He", "NaD", "Mgb", "Gband", "O2A", "O2B", "TiO7054", "TiO6159",
            "CaT8542", "CaT8498", "CaT8662", "HeII4686", "HeI4471", "HeI5876", "HeI6678", "HeI4026", "OIII5007",
            "OIII4959", "NII6583", "NII6548", "SII6716", "SII6731", "OI7774", "MgII4481", "CaI4227", "FeI4383",
            "FeI5270", "FeI5335", "H8", "H9", "C2_5165"]


def blends(resolution: float) -> dict[str, Any]:
    """Features closer than ~the resolution FWHM cannot be measured separately: the higher-priority one is
    measured and reported as a blend, the others are hidden. Bands are never merged with lines."""
    hidden: set[str] = set()
    groups: dict[str, list[str]] = {}
    ordered = [key for key in PRIORITY if key in FEATURE] + [f.key for f in FEATURES if f.key not in PRIORITY]
    for key in ordered:
        if key in hidden or FEATURE[key].kind == "band":
            continue
        for other in ordered:
            if other == key or other in hidden or other in groups or FEATURE[other].kind == "band":
                continue
            same_kind = (FEATURE[other].kind == "emission") == (FEATURE[key].kind == "emission")
            if same_kind and abs(FEATURE[other].wave - FEATURE[key].wave) < max(resolution, 2.0) * 1.0:
                hidden.add(other)
                groups.setdefault(key, []).append(other)
    return {"hidden": hidden, "groups": groups}


# Coolest Teff (K) at which each line forms: He II only in O stars, He I in B (to ~B9), Mg II 4481 from F.
HOT_ONLY = {"HeI4026": 10500, "HeI4471": 10500, "HeI5876": 10500, "HeI6678": 10500, "HeII4686": 30000, "MgII4481": 6500,
            "OI7774": 6000}
# Hottest Teff (K) at which each feature appears: molecules and neutral metals vanish in hot photospheres.
COOL_ONLY = {"TiO6159": 4200, "TiO7054": 4200, "Gband": 7500, "CaI4227": 8500, "FeI4383": 8500, "FeI5270": 8500,
             "FeI5335": 8500, "Mgb": 11000, "C2_5165": 5500}


def possible(key: str, teff: float) -> bool:
    return not ((key in HOT_ONLY and teff < HOT_ONLY[key]) or (key in COOL_ONLY and teff > COOL_ONLY[key]))


def plausible_lines(lines: list[dict[str, Any]], teff: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Keeps the identifications that are physically possible at the fitted temperature. Helium lines only
    form in hot photospheres and TiO only in cool ones; in other stars the same windows hold blends of metal
    lines, reported as unidentified absorptions instead of elements."""
    kept, other = [], []
    for line in lines:
        partners = [key for key in line.get("partners", []) if possible(key, teff)]
        if line.get("partners") is not None and partners != line["partners"]:
            main = FEATURE[line["key"]]
            line = {**line, "partners": partners,
                    "label": main.label if not partners else f"{main.label} + {' + '.join(FEATURE[p].label for p in partners)} (blend)",
                    "element": "/".join(dict.fromkeys([main.element] + [FEATURE[p].element for p in partners]))}
        if not possible(line["key"], teff) and line["type"] != "emission":
            other.append({**line, "label": f"Absorption near {line['rest'] / 10:.1f} nm", "element": "unidentified",
                          "note": f"not {line['label']}: impossible at ~{int(teff)} K (blend of other lines)"})
        else:
            kept.append(line)
    return kept, other


def analyse_spectrum(spectrum: Spectrum1D, wavelength_calibrated: bool = True) -> dict[str, Any]:
    """Continuum, detected lines, elements, type/temperature, velocity and confidence for one spectrum."""
    wave, flux = spectrum.wave, spectrum.flux
    continuum = continuum_normalise(spectrum)
    norm = flux / continuum
    norm_err = spectrum.error / continuum
    if not np.isfinite(norm_err).any():
        residual = norm - np.convolve(norm, np.ones(5) / 5, mode="same")
        sigma = 1.4826 * np.nanmedian(np.abs(residual - np.nanmedian(residual)))
        norm_err = np.full_like(norm, max(sigma, 1e-3))
    snr = float(np.nanmedian(1 / norm_err[np.isfinite(norm_err) & (norm_err > 0)])) if np.isfinite(norm_err).any() else 0.0

    measurements: dict[str, dict[str, Any]] = {}
    lines: list[dict[str, Any]] = []
    blended = blends(spectrum.resolution)
    if wavelength_calibrated:
        for feature in FEATURES:
            if feature.key in blended["hidden"]:
                continue
            if feature.kind == "emission":
                continue  # emission is measured against the fitted stellar model, below
            result = measure_feature(feature, wave, norm, norm_err, spectrum.resolution)
            if result is None:
                continue
            measurements[feature.key] = result
            significance = result["value"] / result["error"]
            is_emission = False
            if feature.kind == "band":
                # C2 Swan bands only appear (strongly) in carbon stars; weaker dips there are Mg b/MgH blends.
                floor = 0.25 if feature.key == "C2_5165" else 0.05
                detected = result["value"] > max(floor, 3 * result["error"])
            else:
                detected = significance > 3 and result["value"] > 0.15 * min(spectrum.resolution, 10) / 10
            if not detected:
                continue
            partners = blended["groups"].get(feature.key, [])
            label = feature.label if not partners else f"{feature.label} + {' + '.join(FEATURE[p].label for p in partners)} (blend)"
            element = feature.element if not partners else "/".join(dict.fromkeys([feature.element] + [FEATURE[p].element for p in partners]))
            lines.append({
                "key": feature.key, "label": label, "element": element, "partners": partners,
                "rest": feature.wave, "observed": result.get("observed"),
                "type": "emission" if is_emission or feature.kind == "emission" else ("telluric" if feature.kind == "telluric" else ("band" if feature.kind == "band" else "absorption")),
                "ew": round(result["value"], 3), "ewError": round(result["error"], 3), "unit": result["unit"],
                "significance": round(abs(significance), 1), "velocity": None,
            })
    classification = None
    model = None
    if wavelength_calibrated:
        classification = fit_templates(spectrum)
        hbeta_fwhm = balmer_width(spectrum, norm)
        special, notes = special_features(measurements, lines, hbeta_fwhm)
        if classification is None:
            classification = {"type": None, "range": None, "teff": None, "teffLow": None, "teffHigh": None,
                              "notes": ["Wavelength range too short to compare with the standard-star library"]}
        model = classification.pop("model", None)
        emission = classification.pop("emission", None) or []
        balmer_emission = any(line["key"] in BALMER_EMISSION for line in emission)
        # Ionised gas (forbidden lines) always shows Balmer emission too; helium emission in a cool
        # photosphere only comes with it as well (accreting binaries).
        if not balmer_emission:
            emission = [line for line in emission if line["key"] in BALMER_EMISSION
                        or (line["key"].startswith("He") and (classification.get("teff") or 0) >= 10500)]
        # Objects outside the normal-star library are fitted poorly, so their emission cannot be assessed.
        provisional_special, _ = special_features(measurements, lines, hbeta_fwhm)
        if provisional_special and ("white dwarf" in provisional_special or "Carbon" in provisional_special):
            emission = []
            notes.append("Emission lines not assessed: the object is outside the normal-star library")
        if emission:
            # A Balmer line seen in emission replaces its absorption entry.
            emitted = {line["key"] for line in emission}
            lines = [line for line in lines if line["key"] not in emitted] + emission
            special, notes = special_features(measurements, lines, hbeta_fwhm)
        classification["special"] = special
        classification["notes"] = classification.get("notes", []) + notes
    unidentified: list[dict[str, Any]] = []
    if classification and classification.get("teff"):
        lines, unidentified = plausible_lines(lines, classification["teff"])
    elements = sorted({part for line in lines if line["type"] != "telluric" for part in line["element"].split("/")
                       if part not in ("telluric", "TiO")} | ({"Ti", "O"} if any(line["key"].startswith("TiO") for line in lines) else set()))
    # Pickles standards have ~10 Å resolution and did not reproduce catalogued
    # SDSS velocities closely enough in our independent fixtures. A pPXF shift
    # aligns templates for classification; it is not a validated radial velocity.
    velocity = None
    # A Planck colour temperature is not scientifically meaningful without a
    # verified absolute flux response and an extinction correction. The MK
    # template temperature below is retained; no independent value is claimed.
    colour = None
    return {"continuum": continuum, "normalized": norm, "normalizedError": norm_err, "snr": round(snr, 1), "model": model,
            "unidentified": unidentified,
            "lines": lines, "elements": elements, "classification": classification, "velocity": velocity,
            "colourTemperature": colour, "measurements": {key: {k: (round(v, 4) if isinstance(v, float) else v) for k, v in m.items()} for key, m in measurements.items()}}


_LIBRARY: dict[str, Any] | None = None


def library() -> dict[str, Any]:
    """The Pickles (1998) standard-star library, resampled to 5 A (tools/data/spectral-library.fits)."""
    global _LIBRARY
    if _LIBRARY is None:
        path = os.environ.get("ASTROVIABIN_SPECTRAL_LIBRARY") or str(Path(__file__).resolve().parent.parent / "data" / "spectral-library.fits")
        with fits.open(path, memmap=False) as hdus:
            table = hdus["LIBRARY"]
            header, data = table.header, table.data
            wave = header["WAVE0"] + header["DWAVE"] * np.arange(header["NWAVE"])
            _LIBRARY = {
                "wave": wave, "flux": np.asarray(data["FLUX"], dtype=float),
                "label": [str(v).strip() for v in data["LABEL"]], "mk": [str(v).strip() for v in data["MKTYPE"]],
                "lum": [str(v).strip() for v in data["LUMCLASS"]], "metal": [str(v).strip() for v in data["METAL"]],
                "index": np.asarray(data["TYPEINDEX"], dtype=float), "teff": np.asarray(data["TEFF"], dtype=float),
                "smoothed": {},
            }
    return _LIBRARY


def gaussian_smooth(wave: np.ndarray, flux: np.ndarray, fwhm: float) -> np.ndarray:
    from scipy.ndimage import gaussian_filter1d
    if fwhm <= 0:
        return flux
    step = float(np.median(np.diff(wave)))
    return gaussian_filter1d(flux, fwhm / 2.355 / max(step, 1e-6), mode="nearest")


def _log_rebinned_library(lib: dict[str, Any], low: float, high: float, velscale: float, smoothing: float) -> tuple[np.ndarray, np.ndarray]:
    """The library over [low, high] A, smoothed by `smoothing` A FWHM and log-rebinned at `velscale` (cached)."""
    import ppxf.ppxf_util as util
    key = (round(low), round(high), round(float(velscale), 3), round(smoothing, 1))
    cache = lib.setdefault("ppxf", {})
    if key not in cache:
        selected = (lib["wave"] >= low) & (lib["wave"] <= high)
        wave = lib["wave"][selected]
        rows = []
        for row in lib["flux"]:
            template, ln_lam, _ = util.log_rebin(wave, gaussian_smooth(wave, row[selected], smoothing), velscale=velscale)
            rows.append(template / np.median(template))
        cache[key] = (np.array(rows).T, np.exp(ln_lam))
    return cache[key]


def fit_templates(spectrum: Spectrum1D) -> dict[str, Any] | None:
    """Spectral type, luminosity class, temperature and radial velocity with pPXF (Cappellari 2004, 2017)
    against the Pickles (1998) library.

    Both are compared at the coarser of the two resolutions (pPXF needs templates at least as sharp as the
    data). A multiplicative Legendre polynomial absorbs reddening, flux calibration and the instrumental
    response; telluric bands are masked and outliers clipped (pPXF `clean`). Stage 1 fits every library
    star with fixed kinematics (ranking and the delta-chi2 range); stage 2 refits the best ones with free
    velocity and dispersion when the resolution allows a velocity.
    """
    require_ppxf()
    from ppxf.ppxf import ppxf
    import ppxf.ppxf_util as util
    lib = library()
    low, high = max(spectrum.wave[0], 3700.0, lib["wave"][0] + 60), min(spectrum.wave[-1], 9200.0, lib["wave"][-1] - 60)
    if high - low < 600:
        return None
    inside = (spectrum.wave >= low) & (spectrum.wave <= high)
    wave, flux, error = spectrum.wave[inside], np.nan_to_num(spectrum.flux[inside]), spectrum.error[inside]
    known = np.isfinite(error) & (error > 0)
    if known.any():
        error = np.where(known, error, np.nanmax(error[known]) * 10)
    else:
        residual = flux - gaussian_smooth(wave, flux, 3 * spectrum.resolution)
        error = np.full_like(flux, max(1.4826 * float(np.median(np.abs(residual))), 1e-9))
    target = max(spectrum.resolution, LIBRARY_RESOLUTION)
    observed = gaussian_smooth(wave, flux, math.sqrt(max(target ** 2 - spectrum.resolution ** 2, 0)))
    galaxy, ln_lam, velscale = util.log_rebin(wave, observed)  # the real (possibly non-linear) grid
    noise = np.sqrt(util.log_rebin(wave, error ** 2, velscale=velscale)[0])
    n = min(len(galaxy), len(noise))
    galaxy, noise, lam = galaxy[:n], noise[:n], np.exp(ln_lam[:n])
    mask = np.isfinite(noise) & (noise > 0) & np.isfinite(galaxy)
    for band_low, band_high in TELLURIC:
        mask &= ~((lam >= band_low) & (lam <= band_high))
    goodpixels = np.nonzero(mask)[0]
    if goodpixels.size < 50:
        return None
    scale = float(np.median(galaxy[goodpixels]))
    galaxy, noise = galaxy / scale, noise / scale
    templates, lam_temp = _log_rebinned_library(lib, low - 300, high + 300, velscale, math.sqrt(max(target ** 2 - LIBRARY_RESOLUTION ** 2, 0)))
    mdegree = int(np.clip(round((high - low) / 900), 2, 8))
    common = dict(moments=2, degree=-1, mdegree=mdegree, goodpixels=goodpixels, lam=lam, lam_temp=lam_temp, quiet=True)
    sigma_start = max(float(velscale), 30.0)
    chi2 = np.full(templates.shape[1], np.inf)
    for index in range(templates.shape[1]):
        try:
            fit = ppxf(templates[:, index:index + 1], galaxy, noise, velscale, [0.0, sigma_start], fixed=[1, 1], **common)
            chi2[index] = fit.chi2
        except Exception:
            continue
    if not np.isfinite(chi2).any():
        return None
    order = np.argsort(chi2)
    best = int(order[0])
    velocity = None
    best_fit = None
    if spectrum.resolution <= 8:
        refined = []
        for index in order[:8]:
            try:
                fit = ppxf(templates[:, index:index + 1], galaxy, noise, velscale, [0.0, sigma_start], bounds=[[-600, 600], [1, 300]], clean=True, **common)
                refined.append((fit.chi2, int(index), fit))
            except Exception:
                continue
        if refined:
            _, best, best_fit = min(refined, key=lambda item: item[0])
            # The velocity is a nuisance alignment parameter only. The Pickles
            # templates do not support a defensible radial-velocity claim.
    if best_fit is None:
        best_fit = ppxf(templates[:, best:best + 1], galaxy, noise, velscale, [0.0, sigma_start], fixed=[1, 1], **common)
    # pPXF's chi2 is per degree of freedom: rescale so the best is 1, and count one degree of freedom per
    # resolution element (the log-rebinned pixels oversample the smoothed spectrum).
    dof = goodpixels.size
    pixel_width = float(np.median(np.diff(lam)))
    correlation = max(1.0, target / max(pixel_width, 1e-6))
    delta = (chi2 - chi2[order[0]]) / chi2[order[0]] * dof / correlation
    accepted = np.nonzero(delta <= 2.3)[0]
    if best not in accepted:
        accepted = np.append(accepted, best)
    # Broad uncertainty guard band from independent SDSS observations; this is
    # a closest-template estimate, not a precise MK classification.
    near = np.nonzero(np.abs(lib["index"] - lib["index"][best]) <= TYPE_SYSTEMATIC)[0]
    accepted = np.union1d(accepted, near)
    indices = lib["index"][accepted]
    low_i, high_i = accepted[int(np.argmin(indices))], accepted[int(np.argmax(indices))]
    luminosities = sorted({lib["lum"][i] for i in accepted}, key=["V", "IV", "III", "II", "I"].index)
    teffs = lib["teff"][accepted]
    model = np.interp(spectrum.wave, lam, best_fit.bestfit * scale, left=np.nan, right=np.nan)
    emission = gas_emission(templates, galaxy, noise, velscale, lam, lam_temp, goodpixels, mdegree, target,
                            [float(best_fit.sol[0]), float(best_fit.sol[1])], spectrum.resolution <= 8)
    mk_low, mk_high = lib["mk"][low_i], lib["mk"][high_i]
    alternatives = [lib["label"][i] + (f" ({'metal-poor' if lib['metal'][i] == 'w' else 'metal-rich'})" if lib["metal"][i] else "")
                    for i in order[:6] if delta[i] <= 2.3 or i == best]
    return {
        "type": f"{lib['mk'][best]}{lib['lum'][best]}", "mk": lib["mk"][best], "luminosityClass": lib["lum"][best],
        "range": mk_low if mk_low == mk_high else f"{mk_low}–{mk_high}", "luminosityRange": "–".join(dict.fromkeys([luminosities[0], luminosities[-1]])),
        "metallicity": {"w": "metal-poor", "r": "metal-rich"}.get(lib["metal"][best], "solar"),
        "teff": int(round(lib["teff"][best], -1)), "teffLow": int(teffs.min()), "teffHigh": int(teffs.max()),
        "chi2red": round(float(best_fit.chi2), 3), "matches": alternatives, "velocity": velocity, "emission": emission,
        "method": "pPXF (Cappellari 2017) against the Pickles (1998) library: 131 standards, O5–M10, classes V–I",
        "notes": ["Type is the closest library template; the reported range includes an 8-subclass empirical guard band.",
                  "Radial velocity withheld: 10 Å Pickles templates are insufficient for a validated velocity measurement."],
        "model": model,
    }


def balmer_width(spectrum: Spectrum1D, normalized: np.ndarray) -> float | None:
    """FWHM (A) of the H-beta absorption measured with specutils, or None when it is not measurable."""
    import astropy.units as u
    from specutils import Spectrum, SpectralRegion
    from specutils.analysis import fwhm
    window = (spectrum.wave > 4861.3 - 160) & (spectrum.wave < 4861.3 + 160)
    if window.sum() < 10 or spectrum.resolution > 40:
        return None
    depth = np.clip(1 - np.nan_to_num(normalized[window], nan=1.0), 0, None)
    if depth.max() < 0.2:
        return None
    try:
        value = fwhm(Spectrum(flux=depth * u.dimensionless_unscaled, spectral_axis=spectrum.wave[window] * u.AA),
                     regions=SpectralRegion((4861.3 - 160) * u.AA, (4861.3 + 160) * u.AA))
        return float(value.to_value(u.AA))
    except Exception:
        return None


# pPXF gas line names -> catalogue keys used in the reports.
GAS_KEYS = {"Balmer": "Ha", "Halpha": "Ha", "Hbeta": "Hb", "Hgamma": "Hg", "Hdelta": "Hd", "[OIII]5007_d": "OIII5007", "[NII]6583_d": "NII6583",
            "[SII]6716": "SII6716", "[SII]6731": "SII6731", "HeI5876": "HeI5876", "HeII4687": "HeII4686"}


def gas_emission(stellar: np.ndarray, galaxy: np.ndarray, noise: np.ndarray, velscale: float, lam: np.ndarray, lam_temp: np.ndarray,
                 goodpixels: np.ndarray, mdegree: int, fwhm: float, kinematics: list[float], free: bool) -> list[dict[str, Any]]:
    """Emission lines with pPXF: the whole stellar library (a non-negative combination, so line depths are
    reproduced) plus Gaussian gas templates (ppxf_util.emission_lines, Balmer lines tied to the recombination
    decrement), fitted together. A line counts when its flux is positive and significant against pPXF's error
    scaled by sqrt(chi2), which includes the remaining stellar-template mismatch."""
    from ppxf.ppxf import ppxf
    import ppxf.ppxf_util as util
    try:
        gas_templates, gas_names, gas_wave = util.emission_lines(np.log(lam_temp), [lam[0], lam[-1]], fwhm, tie_balmer=True, limit_doublets=True)
    except Exception:
        return []
    if gas_templates.shape[1] == 0:
        return []
    stellar = stellar if stellar.ndim == 2 else stellar[:, None]
    templates = np.column_stack([stellar, gas_templates])
    component = np.array([0] * stellar.shape[1] + [1] * gas_templates.shape[1])
    moments = [2, 2] if free else [-2, -2]
    start = [kinematics, kinematics] if free else [[0.0, kinematics[1]], [0.0, kinematics[1]]]
    try:
        fit = ppxf(templates, galaxy, noise, velscale, start, moments=moments, degree=-1, mdegree=mdegree, goodpixels=goodpixels,
                   lam=lam, lam_temp=lam_temp, component=component, gas_component=component > 0, gas_names=gas_names, quiet=True)
    except Exception:
        return []
    scale = math.sqrt(max(fit.chi2, 1.0))
    stellar_level = np.interp(gas_wave, lam, fit.bestfit - (fit.gas_bestfit if fit.gas_bestfit is not None else 0))
    found = []
    for name, flux, error, wave, level in zip(gas_names, fit.gas_flux, fit.gas_flux_error, gas_wave, stellar_level):
        key = GAS_KEYS.get(str(name))
        if key is None or not np.isfinite(flux) or not np.isfinite(error) or error <= 0:
            continue
        significance = flux / (error * scale)
        if flux > 0 and significance > 5:
            ew = flux / max(level, 1e-9)
            found.append({"key": key, "label": FEATURE[key].label, "element": FEATURE[key].element, "rest": FEATURE[key].wave, "observed": None,
                          "type": "emission", "ew": round(-float(ew), 2), "ewError": round(float(error * scale / max(level, 1e-9)), 2), "unit": "A",
                          "significance": round(float(significance), 1), "velocity": None, "method": "pPXF gas emission fit"})
    return found


def special_features(measurements: dict[str, dict[str, Any]], lines: list[dict[str, Any]], hbeta_fwhm: float | None = None) -> tuple[str | None, list[str]]:
    """Objects the normal-star library does not contain: white dwarfs, carbon stars, emission-line objects."""
    notes: list[str] = []
    special = None
    # DA white dwarfs: pressure-broadened Balmer lines, H-beta FWHM of 50-150 A (A stars: about 15-30 A).
    if hbeta_fwhm is not None and hbeta_fwhm > 45:
        special = f"DA white dwarf candidate (H-beta FWHM {hbeta_fwhm:.0f} Å: pressure-broadened Balmer lines; not in the normal-star library)"
    if ((measurements.get("C2_5165") or {}).get("value") or 0) > 0.25:
        special = "Carbon star candidate (C₂ Swan bands)"
    if any(line["type"] == "emission" and line["key"] in BALMER_EMISSION for line in lines):
        special = (special + "; " if special else "") + "Balmer emission (Be/T Tauri star, CV or emission-line object)"
    if any(line["type"] == "emission" and line["key"] not in BALMER_EMISSION for line in lines):
        notes.append("Forbidden emission lines ([O III], [N II], [S II]): nebular or extragalactic, not a normal stellar photosphere")
    return special, notes


def confidence_of(analysis: dict[str, Any], calibration_status: str, flags: list[str]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    snr = analysis["snr"]
    stellar = [line for line in analysis["lines"] if line["type"] in ("absorption", "band", "emission")]
    if calibration_status == "none":
        return "Insufficient", ["No wavelength calibration: lines cannot be identified"]
    if snr < 3 or not stellar:
        return "Insufficient", [f"S/N {snr:.1f}" if snr < 3 else "No stellar lines detected above 3σ"]
    score = 3
    if snr < 10:
        score -= 1
        reasons.append(f"Low S/N ({snr:.1f})")
    if snr < 5:
        score -= 1
    if len(stellar) < 3:
        score -= 1
        reasons.append(f"Only {len(stellar)} stellar feature(s)")
    if calibration_status == "user":
        # Slitless: user dispersion and the zero order as wavelength zero point, no arc lamp.
        score = min(score, 2)
        reasons.append("Wavelengths from the user dispersion and the zero order (no reference lamp)")
    if any(flag in flags for flag in ("overlap", "truncated", "saturated")):
        score -= 1
        reasons.append("Contaminated, truncated or saturated trace")
    reasons.append("Spectral type is a pPXF template match (about ±2 subclasses), not a definitive classification")
    level = "High" if score >= 3 else "Medium" if score == 2 else "Low" if score >= 1 else "Insufficient"
    return level, reasons


# ------------------------------------------------------------------------------------------------
# Slitless (Star Analyser) frames

def load_frame(path: str, settings: dict[str, Any], calibration: dict[str, Any]) -> tuple[np.ndarray, fits.Header, list[str]]:
    """2-D frame calibrated with ccdproc (masters optional) and cleaned of cosmic rays (L.A.Cosmic)."""
    import astropy.units as u
    import ccdproc
    from astropy.nddata import CCDData

    notes: list[str] = []
    with fits.open(path, memmap=False) as hdus:
        hdu = next((h for h in hdus if h.is_image and h.data is not None and h.data.ndim in (2, 3)), None)
        if hdu is None:
            fail("The FITS contains no 2-D image")
        data = np.asarray(hdu.data, dtype=float)
        header = hdus[0].header.copy()
        if hdu is not hdus[0]:
            header.update(hdu.header)
    if data.ndim == 3:
        data = np.nansum(data, axis=0) if data.shape[0] <= 4 else data[0]
        notes.append("Colour frame: the planes were summed (a slitless spectrum needs a mono or summed image)")
    ccd = CCDData(np.nan_to_num(data), unit=u.adu)

    def master(key: str) -> tuple[CCDData | None, float | None]:
        value = calibration.get(key)
        if not value:
            return None, None
        with fits.open(value, memmap=False) as hdus:
            hdu = next((h for h in hdus if h.is_image and h.data is not None), None)
            if hdu is None:
                return None, None
            exposure_value = finite(hdu.header.get("EXPTIME")) or finite(hdus[0].header.get("EXPTIME")) or finite(hdu.header.get("EXPOSURE"))
            image_data = np.asarray(hdu.data, dtype=float)
        if image_data.ndim == 3:
            image_data = np.nansum(image_data, axis=0) if image_data.shape[0] <= 4 else image_data[0]
        if image_data.shape != ccd.data.shape:
            fail(f"The {key.replace('Path', '')} frame is {image_data.shape[1]}x{image_data.shape[0]} px; the image is {ccd.data.shape[1]}x{ccd.data.shape[0]} px")
        return CCDData(image_data, unit=u.adu), exposure_value

    (bias, _), (dark, dark_exposure), (flat, _) = master("biasPath"), master("darkPath"), master("flatPath")
    if bias is not None or dark is not None or flat is not None:
        exposure = finite(header.get("EXPTIME"), None) or finite(header.get("EXPOSURE"), 1.0) or 1.0
        if flat is not None:
            flat = CCDData(flat.data / np.nanmedian(flat.data), unit=u.dimensionless_unscaled)
        # Darks are scaled by exposure time (each frame's own EXPTIME).
        ccd = ccdproc.ccd_process(ccd, master_bias=bias, dark_frame=dark, master_flat=flat,
                                  dark_exposure=(dark_exposure or exposure) * u.s if dark is not None else None,
                                  data_exposure=exposure * u.s if dark is not None else None,
                                  dark_scale=dark is not None)
        notes.append("Calibrated with ccdproc (" + ", ".join(name for name, value in (("bias", bias), ("dark", dark), ("flat", flat)) if value is not None) + ")")
    if settings.get("cosmicRays", True):
        cleaned = ccdproc.cosmicray_lacosmic(ccd, sigclip=float(finite(settings.get("cosmicSigma"), 6.0)), objlim=8.0, niter=3)
        ccd = cleaned
        notes.append("Cosmic rays removed with L.A.Cosmic (ccdproc)")
    return np.asarray(ccd.data, dtype=float), header, notes


def detect_zero_orders(image: np.ndarray, settings: dict[str, Any]) -> tuple[np.ndarray, Any, float, float]:
    """Background-subtracted image and point-like sources (zero orders), photutils."""
    from photutils.background import Background2D, MedianBackground
    from photutils.detection import DAOStarFinder
    from astropy.stats import SigmaClip, sigma_clipped_stats

    box = int(max(32, min(128, min(image.shape) // 16)))
    background = Background2D(image, (box, box), filter_size=(3, 3), sigma_clip=SigmaClip(sigma=3.0), bkg_estimator=MedianBackground())
    data = image - background.background
    _, _, sigma = sigma_clipped_stats(data, sigma=3.0)
    fwhm = float(finite(settings.get("fwhm"), 4.0))
    finder = DAOStarFinder(fwhm=fwhm, threshold=float(finite(settings.get("detectionSigma"), 6.0)) * sigma,
                           sharplo=0.2, sharphi=1.0, roundlo=-0.6, roundhi=0.6, exclude_border=True)
    sources = finder(data)
    if sources is not None and "x_centroid" in sources.colnames and "xcentroid" not in sources.colnames:
        sources["xcentroid"] = sources["x_centroid"]
        sources["ycentroid"] = sources["y_centroid"]
    return data, sources, float(sigma), fwhm


def ray_profile(data: np.ndarray, x0: float, y0: float, angle: float, r0: float, r1: float, half: float) -> tuple[np.ndarray, np.ndarray]:
    """Flux summed across a strip of +-half px along the ray from (x0, y0) at `angle` (radians).

    Geometry glue only (scipy map_coordinates sampling): used to find the dispersion direction and to flag
    saturation. Spectra are traced and extracted by specreduce in `specreduce_stamp_extract`."""
    from scipy.ndimage import map_coordinates
    s = np.arange(r0, r1)
    t = np.arange(-half, half + 1)
    cos, sin = math.cos(angle), math.sin(angle)
    xs = x0 + s[None, :] * cos - t[:, None] * sin
    ys = y0 + s[None, :] * sin + t[:, None] * cos
    values = map_coordinates(data, [ys, xs], order=1, mode="constant", cval=np.nan)
    return s, np.nansum(values, axis=0)


def dispersion_direction(data: np.ndarray, sources: Any, sigma: float, settings: dict[str, Any]) -> tuple[float, float, float]:
    """Angle of the first order and its radial extent, voted over the brightest zero orders.

    No published library finds the dispersion direction of a crowded slitless field (Spectractor needs an
    accurate instrument model per target), so this is minimal glue: the direction that carries the most
    light from the brightest zero orders, as done by hand in RSpec/ISIS. The user can fix it in settings."""
    angle_setting = finite(settings.get("dispersionAngle"))
    reach = float(finite(settings.get("maxTraceLength"), min(800, max(data.shape) * 0.45)))
    brightest = sorted(range(len(sources)), key=lambda i: -float(sources["flux"][i]))[:25]
    angles = np.deg2rad(np.arange(0, 360, 1.0)) if angle_setting is None else np.array([math.radians(angle_setting)])
    votes: list[tuple[float, float]] = []
    for index in brightest:
        x0, y0 = float(sources["xcentroid"][index]), float(sources["ycentroid"][index])
        best, best_value = None, -np.inf
        for angle in angles:
            _, profile = ray_profile(data, x0, y0, angle, 12, reach, 2)
            value = float(np.nansum(np.clip(profile, 0, None)))
            if value > best_value:
                best, best_value = angle, value
        if best is not None:
            votes.append((best, best_value))
    if not votes:
        fail("No zero order is bright enough to find the dispersion direction")
    if angle_setting is not None:
        angle = math.radians(angle_setting)
    else:
        # Weighted circular mean of the per-star angles after discarding outliers (> 5 degrees from the mode).
        histogram = np.zeros(360)
        for value, weight in votes:
            histogram[int(round(math.degrees(value))) % 360] += math.log1p(max(weight, 0))
        mode = int(np.argmax(np.convolve(np.r_[histogram[-3:], histogram, histogram[:3]], np.ones(7), "valid")))
        close = [(a, w) for a, w in votes if abs(((math.degrees(a) - mode + 180) % 360) - 180) <= 5]
        sx = sum(math.cos(a) * math.log1p(w) for a, w in close)
        sy = sum(math.sin(a) * math.log1p(w) for a, w in close)
        angle = math.atan2(sy, sx)
    # Refine the angle to 0.05 degrees: the direction that puts the most light of the bright stars in a
    # narrow strip beyond the zero-order wings.
    near = max(15.0, 5 * float(finite(settings.get("fwhm"), 4.0)))
    if angle_setting is None:
        best_total, best_angle = -np.inf, angle
        for candidate in angle + np.deg2rad(np.arange(-1.0, 1.0001, 0.05)):
            total = 0.0
            for index in brightest[:10]:
                _, profile = ray_profile(data, float(sources["xcentroid"][index]), float(sources["ycentroid"][index]), candidate, near, reach, 1)
                total += float(np.nansum(np.clip(profile, 0, None)))
            if total > best_total:
                best_total, best_angle = total, candidate
        angle = float(best_angle)
    # Radial extent of the first order: where the stacked, normalised profile of the brightest stars rises
    # clearly above the noise, beyond the zero-order wings.
    stacked = None
    s = np.arange(near, reach)
    for index in brightest[:10]:
        _, profile = ray_profile(data, float(sources["xcentroid"][index]), float(sources["ycentroid"][index]), angle, near, reach, 3)
        profile = np.nan_to_num(profile)
        peak = float(np.nanpercentile(profile, 99)) if profile.size else 0.0
        if peak > 0:
            normalised = profile / peak
            stacked = normalised if stacked is None else stacked + normalised
    if stacked is not None:
        from scipy.ndimage import uniform_filter1d
        smooth = uniform_filter1d(stacked, 9)
        # The spectrum can fill most of the profile: take the background from its faint part.
        level = float(np.nanpercentile(smooth, 10))
        faint = smooth[smooth <= np.nanpercentile(smooth, 30)]
        noise = float(1.4826 * np.nanmedian(np.abs(faint - np.nanmedian(faint)))) if faint.size else 0.0
        above = np.nonzero(smooth > level + max(5 * noise, 0.1 * (np.nanmax(smooth) - level)))[0]
    else:
        above = np.array([], dtype=int)
    start = float(finite(settings.get("traceStart"), max(near, float(s[above.min()]) - 10) if len(above) else near))
    end = float(finite(settings.get("traceEnd"), min(reach, float(s[above.max()]) + 15) if len(above) else reach))
    return angle, start, end


def extract_traces(data: np.ndarray, sources: Any, sigma: float, fwhm: float, angle: float, start: float, end: float,
                   settings: dict[str, Any], saturation: float | None, raw: np.ndarray) -> list[dict[str, Any]]:
    """Box extraction of every first order with a local sky; overlaps, truncation and saturation flagged."""
    half = float(finite(settings.get("extractionHalfWidth"), max(3.0, 1.2 * fwhm)))
    sky_gap, sky_width = half + 3, max(4.0, half)
    cos, sin = math.cos(angle), math.sin(angle)
    height, width = data.shape
    stars = []
    order = sorted(range(len(sources)), key=lambda i: -float(sources["flux"][i]))
    max_stars = int(finite(settings.get("maxStars"), 60))
    positions = [(float(sources["xcentroid"][i]), float(sources["ycentroid"][i])) for i in range(len(sources))]
    for rank, index in enumerate(order[:max_stars]):
        x0, y0 = positions[index]
        flags: list[str] = []
        s = np.arange(start, end)
        xs_end, ys_end = x0 + end * cos, y0 + end * sin
        along = np.arange(start, end)
        xs_all, ys_all = x0 + along * cos, y0 + along * sin
        in_frame = float(np.mean((xs_all >= 0) & (xs_all < width) & (ys_all >= 0) & (ys_all < height)))
        if not (0 <= xs_end < width and 0 <= ys_end < height):
            flags.append("truncated")
        # Rectified stamp along the dispersion direction (geometry only); the spectrum itself is traced,
        # background-subtracted and extracted by specreduce on that stamp.
        extracted = specreduce_stamp_extract(data, x0, y0, angle, start, end, fwhm, sigma, settings)
        if extracted is None:
            flux = np.zeros_like(s, dtype=float)
            error = np.full_like(s, np.inf, dtype=float)
            flags.append("trace not found")
        else:
            flux, error = extracted
        # Other zero orders and traces inside this extraction box.
        contaminants = []
        for other, (ox, oy) in enumerate(positions):
            if other == index:
                continue
            for px, py in ((ox, oy),):
                dx, dy = px - x0, py - y0
                along, across = dx * cos + dy * sin, -dx * sin + dy * cos
                if start - 5 <= along <= end and abs(across) <= half + 2 * fwhm:
                    contaminants.append(other)
            # The other star's own first order crossing this box.
            dx, dy = ox - x0, oy - y0
            across = -dx * sin + dy * cos
            along = dx * cos + dy * sin
            if abs(across) <= half + 2 * fwhm and -end < along < end - start and other not in contaminants and abs(along) > 2:
                contaminants.append(other)
        if contaminants:
            flags.append("overlap")
        if saturation is not None:
            _, peak = ray_profile(raw, x0, y0, angle, start, end, 1)
            if np.nanmax(peak) / 3 >= 0.95 * saturation:
                flags.append("saturated")
        finite_error = np.isfinite(error) & (error > 0)
        peak = float(np.nanmax(flux)) if np.isfinite(flux).any() else 0.0
        usable = (flux > 0) & finite_error
        snr_trace = float(np.nanmedian(flux[usable] / error[usable])) if usable.any() else 0.0
        stars.append({"index": int(index), "rank": rank, "x": x0, "y": y0, "flux0": float(sources["flux"][index]), "inFrame": in_frame,
                      "pixel": s.astype(float), "flux": flux, "error": error, "flags": flags,
                      "contaminants": [int(c) for c in contaminants], "traceSnr": snr_trace, "peak": peak,
                      "trace": {"x0": x0 + start * cos, "y0": y0 + start * sin, "x1": x0 + end * cos, "y1": y0 + end * sin, "halfWidth": half}})
    return stars


def specreduce_stamp_extract(data: np.ndarray, x0: float, y0: float, angle: float, start: float, end: float, fwhm: float,
                             sigma: float, settings: dict[str, Any]) -> tuple[np.ndarray, np.ndarray] | None:
    """First order of one star: a stamp resampled along the dispersion direction (columns = distance from the
    zero order, rows = across the trace) is traced, background-subtracted and box-extracted with specreduce."""
    from scipy.ndimage import map_coordinates
    half_height = int(max(12, 6 * fwhm))
    along = np.arange(start, end, dtype=float)
    across = np.arange(-half_height, half_height + 1, dtype=float)
    cos, sin = math.cos(angle), math.sin(angle)
    xs = x0 + along[None, :] * cos - across[:, None] * sin
    ys = y0 + along[None, :] * sin + across[:, None] * cos
    stamp = map_coordinates(data, [ys, xs], order=1, mode="constant", cval=np.nan)
    if np.isfinite(stamp).mean() < 0.3:
        return None
    filled = np.where(np.isfinite(stamp), stamp, np.nanmedian(stamp))
    strip = specreduce_extract(filled, float(half_height), fwhm, sigma, settings, keep_all=True)
    if strip is None:
        return None
    return strip["flux"], strip["error"]


def calibrate_dispersion(stars: list[dict[str, Any]], settings: dict[str, Any], header: fits.Header, fwhm: float) -> dict[str, Any]:
    """Accept an independently measured nm/px.

    Assigning stellar/telluric dips to lines in the same uncalibrated exposure is
    circular and can produce a convincing but wrong solution. It cannot establish
    a scientific wavelength scale without a reference source.
    """
    del stars, header, fwhm
    user = finite(settings.get("dispersionNmPerPixel"))
    if user and user > 0:
        return {"status": "user", "dispersion": user, "error": None,
                "method": "Instrument dispersion supplied by the user; verify against a reference spectrum taken with this exact optical setup"}
    return {"status": "none", "dispersion": None, "error": None,
            "method": "Uncalibrated: supply an independently measured dispersion (nm/px) for this grating, camera and spacing"}


# ------------------------------------------------------------------------------------------------
# Spectrum strips (first orders without the zero order in the frame, or any 2-D dispersed spectrum)

def trace_guesses(data: np.ndarray, sigma: float, limit: int) -> list[float]:
    """Cross-dispersion positions of the dispersed spectra (rows of a frame dispersed along x): peaks of
    the frame collapsed along the dispersion axis. These seed specreduce's FitTrace."""
    from scipy.signal import find_peaks
    profile = np.nanpercentile(data, 90, axis=1)
    peaks, properties = find_peaks(profile, prominence=10 * sigma, distance=8)
    order = np.argsort(properties["prominences"])[::-1]
    return [float(peaks[i]) for i in order[:limit]]


def specreduce_extract(data: np.ndarray, guess: float, fwhm: float, sigma: float, settings: dict[str, Any], keep_all: bool = False) -> dict[str, Any] | None:
    """One spectrum with specreduce: FitTrace (quadratic, Gaussian peaks), two-sided background and boxcar
    extraction of the flux and of its variance (read noise + Poisson)."""
    from astropy.modeling import models
    from specreduce.background import Background
    from specreduce.extract import BoxcarExtract
    from specreduce.tracing import FitTrace
    half = float(finite(settings.get("extractionHalfWidth"), max(3.0, 1.2 * fwhm)))
    width = 2 * half + 1
    try:
        trace = FitTrace(data, guess=guess, window=int(max(8, 3 * fwhm)), bins=max(8, data.shape[1] // 20),
                         trace_model=models.Polynomial1D(2), peak_method="gaussian")
        background = Background.two_sided(data, trace, separation=half + 3 + max(4.0, half) / 2, width=max(4.0, half))
        subtracted = data - background.bkg_image().flux.value
        flux = np.asarray(BoxcarExtract(subtracted, trace, width=width).spectrum.flux.value, dtype=float)
        gain = max(float(finite(settings.get("gain"), 1.0)), 1e-3)
        variance_image = np.full_like(data, sigma ** 2) + np.clip(data, 0, None) / gain
        variance = np.asarray(BoxcarExtract(variance_image, trace, width=width).spectrum.flux.value, dtype=float)
    except Exception:
        return None
    error = np.sqrt(np.clip(variance, 1e-12, None))
    positions = np.asarray(trace.trace, dtype=float)
    x = np.arange(len(flux), dtype=float)
    if keep_all:
        return {"x": x, "y": positions, "flux": flux, "error": error}
    # The spectrum itself: columns brighter than 8% of its peak (the trace continues as sky beyond).
    smooth = gaussian_smooth(x, np.nan_to_num(flux), 5)
    bright = np.nonzero(smooth > 0.08 * np.nanmax(smooth))[0]
    if bright.size < 20:
        return None
    start, end = int(bright[0]), int(bright[-1])
    keep = slice(start, end + 1)
    snr = float(np.nanmedian(flux[keep] / error[keep]))
    return {"x": x[keep], "y": positions[keep], "flux": flux[keep], "error": error[keep], "snr": snr, "halfWidth": half,
            "start": start, "end": end, "fwhm": fwhm}


# ------------------------------------------------------------------------------------------------
# Spectral type index (for comparisons)

def mk_class_index(sptype: str) -> float | None:
    import re
    match = re.match(r"\s*([OBAFGKM])\s*(\d+(?:\.\d+)?)?", sptype or "")
    if not match:
        return None
    return "OBAFGKM".index(match.group(1)) * 10 + float(match.group(2) or 5)


# ------------------------------------------------------------------------------------------------
# Outputs

def downsample(*arrays: np.ndarray, limit: int = 1500) -> list[list[float | None]]:
    length = len(arrays[0])
    step = max(1, int(math.ceil(length / limit)))
    result = []
    for array in arrays:
        values = np.asarray(array, dtype=float)[::step]
        result.append([round(float(v), 6) if np.isfinite(v) else None for v in values])
    return result


def spectrum_payload(wave: np.ndarray, flux: np.ndarray, analysis: dict[str, Any]) -> dict[str, Any]:
    model = analysis.get("model")
    arrays = downsample(wave, flux, analysis["continuum"], analysis["normalized"], model if model is not None else np.full(len(wave), np.nan))
    payload = dict(zip(("wavelength", "flux", "continuum", "normalized", "model"), arrays))
    if model is None:
        payload.pop("model")
    return payload


def world(wcs: Any, x: float, y: float) -> tuple[float | None, float | None]:
    if wcs is None:
        return None, None
    try:
        sky = wcs.pixel_to_world(x, y)
        return round(float(sky.ra.deg), 7), round(float(sky.dec.deg), 7)
    except Exception:
        return None, None


def build_wcs(header: fits.Header, stored: Any) -> Any:
    from astropy.wcs import WCS
    try:
        candidate = WCS(header, naxis=2)
        if candidate.has_celestial:
            return candidate
    except Exception:
        pass
    if isinstance(stored, dict) and all(finite(stored.get(k)) is not None for k in ("crval1", "crval2", "crpix1", "crpix2", "cd11", "cd12", "cd21", "cd22")):
        h = fits.Header()
        sip = stored.get("sip") if isinstance(stored.get("sip"), dict) else None
        h["CTYPE1"], h["CTYPE2"] = ("RA---TAN-SIP", "DEC--TAN-SIP") if sip else ("RA---TAN", "DEC--TAN")
        for key in ("crval1", "crval2", "crpix1", "crpix2"):
            h[key.upper()] = float(stored[key])
        h["CD1_1"], h["CD1_2"], h["CD2_1"], h["CD2_2"] = (float(stored[k]) for k in ("cd11", "cd12", "cd21", "cd22"))
        if sip:
            for name in ("a", "b", "ap", "bp"):
                poly = sip.get(name)
                if isinstance(poly, dict):
                    h[f"{name.upper()}_ORDER"] = int(poly.get("order", 0))
                    for powers, coefficient in (poly.get("terms") or {}).items():
                        h[f"{name.upper()}_{powers}"] = float(coefficient)
        return WCS(h)
    return None


def write_outputs(work: Path, result: dict[str, Any], spectra: list[dict[str, Any]]) -> None:
    rows = []
    for star in result["stars"]:
        classification = star.get("classification") or {}
        rows.append({
            "Star": star["id"], "Status": star["status"], "x (px)": f"{star['x']:.2f}" if star.get("x") is not None else "",
            "y (px)": f"{star['y']:.2f}" if star.get("y") is not None else "",
            "RA (deg)": star.get("ra") or "", "Dec (deg)": star.get("dec") or "",
            "Estimated type": classification.get("type") or "Unclassified", "Type range": classification.get("range") or "",
            "Teff (K)": classification.get("teff") or "", "Teff range (K)": f"{classification.get('teffLow')}–{classification.get('teffHigh')}" if classification.get("teff") else "",
            "Detected lines": "; ".join(line["label"] for line in star.get("lines", [])),
            "Elements (compatible)": " ".join(star.get("elements", [])),
            "Radial velocity (km/s)": (star.get("velocity") or {}).get("value", ""),
            "S/N": star.get("snr", ""), "Confidence": star.get("confidence", ""), "Catalogue": star.get("catalogue", ""),
            "Notes": " | ".join(star.get("reasons", []) + star.get("flags", [])),
        })
    with open(work / "summary.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else ["Star"])
        writer.writeheader()
        writer.writerows(rows)
    hdus = [fits.PrimaryHDU()]
    hdus[0].header["ORIGIN"] = "AstroviaBin spectroscopy"
    hdus[0].header["CALIBST"] = (result["calibration"]["status"], "wavelength calibration status")
    if result["calibration"].get("dispersion"):
        hdus[0].header["DISPERS"] = (result["calibration"]["dispersion"], "nm per pixel")
    for item in spectra:
        star = item["star"]
        columns = [fits.Column(name="WAVELENGTH", format="E", unit="Angstrom", array=item["wave"]) if item["wave"] is not None else
                   fits.Column(name="PIXEL", format="E", unit="pixel", array=item["pixel"]),
                   fits.Column(name="FLUX", format="E", array=item["flux"]),
                   fits.Column(name="ERROR", format="E", array=np.where(np.isfinite(item["error"]), item["error"], np.nan)),
                   fits.Column(name="NORMALIZED", format="E", array=item["normalized"] if item["normalized"] is not None else np.full(len(item["flux"]), np.nan)),
                   fits.Column(name="CONTINUUM", format="E", array=item["continuum"] if item.get("continuum") is not None else np.full(len(item["flux"]), np.nan)),
                   fits.Column(name="MODEL", format="E", array=item["model"] if item.get("model") is not None else np.full(len(item["flux"]), np.nan))]
        table = fits.BinTableHDU.from_columns(columns, name=f"STAR{star['id']}")
        h = table.header
        h["STAR"] = star["id"]
        for key, value in (("XPIX", star.get("x")), ("YPIX", star.get("y")), ("RA", star.get("ra")), ("DEC", star.get("dec")),
                           ("SNR", star.get("snr")), ("CONFID", star.get("confidence"))):
            if value is not None:
                h[key] = value
        classification = star.get("classification") or {}
        if classification.get("type"):
            h["SPTYPE"] = (classification["type"], f"estimated, range {str(classification.get('range')).replace('–', '-')}")
            h["TEFF"] = (classification["teff"], f"K, range {classification['teffLow']}-{classification['teffHigh']}")
        hdus.append(table)
        with open(work / f"star-{star['id']}.csv", "w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["wavelength_A" if item["wave"] is not None else "pixel_from_zero_order", "flux", "error", "normalized"])
            axis = item["wave"] if item["wave"] is not None else item["pixel"]
            norm = item["normalized"] if item["normalized"] is not None else np.full(len(axis), np.nan)
            for values in zip(axis, item["flux"], item["error"], norm):
                writer.writerow([f"{v:.6g}" if np.isfinite(v) else "" for v in values])
    fits.HDUList(hdus).writeto(work / "spectra.fits", overwrite=True)


def write_report(work: Path, result: dict[str, Any], spectra: list[dict[str, Any]], frame: np.ndarray | None) -> None:
    """PDF: overview, field with every star marked, one page per star (cutouts, spectrum, lines, results)."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    from matplotlib.patches import Polygon, Circle

    def stretch(image: np.ndarray) -> tuple[float, float]:
        finite_values = image[np.isfinite(image)]
        if finite_values.size == 0:
            return 0, 1
        low, high = np.percentile(finite_values, [5, 99.7])
        return float(low), float(high if high > low else low + 1)

    def trace_polygon(star: dict[str, Any]) -> np.ndarray:
        trace = star["trace"]
        dx, dy = trace["x1"] - trace["x0"], trace["y1"] - trace["y0"]
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length * trace["halfWidth"], dx / length * trace["halfWidth"]
        return np.array([[trace["x0"] + nx, trace["y0"] + ny], [trace["x1"] + nx, trace["y1"] + ny],
                         [trace["x1"] - nx, trace["y1"] - ny], [trace["x0"] - nx, trace["y0"] - ny]])

    by_id = {item["star"]["id"]: item for item in spectra}
    with PdfPages(work / "report.pdf") as pdf:
        # Page 1: summary.
        figure = plt.figure(figsize=(8.27, 11.69))
        figure.text(0.07, 0.95, "AstroviaBin — Spectroscopic analysis", fontsize=17, weight="bold")
        info = result["input"]
        calibration = result["calibration"]
        lines = [
            f"File: {info['name']}",
            f"Mode: {'slitless image (Star Analyser–type grating)' if result['mode'] == 'slitless' else '1-D spectrum'}",
            f"Generated: {result['generatedAt']}",
            f"Wavelength calibration: {calibration['status']} — {calibration['method']}",
        ]
        if calibration.get("dispersion"):
            lines.append(f"Dispersion: {calibration['dispersion']:.4f} nm/px" + (f" ± {calibration['error']:.4f}" if calibration.get("error") else ""))
        if result.get("geometry"):
            geometry = result["geometry"]
            lines.append(f"Dispersion direction: {geometry['angleDeg']:.2f}°; first order {geometry['start']:.0f}–{geometry['end']:.0f} px from the zero order")
        lines.append(f"Stars analysed: {sum(1 for s in result['stars'] if s['status'] == 'analysed')} of {len(result['stars'])} detected")
        lines += [""] + [f"• {note}" for note in result.get("notes", [])]
        lines += ["", "Lines identify elements compatible with the spectrum; they are not quantitative abundances.",
                  "Types and temperatures are estimates from line strengths, with the range shown for each star.",
                  "Instrumental response is not corrected in slitless frames: continuum shapes are not physical."]
        y = 0.9
        for text in lines:
            figure.text(0.07, y, text, fontsize=9, wrap=True)
            y -= 0.022
        table_rows = [[str(s["id"]), (s.get("classification") or {}).get("type") or "—",
                       ", ".join(l["label"] for l in s.get("lines", [])[:6]) or "—", s.get("confidence", "—"),
                       f"{s['x']:.1f}, {s['y']:.1f}" if s.get("x") is not None else "—",
                       f"{s['ra']:.5f}, {s['dec']:+.5f}" if s.get("ra") is not None else "—"] for s in result["stars"][:30]]
        if table_rows:
            axis = figure.add_axes([0.05, 0.05, 0.9, max(0.1, y - 0.08)])
            axis.axis("off")
            table = axis.table(cellText=table_rows, colLabels=["Star", "Type", "Lines", "Confidence", "x, y (px)", "RA, Dec (°)"],
                               loc="upper center", cellLoc="left", colWidths=[0.06, 0.08, 0.42, 0.12, 0.14, 0.2])
            table.auto_set_font_size(False)
            table.set_fontsize(6.5)
        pdf.savefig(figure)
        plt.close(figure)

        # Page 2: field with every star marked (slitless).
        if frame is not None:
            figure, axis = plt.subplots(figsize=(11.69, 8.27))
            low, high = stretch(frame)
            axis.imshow(frame, cmap="gray", origin="lower", vmin=low, vmax=high, interpolation="nearest")
            for star in result["stars"]:
                colour = "#22d3ee" if star["status"] == "analysed" else "#f59e0b"
                if star.get("trace"):
                    axis.add_patch(Polygon(trace_polygon(star), closed=True, fill=False, edgecolor=colour, linewidth=0.7))
                axis.add_patch(Circle((star["x"], star["y"]), 9, fill=False, edgecolor=colour, linewidth=0.9))
                axis.text(star["x"] + 11, star["y"] + 11, str(star["id"]), color=colour, fontsize=7, weight="bold")
            axis.set_title("Detected stars (circles: zero orders) and extracted first orders (boxes). Cyan: analysed, amber: discarded", fontsize=9)
            axis.set_xlabel("x (px)")
            axis.set_ylabel("y (px)")
            pdf.savefig(figure)
            plt.close(figure)

        # One page per star.
        for star in result["stars"]:
            item = by_id.get(star["id"])
            figure = plt.figure(figsize=(8.27, 11.69))
            classification = star.get("classification") or {}
            title = f"Star {star['id']} — {classification.get('type') or 'unclassified'}"
            if classification.get("range") and classification.get("range") != classification.get("type"):
                title += f" ({classification['range']})"
            figure.text(0.07, 0.955, title, fontsize=15, weight="bold")
            details = []
            if star.get("x") is not None:
                details.append(f"Zero order: x = {star['x']:.2f} px, y = {star['y']:.2f} px")
            if star.get("ra") is not None:
                from astropy.coordinates import SkyCoord
                import astropy.units as u
                coordinate = SkyCoord(star["ra"] * u.deg, star["dec"] * u.deg)
                details.append(f"RA, Dec (ICRS): {star['ra']:.6f}°, {star['dec']:+.6f}°  =  {coordinate.to_string('hmsdms', precision=2)}")
            if classification.get("teff"):
                details.append(f"Temperature (from type): {classification['teff']} K  (range {classification['teffLow']}–{classification['teffHigh']} K)")
            if star.get("colourTemperature"):
                ct = star["colourTemperature"]
                details.append(f"Continuum colour temperature: {ct['value']} K" + (f" ± {ct['error']} K" if ct.get("error") else "") + " (not dereddened)")
            if star.get("velocity"):
                how = star["velocity"].get("method") or f"{star['velocity'].get('lines')} lines"
                details.append(f"Radial velocity: {star['velocity']['value']} ± {star['velocity']['error']} km/s ({how})")
            details.append(f"S/N: {star.get('snr', '—')}   Confidence: {star.get('confidence', '—')}   Status: {star['status']}")
            if star.get("catalogue"):
                details.append(f"Catalogue: {star['catalogue']}")
            if star.get("elements"):
                details.append(f"Elements compatible with the lines: {', '.join(star['elements'])}")
            if classification.get("special"):
                details.append(f"Note: {classification['special']}")
            for reason in star.get("reasons", []) + [f"flag: {flag}" for flag in star.get("flags", [])] + list(classification.get("notes") or []):
                details.append(f"• {reason}")
            y = 0.925
            for text in details:
                figure.text(0.07, y, text, fontsize=8.5)
                y -= 0.019
            top = y - 0.01
            if frame is not None and star.get("x") is not None:
                size = 60
                x0, y0 = int(round(star["x"])), int(round(star["y"]))
                cut = frame[max(0, y0 - size): y0 + size, max(0, x0 - size): x0 + size]
                axis = figure.add_axes([0.06, top - 0.24, 0.26, 0.23])
                low, high = stretch(cut)
                axis.imshow(cut, cmap="gray", origin="lower", vmin=low, vmax=high,
                            extent=(max(0, x0 - size) - 0.5, max(0, x0 - size) + cut.shape[1] - 0.5, max(0, y0 - size) - 0.5, max(0, y0 - size) + cut.shape[0] - 0.5))
                axis.plot([star["x"] - 12, star["x"] - 4], [star["y"], star["y"]], color="#22d3ee", lw=1)
                axis.plot([star["x"] + 4, star["x"] + 12], [star["y"], star["y"]], color="#22d3ee", lw=1)
                axis.plot([star["x"], star["x"]], [star["y"] - 12, star["y"] - 4], color="#22d3ee", lw=1)
                axis.plot([star["x"], star["x"]], [star["y"] + 4, star["y"] + 12], color="#22d3ee", lw=1)
                axis.set_title("Zero order (exact centroid)", fontsize=8)
                axis.tick_params(labelsize=6)
                if star.get("trace"):
                    polygon = trace_polygon(star)
                    xs, ys = polygon[:, 0], polygon[:, 1]
                    pad = 15
                    x_low, x_high = int(max(0, xs.min() - pad)), int(min(frame.shape[1], xs.max() + pad))
                    y_low, y_high = int(max(0, ys.min() - pad)), int(min(frame.shape[0], ys.max() + pad))
                    trace_cut = frame[y_low:y_high, x_low:x_high]
                    if trace_cut.size:
                        axis = figure.add_axes([0.38, top - 0.24, 0.56, 0.23])
                        low, high = stretch(trace_cut)
                        axis.imshow(trace_cut, cmap="gray", origin="lower", vmin=low, vmax=high, aspect="auto",
                                    extent=(x_low - 0.5, x_high - 0.5, y_low - 0.5, y_high - 0.5))
                        axis.add_patch(Polygon(polygon, closed=True, fill=False, edgecolor="#22d3ee", linewidth=0.8))
                        axis.set_title("First-order spectrum and extraction box", fontsize=8)
                        axis.tick_params(labelsize=6)
                top -= 0.27
            if item is not None:
                axis = figure.add_axes([0.09, max(0.06, top - 0.3), 0.85, 0.27])
                x_axis = item["wave"] / 10 if item["wave"] is not None else item["pixel"]
                # Raw data in grey, the same smoothed to ~3 pixels in dark (noisy spectra stay readable).
                from scipy.ndimage import gaussian_filter1d
                smoothed = gaussian_filter1d(np.nan_to_num(item["flux"]), 1.5)
                axis.plot(x_axis, item["flux"], color="#cbd5e1", lw=0.5)
                axis.plot(x_axis, smoothed, color="#0f172a", lw=0.8, label="Flux (smoothed)")
                finite_flux = smoothed[np.isfinite(smoothed)]
                if finite_flux.size:
                    low_y, high_y = np.percentile(finite_flux, [0.5, 99.5])
                    axis.set_ylim(low_y - 0.15 * (high_y - low_y), high_y + 0.35 * (high_y - low_y))
                if item.get("continuum") is not None:
                    axis.plot(x_axis, item["continuum"], color="#f97316", lw=0.8, alpha=0.8, label="Continuum (specutils)")
                if item.get("model") is not None:
                    best_label = (star.get("classification") or {}).get("matches", ["best template"])[0]
                    axis.plot(x_axis, item["model"], color="#16a34a", lw=0.9, alpha=0.9, label=f"Best standard: {best_label}")
                label_top = axis.get_ylim()[1]
                for number, line in enumerate(sorted(star.get("lines", []), key=lambda entry: entry["rest"])):
                    if item["wave"] is None:
                        break
                    colour = {"absorption": "#2563eb", "emission": "#dc2626", "band": "#7c3aed", "telluric": "#9ca3af"}[line["type"]]
                    axis.axvline(line["rest"] / 10, color=colour, lw=0.6, ls="--")
                    # Staggered, short labels so neighbouring lines stay legible.
                    short = line["label"].split(" + ")[0].replace(" (telluric)", "")
                    axis.text(line["rest"] / 10, label_top * (0.99 if number % 2 == 0 else 0.9), short, rotation=90, fontsize=5.5, va="top", ha="right", color=colour)
                axis.set_xlabel("Wavelength (nm, air)" if item["wave"] is not None else "Distance from the zero order (px) — not calibrated")
                axis.set_ylabel("Flux" + (" (calibrated)" if result.get("fluxCalibrated") else " (instrumental)"))
                axis.legend(fontsize=6, loc="lower right")
                axis.tick_params(labelsize=7)
                if item.get("normalized") is not None and item["wave"] is not None:
                    axis2 = figure.add_axes([0.09, max(0.04, top - 0.62), 0.85, 0.25])
                    axis2.plot(x_axis, item["normalized"], color="#cbd5e1", lw=0.5)
                    axis2.plot(x_axis, gaussian_filter1d(np.nan_to_num(item["normalized"], nan=1.0), 1.5), color="#0f172a", lw=0.7)
                    axis2.axhline(1, color="#94a3b8", lw=0.5)
                    for line in star.get("lines", []):
                        colour = {"absorption": "#2563eb", "emission": "#dc2626", "band": "#7c3aed", "telluric": "#9ca3af"}[line["type"]]
                        axis2.axvline(line["rest"] / 10, color=colour, lw=0.5, ls=":")
                    axis2.set_ylim(0, 1.5)
                    axis2.set_xlabel("Wavelength (nm, air)")
                    axis2.set_ylabel("Normalised flux")
                    axis2.tick_params(labelsize=7)
                    rows = [[l["label"], f"{l['rest'] / 10:.2f}", f"{l['observed'] / 10:.2f}" if l.get("observed") else "—",
                             f"{l['ew']:.2f} ± {l['ewError']:.2f} {'Å' if l['unit'] == 'A' else ''}".strip(), f"{l['significance']:.1f}σ", l["type"]]
                            for l in star.get("lines", [])[:14]]
                    if rows and top - 0.62 > 0.2:
                        axis3 = figure.add_axes([0.07, 0.03, 0.88, top - 0.66])
                        axis3.axis("off")
                        t = axis3.table(cellText=rows, colLabels=["Line", "Rest (nm)", "Observed (nm)", "EW / depth", "Signif.", "Type"], loc="upper center", cellLoc="left")
                        t.auto_set_font_size(False)
                        t.set_fontsize(6.5)
            pdf.savefig(figure)
            plt.close(figure)
        if result.get("comparison"):
            comparison_pages(pdf, result["comparison"])


# ------------------------------------------------------------------------------------------------
# Comparison with earlier spectroscopic profiles (SIMBAD, Gaia DR3, SDSS DR18)

def table_value(row: Any, name: str) -> Any:
    """Unmask an Astroquery/Astropy table value without changing its meaning."""
    names = {key.lower(): key for key in row.colnames}
    key = names.get(name.lower())
    if key is None:
        return None
    value = row[key]
    if np.ma.is_masked(value):
        return None
    return value.item() if hasattr(value, "item") else value


def query_simbad(ra: float, dec: float, radius_deg: float) -> list[dict[str, Any]]:
    from astroquery.simbad import Simbad
    query = ("SELECT TOP 3000 main_id, ra, dec, sp_type, otype, rvz_radvel, rvz_err, V FROM basic "
             "LEFT JOIN allfluxes ON oid = oidref "
             f"WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.6f}, {dec:.6f}, {radius_deg:.5f})) = 1")
    data = Simbad.query_tap(query, maxrec=3000)
    rows = []
    for entry in data if data is not None else []:
        name, r, d = (table_value(entry, key) for key in ("main_id", "ra", "dec"))
        sptype, otype, rv, rv_err, vmag = (table_value(entry, key) for key in ("sp_type", "otype", "rvz_radvel", "rvz_err", "V"))
        if r is None or d is None:
            continue
        rows.append({"name": " ".join(str(name).split()), "ra": float(r), "dec": float(d), "spType": (sptype or "").strip() or None,
                     "otype": otype, "rv": rv, "rvError": rv_err, "v": vmag})
    return rows


def query_gaia(ra: float, dec: float, radius_deg: float) -> list[dict[str, Any]]:
    import astropy.units as u
    from astropy.coordinates import SkyCoord
    from astroquery.gaia import Gaia
    coordinate = SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
    Gaia.ROW_LIMIT = 5000
    columns = ["source_id", "ra", "dec", "phot_g_mean_mag", "bp_rp", "radial_velocity", "radial_velocity_error",
               "teff_gspphot", "logg_gspphot", "mh_gspphot", "distance_gspphot"]
    table = Gaia.cone_search_async(coordinate, radius=radius_deg * u.deg, columns=columns).get_results()
    rows = []
    for entry in table:
        get = lambda name: table_value(entry, name)
        rows.append({"source": str(get("source_id")), "ra": get("ra"), "dec": get("dec"), "g": get("phot_g_mean_mag"), "bpRp": get("bp_rp"),
                     "rv": get("radial_velocity"), "rvError": get("radial_velocity_error"), "teff": get("teff_gspphot"),
                     "logg": get("logg_gspphot"), "mh": get("mh_gspphot"), "distance": get("distance_gspphot")})
    return [row for row in rows if row["ra"] is not None and row["dec"] is not None]


def query_sdss(ra: float, dec: float, radius_arcmin: float) -> dict[str, Any] | None:
    from astroquery.sdss import SDSS
    command = ("select top 1 n.distance, s.ra, s.dec, s.class, s.subclass, s.z, s.zErr, s.plate, s.mjd, s.fiberID, "
               "p.TEFFADOP, p.TEFFADOPUNC, p.LOGGADOP, p.FEHADOP "
               f"from dbo.fGetNearbySpecObjEq({ra:.6f}, {dec:.6f}, {radius_arcmin:.4f}) n "
               "join specObj s on s.specobjid = n.specobjid left join sppParams p on p.specobjid = s.specobjid order by n.distance")
    rows = SDSS.query_sql(command, data_release=18, timeout=60)
    if rows is None or len(rows) == 0:
        return None
    row = rows[0]
    get = lambda name: table_value(row, name)
    return {"class": str(get("class") or "").strip(), "subclass": str(get("subclass") or "").strip(), "z": get("z"), "zError": get("zErr"),
            "teff": get("TEFFADOP"), "teffError": get("TEFFADOPUNC"), "logg": get("LOGGADOP"), "feh": get("FEHADOP"),
            "separationArcsec": round(float(get("distance") or 0) * 60, 2), "spectrum": f"{get('plate')}-{get('mjd')}-{get('fiberID')}"}


def nearest(rows: list[dict[str, Any]], ra: float, dec: float, radius_arcsec: float) -> tuple[dict[str, Any] | None, float | None]:
    best, best_distance = None, radius_arcsec
    for row in rows:
        distance = math.hypot((row["ra"] - ra) * math.cos(math.radians(dec)), row["dec"] - dec) * 3600
        if distance <= best_distance:
            best, best_distance = row, distance
    return best, (round(best_distance, 2) if best else None)


def luminosity_from_logg(logg: float | None) -> str | None:
    if logg is None:
        return None
    return "dwarf (V)" if logg >= 3.8 else "subgiant (IV)" if logg >= 3.3 else "giant (III)" if logg >= 1.5 else "supergiant (I/II)"


def our_luminosity(lum: str | None) -> str | None:
    return {"V": "dwarf (V)", "IV": "subgiant (IV)", "III": "giant (III)", "II": "supergiant (I/II)", "I": "supergiant (I/II)"}.get(lum or "")


def _retry(function, *args, attempts: int = 2):
    for attempt in range(attempts):
        try:
            return function(*args)
        except Exception:
            if attempt == attempts - 1:
                raise
    return None


def describe_known(entry: dict[str, Any]) -> str:
    parts = []
    simbad, gaia, sdss = entry.get("simbad"), entry.get("gaia"), entry.get("sdss")
    if simbad and simbad.get("spType"):
        parts.append(f"SIMBAD {simbad['name']}: {simbad['spType']}")
    elif simbad:
        parts.append(f"SIMBAD {simbad['name']} ({simbad.get('otype') or 'no spectral type'})")
    if gaia and (gaia.get("teff") or gaia.get("rv") is not None):
        bits = []
        if gaia.get("teff"):
            bits.append(f"Teff {gaia['teff']:.0f} K")
        if gaia.get("logg") is not None:
            bits.append(f"log g {gaia['logg']:.2f}")
        if gaia.get("rv") is not None:
            bits.append(f"RV {gaia['rv']:.1f} km/s")
        parts.append("Gaia DR3 " + ", ".join(bits))
    if sdss:
        parts.append(f"SDSS {sdss['class']} {sdss['subclass']}".strip())
    return "; ".join(parts) if parts else "No earlier spectroscopy found"


def lookup_known(positions: list[dict[str, Any]], radius_arcsec: float, sdss_limit: int = 40) -> tuple[dict[int, dict[str, Any]], list[str]]:
    """Earlier spectroscopic profile of every position: SIMBAD spectral type and RV, Gaia DR3 XP/RVS
    parameters (GSP-Phot Teff, log g, [M/H]; RVS radial velocity) and the nearest SDSS DR18 spectrum."""
    errors: list[str] = []
    known: dict[int, dict[str, Any]] = {}
    if not positions:
        return known, errors
    ras = np.array([p["ra"] for p in positions])
    decs = np.array([p["dec"] for p in positions])
    centre_ra = float(np.degrees(np.arctan2(np.mean(np.sin(np.radians(ras))), np.mean(np.cos(np.radians(ras))))) % 360)
    centre_dec = float(np.mean(decs))
    spread = float(np.max(np.hypot((ras - centre_ra) * math.cos(math.radians(centre_dec)), decs - centre_dec)))
    circles = [(centre_ra, centre_dec, spread + radius_arcsec / 3600 + 0.003)] if spread < 0.5 else [(p["ra"], p["dec"], radius_arcsec / 3600 + 0.001) for p in positions[:60]]
    simbad_rows: list[dict[str, Any]] = []
    gaia_rows: list[dict[str, Any]] = []
    for ra, dec, radius in circles:
        try:
            simbad_rows += _retry(query_simbad, ra, dec, radius)
        except Exception as error:
            errors.append(f"SIMBAD unavailable ({error.__class__.__name__})")
            break
    for ra, dec, radius in circles:
        try:
            gaia_rows += _retry(query_gaia, ra, dec, radius)
        except Exception as error:
            errors.append(f"Gaia DR3 unavailable ({error.__class__.__name__})")
            break
    for number, position in enumerate(positions):
        simbad, simbad_sep = nearest(simbad_rows, position["ra"], position["dec"], radius_arcsec)
        gaia, gaia_sep = nearest(gaia_rows, position["ra"], position["dec"], radius_arcsec)
        sdss = None
        if number < sdss_limit and not any("SDSS" in e for e in errors):
            try:
                sdss = _retry(query_sdss, position["ra"], position["dec"], radius_arcsec / 60)
            except Exception as error:
                errors.append(f"SDSS DR18 unavailable ({error.__class__.__name__})")
        entry = {"simbad": {**simbad, "separationArcsec": simbad_sep} if simbad else None,
                 "gaia": {**gaia, "separationArcsec": gaia_sep} if gaia else None, "sdss": sdss}
        entry["hasSpectroscopy"] = bool((simbad and simbad.get("spType")) or sdss or (gaia and (gaia.get("teff") or gaia.get("rv") is not None)))
        entry["sources"] = [name for name, present in (("SIMBAD", simbad and simbad.get("spType")), ("Gaia XP", gaia and gaia.get("teff")),
                                                       ("Gaia RVS", gaia and gaia.get("rv") is not None), ("SDSS", sdss)) if present]
        entry["summary"] = describe_known(entry)
        known[position["id"]] = entry
    return known, errors


def build_comparison(stars: list[dict[str, Any]], known: dict[int, dict[str, Any]], radius_arcsec: float, errors: list[str]) -> dict[str, Any]:
    """Our type, temperature, luminosity class and velocity against every earlier profile of each star."""
    from datetime import datetime, timezone
    rows = []
    for star in stars:
        entry = known.get(star["id"])
        if entry is None or star["status"] == "discarded":
            continue
        simbad, gaia, sdss = entry.get("simbad"), entry.get("gaia"), entry.get("sdss")
        classification = star.get("classification") or {}
        ours = {"type": classification.get("type"), "range": classification.get("range"), "teff": classification.get("teff"),
                "teffLow": classification.get("teffLow"), "teffHigh": classification.get("teffHigh"),
                "luminosity": our_luminosity(classification.get("luminosityClass")), "rv": (star.get("velocity") or {}).get("value"),
                "rvError": (star.get("velocity") or {}).get("error")}
        checks: list[dict[str, Any]] = []
        mine = mk_class_index(classification.get("mk") or ours["type"] or "")
        for source, reference_type in (("SIMBAD", simbad and simbad.get("spType")), ("SDSS", sdss and sdss.get("class") == "STAR" and sdss.get("subclass"))):
            theirs = mk_class_index(reference_type or "")
            if mine is not None and theirs is not None:
                difference = mine - theirs
                checks.append({"quantity": "Spectral type", "source": source, "ours": ours["type"], "reference": reference_type,
                               "difference": f"{difference:+.1f} subclasses", "agreement": "agrees" if abs(difference) <= 3 else "close" if abs(difference) <= 7 else "differs",
                               "deltaSubclass": round(difference, 1)})
        for source, teff, teff_error in (("Gaia DR3 GSP-Phot", gaia and gaia.get("teff"), None), ("SDSS SSPP", sdss and sdss.get("teff"), sdss and sdss.get("teffError"))):
            if ours["teff"] and teff:
                inside = ours["teffLow"] - 150 <= teff <= ours["teffHigh"] + 150
                half_range = max((ours["teffHigh"] - ours["teffLow"]) / 2, 150)
                sigma = abs(ours["teff"] - teff) / math.hypot(half_range, teff_error or 0.04 * teff)
                checks.append({"quantity": "Teff (K)", "source": source, "ours": f"{ours['teff']} ({ours['teffLow']}–{ours['teffHigh']})",
                               "reference": f"{teff:.0f}" + (f" ± {teff_error:.0f}" if teff_error else ""),
                               "difference": f"{ours['teff'] - teff:+.0f} K", "agreement": "agrees" if inside or sigma <= 1 else "close" if sigma <= 2.5 else "differs",
                               "deltaTeff": round(ours["teff"] - teff, 0), "referenceTeff": float(teff)})
        for source, logg in (("Gaia DR3 GSP-Phot", gaia and gaia.get("logg")), ("SDSS SSPP", sdss and sdss.get("logg"))):
            reference = luminosity_from_logg(logg)
            if ours["luminosity"] and reference:
                same = ours["luminosity"] == reference
                near = {ours["luminosity"], reference} <= {"dwarf (V)", "subgiant (IV)"} or {ours["luminosity"], reference} <= {"subgiant (IV)", "giant (III)"}
                checks.append({"quantity": "Luminosity class", "source": source, "ours": ours["luminosity"], "reference": f"{reference} (log g {logg:.2f})",
                               "difference": "", "agreement": "agrees" if same else "close" if near else "differs"})
        rv_references = [("SIMBAD", simbad and simbad.get("rv"), simbad and simbad.get("rvError")), ("Gaia DR3 RVS", gaia and gaia.get("rv"), gaia and gaia.get("rvError")),
                         ("SDSS", sdss and sdss.get("z") is not None and sdss.get("class") == "STAR" and sdss["z"] * C_KMS, sdss and sdss.get("zError") and sdss["zError"] * C_KMS)]
        for source, rv, rv_error in rv_references:
            if ours["rv"] is not None and isinstance(rv, (int, float)) and not isinstance(rv, bool):
                sigma = abs(ours["rv"] - rv) / math.hypot(ours["rvError"] or 10, rv_error or 2)
                checks.append({"quantity": "Radial velocity (km/s)", "source": source, "ours": f"{ours['rv']:.1f} ± {ours['rvError']:.1f}",
                               "reference": f"{rv:.1f}" + (f" ± {rv_error:.1f}" if rv_error else ""),
                               "difference": f"{ours['rv'] - rv:+.1f} km/s ({sigma:.1f}σ)", "agreement": "agrees" if sigma <= 2 else "close" if sigma <= 3 else "differs",
                               "deltaRv": round(ours["rv"] - rv, 1)})
        rows.append({"id": star["id"], "x": star.get("x"), "y": star.get("y"), "ra": star.get("ra"), "dec": star.get("dec"), "ours": ours,
                     "confidence": star.get("confidence"), "known": entry, "checks": checks, "previousProfile": entry["hasSpectroscopy"],
                     "verdict": ("no earlier spectroscopy (new)" if not entry["hasSpectroscopy"] else "no comparable quantities" if not checks
                                 else "agrees" if all(c["agreement"] == "agrees" for c in checks)
                                 else "differs" if any(c["agreement"] == "differs" for c in checks) else "close")})
    statistics: dict[str, Any] = {"stars": len(rows), "withEarlierProfile": sum(1 for r in rows if r["previousProfile"]),
                                  "withoutEarlierProfile": sum(1 for r in rows if not r["previousProfile"])}
    all_checks = [c for r in rows for c in r["checks"]]
    for quantity, field in (("Spectral type", "deltaSubclass"), ("Teff (K)", "deltaTeff"), ("Radial velocity (km/s)", "deltaRv")):
        values = [c[field] for c in all_checks if c["quantity"] == quantity and field in c]
        if values:
            statistics[quantity] = {"comparisons": len(values), "median": round(float(np.median(values)), 1),
                                    "medianAbsolute": round(float(np.median(np.abs(values))), 1),
                                    "agreeing": sum(1 for c in all_checks if c["quantity"] == quantity and c["agreement"] == "agrees")}
    luminosity = [c for c in all_checks if c["quantity"] == "Luminosity class"]
    if luminosity:
        statistics["Luminosity class"] = {"comparisons": len(luminosity), "agreeing": sum(1 for c in luminosity if c["agreement"] == "agrees")}
    return {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), "matchRadiusArcsec": radius_arcsec,
            "stars": rows, "statistics": statistics, "errors": errors, "sources": CATALOGUE_SOURCES}


CATALOGUE_SOURCES = [
    "SIMBAD (CDS): published spectral types and radial velocities",
    "Gaia DR3: GSP-Phot Teff, log g, [M/H] from BP/RP (XP) spectra and RVS radial velocities (VizieR I/355/gaiadr3)",
    "SDSS DR18: spectroscopic class/subclass, redshift and SSPP Teff, log g, [Fe/H] (SkyServer)",
]


def write_comparison_csv(work: Path, comparison: dict[str, Any]) -> None:
    with open(work / "comparison.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Star", "RA (deg)", "Dec (deg)", "Earlier spectroscopy", "Quantity", "AstroviaBin", "Reference", "Source", "Difference", "Agreement", "Verdict"])
        for row in comparison["stars"]:
            if not row["checks"]:
                writer.writerow([row["id"], row["ra"], row["dec"], row["known"]["summary"], "", row["ours"]["type"] or "", "", "", "", "", row["verdict"]])
            for check in row["checks"]:
                writer.writerow([row["id"], row["ra"], row["dec"], row["known"]["summary"], check["quantity"], check["ours"], check["reference"], check["source"],
                                 check["difference"], check["agreement"], row["verdict"]])


def attach_catalogues(result: dict[str, Any], work: Path, previous: dict[str, Any] | None) -> None:
    """Earlier spectroscopy of every analysed star (from the pre-check the user ran before the analysis,
    looking up only stars it did not cover) and the comparison with our results (in place)."""
    positioned = [{"id": s["id"], "ra": s["ra"], "dec": s["dec"]} for s in result["stars"] if s.get("ra") is not None and s.get("dec") is not None]
    if not positioned:
        result["notes"].append("Catalogue comparison skipped: no sky coordinates (plate-solve the image first)")
        return
    radius = 3.0 if result["mode"] == "spectrum1d" else 5.0
    known: dict[int, dict[str, Any]] = {}
    missing = []
    checked = [s for s in (previous or {}).get("stars", []) if s.get("ra") is not None and s.get("known")]
    for position in positioned:
        match, _ = nearest(checked, position["ra"], position["dec"], 2.0)
        if match:
            known[position["id"]] = match["known"]
        else:
            missing.append(position)
    errors = list((previous or {}).get("errors", []))
    if missing:
        extra, extra_errors = lookup_known(missing, radius)
        known.update(extra)
        errors += [e for e in extra_errors if e not in errors]
    for star in result["stars"]:
        entry = known.get(star["id"])
        if entry is not None:
            star["known"] = entry
            star["catalogue"] = entry["summary"] if not star.get("catalogue") else f"{star['catalogue']}; {entry['summary']}"
    result["comparison"] = build_comparison(result["stars"], known, radius, errors)
    (work / "comparison.json").write_text(json.dumps(result["comparison"], default=lambda v: v.item() if hasattr(v, "item") else str(v)))
    write_comparison_csv(work, result["comparison"])


def comparison_pages(pdf: Any, comparison: dict[str, Any]) -> None:
    """The comparison chapter of the report: statistics, plots and one block per star."""
    import matplotlib.pyplot as plt
    colours = {"agrees": "#16a34a", "close": "#d97706", "differs": "#dc2626"}
    figure = plt.figure(figsize=(8.27, 11.69))
    figure.text(0.07, 0.95, "Comparison with earlier spectroscopy", fontsize=15, weight="bold")
    statistics = comparison["statistics"]
    lines = [f"Generated: {comparison['generatedAt']}; match radius {comparison['matchRadiusArcsec']}″",
             f"Stars compared: {statistics['stars']} — with an earlier spectroscopic profile: {statistics['withEarlierProfile']}, "
             f"without any (new): {statistics['withoutEarlierProfile']}", ""]
    for name in ("Spectral type", "Teff (K)", "Luminosity class", "Radial velocity (km/s)"):
        stat = statistics.get(name)
        if stat:
            text = f"{name}: {stat['agreeing']}/{stat['comparisons']} agree"
            if "medianAbsolute" in stat:
                unit = {"Spectral type": "subclasses", "Teff (K)": "K", "Radial velocity (km/s)": "km/s"}[name]
                text += f"; median Δ {stat['median']:+g} {unit} (median |Δ| {stat['medianAbsolute']:g} {unit})"
            lines.append(text)
    new = [str(r["id"]) for r in comparison["stars"] if not r["previousProfile"]]
    if new:
        lines += ["", "Stars with no earlier spectroscopy in these catalogues: " + ", ".join(new)]
    lines += ["", "Sources:"] + [f"• {source}" for source in comparison["sources"]] + [f"• Note: {error}" for error in comparison["errors"]]
    lines += ["", "Agreement: type within 3 subclasses, Teff inside our range or within 1σ, RV within 2σ; 'close' within",
              "7 subclasses / 2.5σ / 3σ. Gaia GSP-Phot temperatures come from low-resolution XP spectra and have their own errors."]
    y = 0.91
    for text in lines:
        figure.text(0.07, y, text, fontsize=8.8)
        y -= 0.02
    teff_points = [(c["referenceTeff"], r["ours"]["teff"], c["agreement"]) for r in comparison["stars"] for c in r["checks"] if "deltaTeff" in c]
    type_points = [c["deltaSubclass"] for r in comparison["stars"] for c in r["checks"] if "deltaSubclass" in c]
    if teff_points or type_points:
        height = min(0.3, max(0.15, y - 0.12))
        if teff_points:
            axis = figure.add_axes([0.1, 0.08, 0.38, height])
            axis.scatter([p[0] for p in teff_points], [p[1] for p in teff_points], s=16, c=[colours[p[2]] for p in teff_points])
            values = [p[0] for p in teff_points] + [p[1] for p in teff_points]
            limits = [min(values) * 0.9, max(values) * 1.1]
            axis.plot(limits, limits, color="#64748b", lw=0.8)
            axis.set_xlabel("Catalogue Teff (K)", fontsize=8)
            axis.set_ylabel("AstroviaBin Teff (K)", fontsize=8)
            axis.set_title("Temperature", fontsize=9)
            axis.tick_params(labelsize=7)
        if type_points:
            axis = figure.add_axes([0.58, 0.08, 0.36, height])
            axis.hist(type_points, bins=np.arange(-20.5, 21, 1), color="#a855f7")
            axis.set_xlabel("Δ type (subclasses, ours − catalogue)", fontsize=8)
            axis.set_title("Spectral type", fontsize=9)
            axis.tick_params(labelsize=7)
    pdf.savefig(figure)
    plt.close(figure)
    flat = []
    for row in comparison["stars"]:
        position = f"RA {row['ra']:.5f}  Dec {row['dec']:+.5f}" if row.get("ra") is not None else ""
        if row.get("x") is not None:
            position += f"  (x {row['x']:.1f}, y {row['y']:.1f})"
        flat.append(("header", f"Star {row['id']} — {row['verdict']}   {position}", row["known"]["summary"]))
        for check in row["checks"]:
            flat.append(("check", check))
    for start in range(0, len(flat), 30):
        figure = plt.figure(figsize=(8.27, 11.69))
        figure.text(0.05, 0.965, "Per-star comparison", fontsize=12, weight="bold")
        y = 0.94
        for item in flat[start:start + 30]:
            if item[0] == "header":
                figure.text(0.05, y, item[1], fontsize=8.3, weight="bold")
                y -= 0.015
                figure.text(0.07, y, item[2][:150], fontsize=7, color="#475569")
                y -= 0.016
            else:
                check = item[1]
                figure.text(0.07, y, f"{check['quantity']} — {check['source']}: ours {check['ours']}  vs  {check['reference']}  {check['difference']}"[:140], fontsize=7.3)
                figure.text(0.9, y, check["agreement"], fontsize=7.3, color=colours[check["agreement"]], weight="bold")
                y -= 0.015
            if y < 0.04:
                break
        pdf.savefig(figure)
        plt.close(figure)


def known_before(config: dict[str, Any]) -> dict[str, Any]:
    """Pre-check, before any spectral analysis: the stars in the frame (or the 1-D target) and which of
    them already have spectroscopy in SIMBAD, Gaia DR3 or SDSS."""
    from datetime import datetime, timezone
    path = config["input"]
    settings = config.get("settings") or {}
    positions: list[dict[str, Any]] = []
    mode = "spectrum1d"
    notes: list[str] = []
    spectrum = read_spectrum1d(path) if settings.get("mode", "auto") in ("auto", "spectrum1d") else None
    if spectrum is not None:
        ra = finite(spectrum.meta.get("SDSS_PLUG_RA")) or finite(spectrum.meta.get("PLUG_RA")) or finite(spectrum.meta.get("RA"))
        dec = finite(spectrum.meta.get("SDSS_PLUG_DEC")) or finite(spectrum.meta.get("PLUG_DEC")) or finite(spectrum.meta.get("DEC"))
        if ra is not None and dec is not None:
            positions.append({"id": 1, "x": None, "y": None, "ra": ra, "dec": dec})
    else:
        mode = "slitless"
        image, header, _ = load_frame(path, {**settings, "cosmicRays": False}, {})
        data, sources, _, _ = detect_zero_orders(image, settings)
        wcs = build_wcs(header, config.get("wcs"))
        if wcs is None:
            fail("The frame has no plate solution: plate-solve it first to look the stars up in the catalogues")
        order = sorted(range(len(sources)), key=lambda i: -float(sources["flux"][i]))[: int(finite(settings.get("maxStars"), 60))]
        for rank, index in enumerate(order):
            x, y = float(sources["xcentroid"][index]), float(sources["ycentroid"][index])
            ra, dec = world(wcs, x, y)
            positions.append({"id": rank + 1, "x": round(x, 3), "y": round(y, 3), "ra": ra, "dec": dec})
        notes.append("Star numbers follow brightness, as in the analysis that uses the same settings")
    if not positions:
        fail("No sky position: the spectrum has no RA/DEC")
    known, errors = lookup_known([p for p in positions if p["ra"] is not None], 3.0 if mode == "spectrum1d" else 5.0)
    stars = [{**p, "known": known.get(p["id"])} for p in positions]
    return {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"), "mode": mode, "stars": stars, "errors": errors, "notes": notes,
            "sources": CATALOGUE_SOURCES,
            "summary": {"stars": len(stars), "known": sum(1 for s in stars if s["known"] and s["known"]["hasSpectroscopy"]),
                        "unknown": sum(1 for s in stars if not (s["known"] and s["known"]["hasSpectroscopy"]))}}


# ------------------------------------------------------------------------------------------------
# Entry points

def progress(work: Path, stage: str, fraction: float) -> None:
    try:
        (work / "progress.json").write_text(json.dumps({"stage": stage, "fraction": round(fraction, 3)}))
    except OSError:
        pass


def star_result(star_id: int, analysis: dict[str, Any] | None, status: str, calibration_status: str, flags: list[str], extra: dict[str, Any]) -> dict[str, Any]:
    result = {"id": star_id, "status": status, "flags": flags, **extra}
    if analysis is None:
        result.update({"lines": [], "elements": [], "classification": None, "confidence": "Insufficient"})
        return result
    confidence, reasons = confidence_of(analysis, calibration_status, flags)
    result.update({"snr": analysis["snr"], "lines": analysis["lines"], "elements": analysis["elements"],
                   "unidentified": analysis.get("unidentified", []),
                   "classification": analysis["classification"], "velocity": analysis["velocity"],
                   "colourTemperature": analysis["colourTemperature"], "confidence": confidence,
                   "reasons": result.get("reasons", []) + reasons, "measurements": analysis["measurements"]})
    return result


def finish(result: dict[str, Any], work: Path, config: dict[str, Any], spectra: list[dict[str, Any]], frame: np.ndarray | None) -> dict[str, Any]:
    """Catalogue comparison (only after a pre-check), CSV/FITS/PDF outputs and result.json."""
    # The comparison with earlier spectroscopy only runs when the user checked the catalogues first.
    if config.get("known") is not None:
        progress(work, "Comparing with earlier spectroscopy (SIMBAD, Gaia DR3, SDSS)", 0.8)
        attach_catalogues(result, work, config["known"])
    progress(work, "Writing CSV, FITS and the PDF report", 0.85)
    write_outputs(work, result, spectra)
    write_report(work, result, spectra, frame)
    analysed = [s for s in result["stars"] if s["status"] == "analysed"]
    result["summary"] = {"detected": len(result["stars"]), "analysed": len(analysed),
                         "classified": sum(1 for s in analysed if (s.get("classification") or {}).get("type"))}
    (work / "result.json").write_text(json.dumps(result, default=lambda value: value.item() if hasattr(value, "item") else str(value)))
    progress(work, "Done", 1.0)
    return result


def analyse(config: dict[str, Any]) -> dict[str, Any]:
    from datetime import datetime, timezone
    path = config["input"]
    work = Path(config["work"])
    work.mkdir(parents=True, exist_ok=True)
    settings = config.get("settings") or {}
    mode = settings.get("mode", "auto")
    progress(work, "Reading the FITS", 0.05)
    spectrum = read_spectrum1d(path) if mode in ("auto", "spectrum1d") else None
    result: dict[str, Any] = {"generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
                              "input": {"name": config.get("name") or Path(path).name}, "notes": [], "stars": []}
    spectra: list[dict[str, Any]] = []
    frame = None
    if spectrum is not None:
        result["mode"] = "spectrum1d"
        result["calibration"] = {"status": "file", "dispersion": None, "error": None, "method": "Wavelengths from the FITS file"}
        result["fluxCalibrated"] = spectrum.flux_calibrated
        result["resolutionA"] = round(spectrum.resolution, 2)
        progress(work, "Measuring lines (specutils)", 0.4)
        stellar_target = str(spectrum.meta.get("SDSS_CLASS", "STAR")).strip().upper() == "STAR"
        analysis = analyse_spectrum(spectrum, wavelength_calibrated=stellar_target)
        if not stellar_target:
            result["notes"].append(f"SDSS classifies this object as {spectrum.meta['SDSS_CLASS']}; stellar templates and line identifications were not applied")
        ra = finite(spectrum.meta.get("SDSS_PLUG_RA")) or finite(spectrum.meta.get("PLUG_RA")) or finite(spectrum.meta.get("RA"))
        dec = finite(spectrum.meta.get("SDSS_PLUG_DEC")) or finite(spectrum.meta.get("PLUG_DEC")) or finite(spectrum.meta.get("DEC"))
        extra: dict[str, Any] = {"x": None, "y": None, "ra": ra, "dec": dec, "reasons": []}
        if spectrum.meta.get("SDSS_CLASS"):
            extra["catalogue"] = f"SDSS pipeline: {spectrum.meta.get('SDSS_CLASS')} {spectrum.meta.get('SDSS_SUBCLASS') or ''}, z = {spectrum.meta.get('SDSS_Z')}".strip()
        if not stellar_target:
            extra["reasons"].append("The supplied SDSS metadata identifies a non-stellar object")
        star = star_result(1, analysis, "analysed", "file", [], extra)
        if not stellar_target:
            star["confidence"] = "Insufficient"
        star["spectrum"] = spectrum_payload(spectrum.wave, spectrum.flux, analysis)
        result["stars"].append(star)
        spectra.append({"star": star, "wave": spectrum.wave, "pixel": None, "flux": spectrum.flux, "error": spectrum.error,
                        "continuum": analysis["continuum"], "normalized": analysis["normalized"], "model": analysis["model"]})
    else:
        result["mode"] = "slitless"
        result["fluxCalibrated"] = False
        image, header, notes = load_frame(path, settings, settings.get("calibration") or {})
        result["notes"] += notes
        progress(work, "Detecting stars (photutils)", 0.25)
        data, sources, sigma, fwhm = detect_zero_orders(image, settings)
        wanted = settings.get("mode", "auto")
        if wanted == "trace" or (wanted == "auto" and not field_signature(data, sources, fwhm)["slitless"]):
            return finish_strip(result, work, config, image, header, data, sigma, notes)
        if sources is None or len(sources) == 0:
            fail("No stars were detected in the frame")
        progress(work, "Finding the dispersion direction", 0.4)
        angle, start, end = dispersion_direction(data, sources, sigma, settings)
        result["geometry"] = {"angleDeg": round(math.degrees(angle) % 360, 3), "start": start, "end": end, "fwhm": fwhm}
        saturation = finite(header.get("SATURATE")) or (float(np.nanmax(image)) if np.nanmax(image) > 0 else None)
        progress(work, "Extracting the spectra", 0.55)
        stars = extract_traces(data, sources, sigma, fwhm, angle, start, end, settings, saturation, image)
        calibration = calibrate_dispersion(stars, settings, header, fwhm)
        result["calibration"] = calibration
        wcs = build_wcs(header, config.get("wcs"))
        resolution_px = max(fwhm, 2.0)
        progress(work, "Measuring lines (specutils)", 0.7)
        min_snr = float(finite(settings.get("minTraceSnr"), 5.0))
        for star in stars:
            star_id = star["rank"] + 1
            ra, dec = world(wcs, star["x"], star["y"])
            extra = {"x": round(star["x"], 3), "y": round(star["y"], 3), "ra": ra, "dec": dec,
                     "trace": {key: round(value, 2) for key, value in star["trace"].items()},
                     "contaminants": [s["rank"] + 1 for s in stars if s["index"] in star["contaminants"]],
                     "zeroOrderFlux": round(star["flux0"], 1), "reasons": []}
            flags = list(star["flags"])
            if star["inFrame"] < 0.3:
                extra["reasons"].append(f"First order falls outside the frame ({star['inFrame'] * 100:.0f}% inside)")
                result["stars"].append(star_result(star_id, None, "discarded", calibration["status"], flags, extra))
                continue
            if star["traceSnr"] < min_snr:
                extra["reasons"].append(f"Spectrum too faint (trace S/N {star['traceSnr']:.1f} < {min_snr:g})")
                result["stars"].append(star_result(star_id, None, "discarded", calibration["status"], flags, extra))
                continue
            if "overlap" in flags:
                extra["reasons"].append(f"Spectrum overlaps star(s) {', '.join(map(str, extra['contaminants']))}; classification and line identifications withheld")
                record = star_result(star_id, None, "contaminated", calibration["status"], flags, extra)
                record["confidence"] = "Insufficient"
                record["spectrum"] = dict(zip(("pixel", "flux"), downsample(star["pixel"], star["flux"])))
                result["stars"].append(record)
                spectra.append({"star": record, "wave": None, "pixel": star["pixel"], "flux": star["flux"], "error": star["error"], "normalized": None, "continuum": None})
                continue
            if calibration["status"] == "none":
                record = star_result(star_id, None, "analysed", "none", flags, extra)
                record["confidence"] = "Insufficient"
                record["reasons"] = extra["reasons"] + ["No wavelength calibration: give the dispersion to identify lines"]
                record["spectrum"] = dict(zip(("pixel", "flux"), downsample(star["pixel"], star["flux"])))
                result["stars"].append(record)
                spectra.append({"star": record, "wave": None, "pixel": star["pixel"], "flux": star["flux"], "error": star["error"], "normalized": None, "continuum": None})
                continue
            dispersion_a = calibration["dispersion"] * 10  # A per pixel
            wave = star["pixel"] * dispersion_a
            keep = (wave > 3600) & (wave < 9500)
            if keep.sum() < 20:
                extra["reasons"].append("Calibrated spectrum outside 360–950 nm")
                result["stars"].append(star_result(star_id, None, "discarded", calibration["status"], flags, extra))
                continue
            spectrum_star = Spectrum1D(wave[keep], star["flux"][keep], star["error"][keep], False,
                                       resolution_px * dispersion_a, f"star {star_id}", {})
            analysis = analyse_spectrum(spectrum_star)
            record = star_result(star_id, analysis, "analysed", calibration["status"], flags, extra)
            record["spectrum"] = spectrum_payload(spectrum_star.wave, spectrum_star.flux, analysis)
            result["stars"].append(record)
            spectra.append({"star": record, "wave": spectrum_star.wave, "pixel": star["pixel"][keep], "flux": spectrum_star.flux,
                            "error": spectrum_star.error, "continuum": analysis["continuum"], "normalized": analysis["normalized"], "model": analysis["model"]})
        frame = data
        result["image"] = {"width": int(image.shape[1]), "height": int(image.shape[0]), "wcs": wcs is not None}
        if wcs is None:
            result["notes"].append("No plate solution: star coordinates are given in pixels only (plate-solve the frame for RA/Dec)")
    return finish(result, work, config, spectra, frame)


SPECTROSCOPY_WORDS = ("SA100", "SA-100", "SA200", "SA-200", "STAR ANALYSER", "STAR ANALYZER", "STARANALYSER", "GRATING",
                      "GRISM", "SLITLESS", "SPECTRO", "SPECTRUM", "SPECTRA", "RAINBOW OPTICS", "TRANSMISSION GRATING")


def streak_votes(background: np.ndarray, sources: Any, fwhm: float, limit: int = 15) -> tuple[list[tuple[float, float]], int]:
    """(angle, strength) of the one-sided streak of each bright point-like source (first order beside a
    zero order). Diffraction spikes are symmetric and trails are not anchored to a point, so they do not vote."""
    reach = min(400.0, max(background.shape) * 0.3)
    brightest = sorted(range(len(sources)), key=lambda i: -float(sources["flux"][i]))[:limit]
    angles = np.deg2rad(np.arange(0, 360, 2.0))  # 2-degree steps with a 9-px strip miss no streak
    votes = []
    for index in brightest:
        x0, y0 = float(sources["xcentroid"][index]), float(sources["ycentroid"][index])
        totals = np.array([np.nansum(np.clip(ray_profile(background, x0, y0, angle, 6 * fwhm, reach, 4)[1], 0, None)) for angle in angles])
        best = int(np.argmax(totals))
        opposite = totals[(best + len(angles) // 2) % len(angles)]
        typical = float(np.median(totals))
        if totals[best] > 4 * max(typical, 1e-9) and totals[best] > 3 * max(opposite, 1e-9):
            votes.append((float(np.degrees(angles[best])), float(totals[best] / max(typical, 1e-9))))
    return votes, len(brightest)


def field_signature(background: np.ndarray, sources: Any, fwhm: float) -> dict[str, Any]:
    """Zero orders with first orders at one common angle (a full slitless field)."""
    if sources is None or len(sources) == 0:
        return {"slitless": False, "reason": "no point-like stars (zero orders)"}
    votes, tested = streak_votes(background, sources, fwhm)
    if not votes:
        return {"slitless": False, "reason": "no star has a one-sided first order"}
    radians = np.deg2rad([v[0] for v in votes])
    mean = math.degrees(math.atan2(np.mean(np.sin(radians)), np.mean(np.cos(radians)))) % 360
    agreeing = [v for v in votes if abs(((v[0] - mean + 180) % 360) - 180) <= 10]
    # Several stars sharing the angle, or a single target star with a strong, clearly one-sided first order.
    is_field = (len(agreeing) >= 3 and len(agreeing) / tested >= 0.5) or (tested <= 2 and agreeing and max(v[1] for v in agreeing) > 8)
    return {"slitless": is_field, "angleDeg": round(mean, 1), "stars": len(agreeing), "tested": tested,
            "reason": f"{len(agreeing)} of {tested} bright stars show a first-order spectrum at {mean:.0f}°" if is_field
            else f"only {len(agreeing)} of {tested} stars share a one-sided streak"}


def strip_signature(background: np.ndarray, sigma: float) -> dict[str, Any]:
    """A dispersed spectrum crossing much of the frame without its zero order (cropped strips, 2-D spectra),
    traced and extracted with specreduce."""
    for transposed in (False, True):
        frame = background.T if transposed else background
        for guess in trace_guesses(frame, sigma, 3):
            strip = specreduce_extract(frame, guess, 4.0, sigma, {})
            if strip and (strip["end"] - strip["start"]) >= 0.4 * frame.shape[1] and strip["snr"] > 20:
                return {"slitless": True, "variant": "strip", "transposed": transposed,
                        "reason": f"a dispersed spectrum spans {strip['end'] - strip['start']} px without a zero order"}
    return {"slitless": False}


def slitless_signature(image: np.ndarray) -> dict[str, Any]:
    """Does the frame look like a slitless spectrum (field of zero orders with first orders, or a strip)?"""
    from scipy.ndimage import zoom
    data = np.nan_to_num(image.astype(float))
    factor = max(1, int(math.ceil(max(data.shape) / 1500)))
    if factor > 1:
        data = zoom(data, 1 / factor, order=1)
    background, sources, sigma, fwhm = detect_zero_orders(data, {"detectionSigma": 8.0, "fwhm": 3.0})
    field = field_signature(background, sources, fwhm)
    if field["slitless"]:
        return field
    strip = strip_signature(background, sigma)
    return strip if strip["slitless"] else field


def finish_strip(result: dict[str, Any], work: Path, config: dict[str, Any], image: np.ndarray, header: fits.Header,
                 data: np.ndarray, sigma: float, notes: list[str]) -> dict[str, Any]:
    """Trace with Specreduce; analyse wavelengths only when FITS carries a spectral WCS."""
    import astropy.units as u
    from astropy.wcs import WCS
    settings = config.get("settings") or {}
    result["mode"] = "trace"
    fwhm = float(finite(settings.get("fwhm"), 4.0))
    limit = int(finite(settings.get("maxStars"), 60))
    candidates = []
    for transposed in (False, True):
        frame = data.T if transposed else data
        strips = []
        for guess in trace_guesses(frame, sigma, limit):
            strip = specreduce_extract(frame, guess, fwhm, sigma, settings)
            # Two guesses can converge on the same spectrum.
            if strip and all(abs(np.median(strip["y"]) - np.median(other["y"])) > 2 * fwhm for other in strips):
                strips.append(strip)
        candidates.append((max((st["end"] - st["start"] for st in strips), default=0), transposed, strips))
    _, transposed, strips = max(candidates, key=lambda item: item[0])
    if not strips:
        fail("No dispersed spectrum was found in the frame")
    progress(work, "Reading FITS spectral WCS", 0.55)
    spectral_wcs = None
    try:
        complete_wcs = WCS(header)
        if complete_wcs.has_spectral and complete_wcs.wcs.spec == (1 if transposed else 0):
            spectral_wcs = complete_wcs.spectral
    except Exception:
        pass
    calibration = {"status": "file" if spectral_wcs is not None else "none", "dispersion": None, "error": None,
                   "method": "Wavelength solution from the FITS spectral WCS" if spectral_wcs is not None
                   else "No spectral WCS or arc-lamp calibration; extracted flux is shown against pixels only"}
    result["calibration"] = calibration
    result["geometry"] = {"angleDeg": 90.0 if transposed else 0.0, "start": float(min(st["start"] for st in strips)),
                          "end": float(max(st["end"] for st in strips)), "fwhm": fwhm, "transposed": transposed}
    wcs = build_wcs(header, config.get("wcs"))
    spectra: list[dict[str, Any]] = []
    progress(work, "Measuring calibrated lines and fitting standards", 0.7)
    min_snr = float(finite(settings.get("minTraceSnr"), 5.0))
    for number, strip in enumerate(sorted(strips, key=lambda st: -st["snr"])):
        middle = len(strip["x"]) // 2
        sx, sy = float(strip["x"][middle]), float(strip["y"][middle])
        x, y = (sy, sx) if transposed else (sx, sy)
        ends = [(float(strip["x"][0]), float(strip["y"][0])), (float(strip["x"][-1]), float(strip["y"][-1]))]
        if transposed:
            ends = [(b_, a_) for a_, b_ in ends]
        ra, dec = world(wcs, x, y)
        extra = {"x": round(x, 2), "y": round(y, 2), "ra": ra, "dec": dec,
                 "trace": {"x0": round(ends[0][0], 2), "y0": round(ends[0][1], 2), "x1": round(ends[1][0], 2), "y1": round(ends[1][1], 2), "halfWidth": round(strip["halfWidth"], 2)},
                 "reasons": ["Position is the middle of the spectrum (the zero order is outside the frame)"]}
        if strip["snr"] < min_snr:
            extra["reasons"].append(f"Spectrum too faint (S/N {strip['snr']:.1f} < {min_snr:g})")
            result["stars"].append(star_result(number + 1, None, "discarded", calibration["status"], [], extra))
            continue
        wave = None
        if spectral_wcs is not None:
            try:
                axis_unit = u.Unit(spectral_wcs.wcs.cunit[0])
                world_values = spectral_wcs.pixel_to_world_values(strip["x"])
                wave = np.asarray((world_values * axis_unit).to_value(u.AA, equivalencies=u.spectral()), dtype=float)
            except Exception:
                extra["reasons"].append("Could not convert the FITS spectral WCS to wavelengths")
        if wave is None:
            record = star_result(number + 1, None, "analysed", "none", [], extra)
            record["reasons"] = extra["reasons"] + [calibration["method"]]
            record["spectrum"] = dict(zip(("pixel", "flux"), downsample(strip["x"], strip["flux"])))
            result["stars"].append(record)
            spectra.append({"star": record, "wave": None, "pixel": strip["x"], "flux": strip["flux"], "error": strip["error"], "normalized": None, "continuum": None})
            continue
        keep = (wave > 3600) & (wave < 9500) & np.isfinite(strip["flux"])
        if keep.sum() < 20:
            extra["reasons"].append("Calibrated wavelength coverage is outside 360–950 nm")
            result["stars"].append(star_result(number + 1, None, "discarded", calibration["status"], [], extra))
            continue
        order = np.argsort(wave[keep])
        spectral_step = float(np.nanmedian(np.abs(np.diff(wave[keep]))))
        spectrum = Spectrum1D(wave[keep][order], strip["flux"][keep][order], strip["error"][keep][order], False, max(fwhm, 2.0) * spectral_step,
                              f"star {number + 1}", {})
        analysis = analyse_spectrum(spectrum)
        record = star_result(number + 1, analysis, "analysed", calibration["status"], [], extra)
        record["spectrum"] = spectrum_payload(spectrum.wave, spectrum.flux, analysis)
        result["stars"].append(record)
        spectra.append({"star": record, "wave": spectrum.wave, "pixel": strip["x"][keep][order], "flux": spectrum.flux, "error": spectrum.error,
                        "continuum": analysis["continuum"], "normalized": analysis["normalized"], "model": analysis["model"]})
    result["image"] = {"width": int(image.shape[1]), "height": int(image.shape[0]), "wcs": wcs is not None}
    result["notes"] += notes + ["Spectrum strip (no zero order in the frame): traced and extracted with Specreduce; wavelength analysis requires a spectral WCS in the FITS"]
    if wcs is None:
        result["notes"].append("No plate solution: positions are given in pixels only")
    return finish(result, work, config, spectra, data)


def detect(path: str, image_test: bool = True) -> dict[str, Any]:
    """1-D spectrum, slitless spectroscopic image, or ordinary image (used when FITS are uploaded)."""
    spectrum = read_spectrum1d(path)
    if spectrum is not None:
        return {"kind": "spectrum1d", "points": int(len(spectrum.wave)), "waveMin": float(spectrum.wave[0]), "waveMax": float(spectrum.wave[-1])}
    with fits.open(path, memmap=False) as hdus:
        hdu = next((h for h in hdus if h.is_image and h.data is not None and h.data.ndim in (2, 3)), None)
        if hdu is None:
            return {"kind": "unknown"}
        header = hdus[0].header.copy()
        header.update(hdu.header)
        words = " ".join(str(header.get(key, "")) for key in ("FILTER", "INSTRUME", "IMAGETYP", "FRAMETYP", "OBJECT", "GRATING", "DISPERSR", "OBSTYPE")).upper()
        hint = next((word for word in SPECTROSCOPY_WORDS if word in words), None)
        if hint:
            return {"kind": "slitless", "reason": f"header mentions {hint.title()}"}
        if not image_test:
            return {"kind": "image2d"}
        data = np.asarray(hdu.data, dtype=float)
    if data.ndim == 3:
        data = np.nansum(data, axis=0) if data.shape[0] <= 4 else data[0]
    try:
        signature = slitless_signature(data)
    except Exception as error:
        return {"kind": "image2d", "reason": f"image test unavailable ({error.__class__.__name__})"}
    return {"kind": "slitless" if signature["slitless"] else "image2d", **{k: v for k, v in signature.items() if k != "slitless"}}


def to_image(source: str, destination: str) -> dict[str, Any]:
    """A 1-D spectrum as a 1 x N primary image (flux) for the gallery, plus the full SPECTRUM table."""
    spectrum = read_spectrum1d(source)
    if spectrum is None:
        fail("The FITS file contains no image and no 1-D spectrum")
    header = fits.Header()
    with fits.open(source, memmap=False) as hdus:
        for key, value in hdus[0].header.items():
            if key in ("OBJECT", "RA", "DEC", "OBJCTRA", "OBJCTDEC", "PLUG_RA", "PLUG_DEC", "RA_OBJ", "DEC_OBJ", "TARG_RA", "TARG_DEC", "DATE-OBS", "MJD", "TELESCOP", "INSTRUME", "OBSERVER", "EXPTIME", "PLATEID", "FIBERID"):
                header[key] = value
    meta = spectrum.meta
    if finite(meta.get("SDSS_PLUG_RA")) is not None:
        # SDSS RA/DEC keywords are the plate centre; the object is at the fibre position.
        header["RA"] = (finite(meta.get("SDSS_PLUG_RA")), "deg, object (fibre) position")
        header["DEC"] = (finite(meta.get("SDSS_PLUG_DEC")), "deg, object (fibre) position")
        if all(key in header for key in ("PLATEID", "MJD", "FIBERID")):
            header["OBJECT"] = f"SDSS {header['PLATEID']}-{header['MJD']}-{header['FIBERID']}"
    if meta.get("SDSS_CLASS"):
        header["SPCLASS"] = (str(meta.get("SDSS_CLASS")), "class from the SDSS pipeline")
        header["SPSUBCL"] = (str(meta.get("SDSS_SUBCLASS") or "")[:60], "subclass from the SDSS pipeline")
    header["ASTVSPEC"] = (True, "AstroviaBin: 1-D spectrum (row 1 = flux)")
    header["WAVEMIN"] = (float(spectrum.wave[0]), "Angstrom (air)")
    header["WAVEMAX"] = (float(spectrum.wave[-1]), "Angstrom (air)")
    log_steps = np.diff(np.log(spectrum.wave))
    linear_steps = np.diff(spectrum.wave)
    is_log = np.std(log_steps) / np.mean(log_steps) < np.std(linear_steps) / np.mean(linear_steps)
    header["SPECGRID"] = ("log" if is_log else "linear", "spacing of the flux samples")
    header["HISTORY"] = f"AstroviaBin: 1-D spectrum from {Path(source).name} (the original is kept beside it)"
    primary = fits.PrimaryHDU(np.asarray(spectrum.flux, dtype=np.float32)[None, :], header=header)
    columns = [fits.Column(name="WAVELENGTH", format="E", unit="Angstrom", array=spectrum.wave),
               fits.Column(name="FLUX", format="E", array=spectrum.flux),
               fits.Column(name="ERROR", format="E", array=np.where(np.isfinite(spectrum.error), spectrum.error, np.nan))]
    table = fits.BinTableHDU.from_columns(columns, name="SPECTRUM")
    table.header["VACUUM"] = (False, "wavelengths are in air")
    table.header["FLUXCAL"] = (bool(spectrum.flux_calibrated), "flux-calibrated spectrum")
    table.header["RESOL"] = (float(spectrum.resolution), "FWHM resolution (Angstrom)")
    fits.HDUList([primary, table]).writeto(destination, overwrite=True)
    return {"spectrum": True, "points": int(len(spectrum.wave)), "waveMin": float(spectrum.wave[0]), "waveMax": float(spectrum.wave[-1])}


def main(argv: list[str]) -> int:
    try:
        if len(argv) >= 3 and argv[1] == "analyse":
            config = json.loads(Path(argv[2]).read_text())
            result = analyse(config)
            print(json.dumps({"ok": True, "summary": result.get("summary")}))
        elif len(argv) >= 3 and argv[1] == "known":
            config = json.loads(Path(argv[2]).read_text())
            known = known_before(config)
            Path(config["output"]).write_text(json.dumps(known, default=lambda v: v.item() if hasattr(v, "item") else str(v)))
            print(json.dumps({"ok": True, "summary": known["summary"]}))
        elif len(argv) >= 3 and argv[1] == "detect":
            print(json.dumps(detect(argv[2], "--no-image-test" not in argv)))
        elif len(argv) >= 4 and argv[1] == "to-image":
            print(json.dumps(to_image(argv[2], argv[3])))
        else:
            print(__doc__)
            return 2
        return 0
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
