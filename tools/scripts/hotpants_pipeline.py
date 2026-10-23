#!/usr/bin/env python3
"""Private FITS preparation, WCS alignment and candidate extraction around upstream HOTPANTS.

Only the reference survey is fetched. The science FITS never leaves this machine.
The HOTPANTS executable is used unchanged for subtraction.
"""

import json
import math
import os
import subprocess
import sys
import urllib.parse
import urllib.request
import warnings
import csv
from io import StringIO
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, Sip
from photutils.detection import DAOStarFinder
from scipy.ndimage import binary_dilation, find_objects, label, map_coordinates, maximum_filter
from scipy.optimize import least_squares


def write_state(work, stage, **extra):
    target = work / 'progress.json'
    temp = work / 'progress.tmp'
    temp.write_text(json.dumps({'stage': stage, **extra}))
    temp.replace(target)


def mono_data(source):
    with fits.open(source, memmap=False, do_not_scale_image_data=False) as hdus:
        hdu = next((h for h in hdus if h.data is not None and h.data.ndim >= 2), None)
        if hdu is None:
            raise ValueError('The FITS has no image data')
        data = hdu.data
        if data.ndim == 3:
            if data.shape[0] in (3, 4):
                data = np.mean(data[:3].astype(np.float32), axis=0)
            else:
                raise ValueError('Only 2D or three-channel FITS images can be compared')
        if data.ndim != 2:
            raise ValueError('Only 2D or three-channel FITS images can be compared')
        return np.asarray(data, dtype=np.float32), hdu.header.copy()


def binned_wcs(source_wcs, factor):
    """WCS of a factor x factor block-integrated image.

    Each output pixel covers source pixels [j*f, j*f + f - 1] (0-based), so its centre is at
    source 1-based x = f*(X - 1) + (f - 1)/2 + 1. The linear transform (CD or CDELT) grows by f,
    and SIP coefficients A_pq/B_pq/AP_pq/BP_pq scale by f**(p + q - 1) because SIP offsets are
    measured in pixels relative to CRPIX. Built explicitly: WCS.slice() neither rescales a CD
    matrix nor can move a SIP reference pixel (Sip.crpix is read-only).
    """
    wcs = source_wcs.deepcopy()
    block_center = (factor - 1) / 2
    crpix = (np.asarray(source_wcs.wcs.crpix, dtype=float) - block_center - 1 + factor) / factor
    wcs.wcs.crpix = crpix
    if source_wcs.wcs.has_cd():
        wcs.wcs.cd = np.asarray(source_wcs.wcs.cd, dtype=float) * factor
    else:
        wcs.wcs.cdelt = np.asarray(source_wcs.wcs.cdelt, dtype=float) * factor
    if source_wcs.sip is not None:
        def scale(coefficients):
            if coefficients is None:
                return None
            scaled = np.array(coefficients, dtype=float, copy=True)
            for p in range(scaled.shape[0]):
                for q in range(scaled.shape[1]):
                    scaled[p, q] *= float(factor) ** (p + q - 1)
            return scaled
        sip = source_wcs.sip
        wcs.sip = Sip(scale(sip.a), scale(sip.b), scale(sip.ap), scale(sip.bp), crpix)
    wcs.wcs.set()
    return wcs


def clean_cosmic_rays(data, header):
    """L.A.Cosmic (astroscrappy) on a single exposure at native resolution, before any binning.

    Cosmic-ray hits and hot pixels are sharper than the PSF and absent from any reference, so
    every one would otherwise be a "new source". Stacks (NCOMBINE > 1) are already rejected.
    Returns the cleaned image and the number of replaced pixels (None when skipped)."""
    if int(header.get('NCOMBINE') or 1) > 1:
        return data, None
    try:
        import astroscrappy
    except ImportError:
        print('astroscrappy unavailable; cosmic rays are not removed', file=sys.stderr)
        return data, None
    valid = np.isfinite(data)
    if valid.sum() < 1000:
        return data, None
    fill = float(np.median(data[valid]))
    saturation = float(header.get('SATURATE') or header.get('SATLEVEL') or 0) or float(np.nanmax(data)) + 1
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        flagged, cleaned = astroscrappy.detect_cosmics(
            np.where(valid, data, fill).astype(np.float32), inmask=~valid,
            gain=float(header.get('GAIN') or 1.0), readnoise=float(header.get('RDNOISE') or 6.5),
            satlevel=saturation, sigclip=4.5, sigfrac=0.3, objlim=5.0, niter=4,
            cleantype='medmask', sepmed=True)
    cleaned = np.where(valid, cleaned, data).astype(np.float32)
    return cleaned, int(np.count_nonzero(flagged & valid))


def reduced_image(source, output, max_dimension):
    data, header = mono_data(source)
    data, cosmic_pixels = clean_cosmic_rays(data, header)
    height, width = data.shape
    factor = max(1, math.ceil(max(height, width) / max_dimension))
    valid = np.isfinite(data)
    if factor > 1:
        # Exact non-overlapping block integration is an anti-aliasing box filter.
        # Use sums for per-pixel flux units and means for surface-brightness units.
        block_height, block_width = height // factor, width // factor
        if not block_height or not block_width:
            raise ValueError('The FITS dimensions are too small for the requested analysis resolution')
        crop = data[:block_height * factor, :block_width * factor]
        valid_crop = valid[:block_height * factor, :block_width * factor]
        safe = np.where(valid_crop, crop, 0).reshape(block_height, factor, block_width, factor)
        block_sum = safe.sum(axis=(1, 3), dtype=np.float64).astype(np.float32)
        valid_count = valid_crop.reshape(block_height, factor, block_width, factor).sum(axis=(1, 3))
        if _surface_brightness_units(header):
            data = np.divide(block_sum, valid_count, out=np.zeros_like(block_sum), where=valid_count > 0)
        else:
            data = block_sum
        invalid = valid_count != factor ** 2
        saturation = header.get('SATURATE') or header.get('SATLEVEL')
        if saturation:
            # A block containing any saturated pixel is not photometric; mask it for HOTPANTS.
            saturated = np.where(valid_crop, crop, 0) >= 0.95 * float(saturation)
            invalid |= saturated.reshape(block_height, factor, block_width, factor).any(axis=(1, 3))
        if WCS(header).has_celestial:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                wcs = binned_wcs(WCS(header).celestial, factor)
            source_header = header
            header = fits.Header()
            for keyword in ('OBJECT', 'DATE-OBS', 'MJD-OBS', 'EXPTIME', 'FILTER', 'INSTRUME', 'TELESCOP', 'GAIN', 'RDNOISE',
                            'SATURATE', 'NCOMBINE', 'BUNIT', 'SITEID', 'SITE', 'MPCCODE', 'OBSCODE',
                            'LATITUDE', 'LONGITUD', 'HEIGHT'):
                if keyword in source_header:
                    header[keyword] = source_header[keyword]
            header.update(wcs.to_header(relax=True))
        header['DOWNSAMP'] = (factor, 'Integer anti-aliased rebin factor')
        header['FLXSCALE'] = (factor ** 2 if not _surface_brightness_units(header) else 1,
                              'Per-pixel integrated-flux scale applied')
    else:
        invalid = ~valid
        replacement = float(np.median(data[valid])) if np.any(valid) else 0.0
        data = np.where(valid, data, replacement).astype(np.float32)
    if cosmic_pixels is not None:
        header['COSMICPX'] = (cosmic_pixels, 'Cosmic-ray/hot pixels replaced (astroscrappy)')
    fits.writeto(output, data, header=header, overwrite=True)
    invalid_path = output.with_name(output.stem + '-invalid-mask.fits')
    fits.writeto(invalid_path, invalid.astype(np.uint8), header=header, overwrite=True)
    return factor


