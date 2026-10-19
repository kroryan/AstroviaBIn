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
from astropy.wcs import WCS
from photutils.detection import DAOStarFinder
from scipy.ndimage import binary_dilation, map_coordinates, maximum_filter


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


def reduced_image(source, output, max_dimension):
    data, header = mono_data(source)
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
        if WCS(header).has_celestial:
            block_center = (factor - 1) / 2
            slice_start = math.floor(block_center)
            # These slices follow the NumPy array's (y, x) order.
            source_wcs = WCS(header).celestial
            source_crpix = source_wcs.wcs.crpix.copy()
            source_sip_crpix = source_wcs.sip.crpix.copy() if source_wcs.sip is not None else None
            wcs = source_wcs.slice((slice(slice_start, slice_start + block_height * factor, factor),
                                    slice(slice_start, slice_start + block_width * factor, factor)),
                                   numpy_order=True)
            # Derive CRPIX directly from the geometric center of each integration
            # bin, avoiding slice-origin convention and odd/even half-pixel drift.
            wcs.wcs.crpix = (source_crpix - block_center - 1 + factor) / factor
            if wcs.sip is not None:
                wcs.sip.crpix = (source_sip_crpix - block_center - 1 + factor) / factor
            source_header = header
            header = fits.Header()
            for keyword in ('OBJECT', 'DATE-OBS', 'EXPTIME', 'FILTER', 'INSTRUME', 'TELESCOP', 'GAIN', 'BUNIT'):
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
    fits.writeto(output, data, header=header, overwrite=True)
    invalid_path = output.with_name(output.stem + '-invalid-mask.fits')
    fits.writeto(invalid_path, invalid.astype(np.uint8), header=header, overwrite=True)
    return factor


def ensure_wcs(image_path, original_path, hint, work):
    with fits.open(image_path, mode='update') as hdus:
        if WCS(hdus[0].header).has_celestial:
            return WCS(hdus[0].header).celestial
    work.mkdir(parents=True, exist_ok=True)
    config = work / 'backend.cfg'
    config.write_text('add_path ' + os.environ.get('ASTROMETRY_INDEX_DIR', '/usr/share/astrometry') + '\nautoindex\n')
    wcs_path = work / 'local.wcs'
    base = ['solve-field', '--overwrite', '--no-plots', '--downsample', '1',
            '--backend-config', str(config), '--dir', str(work), '--wcs', str(wcs_path),
            '--cpulimit', '120']
    attempts = []
    if hint and hint.get('ra') is not None and hint.get('dec') is not None:
        attempts.append(['--ra', str(hint['ra']), '--dec', str(hint['dec']), '--radius', '5'])
    attempts.append([])
    result = None
    for positional_hint in attempts:
        result = subprocess.run(base + positional_hint + [str(image_path)],
                                capture_output=True, text=True, timeout=150, check=False)
        if result.returncode == 0 and wcs_path.exists():
            break
    if result.returncode or not wcs_path.exists():
        raise RuntimeError('Local Astrometry.net could not determine WCS: ' + (result.stderr or result.stdout)[-1200:])
    solution = WCS(fits.getheader(wcs_path)).celestial
    with fits.open(image_path, mode='update') as hdus:
        hdus[0].header.update(solution.to_header(relax=True))
    return solution


def fetch_reference(wcs, shape, destination, survey):
    if survey == 'Pan-STARRS1 r stack':
        return fetch_pan_starrs_reference(wcs, shape, destination)
    if survey not in ('DSS2 Red', 'DSS2 Blue', 'DSS2 IR'):
        raise ValueError('Unsupported survey')
    height, width = shape
    ra, dec = wcs.pixel_to_world_values((width - 1) / 2, (height - 1) / 2)
    corners = wcs.pixel_to_world_values(np.array([0, width - 1, 0, width - 1]),
                                       np.array([0, 0, height - 1, height - 1]))
    offsets = np.hypot((np.mod(corners[0] - ra + 180, 360) - 180) * math.cos(math.radians(dec)), corners[1] - dec)
    fov = float(max(offsets) * 2.3)
    if not 0 < fov <= 8:
        raise ValueError('The FITS field is too large for an automatic DSS reference; choose a local FITS reference')
    query = urllib.parse.urlencode({'Survey': survey, 'Position': f'{ra:.8f},{dec:.8f}',
                                    'Return': 'FITS', 'Size': f'{fov:.6f}', 'Pixels': '2048'})
    url = 'https://skyview.gsfc.nasa.gov/cgi-bin/images?' + query
    request = urllib.request.Request(url, headers={'User-Agent': 'AstroviaBin private FITS analysis/1.0'})
    with urllib.request.urlopen(request, timeout=180) as response, destination.open('wb') as output:
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 120 * 1024 * 1024:
                raise ValueError('The survey reference exceeds the 120 MB safety limit')
            output.write(chunk)
    with destination.open('rb') as reference:
        if reference.read(9) != b'SIMPLE  =':
            raise ValueError('The reference survey did not return a FITS file')
    return {'survey': survey, 'url': url, 'ra': float(ra), 'dec': float(dec), 'fieldDegrees': fov}


