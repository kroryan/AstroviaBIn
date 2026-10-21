#!/usr/bin/env python3
"""WCS for a frame too sparse to plate-solve, from a solved frame of the same pointing.

Slooh (and most observatories) take the filters of one target back to back without moving the
telescope, so a short blue frame shows the same field as a solved V or R frame taken seconds before.
The two images are aligned with astroalign (Beroiz, Cabral & Sanchez 2020, Astronomy and Computing
32, 100384), which matches triangles of stars, and the target's WCS is fitted with
astropy.wcs.utils.fit_wcs_from_points to the matched stars projected through the solved frame's WCS.

The result is accepted only when the alignment is physically the same pointing: enough matched stars,
sub-pixel fit residuals, scale within 1 % and rotation within 1 degree. Otherwise the script fails and
the normal plate-solving attempts continue.

usage: wcs_transfer.py <target.fits> <reference.fits> <reference-wcs.json> <output.wcs>
prints a JSON summary; exit status 0 on success.
"""

import json
import math
import sys
import warnings

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import fit_wcs_from_points

warnings.simplefilter("ignore")

MIN_STARS = 15
MAX_RMS_PX = 1.0
MAX_SCALE_CHANGE = 0.01
MAX_ROTATION_DEG = 1.0


def image_data(path: str) -> np.ndarray:
    with fits.open(path, memmap=False) as hdus:
        hdu = next((h for h in hdus if h.is_image and h.data is not None and h.data.ndim >= 2), None)
        if hdu is None:
            raise ValueError(f"{path} has no image")
        data = np.asarray(hdu.data, dtype=float)
    if data.ndim == 3:
        data = data.sum(axis=0) if data.shape[0] <= 4 else data[0]
    return np.nan_to_num(data)


def reference_wcs(stored: dict) -> WCS:
    """The solution as AstroviaBin stores it (TAN with optional SIP), as an astropy WCS."""
    header = fits.Header()
    sip = stored.get("sip")
    header["CTYPE1"], header["CTYPE2"] = ("RA---TAN-SIP", "DEC--TAN-SIP") if sip else ("RA---TAN", "DEC--TAN")
    header["CRVAL1"], header["CRVAL2"] = stored["crval1"], stored["crval2"]
    header["CRPIX1"], header["CRPIX2"] = stored["crpix1"], stored["crpix2"]
    header["CD1_1"], header["CD1_2"] = stored["cd11"], stored["cd12"]
    header["CD2_1"], header["CD2_2"] = stored["cd21"], stored["cd22"]
    for key, name in (("a", "A"), ("b", "B"), ("ap", "AP"), ("bp", "BP")):
        part = (sip or {}).get(key)
        if not part:
            continue
        header[f"{name}_ORDER"] = part["order"]
        for term, value in part["terms"].items():
            header[f"{name}_{term}"] = value
    return WCS(header)


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    target_path, reference_path, wcs_json, output = sys.argv[1:]
    import astroalign

    target = image_data(target_path)
    reference = image_data(reference_path)
    if target.shape != reference.shape:
        print(json.dumps({"ok": False, "reason": f"different sizes {target.shape} and {reference.shape}"}))
        return 1
    try:
        transform, (source_points, reference_points) = astroalign.find_transform(
            target, reference, max_control_points=80, detection_sigma=4)
    except Exception as error:  # astroalign raises when it finds no consistent asterism
        print(json.dumps({"ok": False, "reason": f"astroalign: {error}"}))
        return 1

    rotation = abs(math.degrees(transform.rotation))
    rotation = min(rotation, 360 - rotation)
    summary = {"stars": int(len(source_points)), "shiftPx": [round(float(v), 2) for v in transform.translation],
               "rotationDeg": round(rotation, 4), "scale": round(float(transform.scale), 6)}
    if len(source_points) < MIN_STARS or abs(transform.scale - 1) > MAX_SCALE_CHANGE or rotation > MAX_ROTATION_DEG:
        print(json.dumps({"ok": False, "reason": "not the same pointing", **summary}))
        return 1

    with open(wcs_json, encoding="utf-8") as handle:
        solved = reference_wcs(json.load(handle))
    sky = solved.pixel_to_world(reference_points[:, 0], reference_points[:, 1])
    fitted = fit_wcs_from_points((source_points[:, 0], source_points[:, 1]), sky, projection="TAN")
    back_x, back_y = fitted.world_to_pixel(sky)
    rms = float(np.sqrt(np.mean((back_x - source_points[:, 0]) ** 2 + (back_y - source_points[:, 1]) ** 2)))
    summary["rmsPx"] = round(rms, 3)
    if not math.isfinite(rms) or rms > MAX_RMS_PX:
        print(json.dumps({"ok": False, "reason": "fit residuals too large", **summary}))
        return 1

    # Written like an Astrometry.net solution (CD matrix, FITS pixel convention).
    cd = fitted.pixel_scale_matrix
    header = fits.Header()
    header["WCSAXES"] = 2
    header["CTYPE1"], header["CTYPE2"] = "RA---TAN", "DEC--TAN"
    header["CRVAL1"], header["CRVAL2"] = float(fitted.wcs.crval[0]), float(fitted.wcs.crval[1])
    header["CRPIX1"], header["CRPIX2"] = float(fitted.wcs.crpix[0]), float(fitted.wcs.crpix[1])
    header["CD1_1"], header["CD1_2"] = float(cd[0, 0]), float(cd[0, 1])
    header["CD2_1"], header["CD2_2"] = float(cd[1, 0]), float(cd[1, 1])
    header["IMAGEW"], header["IMAGEH"] = target.shape[1], target.shape[0]
    header["COMMENT"] = "WCS transferred from a solved frame of the same pointing (astroalign + astropy)"
    fits.PrimaryHDU(header=header).writeto(output, overwrite=True)
    print(json.dumps({"ok": True, **summary}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