def ensure_wcs(image_path, original_path, hint, work, stored=None):
    with fits.open(image_path, mode='update') as hdus:
        if WCS(hdus[0].header).has_celestial:
            return WCS(hdus[0].header).celestial
    # The solution AstroviaBin already verified for this exact file (Astrometry.net, kept in its
    # database): reused instead of solving again, rescaled exactly to the block-integrated image.
    if stored:
        try:
            from wcs_transfer import reference_wcs
            original_shape = mono_data(Path(original_path))[0].shape
            if (int(stored.get('imageWidth') or 0), int(stored.get('imageHeight') or 0)) == (original_shape[1], original_shape[0]):
                solution = reference_wcs(stored).celestial
                factor = int((hint or {}).get('factor') or 1)
                if factor > 1:
                    solution = binned_wcs(solution, factor)
                with fits.open(image_path, mode='update') as hdus:
                    hdus[0].header.update(solution.to_header(relax=True))
                print(f'Using the stored plate solution of {Path(original_path).name}', file=sys.stderr, flush=True)
                return solution
        except Exception as error:  # fall back to solving
            print(f'Stored plate solution unusable ({error}); solving again', file=sys.stderr, flush=True)
    work.mkdir(parents=True, exist_ok=True)
    config = work / 'backend.cfg'
    # Same index set as the main solver, including downloaded narrow-field indexes.
    directories = [os.environ.get('ASTROMETRY_INDEX_DIR', '/usr/share/astrometry')]
    directories += [d for d in os.environ.get('ASTROMETRY_EXTRA_INDEX_DIRS', '/app/config/astrometry-index').split(os.pathsep) if d]
    directories = [d for d in directories if os.path.isdir(d)]
    config.write_text(''.join(f'add_path {d}\n' for d in directories) + 'autoindex\n')
    wcs_path = work / 'local.wcs'
    base = [os.environ.get('ASTROMETRY_SOLVE_FIELD', 'solve-field'), '--overwrite', '--no-plots', '--downsample', '1',
            '--backend-config', str(config), '--dir', str(work), '--wcs', str(wcs_path),
            '--cpulimit', '120']
    attempts = []
    if hint and hint.get('ra') is not None and hint.get('dec') is not None:
        positional = ['--ra', str(hint['ra']), '--dec', str(hint['dec']), '--radius', '5']
        # The image was block-integrated by `factor`, so its pixel scale grew by that factor.
        scale = hint.get('pixelScale')
        if scale:
            scale = float(scale) * float(hint.get('factor') or 1)
            attempts.append(positional + ['--scale-units', 'arcsecperpix',
                                          '--scale-low', f'{scale * 0.85:.4f}', '--scale-high', f'{scale * 1.15:.4f}'])
        attempts.append(positional)
    attempts.append([])
    result = None
    failures = []
    for positional_hint in attempts:
        try:
            result = subprocess.run(base + positional_hint + [str(image_path)],
                                    capture_output=True, text=True, timeout=150, check=False)
        except subprocess.TimeoutExpired:
            # One attempt running out of time does not end the analysis: try the next one.
            failures.append(f"{' '.join(positional_hint) or 'blind'}: timed out after 150 s")
            continue
        if result.returncode == 0 and wcs_path.exists():
            break
        failures.append(f"{' '.join(positional_hint) or 'blind'}: {(result.stderr or result.stdout)[-300:].strip()}")
    if not wcs_path.exists():
        raise RuntimeError('Local Astrometry.net could not determine the WCS of this image (no stored plate solution). '
                           'Plate-solve it first from the image panel. Attempts: ' + ' | '.join(failures)[-1500:])
    solution = WCS(fits.getheader(wcs_path)).celestial
    with fits.open(image_path, mode='update') as hdus:
        hdus[0].header.update(solution.to_header(relax=True))
    return solution


# Reference surveys. Keys are what the UI sends; "Auto" picks the best match for the science filter.
SKYVIEW_SURVEYS = {
    'DSS2 Red': 'DSS2 Red', 'DSS2 Blue': 'DSS2 Blue', 'DSS2 IR': 'DSS2 IR', 'DSS1 Red': 'DSS1 Red',
    'SDSS u': 'SDSSu', 'SDSS g': 'SDSSg', 'SDSS r': 'SDSSr', 'SDSS i': 'SDSSi', 'SDSS z': 'SDSSz',
    '2MASS J': '2MASS-J', '2MASS H': '2MASS-H', '2MASS K': '2MASS-K',
}
PAN_STARRS_SURVEYS = {f'Pan-STARRS1 {band} stack': band for band in 'grizy'}
LEGACY_SURVEYS = {f'Legacy Surveys DR10 {band}': band for band in 'griz'}


def science_band(header):
    """Photometric band of the science frame from its FILTER keyword (LCO, SDSS, Johnson-Cousins, narrowband)."""
    value = str(header.get('FILTER') or header.get('FILTER1') or '').strip().lower().replace('-', '').replace('_', '')
    if not value:
        return 'r', 'no FILTER keyword; assumed r'
    table = [
        (('ha', 'halpha', 'h-alpha', 'sii', 's2', 'rp', 'r', 'r\'', 'sdssr', 'rc', 'rj', 'l', 'lum', 'luminance', 'clear', 'cl', 'w', 'none'), 'r'),
        (('oiii', 'o3', 'hb', 'hbeta', 'gp', 'g', 'g\'', 'sdssg', 'b', 'bj'), 'g'),
        (('v', 'vj'), 'r'),
        (('ip', 'i', 'i\'', 'sdssi', 'ic', 'ij'), 'i'),
        (('zp', 'zs', 'z', 'z\'', 'sdssz'), 'z'),
        (('y', 'ys'), 'y'),
        (('up', 'u', 'u\'', 'sdssu', 'uj'), 'u'),
        (('j',), 'J'), (('h',), 'H'), (('k', 'ks'), 'K'),
    ]
    for names, band in table:
        if value in names:
            return band, f'FILTER {header.get("FILTER")} → {band}'
    return 'r', f'unrecognised FILTER {header.get("FILTER")}; assumed r'


def auto_reference_order(band, dec, field_degrees):
    """Best-first reference candidates: deep CCD stacks in the matching band, then SDSS, then DSS."""
    order = []
    if band in 'grizy' and dec >= -30 and field_degrees * 60 <= 25:
        order.append(f'Pan-STARRS1 {band} stack')
    if band in 'griz':
        order.append(f'Legacy Surveys DR10 {band}')
    if band in 'ugriz':
        order.append(f'SDSS {band}')
    if band in ('J', 'H', 'K'):
        order.append(f'2MASS {band}')
    order.append('DSS2 Blue' if band in ('u', 'g') else 'DSS2 IR' if band in ('z', 'y', 'J', 'H', 'K') else 'DSS2 Red')
    if 'DSS2 Red' not in order:
        order.append('DSS2 Red')
    return order


def _field_geometry(wcs, shape):
    height, width = shape
    ra, dec = wcs.pixel_to_world_values((width - 1) / 2, (height - 1) / 2)
    corners = wcs.pixel_to_world_values(np.array([0, width - 1, 0, width - 1]),
                                       np.array([0, 0, height - 1, height - 1]))
    offsets = np.hypot((np.mod(corners[0] - ra + 180, 360) - 180) * math.cos(math.radians(dec)), corners[1] - dec)
    return float(ra), float(dec), float(max(offsets) * 2.3)


def _download(url, destination, label, timeout=180):
    request = urllib.request.Request(url, headers={'User-Agent': 'AstroviaBin private FITS analysis/1.0'})
    with urllib.request.urlopen(request, timeout=timeout) as response, destination.open('wb') as output:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 120 * 1024 * 1024:
                raise ValueError(f'The {label} reference exceeds the 120 MB safety limit')
            output.write(chunk)
    with destination.open('rb') as reference:
        if reference.read(9) != b'SIMPLE  =':
            raise ValueError(f'{label} did not return a FITS image')


def _require_coverage(destination, label):
    """Survey services return blank images outside their footprint; treat that as no coverage."""
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        data, _ = mono_data(destination)
    finite = np.isfinite(data)
    useful = finite & (data != 0)
    if data.size == 0 or useful.mean() < 0.5 or float(np.nanstd(data[finite])) == 0.0:
        raise ValueError(f'{label} has no coverage of this field')


def fetch_skyview_reference(wcs, shape, destination, survey):
    ra, dec, fov = _field_geometry(wcs, shape)
    if not 0 < fov <= 8:
        raise ValueError('The FITS field is too large for an automatic survey reference; choose a local FITS reference')
    query = urllib.parse.urlencode({'Survey': SKYVIEW_SURVEYS[survey], 'Position': f'{ra:.8f},{dec:.8f}',
                                    'Return': 'FITS', 'Size': f'{fov:.6f}', 'Pixels': '2048'})
    url = 'https://skyview.gsfc.nasa.gov/cgi-bin/images?' + query
    _download(url, destination, survey)
    _require_coverage(destination, survey)
    return {'survey': survey, 'url': url, 'ra': ra, 'dec': dec, 'fieldDegrees': fov}


def fetch_legacy_reference(wcs, shape, destination, survey):
    """DESI Legacy Imaging Surveys DR10 cutout (0.262"/px native; coarser for big fields, max 3000 px)."""
    band = LEGACY_SURVEYS[survey]
    ra, dec, fov = _field_geometry(wcs, shape)
    pixscale = max(0.262, fov * 3600 / 3000)
    size = min(3000, math.ceil(fov * 3600 / pixscale))
    url = 'https://www.legacysurvey.org/viewer/fits-cutout?' + urllib.parse.urlencode({
        'ra': f'{ra:.8f}', 'dec': f'{dec:.8f}', 'layer': 'ls-dr10', 'pixscale': f'{pixscale:.4f}',
        'bands': band, 'size': str(size)})
    _download(url, destination, survey)
    _require_coverage(destination, survey)
    return {'survey': survey, 'url': url, 'ra': ra, 'dec': dec, 'fieldDegrees': fov, 'pixelScaleArcsec': pixscale}