def fetch_pan_starrs_reference(wcs, shape, destination):
    """Fetch a PS1 DR2 r-band stack cutout; send only WCS coordinates to MAST."""
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
        'ra': f'{ra:.8f}', 'dec': f'{dec:.8f}', 'filters': 'r', 'type': 'stack', 'sep': 'comma'})
    headers = {'User-Agent': 'AstroviaBin private FITS analysis/1.0'}
    request = urllib.request.Request(lookup_url, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = list(csv.DictReader(StringIO(response.read(2_000_000).decode('utf-8'))))
    row = next((item for item in rows if item.get('filter') == 'r' and item.get('filename')), None)
    if row is None:
        raise ValueError('Pan-STARRS1 has no r-band stack coverage at this position. Choose DSS2 or a local FITS reference.')

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
    return {'survey': 'Pan-STARRS1 DR2 r stack (MAST)', 'url': cutout_url,
            'ra': float(ra), 'dec': float(dec), 'fieldDegrees': field_degrees,
            'pixelScaleArcsec': 0.25, 'referenceEpoch': 'multi-epoch stack'}


def _pixel_area(wcs):
    area = wcs.proj_plane_pixel_area()
    return float(area.value if hasattr(area, 'value') else area)


def _surface_brightness_units(header):
    unit = str(header.get('BUNIT', '')).lower().replace(' ', '')
    return any(marker in unit for marker in ('/sr', 'sr-1', 'sr**-1', '/arcsec2', 'arcsec-2', 'deg-2'))


def align_reference(reference_path, science_wcs, science_header, shape, output):
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


def has_subtraction_dipole(difference, x, y, fwhm):
    radius = max(8, math.ceil(fwhm * 3))
    patch = difference[y - radius:y + radius + 1, x - radius:x + radius + 1]
    if patch.shape != (2 * radius + 1, 2 * radius + 1):
        return True
    yy, xx = np.ogrid[-radius:radius + 1, -radius:radius + 1]
    distance = np.hypot(xx, yy)
    sky = float(np.median(patch[distance >= radius * 0.75]))
    core = float(patch[radius, radius] - sky)
    opposite = float(np.min(patch[(distance >= max(2, fwhm * 0.8)) & (distance <= radius)] - sky))
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
    valid = (mask == 0) & (bad_mask == 0) & np.isfinite(difference) & np.isfinite(noise) & (noise > 0)
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
        if local_point_source(reference, int(x), int(y), fwhm):
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
    science_wcs = ensure_wcs(science, config['science'], hint, work / 'science-solve')
    science_data, science_header = mono_data(science)
    write_state(work, 'reference')
    if config['referenceMode'] == 'survey':
        provenance = fetch_reference(science_wcs, science_data.shape, reference, config['survey'])
    else:
        reference_factor = reduced_image(config['reference'], reference, int(config['maxDimension']))
        ref_hint = dict(config.get('referenceHint') or {}, factor=reference_factor)
        ensure_wcs(reference, config['reference'], ref_hint, work / 'reference-solve')
        provenance = {'localImageId': config['referenceImageId']}
    write_state(work, 'aligning')
    coverage, mask, reference_flux_scale = align_reference(reference, science_wcs, science_header, science_data.shape, aligned)
    fits.writeto(work / 'reference-mask.fits', mask, overwrite=True)
    write_state(work, 'subtracting')
    command = ['hotpants', '-inim', str(science), '-tmplim', str(aligned), '-outim', str(difference),
               '-oni', str(noise), '-oci', str(convolved), '-omi', str(bad_mask),
               '-tmi', str(work / 'reference-mask.fits'), '-hki', '-n', 'i'] + config.get('hotpantsArgs', [])
    result = subprocess.run(command, capture_output=True, text=True, timeout=int(config.get('timeoutSeconds', 900)), check=False)
    (work / 'hotpants.log').write_text((result.stdout + '\n' + result.stderr)[-300000:])
    if result.returncode or not difference.exists():
        raise RuntimeError('HOTPANTS failed: ' + (result.stderr or result.stdout)[-1200:])
    write_state(work, 'detecting')
    candidates, detected_total, rejected = detect_candidates(
        difference, noise, bad_mask, mask, science, aligned, science_wcs,
        float(config['thresholdSigma']), int(config['maxCandidates']), float(config.get('sourceFwhm', 3)))
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
