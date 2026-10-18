#!/usr/bin/env python3
"""Robust star extraction for local plate solving.

solve-field's built-in extractor works well on clean frames, but noisy 8-bit
colour exports (Slooh, phone and live-stack PNG/JPGs) either yield a handful of
detections or thousands of noise peaks. This helper smooths with a Gaussian
matched to a stellar profile, estimates the background and noise robustly,
keeps significant local maxima, and writes an astrometry.net xylist (FITS
binary table with X, Y, FLUX, 1-based FITS pixel convention, brightest first).

Usage:
  star_extract.py fits <input.fits> <output.xyls> [max_sources]
  star_extract.py raw <input.u16> <width> <height> <output.xyls> [max_sources]

Prints a JSON summary: {"sources": n, "width": w, "height": h}.
"""
import json
import sys

import numpy as np
from astropy.io import fits
from scipy import ndimage


def load_fits(path):
    # Scaled integer data (BZERO/BSCALE, e.g. unsigned 16-bit) cannot be memory-mapped.
    with fits.open(path, memmap=False) as hdus:
        for hdu in hdus:
            if hdu.data is not None and getattr(hdu.data, 'ndim', 0) >= 2:
                data = np.asarray(hdu.data, dtype=np.float32)
                break
        else:
            raise SystemExit('No image data in FITS file')
    if data.ndim == 3:
        data = np.nansum(data, axis=0)
    return data


def load_raw(path, width, height):
    data = np.fromfile(path, dtype='<u2')
    if data.size != width * height:
        raise SystemExit(f'Raw buffer has {data.size} values, expected {width * height}')
    return data.reshape(height, width).astype(np.float32)


def robust_sigma(values):
    median = np.median(values)
    mad = np.median(np.abs(values - median))
    return median, 1.4826 * mad


def extract(data, max_sources):
    data = np.where(np.isfinite(data), data, np.nanmedian(data)).astype(np.float32)
    height, width = data.shape
    # Very large frames: detect on a 2x binned copy, then refine on full resolution.
    scale = 2 if max(width, height) > 6000 else 1
    work = data[:height - height % scale, :width - width % scale]
    if scale > 1:
        work = work.reshape(work.shape[0] // scale, scale, work.shape[1] // scale, scale).mean(axis=(1, 3))

    background = ndimage.median_filter(work[::4, ::4], size=31, mode='nearest')
    background = ndimage.zoom(background, (work.shape[0] / background.shape[0], work.shape[1] / background.shape[1]), order=1)
    background = background[:work.shape[0], :work.shape[1]]
    residual = work - background

    candidates = []
    for sigma_px in (1.5, 2.5):
        smooth = ndimage.gaussian_filter(residual, sigma_px)
        _, noise = robust_sigma(smooth[::3, ::3])
        if not np.isfinite(noise) or noise <= 0:
            continue
        peaks = (smooth == ndimage.maximum_filter(smooth, size=int(6 * sigma_px) | 1)) & (smooth > 5 * noise)
        # Ignore a border band where profiles are truncated.
        border = int(4 * sigma_px) + 2
        peaks[:border, :] = False
        peaks[-border:, :] = False
        peaks[:, :border] = False
        peaks[:, -border:] = False
        ys, xs = np.nonzero(peaks)
        candidates.append((smooth, ys, xs, noise))
    if not candidates:
        return np.empty((0, 3))

    # Prefer the scale that yields a plausible star count (not noise-dominated).
    smooth, ys, xs, noise = min(candidates, key=lambda c: abs(np.log10(max(len(c[1]), 1)) - np.log10(80)))
    if len(ys) == 0:
        return np.empty((0, 3))
    order = np.argsort(smooth[ys, xs])[::-1][: max_sources * 3]
    ys, xs = ys[order], xs[order]

    rows = []
    radius = 3
    for y, x in zip(ys, xs):
        y0, y1 = max(0, y - radius), min(residual.shape[0], y + radius + 1)
        x0, x1 = max(0, x - radius), min(residual.shape[1], x + radius + 1)
        stamp = np.clip(residual[y0:y1, x0:x1], 0, None)
        total = float(stamp.sum())
        if total <= 0:
            continue
        gy, gx = np.mgrid[y0:y1, x0:x1]
        cy = float((gy * stamp).sum() / total)
        cx = float((gx * stamp).sum() / total)
        # Reject single hot pixels: a real star spreads flux over neighbours.
        peak = float(stamp.max())
        if peak > 0.6 * total:
            continue
        # Back to full-resolution, 0-based pixel centres, then FITS 1-based.
        fx = (cx + 0.5) * scale - 0.5 + 1.0
        fy = (cy + 0.5) * scale - 0.5 + 1.0
        rows.append((fx, fy, total))
        if len(rows) >= max_sources:
            break
    return np.array(rows, dtype=np.float64).reshape(-1, 3)


def write_xyls(path, rows, width, height):
    columns = fits.ColDefs([
        fits.Column(name='X', format='D', array=rows[:, 0]),
        fits.Column(name='Y', format='D', array=rows[:, 1]),
        fits.Column(name='FLUX', format='D', array=rows[:, 2]),
    ])
    table = fits.BinTableHDU.from_columns(columns)
    primary = fits.PrimaryHDU()
    primary.header['IMAGEW'] = width
    primary.header['IMAGEH'] = height
    fits.HDUList([primary, table]).writeto(path, overwrite=True)


def main(argv):
    if len(argv) >= 3 and argv[1] == 'fits':
        data = load_fits(argv[2])
        output = argv[3]
        max_sources = int(argv[4]) if len(argv) > 4 else 300
    elif len(argv) >= 6 and argv[1] == 'raw':
        data = load_raw(argv[2], int(argv[3]), int(argv[4]))
        output = argv[5]
        max_sources = int(argv[6]) if len(argv) > 6 else 300
    else:
        raise SystemExit(__doc__)
    rows = extract(data, max_sources)
    height, width = data.shape
    write_xyls(output, rows, width, height)
    print(json.dumps({'sources': int(len(rows)), 'width': int(width), 'height': int(height)}))


if __name__ == '__main__':
    main(sys.argv)