def fetch_reference(wcs, shape, destination, survey, science_header=None):
    if survey == 'Auto':
        band, reason = science_band(science_header or {})
        _, dec, fov = _field_geometry(wcs, shape)
        tried = []
        for candidate in auto_reference_order(band, dec, fov):
            try:
                provenance = fetch_reference(wcs, shape, destination, candidate)
                provenance['autoSelection'] = {'band': band, 'reason': reason, 'skipped': tried}
                return provenance
            except Exception as error:  # try the next-best survey
                tried.append(f'{candidate}: {error}')
        raise ValueError('No survey reference covers this field: ' + ' | '.join(tried))
    if survey in PAN_STARRS_SURVEYS:
        return fetch_pan_starrs_reference(wcs, shape, destination, PAN_STARRS_SURVEYS[survey])
    if survey in LEGACY_SURVEYS:
        return fetch_legacy_reference(wcs, shape, destination, survey)
    if survey in SKYVIEW_SURVEYS:
        return fetch_skyview_reference(wcs, shape, destination, survey)
    raise ValueError('Unsupported survey')


def fetch_pan_starrs_reference(wcs, shape, destination, band='r'):
    """Fetch a PS1 DR2 stack cutout in one band; send only WCS coordinates to MAST."""
    height, width = shape
    ra, dec = wcs.pixel_to_world_values((width - 1) / 2, (height - 1) / 2)
    corners = wcs.pixel_to_world_values(np.array([0, width - 1, 0, width - 1]),
                                       np.array([0, 0, height - 1, height - 1]))
    offsets = np.hypot((np.mod(corners[0] - ra + 180, 360) - 180) * math.cos(math.radians(dec)), corners[1] - dec)
    field_degrees = float(max(offsets) * 2.3)
    if dec < -30:
        raise ValueError('Pan-STARRS1 stacked reference images cover the sky north of Dec −30°. Choose DSS2 or a local FITS reference.')
    # PS1 pixels are 0.25 arcsec; its cutout service caps requests at 6000 px.
    pixels = math.ceil(field_degrees * 3600 / 0.25)
    if pixels < 1 or pixels > 6000:
        raise ValueError('Pan-STARRS1 cutouts cover fields up to about 25 arcmin. Choose DSS2 or a local FITS reference for this field.')

    lookup_url = 'https://ps1images.stsci.edu/cgi-bin/ps1filenames.py?' + urllib.parse.urlencode({
        'ra': f'{ra:.8f}', 'dec': f'{dec:.8f}', 'filters': band, 'type': 'stack', 'sep': 'comma'})
    headers = {'User-Agent': 'AstroviaBin private FITS analysis/1.0'}
    request = urllib.request.Request(lookup_url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = list(csv.DictReader(StringIO(response.read(2_000_000).decode('utf-8'))))
    row = next((item for item in rows if item.get('filter') == band and item.get('filename')), None)
    if row is None:
        raise ValueError(f'Pan-STARRS1 has no {band}-band stack coverage at this position. Choose another survey or a local FITS reference.')

    cutout_url = 'https://ps1images.stsci.edu/cgi-bin/fitscut.cgi?' + urllib.parse.urlencode({
        'size': str(pixels), 'format': 'fits', 'red': row['filename'],
        'ra': f'{ra:.8f}', 'dec': f'{dec:.8f}'})
    request = urllib.request.Request(cutout_url, headers=headers)
    with urllib.request.urlopen(request, timeout=180) as response, destination.open('wb') as output:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 120 * 1024 * 1024:
                raise ValueError('The Pan-STARRS1 reference exceeds the 120 MB safety limit')
            output.write(chunk)
    with destination.open('rb') as reference:
        if reference.read(9) != b'SIMPLE  =':
            raise ValueError('Pan-STARRS1 did not return a FITS image cutout')
    _require_coverage(destination, f'Pan-STARRS1 {band}')
    return {'survey': f'Pan-STARRS1 DR2 {band} stack (MAST)', 'url': cutout_url,
            'ra': float(ra), 'dec': float(dec), 'fieldDegrees': field_degrees,
            'pixelScaleArcsec': 0.25, 'referenceEpoch': 'multi-epoch stack'}


def _pixel_area(wcs):
    area = wcs.proj_plane_pixel_area()
    return float(area.value if hasattr(area, 'value') else area)


def _surface_brightness_units(header):
    unit = str(header.get('BUNIT', '')).lower().replace(' ', '')
    return any(marker in unit for marker in ('/sr', 'sr-1', 'sr**-1', '/arcsec2', 'arcsec-2', 'deg-2'))


def align_reference(reference_path, science_wcs, science_header, shape, output, correction=None):
    """Resample the reference onto the science pixel grid through both WCS solutions.

    `correction(x, y) -> (dx, dy)` optionally shifts where each science pixel samples the sky,
    from `registration_correction`, so the reference is interpolated only once."""
    reference, header = mono_data(reference_path)
    reference_wcs = WCS(header).celestial
    if not reference_wcs.has_celestial:
        raise ValueError('Reference FITS has no WCS. Plate solve the reference locally first.')
    # FITS photometry is normally integrated per pixel; convert the reference to
    # science-pixel integrated flux before HOTPANTS fits its photometric scale.
    # Surface-brightness units are already per solid angle and must not be scaled.
    area_scale = (_pixel_area(science_wcs) / _pixel_area(reference_wcs)
                  if not (_surface_brightness_units(header) or _surface_brightness_units(science_header)) else 1.0)
    reference_invalid_path = reference_path.with_name(reference_path.stem + '-invalid-mask.fits')
    if reference_invalid_path.exists():
        reference_invalid, _ = mono_data(reference_invalid_path)
        reference_invalid = binary_dilation(reference_invalid > 0, iterations=1)
    else:
        reference_invalid = ~np.isfinite(reference)
        if int(header.get('BITPIX', -32)) < 0:
            # Survey coadds write exactly 0.0 where every exposure was masked (saturated star
            # cores, bleeds, gaps). Real floating-point sky is never exactly zero, so treat those
            # holes, plus the resampled pixels around them, as missing reference data.
            holes = reference == 0
            if holes.any():
                reference_invalid |= binary_dilation(holes, iterations=2)
    science_invalid_path = output.with_name('science-invalid-mask.fits')
    if science_invalid_path.exists():
        science_invalid, _ = mono_data(science_invalid_path)
        science_invalid = science_invalid > 0
    else:
        science_invalid = np.zeros(shape, dtype=bool)
    height, width = shape
    aligned = np.zeros((height, width), dtype=np.float32)
    mask = np.ones((height, width), dtype=np.uint8)
    for row in range(0, height, 64):
        stop = min(row + 64, height)
        yy, xx = np.mgrid[row:stop, 0:width]
        if correction is not None:
            dx, dy = correction(xx, yy)
            ra, dec = science_wcs.pixel_to_world_values(xx + dx, yy + dy)
        else:
            ra, dec = science_wcs.pixel_to_world_values(xx, yy)
        rx, ry = reference_wcs.world_to_pixel_values(ra, dec)
        good = np.isfinite(rx) & np.isfinite(ry) & (rx >= 1) & (ry >= 1) & (rx < reference.shape[1] - 2) & (ry < reference.shape[0] - 2)
        safe_rx, safe_ry = np.nan_to_num(rx), np.nan_to_num(ry)
        reference_bad = map_coordinates(reference_invalid.astype(np.uint8), [safe_ry, safe_rx], order=0, mode='constant', cval=1) > 0
        good &= ~reference_bad & ~science_invalid[row:stop]
        values = map_coordinates(reference, [safe_ry, safe_rx], order=1, mode='constant', cval=0) * area_scale
        values[~good] = 0
        aligned[row:stop] = values
        mask[row:stop] = ~good
    coverage = float(np.mean(mask == 0))
    if coverage < 0.3:
        raise ValueError(f'Reference overlaps only {coverage:.0%} of the science image; choose a matching field')
    fits.writeto(output, aligned, header=science_wcs.to_header(relax=True), overwrite=True)
    return coverage, mask, area_scale


def _registration_stars(data, invalid, fwhm, limit=2500):
    good = np.isfinite(data) & ~invalid
    if good.sum() < 1000:
        return np.empty((0, 2))
    median = float(np.median(data[good]))
    sigma = float(1.4826 * np.median(np.abs(data[good] - median)))
    if not np.isfinite(sigma) or sigma <= 0:
        return np.empty((0, 2))
    finder = DAOStarFinder(threshold=10 * sigma, fwhm=max(1.5, fwhm), sharpness_range=(0.2, 1.0),
                           roundness_range=(-0.5, 0.5), exclude_border=True)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sources = finder(np.where(good, data, median) - median)
    if sources is None:
        return np.empty((0, 2))
    sources.sort('flux', reverse=True)
    points = np.c_[sources['x_centroid'], sources['y_centroid']][:limit]
    keep = ~invalid[np.clip(points[:, 1].round().astype(int), 0, data.shape[0] - 1),
                    np.clip(points[:, 0].round().astype(int), 0, data.shape[1] - 1)]
    return points[keep]


def registration_correction(science, science_invalid, aligned, aligned_invalid, fwhm):
    """Residual science-to-reference misregistration from matched stars, as a smooth polynomial.

    Plate solutions of wide or distorted fields can be off by pixels near the edges; with a
    seeing of 1-2 px that turns every star there into a false "new source". Stars matched between
    the science image and the aligned reference give the residual offset field, fitted with a
    sigma-clipped 2D polynomial whose order grows with the number of matches.
    Returns (correction or None, report)."""
    from scipy.spatial import cKDTree
    stars_science = _registration_stars(science, science_invalid, fwhm)
    stars_reference = _registration_stars(aligned, aligned_invalid, fwhm)
    report = {'scienceStars': int(len(stars_science)), 'referenceStars': int(len(stars_reference))}
    if len(stars_science) < 6 or len(stars_reference) < 6:
        report['note'] = 'Too few stars to refine the registration'
        return None, report
    height, width = science.shape
    half_w, half_h = width / 2, height / 2

    def design(points, order):
        u, v = (points[:, 0] - half_w) / half_w, (points[:, 1] - half_h) / half_h
        return np.column_stack([u ** i * v ** j for i in range(order + 1) for j in range(order + 1 - i)])

    tree = cKDTree(stars_reference)
    distance, index = tree.query(stars_science, distance_upper_bound=4.0)
    matched = np.isfinite(distance)
    if matched.sum() < 6:
        report['note'] = 'Too few matched stars to refine the registration'
        return None, report
    source, offsets = stars_science[matched], stars_reference[index[matched]] - stars_science[matched]
    report['rmsBeforePx'] = round(float(np.sqrt(np.mean(np.sum(offsets ** 2, axis=1)))), 3)
    order = 3 if len(source) >= 80 else 2 if len(source) >= 30 else 1 if len(source) >= 10 else 0
    coefficients = None
    for _ in range(3):  # fit, re-match tightly against the corrected positions, refit
        use = np.ones(len(source), dtype=bool)
        for _ in range(5):
            matrix = design(source[use], order)
            coefficients = np.linalg.lstsq(matrix, offsets[use], rcond=None)[0]
            residual = np.hypot(*(offsets - design(source, order) @ coefficients).T)
            limit = max(0.3, 3 * 1.4826 * float(np.median(residual[use])))
            if np.array_equal(residual <= limit, use):
                break
            use = residual <= limit
        predicted = stars_science + design(stars_science, order) @ coefficients
        distance, index = tree.query(predicted, distance_upper_bound=1.5)
        matched = np.isfinite(distance)
        if matched.sum() < 6:
            break
        source, offsets = stars_science[matched], stars_reference[index[matched]] - stars_science[matched]
    final = offsets - design(source, order) @ coefficients
    rms_after = float(np.sqrt(np.mean(np.sum(final ** 2, axis=1))))
    report.update({'matchedStars': int(len(source)), 'polynomialOrder': order,
                   'rmsAfterPx': round(rms_after, 3)})
    grid = np.array([[x, y] for x in np.linspace(0, width - 1, 9) for y in np.linspace(0, height - 1, 9)])
    report['maxCorrectionPx'] = round(float(np.max(np.hypot(*(design(grid, order) @ coefficients).T))), 3)
    if report['maxCorrectionPx'] < 0.05 or not rms_after < report['rmsBeforePx']:
        report['note'] = 'Registration already consistent; no correction applied'
        return None, report

    def correction(x, y):
        points = np.column_stack([np.ravel(x), np.ravel(y)])
        shift = design(points, order) @ coefficients
        return shift[:, 0].reshape(np.shape(x)), shift[:, 1].reshape(np.shape(y))
    report['applied'] = True
    return correction, report


def estimate_fwhm(data, invalid=None):
    """Median FWHM in pixels of bright, isolated, unsaturated point sources (second moments)."""
    finite = np.isfinite(data) if invalid is None else (np.isfinite(data) & ~invalid)
    if finite.sum() < 1000:
        return None
    median = float(np.median(data[finite]))
    sigma = float(1.4826 * np.median(np.abs(data[finite] - median)))
    if not np.isfinite(sigma) or sigma <= 0:
        return None
    clean = np.where(finite, data, median) - median
    finder = DAOStarFinder(threshold=15 * sigma, fwhm=3.0, sharpness_range=(0.2, 1.0),
                           roundness_range=(-0.5, 0.5), exclude_border=True)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sources = finder(clean)
    if sources is None or len(sources) < 5:
        return None
    sources.sort('flux', reverse=True)
    fwhm_guess = 3.0
    for _ in range(2):
        radius = int(max(6, math.ceil(2.5 * fwhm_guess)))
        values = []
        yy, xx = np.mgrid[-radius:radius + 1, -radius:radius + 1]
        for source in sources[:300]:
            x, y = int(round(float(source['x_centroid']))), int(round(float(source['y_centroid'])))
            stamp = clean[y - radius:y + radius + 1, x - radius:x + radius + 1]
            mask = finite[y - radius:y + radius + 1, x - radius:x + radius + 1]
            if stamp.shape != yy.shape or not mask.all():
                continue
            peak = float(stamp.max())
            # Saturated (clipped) stars have a flat top: several pixels at essentially the peak value.
            if peak <= 0 or np.count_nonzero(stamp >= peak * 0.995) >= 4:
                continue
            edge = np.concatenate([stamp[0], stamp[-1], stamp[:, 0], stamp[:, -1]])
            background = float(np.median(edge))
            # Circular Gaussian + constant, least squares: unbiased by background noise, unlike moments.
            def residual(parameters):
                amplitude, cx, cy, width, offset = parameters
                model = amplitude * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * width ** 2)) + offset
                return (model - stamp).ravel()
            start = [peak - background, 0.0, 0.0, fwhm_guess / 2.3548, background]
            try:
                fit = least_squares(residual, start, bounds=([0, -radius, -radius, 0.3, -np.inf],
                                                             [np.inf, radius, radius, radius, np.inf]))
            except ValueError:
                continue
            if not fit.success or math.hypot(fit.x[1], fit.x[2]) > 2:
                continue
            fwhm = 2.3548 * float(fit.x[3])
            if 0.8 < fwhm < 25:
                values.append(fwhm)
            if len(values) >= 60:
                break
        if len(values) < 5:
            return None
        fwhm_guess = float(np.median(values))
    return round(fwhm_guess, 2)


