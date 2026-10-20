#!/usr/bin/env python3
"""Astropy/CCDProc reduction, registration, and stacking for AstroviaBin.

Node supplies validated paths and options. Originals are opened read-only and
all numerical CCD work is delegated to Astropy and CCDProc.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import traceback
from pathlib import Path
from typing import Any

import astropy.units as u
import ccdproc
import numpy as np
from astropy.io import fits
from astropy.modeling import models
from astropy.nddata import CCDData, StdDevUncertainty
from astropy.stats import mad_std
from astropy.wcs import WCS


def fail(message: str) -> None:
    raise ValueError(message)


def finite_number(value: Any, default: float | None = None) -> float | None:
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return default


def unit_from_header(header: fits.Header) -> u.UnitBase:
    raw = str(header.get("BUNIT", "adu")).strip() or "adu"
    try:
        return u.Unit(raw)
    except (ValueError, TypeError):
        return u.adu


def wcs_from_stored(value: Any) -> WCS | None:
    if not isinstance(value, dict):
        return None
    required = ("crval1", "crval2", "crpix1", "crpix2", "cd11", "cd12", "cd21", "cd22")
    if any(finite_number(value.get(key)) is None for key in required):
        return None
    header = fits.Header()
    sip = value.get("sip") if isinstance(value.get("sip"), dict) else None
    header["CTYPE1"] = "RA---TAN-SIP" if sip else "RA---TAN"
    header["CTYPE2"] = "DEC--TAN-SIP" if sip else "DEC--TAN"
    header["CUNIT1"] = "deg"
    header["CUNIT2"] = "deg"
    for key in ("crval1", "crval2", "crpix1", "crpix2"):
        header[key.upper()] = float(value[key])
    header["CD1_1"], header["CD1_2"] = float(value["cd11"]), float(value["cd12"])
    header["CD2_1"], header["CD2_2"] = float(value["cd21"]), float(value["cd22"])
    if sip:
        for name in ("a", "b", "ap", "bp"):
            polynomial = sip.get(name)
            if not isinstance(polynomial, dict):
                continue
            prefix = name.upper()
            header[f"{prefix}_ORDER"] = int(polynomial.get("order", 0))
            terms = polynomial.get("terms", {})
            if isinstance(terms, dict):
                for powers, coefficient in terms.items():
                    if finite_number(coefficient) is not None and isinstance(powers, str):
                        header[f"{prefix}_{powers}"] = float(coefficient)
    return WCS(header)


def read_ccd(file_path: str, stored_wcs: Any = None, forced_unit: u.UnitBase | None = None) -> CCDData:
    # memmap=False: integer frames scaled by BZERO/BSCALE (e.g. unsigned 16-bit cameras, BZERO=32768)
    # cannot be memory-mapped by Astropy, and the data is converted to float64 in memory anyway.
    with fits.open(file_path, mode="readonly", memmap=False, do_not_scale_image_data=False) as hdul:
        if hdul[0].data is None:
            fail(f"{Path(file_path).name}: primary FITS HDU contains no image")
        data = np.asarray(hdul[0].data, dtype=np.float64)
        header = hdul[0].header.copy()
        # The values are already scaled; these keywords must not follow them into float outputs.
        for keyword in ("BZERO", "BSCALE", "BLANK"):
            header.remove(keyword, ignore_missing=True, remove_all=True)
        mask = np.asarray(hdul["MASK"].data, dtype=bool) if "MASK" in hdul else None
        uncertainty = StdDevUncertainty(np.asarray(hdul["UNCERT"].data, dtype=np.float64)) if "UNCERT" in hdul else None
    if data.ndim not in (2, 3):
        fail(f"{Path(file_path).name}: expected a 2-D mono or 3-D colour FITS, got {data.ndim}-D")
    image_wcs = None
    try:
        candidate = WCS(header)
        if candidate.has_celestial:
            image_wcs = candidate.celestial
    except Exception:
        pass
    image_wcs = image_wcs or wcs_from_stored(stored_wcs)
    return CCDData(data, unit=forced_unit or unit_from_header(header), meta=header, wcs=image_wcs,
                   mask=mask, uncertainty=uncertainty)


def exposure(ccd: CCDData, key: str) -> float | None:
    return finite_number(ccd.meta.get(key))


def image_hash(ccd: CCDData) -> str:
    return hashlib.sha256(np.ascontiguousarray(ccd.data).view(np.uint8)).hexdigest()


def project_auxiliary(data: np.ndarray, source_wcs: WCS, target_wcs: WCS,
                      shape: tuple[int, int], order: str) -> np.ndarray:
    auxiliary = CCDData(np.asarray(data, dtype=np.float64), unit=u.dimensionless_unscaled, wcs=source_wcs)
    return np.asarray(ccdproc.wcs_project(auxiliary, target_wcs, target_shape=shape, order=order).data)


def project_ccd(ccd: CCDData, target_wcs: WCS, shape: tuple[int, int], order: str) -> CCDData:
    if ccd.data.ndim != 2:
        fail("WCS alignment is available for 2-D CCD frames; disable it for already registered colour FITS")
    if ccd.wcs is None or not ccd.wcs.has_celestial:
        fail("frame has no celestial WCS; plate-solve it first or disable alignment")
    source_wcs = ccd.wcs.celestial
    projected = ccdproc.wcs_project(ccd, target_wcs, target_shape=shape, order=order)
    invalid = ~np.isfinite(projected.data)
    if ccd.mask is not None:
        projected_mask = project_auxiliary(np.asarray(ccd.mask, dtype=float), source_wcs, target_wcs,
                                           shape, "nearest-neighbor")
        invalid |= ~np.isfinite(projected_mask) | (projected_mask >= 0.5)
    projected.mask = invalid
    if ccd.uncertainty is not None:
        variance = np.square(np.asarray(ccd.uncertainty.array, dtype=np.float64))
        projected_variance = project_auxiliary(variance, source_wcs, target_wcs, shape, order)
        projected.uncertainty = StdDevUncertainty(np.sqrt(np.clip(projected_variance, 0, None)))
    return projected


def read_master(path_value: Any, unit: u.UnitBase) -> CCDData | None:
    return read_ccd(str(path_value), forced_unit=unit) if isinstance(path_value, str) and path_value else None


def calibrate(ccd: CCDData, settings: dict[str, Any], calibration: dict[str, Any]) -> CCDData:
    gain_value = finite_number(settings.get("gain"))
    read_noise_value = finite_number(settings.get("readNoise"))
    bias = read_master(calibration.get("biasPath"), ccd.unit)
    dark = read_master(calibration.get("darkPath"), ccd.unit)
    flat = read_master(calibration.get("flatPath"), ccd.unit)
    bad_mask_ccd = read_master(calibration.get("badPixelMaskPath"), u.dimensionless_unscaled)
    bad_mask = np.asarray(bad_mask_ccd.data != 0, dtype=bool) if bad_mask_ccd is not None else None
    ratio_ccd = read_master(calibration.get("ccdMaskRatioPath"), u.dimensionless_unscaled)
    if ratio_ccd is not None:
        if ratio_ccd.data.ndim != 2:
            fail("CCDProc ccdmask requires a 2-D flat-ratio FITS")
        generated_mask = ccdproc.ccdmask(
            ratio_ccd,
            findbadcolumns=bool(settings.get("ccdMaskFindBadColumns")),
            byblocks=bool(settings.get("ccdMaskByBlocks")),
            ncmed=int(finite_number(settings.get("ccdMaskColumnMedian"), 7)),
            nlmed=int(finite_number(settings.get("ccdMaskLineMedian"), 7)),
            ncsig=int(finite_number(settings.get("ccdMaskColumnSigmaBox"), 15)),
            nlsig=int(finite_number(settings.get("ccdMaskLineSigmaBox"), 15)),
            lsigma=float(finite_number(settings.get("ccdMaskLowSigma"), 9.0)),
            hsigma=float(finite_number(settings.get("ccdMaskHighSigma"), 9.0)),
            ngood=int(finite_number(settings.get("ccdMaskGoodPixelGap"), 5)),
        )
        bad_mask = generated_mask if bad_mask is None else np.logical_or(bad_mask, generated_mask)
    overscan_degree = finite_number(settings.get("overscanPolynomialDegree"))
    kwargs: dict[str, Any] = {
        "oscan": settings.get("overscan") or None,
        "oscan_median": settings.get("overscanMedian", True) is not False,
        "oscan_model": models.Polynomial1D(int(overscan_degree)) if overscan_degree is not None else None,
        "trim": settings.get("trim") or None,
        "master_bias": bias,
        "dark_frame": dark,
        "master_flat": flat,
        "bad_pixel_mask": bad_mask,
        "min_value": finite_number(settings.get("flatMinimum")),
        "dark_scale": bool(settings.get("darkScale", True) and dark is not None),
        "gain_corrected": bool(settings.get("calibrationMastersGainCorrected", False)),
    }
    exposure_key = str(settings.get("exposureKeyword") or "EXPTIME").strip().upper()
    if kwargs["dark_scale"]:
        kwargs["exposure_key"] = exposure_key
        kwargs["exposure_unit"] = u.second
    if gain_value is not None:
        kwargs["gain"] = gain_value * u.electron / u.adu
    if gain_value is not None and read_noise_value is not None:
        kwargs["readnoise"] = read_noise_value * u.electron
        kwargs["error"] = True
    reduced = ccdproc.ccd_process(ccd, **kwargs)
    cosmic_method = str(settings.get("cosmicMethod") or "none")
    if cosmic_method != "none":
        if reduced.data.ndim != 2:
            fail("CCDProc cosmic-ray cleaning is only valid for 2-D CCD frames")
        if cosmic_method == "median":
            error_image: float | np.ndarray
            if reduced.uncertainty is not None:
                error_image = np.asarray(reduced.uncertainty.array, dtype=np.float64)
            else:
                # CCDProc's CCDData branch expects an explicit error image. Use a robust
                # per-frame noise estimate when gain/read-noise were not supplied.
                deviation = float(mad_std(np.asarray(reduced.data), ignore_nan=True))
                if not math.isfinite(deviation) or deviation <= 0:
                    # A mostly flat frame with one cosmic hit has MAD=0; its ordinary
                    # standard deviation is then dominated by the hit. Use the Poisson
                    # scale of the background instead of hiding the outlier in its noise.
                    background = abs(float(np.nanmedian(reduced.data)))
                    deviation = max(math.sqrt(background), np.finfo(float).eps)
                error_image = np.full(reduced.data.shape, deviation, dtype=np.float64)
            reduced = ccdproc.cosmicray_median(
                reduced,
                error_image=error_image,
                thresh=float(finite_number(settings.get("medianCosmicThreshold"), 5.0)),
                mbox=int(finite_number(settings.get("medianCosmicBox"), 11)),
                gbox=int(finite_number(settings.get("medianCosmicGrowBox"), 0)),
                rbox=int(finite_number(settings.get("medianCosmicReplaceBox"), 11)),
            )
        else:
            reduced = ccdproc.cosmicray_lacosmic(
                reduced,
                sigclip=float(finite_number(settings.get("cosmicSigma"), 4.5)),
                sigfrac=float(finite_number(settings.get("cosmicFraction"), 0.3)),
                objlim=float(finite_number(settings.get("cosmicObjectLimit"), 5.0)),
                gain=1.0 if gain_value is not None else float(gain_value or 1.0),
                readnoise=float(read_noise_value or 6.5),
                satlevel=float(finite_number(settings.get("saturationLevel"), 65535.0)),
                niter=int(finite_number(settings.get("cosmicIterations"), 4)),
                cleantype=str(settings.get("cosmicCleanType") or "meanmask"),
                sepmed=settings.get("cosmicSeparateMedian", True) is not False,
                fsmode=str(settings.get("cosmicFineStructureMode") or "median"),
                psfmodel=str(settings.get("cosmicPsfModel") or "gauss"),
                psffwhm=float(finite_number(settings.get("cosmicPsfFwhm"), 2.5)),
                psfsize=int(finite_number(settings.get("cosmicPsfSize"), 7)),
                psfbeta=float(finite_number(settings.get("cosmicPsfBeta"), 4.765)),
                gain_apply=False,
            )
    return reduced


def valid_pixels(ccd: CCDData) -> np.ndarray:
    data = np.asarray(ccd.data)
    return data[~np.asarray(ccd.mask, dtype=bool)] if ccd.mask is not None else data.ravel()


def scalar_scale(ccd: CCDData, reference: CCDData, mode: str, exposure_key: str) -> float:
    if mode == "none":
        return 1.0
    if mode == "exposure":
        source_exposure, reference_exposure = exposure(ccd, exposure_key), exposure(reference, exposure_key)
        if not source_exposure or not reference_exposure:
            fail(f"Exposure normalization requires a positive {exposure_key} in every frame")
        return reference_exposure / source_exposure
    source_median, reference_median = float(np.nanmedian(valid_pixels(ccd))), float(np.nanmedian(valid_pixels(reference)))
    if not math.isfinite(source_median) or abs(source_median) < np.finfo(float).eps:
        fail("Median normalization cannot scale a frame with a zero or non-finite median")
    return reference_median / source_median


def scalar_weight(ccd: CCDData, mode: str, exposure_key: str) -> float:
    if mode == "none":
        return 1.0
    if mode == "exposure":
        value = exposure(ccd, exposure_key)
        if not value or value <= 0:
            fail(f"Exposure weighting requires a positive {exposure_key} in every frame")
        return value
    deviation = float(mad_std(valid_pixels(ccd), ignore_nan=True))
    if not math.isfinite(deviation) or deviation <= 0:
        fail("Inverse-variance weighting requires measurable noise in every frame")
    return 1.0 / (deviation * deviation)


def report_offset(source: CCDData, target_wcs: WCS, shape: tuple[int, int]) -> tuple[float, float]:
    if source.wcs is None or not source.wcs.has_celestial:
        return (0.0, 0.0)
    y, x = (source.data.shape[-2] - 1) / 2, (source.data.shape[-1] - 1) / 2
    world = source.wcs.celestial.pixel_to_world(x, y)
    target_x, target_y = target_wcs.world_to_pixel(world)
    return (round(float(target_x - (shape[1] - 1) / 2), 2),
            round(float(target_y - (shape[0] - 1) / 2), 2))


def write_result(output_path: str, combined: CCDData, reference: CCDData,
                 frame_count: int, settings: dict[str, Any]) -> None:
    header = reference.meta.copy()
    header["NCOMBINE"] = frame_count
    header["CCDPROC"] = (ccdproc.__version__, "CCDProc version used by AstroviaBin")
    header.add_history(f"AstroviaBin CCDProc stack: {frame_count} frames; method={settings.get('method', 'sigma-clip')}")
    header.add_history("Reduction, WCS projection and combination performed by Astropy/CCDProc")
    if combined.wcs is not None:
        header.update(combined.wcs.to_header(relax=True))
    hdus: list[Any] = [fits.PrimaryHDU(np.asarray(combined.data, dtype=np.float32), header=header)]
    if combined.mask is not None:
        hdus.append(fits.ImageHDU(np.asarray(combined.mask, dtype=np.uint8), name="MASK"))
    if combined.uncertainty is not None:
        hdus.append(fits.ImageHDU(np.asarray(combined.uncertainty.array, dtype=np.float32), name="UNCERT"))
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    temporary = f"{output_path}.partial"
    fits.HDUList(hdus).writeto(temporary, overwrite=True, checksum=True)
    os.replace(temporary, output_path)


def run(request: dict[str, Any]) -> dict[str, Any]:
    paths, output_path = request.get("filePaths"), request.get("outputPath")
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    if not isinstance(paths, list) or len(paths) < 2 or not all(isinstance(item, str) for item in paths):
        fail("Stacking requires at least two FITS frames")
    if not isinstance(output_path, str) or not output_path:
        fail("Missing stack output path")
    names = settings.get("frameNames") if isinstance(settings.get("frameNames"), list) else []
    stored_wcs = settings.get("frameWcs") if isinstance(settings.get("frameWcs"), list) else []
    frames = [read_ccd(file_path, stored_wcs[index] if index < len(stored_wcs) else None)
              for index, file_path in enumerate(paths)]
    reference_unit = frames[0].unit
    for index, frame in enumerate(frames):
        if frame.unit != reference_unit:
            fail(f"{Path(paths[index]).name}: BUNIT {frame.unit} does not match {reference_unit}")
    filters = [str(frame.meta.get("FILTER", "")).strip().lower() for frame in frames]
    if any(filters) and any(not value or value != filters[0] for value in filters):
        fail("All frames must have the same FILTER to stack scientifically")

    reports: list[dict[str, Any]] = []
    unique: list[tuple[int, CCDData]] = []
    seen: dict[str, int] = {}
    for index, frame in enumerate(frames):
        name = str(names[index]) if index < len(names) and names[index] else Path(paths[index]).name
        digest = image_hash(frame)
        if digest in seen:
            reason = f"identical pixels to frame {seen[digest] + 1}: duplicate skipped"
            reports.append({"name": name, "used": False, "method": "none", "reason": reason})
        else:
            seen[digest] = index
            unique.append((index, frame))
            reports.append({"name": name, "used": False})
    if len(unique) < 2:
        fail("Stacking needs at least two different frames: the selection only contains duplicates")

    calibration = settings.get("calibration") if isinstance(settings.get("calibration"), dict) else {}
    reduced: list[tuple[int, CCDData]] = []
    for index, frame in unique:
        try:
            reduced.append((index, calibrate(frame, settings, calibration)))
        except Exception as error:
            reports[index].update({"used": False, "method": "none", "reason": f"calibration failed: {error}"})
    if len(reduced) < 2:
        reasons = " · ".join(str(report.get("reason")) for report in reports if report.get("reason"))
        fail(f"Fewer than two frames passed CCD calibration. {reasons}")

    register = settings.get("register", True) is not False
    interpolation = str(settings.get("interpolation") or "bilinear")
    if interpolation not in {"nearest-neighbor", "bilinear", "biquadratic", "bicubic"}:
        interpolation = "bilinear"
    reference = reduced[0][1]
    target_shape = tuple(int(value) for value in reference.data.shape[-2:])
    target_wcs = reference.wcs.celestial if reference.wcs is not None and reference.wcs.has_celestial else None
    aligned: list[tuple[int, CCDData]] = []
    offsets: list[dict[str, float]] = []
    warnings: list[str] = []
    for index, frame in reduced:
        try:
            if register:
                if target_wcs is None:
                    fail("reference frame has no celestial WCS; plate-solve it first or disable alignment")
                dx, dy = report_offset(frame, target_wcs, target_shape)
                output = frame if index == reduced[0][0] and tuple(frame.data.shape[-2:]) == target_shape else project_ccd(frame, target_wcs, target_shape, interpolation)
                method = "reference" if index == reduced[0][0] else f"CCDProc WCS/{interpolation}"
            else:
                if frame.data.shape != reference.data.shape:
                    fail("all frames must have identical dimensions when alignment is disabled")
                output, dx, dy, method = frame, 0.0, 0.0, "none"
            output.data = np.asarray(output.data, dtype=np.float64)
            aligned.append((index, output))
            offsets.append({"dx": dx, "dy": dy})
            reports[index].update({"used": True, "method": method, "dx": dx, "dy": dy})
        except Exception as error:
            reason = str(error)
            reports[index].update({"used": False, "method": "none", "reason": reason})
            warnings.append(f"{reports[index]['name']}: excluded, {reason}")
    if len(aligned) < 2:
        fail("Fewer than two frames could be aligned. " + " · ".join(warnings))

    exposure_key = str(settings.get("exposureKeyword") or "EXPTIME").strip().upper()
    normalization = str(settings.get("normalization") or "exposure")
    if normalization not in {"none", "exposure", "median"}:
        normalization = "exposure"
    weighting = str(settings.get("weighting") or "none")
    if weighting not in {"none", "exposure", "inverse-variance"}:
        weighting = "none"
    aligned_ccds = [item[1] for item in aligned]
    scales = np.asarray([scalar_scale(frame, aligned_ccds[0], normalization, exposure_key)
                         for frame in aligned_ccds], dtype=float)
    weights = (np.asarray([scalar_weight(frame, weighting, exposure_key) for frame in aligned_ccds], dtype=float)
               if weighting != "none" else None)
    method = str(settings.get("method") or "sigma-clip")
    options: dict[str, Any] = {
        "method": "median" if method == "median" else "sum" if method == "sum" else "average",
        "scale": scales,
        "weights": weights if method != "median" else None,
        "mem_limit": int(finite_number(settings.get("memoryLimitMb"), 512) * 1024 * 1024),
        "dtype": np.float64,
    }
    if method == "sigma-clip":
        threshold = finite_number(settings.get("sigmaClipThreshold"), 3.0)
        options.update({
            "sigma_clip": True,
            "sigma_clip_low_thresh": float(finite_number(settings.get("sigmaClipLow"), threshold)),
            "sigma_clip_high_thresh": float(finite_number(settings.get("sigmaClipHigh"), threshold)),
            "sigma_clip_func": np.ma.median,
            "sigma_clip_dev_func": mad_std,
        })
    if settings.get("clipExtrema"):
        options.update({"clip_extrema": True, "nlow": int(finite_number(settings.get("clipLowCount"), 1)),
                        "nhigh": int(finite_number(settings.get("clipHighCount"), 1))})
    min_clip, max_clip = finite_number(settings.get("minimumClip")), finite_number(settings.get("maximumClip"))
    if min_clip is not None or max_clip is not None:
        options.update({"minmax_clip": True, "minmax_clip_min": min_clip, "minmax_clip_max": max_clip})
    combined = ccdproc.combine(aligned_ccds, **options)
    combined.meta = reference.meta.copy()
    combined.wcs = target_wcs if register else reference.wcs
    write_result(output_path, combined, reference, len(aligned_ccds), settings)
    return {"frameCount": len(aligned_ccds), "offsets": offsets, "frames": reports, "warnings": warnings,
            "engine": {"name": "Astropy/CCDProc", "ccdproc": ccdproc.__version__}}


def main() -> int:
    try:
        print(json.dumps({"ok": True, "result": run(json.load(sys.stdin))}, separators=(",", ":")))
        return 0
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
