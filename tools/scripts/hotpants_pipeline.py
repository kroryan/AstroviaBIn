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
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from scipy.ndimage import map_coordinates, maximum_filter, zoom


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
    if factor > 1:
        data = zoom(data, (1 / factor, 1 / factor), order=1, prefilter=False)
        if WCS(header).has_celestial:
            wcs = WCS(header).celestial.slice((slice(None, None, factor), slice(None, None, factor)))
            source_header = header
            header = fits.Header()
            for keyword in ('OBJECT', 'DATE-OBS', 'EXPTIME', 'FILTER', 'INSTRUME', 'TELESCOP', 'GAIN', 'BUNIT'):
                if keyword in source_header:
                    header[keyword] = source_header[keyword]
            header.update(wcs.to_header(relax=True))
    data[~np.isfinite(data)] = 0
    fits.writeto(output, data, header=header, overwrite=True)
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
    request = urllib.request.Request(url, headers={'User-Agent': 'Sidereal private FITS analysis/1.0'})
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


def align_reference(reference_path, science_wcs, shape, output):
    reference, header = mono_data(reference_path)
    reference_wcs = WCS(header).celestial
    if not reference_wcs.has_celestial:
        raise ValueError('Reference FITS has no WCS. Plate solve the reference locally first.')
    height, width = shape
    aligned = np.zeros((height, width), dtype=np.float32)
    mask = np.ones((height, width), dtype=np.uint8)
    for row in range(0, height, 64):
        stop = min(row + 64, height)
        yy, xx = np.mgrid[row:stop, 0:width]
        ra, dec = science_wcs.pixel_to_world_values(xx, yy)
        rx, ry = reference_wcs.world_to_pixel_values(ra, dec)
        good = np.isfinite(rx) & np.isfinite(ry) & (rx >= 1) & (ry >= 1) & (rx < reference.shape[1] - 2) & (ry < reference.shape[0] - 2)
        values = map_coordinates(reference, [np.nan_to_num(ry), np.nan_to_num(rx)], order=1, mode='constant', cval=0)
        values[~good] = 0
        aligned[row:stop] = values
        mask[row:stop] = ~good
    coverage = float(np.mean(mask == 0))
    if coverage < 0.3:
        raise ValueError(f'Reference overlaps only {coverage:.0%} of the science image; choose a matching field')
    fits.writeto(output, aligned, header=science_wcs.to_header(relax=True), overwrite=True)
    return coverage, mask


def detect_candidates(difference_path, noise_path, bad_mask_path, mask, wcs, threshold, max_candidates):
    difference, _ = mono_data(difference_path)
    noise, _ = mono_data(noise_path)
    bad_mask, _ = mono_data(bad_mask_path)
    if noise.shape != difference.shape or bad_mask.shape != difference.shape:
        raise ValueError('HOTPANTS output layers do not match the difference image')
    valid = (mask == 0) & (bad_mask == 0) & np.isfinite(difference) & np.isfinite(noise) & (noise > 0)
    significance = np.zeros_like(difference)
    significance[valid] = difference[valid] / noise[valid]
    significance = np.clip(significance, -1e5, 1e5)
    edge = max(16, int(min(difference.shape) * 0.01))
    valid[:edge] = False
    valid[-edge:] = False
    valid[:, :edge] = False
    valid[:, -edge:] = False
    peaks = (significance >= threshold) & (significance == maximum_filter(significance, size=7)) & valid
    positions = np.argwhere(peaks)
    count = len(positions)
    found = []
    if count:
        ranks = np.argsort(significance[positions[:, 0], positions[:, 1]])[::-1]
    else:
        ranks = []
    for index in ranks:
        if len(found) >= max_candidates:
            break
        y, x = positions[index]
        neighborhood = significance[y - 2:y + 3, x - 2:x + 3]
        if np.count_nonzero(neighborhood >= threshold * 0.5) < 3:
            continue  # isolated one-pixel defects are not plausible point sources
        ra, dec = wcs.pixel_to_world_values(float(x), float(y))
        found.append({'x': int(x), 'y': int(y), 'ra': float(ra), 'dec': float(dec),
                      'snr': round(float(significance[y, x]), 2), 'difference': float(difference[y, x]),
                      'status': 'unconfirmed'})
    return found, count


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
    science_data, _ = mono_data(science)
    write_state(work, 'reference')
    if config['referenceMode'] == 'survey':
        provenance = fetch_reference(science_wcs, science_data.shape, reference, config['survey'])
    else:
        reference_factor = reduced_image(config['reference'], reference, int(config['maxDimension']))
        ref_hint = dict(config.get('referenceHint') or {}, factor=reference_factor)
        ensure_wcs(reference, config['reference'], ref_hint, work / 'reference-solve')
        provenance = {'localImageId': config['referenceImageId']}
    write_state(work, 'aligning')
    coverage, mask = align_reference(reference, science_wcs, science_data.shape, aligned)
    fits.writeto(work / 'reference-mask.fits', mask, overwrite=True)
    write_state(work, 'subtracting')
    command = ['hotpants', '-inim', str(science), '-tmplim', str(aligned), '-outim', str(difference),
               '-oni', str(noise), '-oci', str(convolved), '-omi', str(bad_mask),
               '-tmi', str(work / 'reference-mask.fits'), '-hki'] + config.get('hotpantsArgs', [])
    result = subprocess.run(command, capture_output=True, text=True, timeout=int(config.get('timeoutSeconds', 900)), check=False)
    (work / 'hotpants.log').write_text((result.stdout + '\n' + result.stderr)[-300000:])
    if result.returncode or not difference.exists():
        raise RuntimeError('HOTPANTS failed: ' + (result.stderr or result.stdout)[-1200:])
    write_state(work, 'detecting')
    candidates, detected_total = detect_candidates(difference, noise, bad_mask, mask, science_wcs,
                                                     float(config['thresholdSigma']), int(config['maxCandidates']))
    return {'reference': provenance, 'coverage': coverage, 'scaleFactor': factor,
            'width': science_data.shape[1], 'height': science_data.shape[0],
            'candidates': candidates, 'detectedTotal': detected_total,
            'files': ['science.fits', 'reference.fits', 'reference-aligned.fits', 'difference.fits',
                      'noise.fits', 'convolved.fits', 'bad-pixels.fits', 'hotpants.log'],
            'note': 'Candidates are unconfirmed. Survey differences, registration, saturation, and artifacts can imitate transients.'}


if __name__ == '__main__':
    try:
        result = main(sys.argv[1])
        result_path = Path(sys.argv[1]).with_name('result.json')
        temporary = result_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result))
        temporary.replace(result_path)
        print(json.dumps(result), flush=True)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