def bright_source_mask(data, invalid, fwhm):
    """Saturated/near-saturated stars and their bleed trails in a reference image.

    Survey stacks (DECam, PS1, photographic DSS) clip bright stars and add bleed trails and
    spikes; their flux no longer scales, so subtraction leaves bright false residuals. Mask every
    pixel above half the brightest-star level and grow it by three seeing widths.
    """
    good = np.isfinite(data) & ~invalid
    if good.sum() < 1000:
        return np.zeros(data.shape, dtype=bool)
    median = float(np.median(data[good]))
    brightest = float(np.percentile(data[good], 99.999))
    if not brightest > median:
        return np.zeros(data.shape, dtype=bool)
    core = good & (data > median + 0.5 * (brightest - median))
    # Keep only star-like cores and thin trails; a wide bright blob is a galaxy or nebula, which
    # is exactly where transients are searched for and must stay unmasked.
    labels, count = label(core)
    width_limit = 4 * (fwhm or 3)
    keep = np.zeros(count + 1, dtype=bool)
    for index, region in enumerate(find_objects(labels), start=1):
        if region is None:
            continue
        height = region[0].stop - region[0].start
        width = region[1].stop - region[1].start
        keep[index] = min(height, width) <= width_limit
    core = keep[labels] & core
    return binary_dilation(core, iterations=max(3, math.ceil(3 * (fwhm or 3))))


def elongated_source_mask(data, invalid, fwhm, axis_ratio_limit=1.35):
    """Bright sources that are markedly elongated in the reference: saturation bleeds and
    diffraction streaks of stars that saturated in the survey's single exposures. Their flux and
    shape cannot be matched by a PSF kernel, so they are masked with a margin."""
    good = np.isfinite(data) & ~invalid
    if good.sum() < 1000:
        return np.zeros(data.shape, dtype=bool)
    median = float(np.median(data[good]))
    sigma = float(1.4826 * np.median(np.abs(data[good] - median))) or 1.0
    clean = np.where(good, data, median) - median
    finder = DAOStarFinder(threshold=25 * sigma, fwhm=max(2.0, fwhm or 3), sharpness_range=(0.0, 2.0),
                           roundness_range=(-2.0, 2.0), exclude_border=True)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sources = finder(clean)
    mask = np.zeros(data.shape, dtype=bool)
    if sources is None:
        return mask
    # Only stars bright enough to saturate bleed: the top of the reference's stellar range.
    brightest = float(np.percentile(clean[good], 99.999))
    bright_level = 0.05 * brightest
    radius = int(max(6, math.ceil(4 * (fwhm or 3))))
    yy, xx = np.mgrid[-radius:radius + 1, -radius:radius + 1]
    height, width = data.shape
    for source in sources:
        x, y = int(round(float(source['x_centroid']))), int(round(float(source['y_centroid'])))
        if x < radius or y < radius or x >= width - radius or y >= height - radius:
            continue
        stamp = np.clip(clean[y - radius:y + radius + 1, x - radius:x + radius + 1], 0, None)
        stamp = np.where(stamp > 0.1 * stamp.max(), stamp, 0)
        # Only the blob containing the star: two neighbouring stars otherwise look like a trail.
        pieces, _ = label(stamp > 0)
        centre = pieces[radius - 1:radius + 2, radius - 1:radius + 2]
        centre = centre[centre > 0]
        if centre.size == 0:
            continue
        stamp = np.where(pieces == np.bincount(centre).argmax(), stamp, 0)
        total = stamp.sum()
        if total <= 0:
            continue
        cx, cy = (xx * stamp).sum() / total, (yy * stamp).sum() / total
        mxx = ((xx - cx) ** 2 * stamp).sum() / total
        myy = ((yy - cy) ** 2 * stamp).sum() / total
        mxy = ((xx - cx) * (yy - cy) * stamp).sum() / total
        root = math.sqrt(max(((mxx - myy) / 2) ** 2 + mxy ** 2, 0))
        major, minor = (mxx + myy) / 2 + root, max((mxx + myy) / 2 - root, 1e-6)
        psf_sigma = (fwhm or 3) / 2.3548
        # Bleed trails are as narrow as a star; galaxy disks, knots and nebulae are not.
        if math.sqrt(major / minor) < axis_ratio_limit or math.sqrt(minor) > 1.6 * psf_sigma:
            continue
        # ...and clearly longer than the PSF: moments of undersampled round stars look elongated.
        if math.sqrt(major) < 2.0 * psf_sigma:
            continue
        if float(source['peak']) < bright_level:
            continue
        extent = min(80.0, 3 * math.sqrt(major) + 2 * (fwhm or 3))
        y0, y1 = max(0, int(y - extent)), min(height, int(y + extent) + 2)
        x0, x1 = max(0, int(x - extent)), min(width, int(x + extent) + 2)
        oy, ox = np.ogrid[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] |= (ox - x) ** 2 + (oy - y) ** 2 <= extent ** 2
    return mask


def catalog_bright_stars(wcs, shape, magnitude_limit=13.0):
    """(x, y, mag) of catalogued stars brighter than `magnitude_limit` in the frame, from the offline
    sky bundle (HYG + Tycho-2); empty when the bundle is not installed."""
    import gzip
    directory = None
    for candidate in (os.environ.get('ASTROVIABIN_SKY_DATA_DIR'), '/usr/share/astroviabin/sky'):
        if candidate and os.path.exists(os.path.join(candidate, 'stars.json.gz')):
            directory = candidate
            break
    if directory is None:
        return []
    ra0, dec0, fov = _field_geometry(wcs, shape)
    radius = fov / 2.3 * 1.1
    ras, decs, mags = [], [], []
    with gzip.open(os.path.join(directory, 'stars.json.gz'), 'rt', encoding='utf-8') as handle:
        table = json.load(handle)
    dec = np.asarray(table['dec'], dtype=float)
    lo, hi = np.searchsorted(dec, dec0 - radius), np.searchsorted(dec, dec0 + radius)
    mag = np.asarray([np.nan if value is None else value for value in table['mag'][lo:hi]], dtype=float)
    keep = np.isfinite(mag) & (mag < magnitude_limit)
    ras.append(np.asarray(table['ra'][lo:hi], dtype=float)[keep]); decs.append(dec[lo:hi][keep]); mags.append(mag[keep])
    tycho_meta = os.path.join(directory, 'tycho.json')
    if os.path.exists(tycho_meta):
        layout = json.load(open(tycho_meta))
        with gzip.open(os.path.join(directory, 'tycho.bin.gz'), 'rb') as handle:
            raw = handle.read()
        count = layout['count']
        column = lambda key, dtype: np.frombuffer(raw, dtype=dtype, count=count, offset=layout['columns'][key]['offset'])
        tdec = column('dec', '<f4').astype(float)
        lo, hi = np.searchsorted(tdec, dec0 - radius), np.searchsorted(tdec, dec0 + radius)
        tmag = column('mag', '<i2')[lo:hi] / 1000.0
        keep = tmag < magnitude_limit
        ras.append(column('ra', '<f4')[lo:hi].astype(float)[keep]); decs.append(tdec[lo:hi][keep]); mags.append(tmag[keep])
    ra_all, dec_all, mag_all = np.concatenate(ras), np.concatenate(decs), np.concatenate(mags)
    if not len(ra_all):
        return []
    x, y = wcs.world_to_pixel_values(ra_all, dec_all)
    height, width = shape
    inside = np.isfinite(x) & np.isfinite(y) & (x > -200) & (y > -200) & (x < width + 200) & (y < height + 200)
    return list(zip(x[inside], y[inside], mag_all[inside]))


def catalog_bright_star_mask(wcs, shape, fwhm, magnitude_limit=13.0):
    """Legacy-Surveys-style bright-star mask: radius 1630" x 1.396**(-mag) around each star."""
    height, width = shape
    mask = np.zeros(shape, dtype=bool)
    scale = float(np.sqrt(abs(np.linalg.det(wcs.pixel_scale_matrix)))) * 3600
    for x, y, mag in catalog_bright_stars(wcs, shape, magnitude_limit):
        radius = min(400.0, max(2.5 * (fwhm or 3), 1630.0 * 1.396 ** (-mag) / scale))
        x0, x1 = max(0, int(x - radius)), min(width, int(x + radius) + 2)
        y0, y1 = max(0, int(y - radius)), min(height, int(y + radius) + 2)
        if x0 >= x1 or y0 >= y1:
            continue
        yy, xx = np.ogrid[y0:y1, x0:x1]
        mask[y0:y1, x0:x1] |= (xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2
    return mask


def default_hotpants_args(user_args, science, science_header, template, template_mask, fwhm_science, fwhm_template, science_invalid):
    """Data-driven HOTPANTS settings; any flag the user passed explicitly is left to the user."""
    present = {value for value in user_args if isinstance(value, str) and value.startswith('-')}
    args, info = [], {}

    def add(flag, *values):
        if flag not in present:
            args.extend([flag, *[str(value) for value in values]])
            info[flag] = ' '.join(str(value) for value in values)

    def valid_range(data, invalid):
        good = np.isfinite(data) & ~invalid
        if not good.any():
            return None
        median = float(np.median(data[good]))
        sigma = float(1.4826 * np.median(np.abs(data[good] - median))) or 1.0
        # Background-subtracted images are legitimately negative; saturation is handled by masks.
        return median - 50 * sigma, float(np.max(data[good])) + sigma

    science_range = valid_range(science, science_invalid)
    template_range = valid_range(template, template_mask > 0)
    if science_range:
        add('-il', f'{science_range[0]:.6g}')
        add('-iu', f'{science_range[1]:.6g}')
    if template_range:
        add('-tl', f'{template_range[0]:.6g}')
        add('-tu', f'{template_range[1]:.6g}')
    gain = science_header.get('GAIN')
    frames = float(science_header.get('NCOMBINE') or 1)
    factor = float(science_header.get('DOWNSAMP') or 1)
    if gain:
        # A mean of N frames has N times the effective gain; block sums add read noise in quadrature.
        add('-ig', f'{float(gain) * frames:.6g}')
    if science_header.get('RDNOISE'):
        add('-ir', f'{float(science_header["RDNOISE"]) * factor / math.sqrt(frames):.6g}')
    if fwhm_science and fwhm_template:
        widest = max(fwhm_science, fwhm_template)
        radius = int(min(25, max(5, round(2.5 * widest))))
        add('-r', radius)
        add('-rss', int(min(40, max(radius + 2, round(1.5 * radius)))))
        sigma_match = math.sqrt(max(abs((fwhm_science / 2.3548) ** 2 - (fwhm_template / 2.3548) ** 2), 0.25))
        add('-ng', 3, 6, f'{max(0.5, 0.5 * sigma_match):.3f}', 4, f'{max(0.7, sigma_match):.3f}', 2, f'{max(1.0, 2 * sigma_match):.3f}')
    info['fwhmSciencePx'] = fwhm_science
    info['fwhmReferencePx'] = fwhm_template
    return args, info


def local_point_source(data, x, y, fwhm, detection_sigma=5):
    """Use Photutils' DAOFIND shape test around one proposed position."""
    radius = max(16, math.ceil(fwhm * 4))
    left, right = max(0, x - radius), min(data.shape[1], x + radius + 1)
    top, bottom = max(0, y - radius), min(data.shape[0], y + radius + 1)
    if left != x - radius or right != x + radius + 1 or top != y - radius or bottom != y + radius + 1:
        return None
    patch = np.asarray(data[top:bottom, left:right], dtype=np.float64)
    if not np.all(np.isfinite(patch)):
        return None
    yy, xx = np.ogrid[:patch.shape[0], :patch.shape[1]]
    distance = np.hypot(xx - radius, yy - radius)
    annulus = patch[(distance >= radius * 0.65) & (distance <= radius)]
    background = float(np.median(annulus))
    sigma = float(1.4826 * np.median(np.abs(annulus - background)))
    if not np.isfinite(sigma) or sigma <= 0:
        return None
    finder = DAOStarFinder(threshold=detection_sigma * sigma, fwhm=fwhm,
                           sharpness_range=(0.1, 1.2), roundness_range=(-0.65, 0.65),
                           scale_threshold=False)
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        sources = finder(patch - background)
    if sources is None:
        return None
    nearest = min(sources, key=lambda source: math.hypot(
        float(source['x_centroid']) - radius, float(source['y_centroid']) - radius))
    offset = math.hypot(float(nearest['x_centroid']) - radius, float(nearest['y_centroid']) - radius)
    if offset > max(2.5, fwhm * 0.6):
        return None
    return {'x': float(nearest['x_centroid']) + left,
            'y': float(nearest['y_centroid']) + top,
            'localContrast': round(float((patch[radius, radius] - background) / sigma), 2),
            'sharpness': round(float(nearest['sharpness']), 3),
            'roundness': round(float(nearest['roundness2']), 3)}


def reference_peak_present(reference, x, y, fwhm, detection_sigma=5):
    """Whether the reference already has a significant local maximum within ~1 FWHM, whatever
    its shape: survey stars that saturated (bleeds, flat or cross-shaped cores) fail a PSF shape
    test but are still existing objects, not new ones."""
    radius = max(16, math.ceil(fwhm * 4))
    patch = np.asarray(reference[y - radius:y + radius + 1, x - radius:x + radius + 1], dtype=np.float64)
    if patch.shape != (2 * radius + 1, 2 * radius + 1) or not np.all(np.isfinite(patch)):
        return False
    yy, xx = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    distance = np.hypot(xx, yy)
    annulus = patch[(distance >= radius * 0.65) & (distance <= radius)]
    background = float(np.median(annulus))
    sigma = float(1.4826 * np.median(np.abs(annulus - background)))
    if not np.isfinite(sigma) or sigma <= 0:
        return False
    near = distance <= max(1.5, 0.8 * fwhm)
    peaks = (patch == maximum_filter(patch, size=3)) & (patch - background >= detection_sigma * sigma)
    return bool(np.any(peaks & near))


def has_subtraction_dipole(difference, x, y, fwhm):
    radius = max(8, math.ceil(fwhm * 3))
    patch = difference[y - radius:y + radius + 1, x - radius:x + radius + 1]
    if patch.shape != (2 * radius + 1, 2 * radius + 1):
        return True
    yy, xx = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    distance = np.hypot(xx, yy)
    sky = float(np.median(patch[distance >= radius * 0.75]))
    core = float(patch[radius, radius] - sky)
    # A misregistration dipole's negative lobe touches the source (offset < 1 FWHM); farther
    # negative pixels are unrelated residuals, e.g. of a host galaxy's disk.
    lobe = max(3.0, 2 * fwhm)
    opposite = float(np.min(patch[(distance >= max(2, fwhm * 0.8)) & (distance <= lobe)] - sky))
    return core <= 0 or opposite < -0.45 * core


def detect_candidates(difference_path, noise_path, bad_mask_path, mask, science_path,
                      reference_path, wcs, threshold, max_candidates, fwhm):
    difference, _ = mono_data(difference_path)
    noise, _ = mono_data(noise_path)
    bad_mask, _ = mono_data(bad_mask_path)
    science, _ = mono_data(science_path)
    reference, _ = mono_data(reference_path)
    if noise.shape != difference.shape or bad_mask.shape != difference.shape:
        raise ValueError('HOTPANTS output layers do not match the difference image')
    # HOTPANTS bit 0x8000 (FLAG_OUTPUT_ISBAD) marks unusable output pixels. Other bits are
    # informational, e.g. 0x40 FLAG_OK_CONV = valid pixel whose kernel touched a flagged neighbour.
    output_bad = (np.nan_to_num(bad_mask).astype(np.int64) & 0x8000) != 0
    valid = (mask == 0) & ~output_bad & np.isfinite(difference) & np.isfinite(noise) & (noise > 0)
    valid &= np.isfinite(science) & np.isfinite(reference)
    valid &= ~binary_dilation(~valid, iterations=max(3, math.ceil(fwhm)))
    significance = np.zeros_like(difference)
    significance[valid] = difference[valid] / noise[valid]
    significance = np.clip(significance, -1e5, 1e5)
    edge = max(20, math.ceil(fwhm * 5), int(min(difference.shape) * 0.01))
    valid[:edge] = False
    valid[-edge:] = False
    valid[:, :edge] = False
    valid[:, -edge:] = False
    peaks = (significance >= threshold) & (significance == maximum_filter(significance, size=7)) & valid
    positions = np.argwhere(peaks)
    count = len(positions)
    found = []
    rejected = {'notPointSourceInDifference': 0, 'notPointSourceInScience': 0,
                'presentInReference': 0, 'subtractionDipole': 0, 'duplicate': 0}
    if count:
        ranks = np.argsort(significance[positions[:, 0], positions[:, 1]])[::-1]
    else:
        ranks = []
    for index in ranks[:5000]:
        y, x = positions[index]
        neighborhood = significance[y - 2:y + 3, x - 2:x + 3]
        if np.count_nonzero(neighborhood >= threshold * 0.5) < 3:
            rejected['notPointSourceInDifference'] += 1
            continue
        difference_source = local_point_source(difference, int(x), int(y), fwhm)
        if difference_source is None:
            rejected['notPointSourceInDifference'] += 1
            continue
        science_source = local_point_source(science, int(x), int(y), fwhm)
        if science_source is None:
            rejected['notPointSourceInScience'] += 1
            continue
        if local_point_source(reference, int(x), int(y), fwhm) or reference_peak_present(reference, int(x), int(y), fwhm):
            rejected['presentInReference'] += 1
            continue
        if has_subtraction_dipole(difference, int(x), int(y), fwhm):
            rejected['subtractionDipole'] += 1
            continue
        if any(math.hypot(x - previous['x'], y - previous['y']) < 2 * fwhm for previous in found):
            rejected['duplicate'] += 1
            continue
        ra, dec = wcs.pixel_to_world_values(difference_source['x'], difference_source['y'])
        found.append({'x': int(x), 'y': int(y),
                      'centroidX': difference_source['x'], 'centroidY': difference_source['y'],
                      'ringRadiusPx': max(5.0, fwhm * 3.0), 'ra': float(ra), 'dec': float(dec),
                      'snr': round(float(significance[y, x]), 2), 'difference': float(difference[y, x]),
                      'scienceContrast': science_source['localContrast'],
                      'shape': {'sharpness': difference_source['sharpness'],
                                'roundness': difference_source['roundness']},
                      'status': 'needs_followup'})
        if len(found) >= max_candidates:
            break
    return found, count, rejected


def write_candidate_products(difference_path, candidates, output_path, regions_path):
    """Bundle exact difference data plus lossless marker extensions and DS9 regions."""
    with fits.open(difference_path, memmap=False) as source_hdus:
        hdus = fits.HDUList([hdu.copy() for hdu in source_hdus])
    primary = next((hdu for hdu in hdus if hdu.data is not None and hdu.data.ndim == 2), None)
    if primary is None:
        hdus.close()
        raise ValueError('Difference FITS has no 2D image for candidate annotations')
    height, width = primary.data.shape
    mask = np.zeros((height, width), dtype=np.uint16)
    columns = {name: [] for name in ('ID', 'X_PEAK', 'Y_PEAK', 'X_CENTROID', 'Y_CENTROID',
                                    'RA_DEG', 'DEC_DEG', 'SNR', 'CONTRAST', 'RADIUS_PX')}
    region_lines = ['# Region file format: DS9 version 4.1',
                    'global color=red width=2 font="helvetica 10 normal" select=1 highlite=1',
                    'image']
    for index, candidate in enumerate(candidates, start=1):
        x = float(candidate.get('centroidX', candidate['x']))
        y = float(candidate.get('centroidY', candidate['y']))
        radius = float(candidate.get('ringRadiusPx', 5.0))
        if not all(np.isfinite(value) for value in (x, y, radius)) or radius <= 0:
            continue
        x0, x1 = max(0, math.floor(x - radius - 1)), min(width, math.ceil(x + radius + 2))
        y0, y1 = max(0, math.floor(y - radius - 1)), min(height, math.ceil(y + radius + 2))
        yy, xx = np.mgrid[y0:y1, x0:x1]
        circle = np.abs(np.hypot(xx - x, yy - y) - radius) <= 0.75
        region = mask[y0:y1, x0:x1]
        region[circle] = index
        columns['ID'].append(index)
        columns['X_PEAK'].append(int(candidate['x']))
        columns['Y_PEAK'].append(int(candidate['y']))
        columns['X_CENTROID'].append(x)
        columns['Y_CENTROID'].append(y)
        columns['RA_DEG'].append(float(candidate['ra']))
        columns['DEC_DEG'].append(float(candidate['dec']))
        columns['SNR'].append(float(candidate.get('snr', float('nan'))))
        columns['CONTRAST'].append(float(candidate.get('scienceContrast', float('nan'))))
        columns['RADIUS_PX'].append(radius)
        region_lines.append(
            f'circle({x + 1:.6f},{y + 1:.6f},{radius:.3f}) # text={{Candidate {index} · '
            f'RA {float(candidate["ra"]):.8f} Dec {float(candidate["dec"]):.8f}}}')

    mask_hdu = fits.ImageHDU(data=mask, name='CANDIDATE_MASK')
    for key, value in primary.header.items():
        if key.startswith(('CTYPE', 'CUNIT', 'CRVAL', 'CRPIX', 'CDELT', 'CD', 'PC', 'CROTA', 'RADESYS', 'EQUINOX')):
            mask_hdu.header[key] = value
    mask_hdu.header['BUNIT'] = 'candidate ID; zero means no marker'
    mask_hdu.header['COMMENT'] = 'Thin circular outlines; primary difference image is unmodified.'
    table_hdu = fits.BinTableHDU.from_columns([
        fits.Column(name='ID', format='I', array=np.asarray(columns['ID'], dtype=np.int16)),
        fits.Column(name='X_PEAK', format='J', unit='pix', array=np.asarray(columns['X_PEAK'], dtype=np.int32)),
        fits.Column(name='Y_PEAK', format='J', unit='pix', array=np.asarray(columns['Y_PEAK'], dtype=np.int32)),
        fits.Column(name='X_CENTROID', format='D', unit='pix', array=np.asarray(columns['X_CENTROID'], dtype=np.float64)),
        fits.Column(name='Y_CENTROID', format='D', unit='pix', array=np.asarray(columns['Y_CENTROID'], dtype=np.float64)),
        fits.Column(name='RA_DEG', format='D', unit='deg', array=np.asarray(columns['RA_DEG'], dtype=np.float64)),
        fits.Column(name='DEC_DEG', format='D', unit='deg', array=np.asarray(columns['DEC_DEG'], dtype=np.float64)),
        fits.Column(name='SNR', format='D', array=np.asarray(columns['SNR'], dtype=np.float64)),
        fits.Column(name='CONTRAST', format='D', array=np.asarray(columns['CONTRAST'], dtype=np.float64)),
        fits.Column(name='RADIUS_PX', format='D', unit='pixel', array=np.asarray(columns['RADIUS_PX'], dtype=np.float64)),
    ], name='CANDIDATES')
    table_hdu.header['COMMENT'] = 'X/Y pixel coordinates are zero-based; centroids are subpixel positions.'
    table_hdu.header['COMMENT'] = 'Sky positions are ICRS decimal degrees; all detections are unconfirmed.'
    hdus.append(mask_hdu)
    hdus.append(table_hdu)
    hdus.writeto(output_path, overwrite=True, checksum=True)
    hdus.close()
    Path(regions_path).write_text('\n'.join(region_lines) + '\n', encoding='utf-8')


# IAU/MPC observatory codes for Las Cumbres Observatory sites (SITEID header), so asteroid
# positions include the observer's parallax; anything else falls back to the geocentre (500).
LCO_SITE_CODES = {'lsc': 'W86', 'coj': 'Q63', 'cpt': 'K91', 'elp': 'V37', 'ogg': 'F65', 'tfn': 'Z21', 'tlv': '097'}


def _sexagesimal(text, hours):
    sign = -1 if text.strip().startswith('-') else 1
    parts = [float(part) for part in text.strip().lstrip('+-').split()]
    value = parts[0] + parts[1] / 60 + parts[2] / 3600
    return value * 15 if hours else sign * value


def known_solar_system_objects(wcs, shape, header):
    """Known asteroids and comets in the field at mid-exposure, from IMCCE SkyBoT.

    Only the field centre, radius and epoch are sent. Returns (objects, note).
    """
    from astropy.time import Time, TimeDelta
    date = str(header.get('DATE-OBS', '')).strip()
    if not date:
        return [], 'No DATE-OBS: known solar-system objects were not checked.'
    exposure = float(header.get('EXPTIME') or 0)
    epoch = Time(date.replace(' ', 'T'), scale='utc') + TimeDelta(exposure / 2, format='sec')
    height, width = shape
    ra, dec = wcs.pixel_to_world_values((width - 1) / 2, (height - 1) / 2)
    corners = wcs.pixel_to_world_values(np.array([0, width - 1, 0, width - 1]), np.array([0, 0, height - 1, height - 1]))
    radius = float(max(np.hypot((np.mod(corners[0] - ra + 180, 360) - 180) * math.cos(math.radians(dec)), corners[1] - dec)))
    site = str(header.get('SITEID', '')).strip().lower()
    location = str(header.get('MPCCODE') or header.get('OBSCODE') or LCO_SITE_CODES.get(site, '500'))
    query = urllib.parse.urlencode({'-ep': f'{epoch.jd:.6f}', '-ra': f'{float(ra):.6f}', '-dec': f'{float(dec):.6f}',
                                    '-rd': f'{min(radius * 1.05, 10):.5f}', '-mime': 'json', '-output': 'basic',
                                    # SkyBoT's observer-location parameter is "-observer" ("-loc" is silently ignored,
                                    # which drops the topocentric parallax: ~15" for a near-Earth asteroid at 0.4 au).
                                    '-observer': location, '-objFilter': '111', '-refsys': 'EQJ2000', '-from': 'AstroviaBin'})
    url = 'https://ssp.imcce.fr/webservices/skybot/api/conesearch.php?' + query
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'AstroviaBin private FITS analysis/1.0'})
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read(5_000_000).decode('utf-8').strip()
    except Exception as error:  # offline or service down: the analysis itself still completes
        return [], f'SkyBoT unavailable ({error}); known asteroids and comets were not checked.'
    if not payload.startswith('['):
        return [], 'SkyBoT found no known solar-system objects in this field.'
    objects = []
    for row in json.loads(payload):
        try:
            ora = _sexagesimal(row['RA (hms)'], True)
            odec = _sexagesimal(row['DEC (dms)'], False)
        except (KeyError, ValueError, IndexError):
            continue
        x, y = wcs.world_to_pixel_values(ora, odec)
        if not (np.isfinite(x) and np.isfinite(y) and 0 <= x < width and 0 <= y < height):
            continue
        name = f"({row['Num']}) {row['Name']}" if row.get('Num') else str(row.get('Name'))
        objects.append({'name': name, 'class': row.get('Class'), 'vmag': row.get('VMag (mag)'),
                        'ra': ora, 'dec': odec, 'x': round(float(x), 2), 'y': round(float(y), 2),
                        'positionErrorArcsec': row.get('Err (arcsec)'),
                        'rateArcsecPerHour': [row.get('dRA (arcsec/h)'), row.get('dDEC (arcsec/h)')]})
    return objects, f'SkyBoT ({location}, mid-exposure {epoch.isot}): {len(objects)} known solar-system object(s) in the field.'


def flag_known_objects(candidates, objects, wcs, exposure_seconds):
    """Marks candidates that coincide with a known asteroid or comet."""
    if not candidates or not objects:
        return
    scale = float(np.sqrt(abs(np.linalg.det(wcs.pixel_scale_matrix)))) * 3600
    for candidate in candidates:
        best = None
        for item in objects:
            rate = math.hypot(*(float(value or 0) for value in item['rateArcsecPerHour']))
            # Allow for the positional uncertainty, a few pixels, and motion during the exposure.
            tolerance = max(10.0, 3 * scale, 3 * float(item.get('positionErrorArcsec') or 0), rate * exposure_seconds / 3600)
            separation = math.hypot((candidate['ra'] - item['ra']) * math.cos(math.radians(item['dec'])), candidate['dec'] - item['dec']) * 3600
            if separation <= tolerance and (best is None or separation < best[1]):
                best = (item, separation)
        if best:
            candidate['status'] = 'known_solar_system_object'
            candidate['knownObject'] = {'name': best[0]['name'], 'class': best[0]['class'],
                                        'vmag': best[0]['vmag'], 'separationArcsec': round(best[1], 1)}


def check_candidate(config):
    """Check a saved candidate against an independent local FITS exposure."""
    work = Path(config['work']).resolve()
    work.mkdir(parents=True, exist_ok=True)
    followup = work / 'followup.fits'
    reduced_image(config['comparison'], followup, int(config['maxDimension']))
    followup_wcs = ensure_wcs(followup, config['comparison'], config.get('comparisonHint'),
                              work / 'solve')
    data, header = mono_data(followup)
    x, y = followup_wcs.world_to_pixel_values(float(config['ra']), float(config['dec']))
    if not np.isfinite(x) or not np.isfinite(y):
        raise ValueError('Candidate coordinates are outside the follow-up WCS')
    px, py = int(round(float(x))), int(round(float(y)))
    if px < 20 or py < 20 or px >= data.shape[1] - 20 or py >= data.shape[0] - 20:
        raise ValueError('Candidate is outside the usable follow-up field')
    source = local_point_source(data, px, py, float(config['sourceFwhm']))
    first_filter = str(config.get('sourceFilter') or '').strip().lower()
    second_filter = str(header.get('FILTER', '')).strip().lower()
    first_date = str(config.get('sourceDate') or '').strip()
    second_date = str(header.get('DATE-OBS', '')).strip()
    comparable = bool(first_filter and second_filter and first_filter == second_filter)
    independent_epoch = bool(first_date and second_date and first_date != second_date)
    if not comparable or not independent_epoch:
        status = 'inconclusive'
    elif source:
        status = 'repeat_detection'
    else:
        status = 'not_detected'
    return {'status': status, 'sourceFound': bool(source), 'source': source,
            'followupImageId': int(config['comparisonImageId']),
            'pixel': {'x': round(float(x), 2), 'y': round(float(y), 2)},
            'sourceFilter': first_filter or None, 'followupFilter': second_filter or None,
            'sourceDate': first_date or None, 'followupDate': second_date or None,
            'comparableFilter': comparable, 'independentEpoch': independent_epoch,
            'note': 'Repeat detection supports a candidate but does not prove a supernova. '
                    'Check moving objects, artifacts, cataloged variables, and additional epochs.'}


def main(config_path):
    config = json.loads(Path(config_path).read_text())
    work = Path(config['work']).resolve()
    work.mkdir(parents=True, exist_ok=True)
    science = work / 'science.fits'
    reference = work / 'reference.fits'
    aligned = work / 'reference-aligned.fits'
    difference = work / 'difference.fits'
    noise = work / 'noise.fits'
    convolved = work / 'convolved.fits'
    bad_mask = work / 'bad-pixels.fits'
    write_state(work, 'preparing')
    factor = reduced_image(config['science'], science, int(config['maxDimension']))
    hint = dict(config.get('scienceHint') or {}, factor=factor)
    science_wcs = ensure_wcs(science, config['science'], hint, work / 'science-solve', config.get('scienceWcs'))
    science_data, science_header = mono_data(science)
    write_state(work, 'reference')
    if config['referenceMode'] == 'survey':
        provenance = fetch_reference(science_wcs, science_data.shape, reference, config['survey'], science_header)
    else:
        reference_factor = reduced_image(config['reference'], reference, int(config['maxDimension']))
        ref_hint = dict(config.get('referenceHint') or {}, factor=reference_factor)
        ensure_wcs(reference, config['reference'], ref_hint, work / 'reference-solve', config.get('referenceWcs'))
        provenance = {'localImageId': config['referenceImageId']}
    write_state(work, 'aligning')
    coverage, mask, reference_flux_scale = align_reference(reference, science_wcs, science_header, science_data.shape, aligned)
    science_invalid_path = work / 'science-invalid-mask.fits'
    science_invalid = (mono_data(science_invalid_path)[0] > 0) if science_invalid_path.exists() else ~np.isfinite(science_data)
    aligned_data, _ = mono_data(aligned)
    fwhm_science = estimate_fwhm(science_data, science_invalid)
    # Refine the WCS-only registration with matched stars, then resample the reference once more.
    correction, registration = registration_correction(science_data, science_invalid, aligned_data, mask > 0,
                                                       fwhm_science or 2.5)
    if correction is not None:
        coverage, mask, reference_flux_scale = align_reference(reference, science_wcs, science_header,
                                                               science_data.shape, aligned, correction)
        aligned_data, _ = mono_data(aligned)
    fits.writeto(work / 'reference-mask.fits', mask, overwrite=True)
    write_state(work, 'subtracting')
    fwhm_reference = estimate_fwhm(aligned_data, mask > 0)
    # Mask clipped bright stars and bleed trails in the reference before subtracting and detecting.
    bright = bright_source_mask(aligned_data, mask > 0, fwhm_reference)
    bright |= elongated_source_mask(aligned_data, mask > 0, fwhm_reference)
    try:
        bright |= catalog_bright_star_mask(science_wcs, science_data.shape, max(fwhm_science or 0, fwhm_reference or 0) or 3)
    except Exception as error:  # the catalogue mask is an improvement, never a reason to fail
        print(f'Bright-star catalogue mask unavailable: {error}', file=sys.stderr)
    if bright.any():
        mask = np.where(bright, 1, mask).astype(np.uint8)
        fits.writeto(work / 'reference-mask.fits', mask, overwrite=True)
    user_args = config.get('hotpantsArgs', [])
    auto_args, auto_settings = default_hotpants_args(user_args, science_data, science_header, aligned_data, mask,
                                                     fwhm_science, fwhm_reference, science_invalid)
    command = [os.environ.get('HOTPANTS_BIN', 'hotpants'), '-inim', str(science), '-tmplim', str(aligned), '-outim', str(difference),
               '-oni', str(noise), '-oci', str(convolved), '-omi', str(bad_mask),
               '-tmi', str(work / 'reference-mask.fits')]
    if science_invalid_path.exists():
        command += ['-imi', str(science_invalid_path)]
    command += ['-hki', '-n', 'i'] + auto_args + user_args
    result = subprocess.run(command, capture_output=True, text=True, timeout=int(config.get('timeoutSeconds', 900)), check=False)
    (work / 'hotpants.log').write_text((result.stdout + '\n' + result.stderr)[-300000:])
    if result.returncode or not difference.exists():
        raise RuntimeError('HOTPANTS failed: ' + (result.stderr or result.stdout)[-1200:])
    write_state(work, 'detecting')
    candidates, detected_total, rejected = detect_candidates(
        difference, noise, bad_mask, mask, science, aligned, science_wcs,
        float(config['thresholdSigma']), int(config['maxCandidates']),
        float(config.get('sourceFwhm') or fwhm_science or 3))
    solar_system_objects, solar_system_note = known_solar_system_objects(science_wcs, science_data.shape, science_header)
    flag_known_objects(candidates, solar_system_objects, science_wcs, float(science_header.get('EXPTIME') or 0))
    write_candidate_products(difference, candidates, work / 'difference-candidates.fits',
                             work / 'difference-candidates.reg')
    science_filter = str(science_header.get('FILTER', '')).strip()
    comparison_warning = ('Historical survey references can have a different bandpass, resolution, epoch, '
                          'and photometric calibration. Candidate detections require an independent '
                          'same-band observation before they can be trusted.'
                          if config['referenceMode'] == 'survey' else
                          'A second local FITS is not independent confirmation unless it is from a '
                          'different exposure or observing epoch with a compatible filter.')
    return {'reference': provenance, 'coverage': coverage, 'scaleFactor': factor,
            'referencePixelAreaFluxScale': reference_flux_scale,
            'analysisVersion': 2, 'sourceFilter': science_filter,
            'sourceDate': str(science_header.get('DATE-OBS', '')).strip(),
            'width': science_data.shape[1], 'height': science_data.shape[0],
            'candidates': candidates, 'detectedTotal': detected_total,
            'solarSystemObjects': solar_system_objects, 'solarSystemCheck': solar_system_note,
            'brightStarMaskFraction': round(float(bright.mean()), 5),
            'cosmicRayPixels': science_header.get('COSMICPX'),
            'registration': registration,
            'autoSettings': {**auto_settings, 'detectionFwhmPx': float(config.get('sourceFwhm') or fwhm_science or 3),
                             'hotpantsArgs': auto_args},
            'rejectedCandidates': rejected, 'comparisonWarning': comparison_warning,
            'files': ['science.fits', 'reference.fits', 'reference-aligned.fits', 'difference.fits',
                      'difference-candidates.fits', 'difference-candidates.reg',
                      'noise.fits', 'convolved.fits', 'bad-pixels.fits', 'hotpants.log'],
            'note': 'Candidates passed local point-source, reference-absence, mask, and dipole checks, but remain unconfirmed.'}


if __name__ == '__main__':
    try:
        config_path = Path(sys.argv[1])
        config = json.loads(config_path.read_text())
        if config.get('mode') == 'candidate-check':
            result = check_candidate(config)
        else:
            result = main(config_path)
            result_path = config_path.with_name('result.json')
            temporary = result_path.with_suffix('.tmp')
            temporary.write_text(json.dumps(result))
            temporary.replace(result_path)
        print(json.dumps(result), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
