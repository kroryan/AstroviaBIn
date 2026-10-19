#!/usr/bin/env python3
"""Verification products for a finished HOTPANTS analysis.

For every candidate: a PSF fit on the difference image with formal errors, astrometry tied
locally to Gaia DR3 (proper motions propagated to the observation epoch), a Gaia-calibrated
magnitude, cross-matches (Gaia, AAVSO VSX, SIMBAD host galaxies, known asteroids), a reasoned
verdict, marked science/reference/difference stamps, a blink GIF and a PDF report.

Online catalogues are optional: without a connection the WCS position and the offline checks
are reported and the PDF says what could not be verified.

Usage: hotpants_report.py <analysis directory> [image title]
"""

import datetime
import json
import math
import sys
import urllib.parse
import urllib.request
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
import astropy.units as u
from astropy.io import fits
from astropy.time import Time
from astropy.visualization import ZScaleInterval
from astropy.wcs import WCS
from scipy.optimize import least_squares

import os
import tempfile
# The service account may have no writable home for matplotlib's font cache.
os.environ.setdefault('MPLCONFIGDIR', os.path.join(tempfile.gettempdir(), 'astroviabin-matplotlib'))
import matplotlib  # noqa: E402
matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from matplotlib.patches import Circle  # noqa: E402

warnings.simplefilter('ignore')

TIMEOUT = 25
MAX_VERIFIED = 50
USER_AGENT = 'AstroviaBin/1.0 (HOTPANTS candidate verification)'
CYAN, MAGENTA, YELLOW, RED = '#00c8d7', '#ff2bd6', '#f9d302', '#ff3b3b'


# ----------------------------------------------------------------------------- data access

def load(path):
    with fits.open(path, memmap=False) as hdus:
        hdu = next(h for h in hdus if h.data is not None and h.data.ndim == 2)
        return np.asarray(hdu.data, dtype=np.float64), hdu.header.copy()


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.read().decode('utf-8', 'replace')


def vizier(source, ra, dec, radius_arcsec, columns, extra=None):
    """Rows of a VizieR cone search as dicts (tab-separated output, units/dashes skipped)."""
    params = {'-source': source, '-c': f'{ra:.7f} {dec:+.7f}', '-c.rs': f'{radius_arcsec:.2f}',
              '-out': ','.join(columns), '-out.max': '2000', '-out.add': '_r', '-sort': '_r'}
    params.update(extra or {})
    text = fetch('https://vizier.cds.unistra.fr/viz-bin/asu-tsv?' + urllib.parse.urlencode(params))
    header, rows = None, []
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        cells = [cell.strip() for cell in line.split('\t')]
        if header is None:
            header = cells
            continue
        if set(line.strip()) <= set('-\t ') or len(cells) != len(header):
            continue
        if cells[0] and not cells[0][0].isdigit() and cells[0] in ('arcmin', 'arcsec', 'deg'):
            continue
        rows.append(dict(zip(header, cells)))
    # The first data line after the header holds units.
    return [row for row in rows if not row.get('_r', '').startswith(('arcmin', 'arcsec', 'deg'))]


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def gaia_stars(ra, dec, radius_arcsec, epoch):
    """Gaia DR3 stars (G < 20) around a position, propagated from J2016.0 to `epoch`."""
    rows = vizier('I/355/gaiadr3', ra, dec, radius_arcsec,
                  ['Source', 'RA_ICRS', 'DE_ICRS', 'pmRA', 'pmDE', 'Gmag', 'RUWE'], {'Gmag': '<20'})
    stars = []
    years = epoch - 2016.0
    for row in rows:
        r, d, g = number(row.get('RA_ICRS')), number(row.get('DE_ICRS')), number(row.get('Gmag'))
        if r is None or d is None or g is None:
            continue
        pmra, pmdec = number(row.get('pmRA')) or 0.0, number(row.get('pmDE')) or 0.0
        d_now = d + pmdec * years / 3.6e6
        r_now = r + pmra * years / 3.6e6 / max(1e-6, math.cos(math.radians(d)))
        stars.append({'source': row.get('Source'), 'ra': r_now, 'dec': d_now, 'g': g,
                      'pmra': pmra, 'pmdec': pmdec, 'ruwe': number(row.get('RUWE'))})
    return stars


def vsx_variables(ra, dec, radius_arcsec):
    rows = vizier('B/vsx/vsx', ra, dec, radius_arcsec, ['Name', 'Type', 'max', 'min', 'RAJ2000', 'DEJ2000'])
    result = []
    for row in rows:
        r, d = number(row.get('RAJ2000')), number(row.get('DEJ2000'))
        if r is None or d is None:
            continue
        result.append({'name': row.get('Name'), 'type': row.get('Type'), 'max': row.get('max'),
                       'min': row.get('min'), 'ra': r, 'dec': d})
    return result


def simbad_objects(ra, dec, radius_arcsec):
    query = ("SELECT TOP 20 main_id, otype, ra, dec, DISTANCE(POINT('ICRS', ra, dec), "
             f"POINT('ICRS', {ra:.7f}, {dec:.7f})) AS dist FROM basic WHERE CONTAINS(POINT('ICRS', ra, dec), "
             f"CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {radius_arcsec / 3600:.6f})) = 1 ORDER BY dist")
    params = urllib.parse.urlencode({'request': 'doQuery', 'lang': 'adql', 'format': 'json', 'query': query})
    data = json.loads(fetch('https://simbad.cds.unistra.fr/simbad/sim-tap/sync?' + params)).get('data') or []
    return [{'name': ' '.join(str(name).split()), 'type': str(otype), 'ra': float(r), 'dec': float(d),
             'separationArcsec': round(float(dist) * 3600, 2)} for name, otype, r, d, dist in data
            if r is not None and d is not None]


# ------------------------------------------------------------------------------- measuring

def gaussian_fit(data, noise, x0, y0, fwhm, radius=None):
    """Weighted 2D circular Gaussian + background fit. Returns position, formal errors, flux."""
    radius = radius or max(4, int(math.ceil(2.5 * fwhm)))
    xi, yi = int(round(x0)), int(round(y0))
    y_lo, y_hi, x_lo, x_hi = yi - radius, yi + radius + 1, xi - radius, xi + radius + 1
    if y_lo < 0 or x_lo < 0 or y_hi > data.shape[0] or x_hi > data.shape[1]:
        return None
    patch = data[y_lo:y_hi, x_lo:x_hi]
    sigma = noise[y_lo:y_hi, x_lo:x_hi] if noise is not None else np.full(patch.shape, float(np.std(patch)) or 1.0)
    good = np.isfinite(patch) & np.isfinite(sigma) & (sigma > 0)
    if good.sum() < 12:
        return None
    yy, xx = np.mgrid[y_lo:y_hi, x_lo:x_hi]
    background = float(np.median(patch[good]))
    amplitude = float(patch[yi - y_lo, xi - x_lo] - background)
    if amplitude <= 0:
        amplitude = float(np.nanmax(patch) - background)
    width = max(0.4, fwhm / 2.3548)

    def residual(parameters):
        a, xc, yc, s, b = parameters
        model = a * np.exp(-((xx - xc) ** 2 + (yy - yc) ** 2) / (2 * s * s)) + b
        return ((patch - model) / sigma)[good]

    try:
        fit = least_squares(residual, [amplitude, x0, y0, width, background],
                            bounds=([0, x0 - 3, y0 - 3, 0.3, -np.inf], [np.inf, x0 + 3, y0 + 3, 4 * width + 2, np.inf]))
    except Exception:
        return None
    a, xc, yc, s, b = fit.x
    dof = max(1, good.sum() - 5)
    chi2 = float(np.sum(fit.fun ** 2)) / dof
    try:
        covariance = np.linalg.inv(fit.jac.T @ fit.jac) * max(1.0, chi2)
        errors = np.sqrt(np.clip(np.diag(covariance), 0, None))
    except np.linalg.LinAlgError:
        errors = np.full(5, np.nan)
    flux = 2 * math.pi * a * s * s
    flux_error = flux * math.hypot(errors[0] / a if a else 0, 2 * errors[3] / s if s else 0)
    return {'x': float(xc), 'y': float(yc), 'xErr': float(errors[1]), 'yErr': float(errors[2]),
            'fwhm': float(2.3548 * s), 'flux': float(flux), 'fluxErr': float(flux_error),
            'peak': float(a), 'reducedChi2': round(chi2, 2), 'converged': bool(fit.success)}


def aperture_flux(data, x, y, radius, noise=None):
    yy, xx = np.ogrid[:data.shape[0], :data.shape[1]]
    y0, y1 = max(0, int(y - 3 * radius)), min(data.shape[0], int(y + 3 * radius) + 2)
    x0, x1 = max(0, int(x - 3 * radius)), min(data.shape[1], int(x + 3 * radius) + 2)
    patch = data[y0:y1, x0:x1]
    distance = np.hypot(xx[:, x0:x1] - x, yy[y0:y1, :] - y)
    inside = (distance <= radius) & np.isfinite(patch)
    ring = (distance >= 1.8 * radius) & (distance <= 2.8 * radius) & np.isfinite(patch)
    if inside.sum() < 3 or ring.sum() < 8:
        return None, None
    background = float(np.median(patch[ring]))
    flux = float(np.sum(patch[inside] - background))
    error = None
    if noise is not None:
        error = float(np.sqrt(np.nansum(noise[y0:y1, x0:x1][inside] ** 2)))
    return flux, error


def pixel_scale_arcsec(wcs):
    return float(np.sqrt(abs(np.linalg.det(wcs.pixel_scale_matrix)))) * 3600


def observation_epoch(header):
    try:
        return float(Time(str(header.get('DATE-OBS'))).decimalyear)
    except Exception:
        return 2016.0


def local_calibration(science, wcs, x, y, fwhm, stars, saturation):
    """Local astrometric offset and photometric zero point from Gaia stars near the candidate."""
    scale = pixel_scale_arcsec(wcs)
    offsets, zero_points = [], []
    aperture = max(2.0, 1.5 * fwhm)
    for star in stars:
        if star['g'] < 10 or (star.get('ruwe') or 1) > 1.4:
            continue
        sx, sy = wcs.world_to_pixel_values(star['ra'], star['dec'])
        sx, sy = float(sx), float(sy)
        if not (10 <= sx < science.shape[1] - 10 and 10 <= sy < science.shape[0] - 10):
            continue
        if math.hypot(sx - x, sy - y) < 2 * fwhm:
            continue
        fit = gaussian_fit(science, None, sx, sy, fwhm)
        if not fit or not fit['converged'] or fit['flux'] <= 0:
            continue
        if saturation and fit['peak'] + np.median(science) > 0.8 * saturation:
            continue
        if abs(fit['fwhm'] - fwhm) > 0.6 * fwhm or math.hypot(fit['x'] - sx, fit['y'] - sy) > 3:
            continue
        offsets.append((fit['x'] - sx, fit['y'] - sy, sx - x, sy - y, star['g']))
        flux, _ = aperture_flux(science, fit['x'], fit['y'], aperture)
        if flux and flux > 0 and 12 <= star['g'] <= 19:
            zero_points.append(star['g'] + 2.5 * math.log10(flux))
        if len(offsets) >= 80:
            break
    result = {'starsUsed': len(offsets), 'zeroPointStars': len(zero_points)}
    if len(offsets) >= 3:
        offsets = np.asarray(offsets)
        vectors, positions, magnitudes = offsets[:, :2], offsets[:, 2:4], offsets[:, 4]
        if len(offsets) >= 12:
            # Offset plus gradient around the candidate (the solution's distortion, or a stack's
            # residual field rotation, varies across the calibration region); sigma-clipped.
            matrix = np.column_stack([np.ones(len(offsets)), positions])
            use = np.ones(len(offsets), dtype=bool)
            for _ in range(4):
                coefficients = np.linalg.lstsq(matrix[use], vectors[use], rcond=None)[0]
                residual = np.hypot(*(vectors - matrix @ coefficients).T)
                limit = max(0.15, 3 * 1.4826 * float(np.median(residual[use])))
                use = residual <= limit
            shift = coefficients[0]
            spread = float(np.sqrt(np.mean(residual[use] ** 2)))
            # Error of the fitted value at the candidate (the origin of `positions`).
            design = matrix[use]
            try:
                variance = float(np.linalg.inv(design.T @ design)[0, 0])
            except np.linalg.LinAlgError:
                variance = 1.0 / use.sum()
            error = spread * math.sqrt(max(variance, 1.0 / use.sum()))
            result['model'] = 'local offset + gradient'
        else:
            shift = np.median(vectors, axis=0)
            spread = float(np.sqrt(np.mean(np.sum((vectors - shift) ** 2, axis=1))))
            error = spread / math.sqrt(len(offsets))
            residual = np.hypot(*(vectors - shift).T)
            use = np.ones(len(offsets), dtype=bool)
            result['model'] = 'local median offset'
        # Per-source systematic scatter (local distortion, PSF smearing in stacks) measured on
        # bright calibration stars, whose own centroid noise is negligible; the candidate is one
        # such source, so its position carries this error too, not just the error of the mean.
        bright = use & (magnitudes < 18)
        systematic = float(np.sqrt(np.mean(residual[bright] ** 2))) if bright.sum() >= 5 else spread
        result['systematicArcsec'] = round(systematic * scale, 3)
        result.update({'dxPx': float(shift[0]), 'dyPx': float(shift[1]),
                       'rmsArcsec': round(spread * scale, 3), 'offsetErrorArcsec': float(error * scale)})
    if len(zero_points) >= 3:
        zp = np.asarray(zero_points)
        median = float(np.median(zp))
        mad = float(1.4826 * np.median(np.abs(zp - median)))
        result.update({'zeroPoint': round(median, 3), 'zeroPointError': round(mad / math.sqrt(len(zp)) + 0.02, 3),
                       'aperturePx': aperture})
    return result


def links(ra, dec):
    coord = f'{ra:.6f} {dec:+.6f}'
    return {
        'Aladin Lite': 'https://aladin.cds.unistra.fr/AladinLite/?' + urllib.parse.urlencode(
            {'target': coord, 'fov': '0.05', 'survey': 'CDS/P/DESI-Legacy-Surveys/DR10/color'}),
        'Legacy Viewer': f'https://www.legacysurvey.org/viewer?ra={ra:.6f}&dec={dec:.6f}&layer=ls-dr10&zoom=16&mark={ra:.6f},{dec:.6f}',
        'TNS': 'https://www.wis-tns.org/search?' + urllib.parse.urlencode(
            {'ra': f'{ra:.6f}', 'decl': f'{dec:.6f}', 'radius': '10', 'coords_unit': 'arcsec'}),
        'SIMBAD': 'https://simbad.cds.unistra.fr/simbad/sim-coo?' + urllib.parse.urlencode(
            {'Coord': coord, 'Radius': '30', 'Radius.unit': 'arcsec'}),
        'VSX': 'https://www.aavso.org/vsx/index.php?' + urllib.parse.urlencode(
            {'view': 'results.submit1', 'ql': '1', 'coords': coord, 'format': 'd', 'size': '60', 'unit': '3'}),
        'ESASky': f'https://sky.esa.int/esasky/?target={ra:.6f}%20{dec:+.6f}&fov=0.05',
    }


def sexagesimal(ra, dec):
    coordinate = SkyCoord(ra * u.deg, dec * u.deg)
    return (coordinate.ra.to_string(unit=u.hourangle, sep=':', precision=3, pad=True),
            coordinate.dec.to_string(sep=':', precision=2, alwayssign=True, pad=True))


def separation_arcsec(ra1, dec1, ra2, dec2):
    return float(SkyCoord(ra1 * u.deg, dec1 * u.deg).separation(SkyCoord(ra2 * u.deg, dec2 * u.deg)).arcsec)


# SIMBAD galaxy types that can host a transient (quasars, blazars and clusters cannot: they are
# distant points or groups, not a host at the measured offset).
GALAXY_TYPES = ('G', 'GiC', 'GiG', 'GiP', 'BiC', 'IG', 'PaG', 'SBG', 'SyG', 'Sy1', 'Sy2', 'AGN', 'LIN',
                'EmG', 'H2G', 'LSB', 'rG', 'bCG')
SIMBAD_HOST_RADIUS = 30.0
_open_ngc = None


def open_ngc_host(ra, dec):
    """OpenNGC galaxy whose catalogued ellipse (1.5 x the major/minor axes, at its position angle)
    contains the position, from the offline sky bundle; None when there is none."""
    global _open_ngc
    if _open_ngc is None:
        import gzip
        _open_ngc = []
        for directory in (os.environ.get('ASTROVIABIN_SKY_DATA_DIR'), '/usr/share/astroviabin/sky'):
            path = os.path.join(directory or '', 'dso.json.gz')
            if directory and os.path.exists(path):
                with gzip.open(path, 'rt', encoding='utf-8') as handle:
                    _open_ngc = [item for item in json.load(handle)
                                 if item.get('type') in ('G', 'GPair', 'GTrpl', 'GGroup') and item.get('maj')]
                break
    best = None
    for item in _open_ngc:
        if abs(item['dec'] - dec) * 60 > item['maj']:
            continue
        east = ((item['ra'] - ra + 540) % 360 - 180) * math.cos(math.radians(dec)) * -60
        north = (dec - item['dec']) * 60
        if math.hypot(east, north) > item['maj']:
            continue
        angle = math.radians(item.get('pa') or 0)
        along = east * math.sin(angle) + north * math.cos(angle)
        across = east * math.cos(angle) - north * math.sin(angle)
        semi_major, semi_minor = item['maj'] / 2, max(0.05, (item.get('min') or item['maj']) / 2)
        radius = math.hypot(along / semi_major, across / semi_minor)
        if radius <= 1.5 and (best is None or radius < best[0]):
            best = (radius, item, math.hypot(east, north) * 60)
    if best is None:
        return None
    radius, item, separation = best
    name = item['name'] + (f" ({item['messier']})" if item.get('messier') else '')
    return {'name': name, 'type': f"OpenNGC {item['type']}, {item['maj']:.1f}'×{(item.get('min') or item['maj']):.1f}'",
            'separationArcsec': round(separation, 1), 'ellipticalRadius': round(radius, 2)}


def verdict_for(entry, candidate):
    position_error = entry.get('positionErrorArcsec') or 1.0
    gaia = entry.get('gaiaNearest')
    vsx = entry.get('vsxNearest')
    host = entry.get('host')
    if candidate.get('status') == 'known_solar_system_object' and candidate.get('knownObject'):
        known = candidate['knownObject']
        return 'known_solar_system_object', f"Known solar-system object {known.get('name')} ({known.get('separationArcsec')}\" away): not a transient."
    if vsx and vsx['separationArcsec'] <= max(3.0, 3 * position_error):
        return 'known_variable_star', f"Known variable star {vsx['name']} ({vsx.get('type') or 'type ?'}), {vsx['separationArcsec']}\" away: variability, not a new object."
    if gaia and gaia['separationArcsec'] <= max(1.5, 3 * position_error):
        return 'stellar_variability', (f"Coincides with Gaia DR3 {gaia['source']} (G {gaia['g']:.2f}, {gaia['separationArcsec']}\"): "
                                       "an existing star, so the difference is variability, a flare or a subtraction residual "
                                       "of a bright star; not a supernova.")
    if host:
        return 'possible_extragalactic_transient', (f"No stellar counterpart; {host['separationArcsec']}\" from galaxy {host['name']} "
                                                    f"({host['type']}). Consistent with a supernova or other extragalactic transient: "
                                                    "confirm with a second epoch and check TNS.")
    if entry.get('online'):
        return 'unclassified_new_source', ("No Gaia, VSX or SIMBAD counterpart: an unclassified new point source "
                                           "(possible transient, uncatalogued asteroid or artifact). Confirm with a second epoch.")
    return 'unverified', 'Online catalogues unavailable; only the offline checks were possible.'


def verify(work, report, science, science_header, difference, noise, wcs):
    candidates = report.get('candidates') or []
    fwhm = float((report.get('autoSettings') or {}).get('detectionFwhmPx') or 3)
    scale = pixel_scale_arcsec(wcs)
    epoch = observation_epoch(science_header)
    saturation = number(science_header.get('SATURATE'))
    registration_rms = float((report.get('registration') or {}).get('rmsAfterPx') or 0)

    def one(index):
        candidate = candidates[index]
        x0 = float(candidate.get('centroidX', candidate['x']))
        y0 = float(candidate.get('centroidY', candidate['y']))
        fit = gaussian_fit(difference, noise, x0, y0, fwhm)
        x, y = (fit['x'], fit['y']) if fit and fit['converged'] else (x0, y0)
        fit_error = math.hypot(fit['xErr'], fit['yErr']) if fit and np.isfinite(fit['xErr']) else 0.5
        entry = {'index': index, 'pixel': {'x': round(x, 3), 'y': round(y, 3)}, 'fit': fit,
                 'online': False, 'notes': []}
        ra, dec = (float(value) for value in wcs.pixel_to_world_values(x, y))
        calibration = {}
        stars = []
        try:
            radius = min(900.0, max(120.0, 150 * scale))
            stars = gaia_stars(ra, dec, radius, epoch)
            entry['online'] = True
            calibration = local_calibration(science, wcs, x, y, fwhm, stars, saturation)
        except Exception as error:
            entry['notes'].append(f'Gaia DR3 unavailable: {error}')
        astrometric_error = scale * max(registration_rms, 0.1)
        if 'dxPx' in calibration:
            ra, dec = (float(value) for value in wcs.pixel_to_world_values(x - calibration['dxPx'], y - calibration['dyPx']))
            astrometric_error = math.hypot(calibration['offsetErrorArcsec'], calibration.get('systematicArcsec', 0))
            entry['astrometry'] = f"Tied to {calibration['starsUsed']} Gaia DR3 stars within {radius / 60:.1f}' (epoch {epoch:.3f}); local scatter {calibration['rmsArcsec']}\""
        else:
            entry['astrometry'] = 'Plate solution only (Gaia DR3 not reachable or too few stars nearby)'
        entry['ra'], entry['dec'] = ra, dec
        entry['raSexagesimal'], entry['decSexagesimal'] = sexagesimal(ra, dec)
        entry['positionErrorArcsec'] = round(math.hypot(fit_error * scale, astrometric_error), 3)
        entry['calibration'] = calibration
        flux, flux_error = aperture_flux(difference, x, y, calibration.get('aperturePx', max(2.0, 1.5 * fwhm)), noise)
        if flux and flux > 0 and 'zeroPoint' in calibration:
            magnitude = calibration['zeroPoint'] - 2.5 * math.log10(flux)
            magnitude_error = math.hypot(1.0857 * (flux_error or 0) / flux, calibration['zeroPointError'])
            entry['magnitude'] = {'value': round(magnitude, 2), 'error': round(magnitude_error, 2),
                                  'system': f"Gaia G-calibrated, {report.get('sourceFilter') or 'unknown'} filter (approximate)"}
        if stars:
            nearest = min(stars, key=lambda star: separation_arcsec(ra, dec, star['ra'], star['dec']))
            separation = separation_arcsec(ra, dec, nearest['ra'], nearest['dec'])
            if separation <= 10:
                entry['gaiaNearest'] = {'source': nearest['source'], 'g': nearest['g'], 'separationArcsec': round(separation, 2)}
        if entry['online']:
            try:
                variables = vsx_variables(ra, dec, 30)
                if variables:
                    best = min(variables, key=lambda item: separation_arcsec(ra, dec, item['ra'], item['dec']))
                    entry['vsxNearest'] = {**best, 'separationArcsec': round(separation_arcsec(ra, dec, best['ra'], best['dec']), 2)}
            except Exception as error:
                entry['notes'].append(f'AAVSO VSX unavailable: {error}')
            try:
                objects = simbad_objects(ra, dec, 90)
                entry['simbad'] = objects[:8]
                galaxies = [item for item in objects if item['type'] in GALAXY_TYPES and item['separationArcsec'] <= SIMBAD_HOST_RADIUS]
                if galaxies:
                    entry['host'] = galaxies[0]
            except Exception as error:
                entry['notes'].append(f'SIMBAD unavailable: {error}')
        ngc_host = open_ngc_host(ra, dec)
        if ngc_host:
            entry['host'] = ngc_host
        entry['verdictCode'], entry['verdict'] = verdict_for(entry, candidate)
        entry['checks'] = {
            'pointSourceInDifference': True,
            'absentFromReference': True,
            'notKnownAsteroid': candidate.get('status') != 'known_solar_system_object',
            'noGaiaStar': 'gaiaNearest' not in entry or entry['gaiaNearest']['separationArcsec'] > max(1.5, 3 * entry['positionErrorArcsec']),
            'noKnownVariable': 'vsxNearest' not in entry or entry['vsxNearest']['separationArcsec'] > 3,
            'secondEpoch': ((report.get('candidateChecks') or {}).get(str(index)) or {}).get('status'),
        }
        entry['links'] = links(ra, dec)
        return entry

    indices = list(range(min(len(candidates), MAX_VERIFIED)))
    with ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(one, indices))


# ------------------------------------------------------------------------------- rendering

def display_limits(data, symmetric_noise=None):
    finite = data[np.isfinite(data)]
    if finite.size == 0:
        return 0, 1
    if symmetric_noise is not None:
        level = 5 * symmetric_noise
        return -level, level
    try:
        return ZScaleInterval(contrast=0.15).get_limits(finite)
    except Exception:
        return np.percentile(finite, [1, 99.5])


def north_east(wcs, x, y, length):
    ra, dec = (float(value) for value in wcs.pixel_to_world_values(x, y))
    step = 10 / 3600
    nx, ny = (float(value) for value in wcs.world_to_pixel_values(ra, dec + step))
    ex, ey = (float(value) for value in wcs.world_to_pixel_values(ra + step / max(1e-6, math.cos(math.radians(dec))), dec))
    north = np.array([nx - x, ny - y])
    east = np.array([ex - x, ey - y])
    return north / np.linalg.norm(north) * length, east / np.linalg.norm(east) * length


def draw_marker(axis, x, y, fwhm, error_px, color):
    """Open crosshair (gap at the source) exactly on the fitted subpixel position."""
    inner = max(2.0, 1.6 * fwhm)
    outer = inner + max(3.0, 2.5 * fwhm)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        axis.plot([x + dx * inner, x + dx * outer], [y + dy * inner, y + dy * outer], color=color, lw=1.6, solid_capstyle='butt')
    if error_px >= 0.35:
        axis.add_patch(Circle((x, y), error_px, fill=False, ec=color, lw=0.8, ls='--'))


def stamp_axis(axis, data, wcs, x, y, half, title, fwhm, error_px, noise_level=None, compass=False, scale=None):
    x0, x1 = max(0, int(round(x)) - half), min(data.shape[1], int(round(x)) + half + 1)
    y0, y1 = max(0, int(round(y)) - half), min(data.shape[0], int(round(y)) + half + 1)
    patch = data[y0:y1, x0:x1]
    low, high = display_limits(patch, noise_level)
    axis.imshow(patch, origin='lower', cmap='gray', vmin=low, vmax=high, interpolation='nearest',
                extent=(x0 - 0.5, x1 - 0.5, y0 - 0.5, y1 - 0.5))
    draw_marker(axis, x, y, fwhm, error_px, RED if noise_level is not None else MAGENTA)
    axis.set_xlim(x - half - 0.5, x + half + 0.5)
    axis.set_ylim(y - half - 0.5, y + half + 0.5)
    axis.set_xticks([])
    axis.set_yticks([])
    axis.set_title(title, fontsize=8)
    if compass:
        length = half * 0.3
        north, east = north_east(wcs, x, y, length)
        corner = -(north + east)
        corner = corner / (np.linalg.norm(corner) or 1)
        base = np.array([x, y]) + corner * half * 0.95 + (north + east) * 0.05
        for vector, label in ((north, 'N'), (east, 'E')):
            axis.annotate('', xy=base + vector, xytext=base, arrowprops={'arrowstyle': '->', 'color': YELLOW, 'lw': 1.2})
            axis.text(*(base + vector * 1.25), label, color=YELLOW, fontsize=7, ha='center', va='center')
    if scale:
        bar_arcsec = next(value for value in (5, 10, 20, 30, 60, 120, 300, 600) if value / scale >= half * 0.3)
        bar = bar_arcsec / scale
        # Bottom edge, on the side away from the compass (which sits in the corner opposite N+E).
        direction = sum(north_east(wcs, x, y, 1))
        compass_bottom_right = compass and direction[0] < 0 and direction[1] > 0
        bx = x - half * 0.9 if compass_bottom_right else x + half * 0.9 - bar
        by = y - half * 0.85
        axis.plot([bx, bx + bar], [by, by], color=YELLOW, lw=2)
        axis.text(bx + bar / 2, by + half * 0.06, f'{bar_arcsec}"' if bar_arcsec < 60 else f"{bar_arcsec // 60}'",
                  color=YELLOW, fontsize=7, ha='center')


def candidate_figure(index, entry, images, wcs, fwhm, scale, noise_level):
    science, reference, difference = images
    x, y = entry['pixel']['x'], entry['pixel']['y']
    error_px = entry['positionErrorArcsec'] / scale
    half = max(15, int(round(7 * fwhm)))
    figure, axes = plt.subplots(1, 4, figsize=(10, 2.9), dpi=130)
    figure.patch.set_facecolor('white')
    stamp_axis(axes[0], science, wcs, x, y, half, 'Science', fwhm, error_px, compass=True, scale=scale)
    stamp_axis(axes[1], reference, wcs, x, y, half, 'Reference (aligned)', fwhm, error_px)
    stamp_axis(axes[2], difference, wcs, x, y, half, 'Difference', fwhm, error_px, noise_level=noise_level)
    finder_half = max(half * 4, int(round(120 / scale)))
    stamp_axis(axes[3], science, wcs, x, y, finder_half, f"Finder {2 * finder_half * scale / 60:.1f}'", fwhm * 2.2, 0,
               compass=True, scale=scale)
    figure.suptitle(f"Candidate {index + 1}  ·  {entry['raSexagesimal']}  {entry['decSexagesimal']}  ±{entry['positionErrorArcsec']}\"",
                    fontsize=9, y=0.99)
    figure.tight_layout(rect=(0, 0, 1, 0.95))
    return figure


def blink_gif(path, science, comparison, x, y, fwhm, label_comparison):
    from PIL import Image, ImageDraw
    half = max(15, int(round(7 * fwhm)))
    xi, yi = int(round(x)), int(round(y))
    frames = []
    size = 320
    s_patch = science[max(0, yi - half):yi + half + 1, max(0, xi - half):xi + half + 1]
    c_patch = comparison[max(0, yi - half):yi + half + 1, max(0, xi - half):xi + half + 1]
    # One stretch for both frames so brightness changes are real, not display artefacts.
    low, high = display_limits(np.concatenate([s_patch[np.isfinite(s_patch)], c_patch[np.isfinite(c_patch)]]))
    for patch, label in ((s_patch, 'SCIENCE'), (c_patch, label_comparison)):
        scaled = np.clip((np.nan_to_num(patch, nan=low) - low) / ((high - low) or 1), 0, 1)
        image = Image.fromarray((np.flipud(scaled) * 255).astype(np.uint8), 'L').resize((size, size), Image.NEAREST).convert('RGB')
        draw = ImageDraw.Draw(image)
        factor = size / patch.shape[1]
        cx = (x - (xi - half) + 0.5) * factor
        cy = size - (y - (yi - half) + 0.5) * factor
        inner, outer = max(2.0, 1.6 * fwhm) * factor, (max(2.0, 1.6 * fwhm) + max(3.0, 2.5 * fwhm)) * factor
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            draw.line([(cx + dx * inner, cy + dy * inner), (cx + dx * outer, cy + dy * outer)], fill=(255, 59, 59), width=2)
        draw.text((6, 6), label, fill=(249, 211, 2))
        frames.append(image)
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=650, loop=0)


def overview_figure(science, wcs, candidates, entries, title, scale):
    figure, axis = plt.subplots(figsize=(8.27, 7.2), dpi=150)
    step = max(1, int(max(science.shape) / 1600))
    shown = science[::step, ::step]
    low, high = display_limits(shown)
    axis.imshow(shown, origin='lower', cmap='gray', vmin=low, vmax=high, interpolation='nearest',
                extent=(-0.5, science.shape[1] - 0.5, -0.5, science.shape[0] - 0.5))
    radius = max(science.shape) / 60
    for index, candidate in enumerate(candidates):
        entry = entries[index] if index < len(entries) else None
        x = entry['pixel']['x'] if entry else candidate.get('centroidX', candidate['x'])
        y = entry['pixel']['y'] if entry else candidate.get('centroidY', candidate['y'])
        color = YELLOW if candidate.get('status') == 'known_solar_system_object' else RED
        axis.add_patch(Circle((x, y), radius, fill=False, ec=color, lw=1.2))
        axis.text(x + radius * 1.1, y + radius * 1.1, str(index + 1), color=color, fontsize=8, weight='bold')
    north, east = north_east(wcs, science.shape[1] * 0.08, science.shape[0] * 0.1, max(science.shape) * 0.06)
    base = np.array([science.shape[1] * 0.08, science.shape[0] * 0.1])
    for vector, label in ((north, 'N'), (east, 'E')):
        axis.annotate('', xy=base + vector, xytext=base, arrowprops={'arrowstyle': '->', 'color': YELLOW, 'lw': 1.5})
        axis.text(*(base + vector * 1.2), label, color=YELLOW, fontsize=9, ha='center', va='center')
    axis.set_xticks([])
    axis.set_yticks([])
    axis.set_title(f'{title} — candidates on the science image ({science.shape[1] * scale / 60:.1f}\' × {science.shape[0] * scale / 60:.1f}\')', fontsize=9)
    figure.tight_layout()
    return figure


def text_page(pdf, lines, title):
    figure = plt.figure(figsize=(8.27, 11.69), dpi=100)
    figure.text(0.06, 0.965, title, fontsize=15, weight='bold')
    y = 0.935
    for line in lines:
        if y < 0.04:
            pdf.savefig(figure)
            plt.close(figure)
            figure = plt.figure(figsize=(8.27, 11.69), dpi=100)
            y = 0.96
        style = {'fontsize': 8, 'family': 'monospace'}
        if isinstance(line, tuple):
            line, extra = line
            style.update(extra)
        pieces = wrap(line, 104) if style['family'] == 'monospace' and len(line) > 104 else [line]
        for number_, piece in enumerate(pieces):
            figure.text(0.06, y, ('              ' if number_ else '') + piece, **style)
            y -= 0.0165 if style.get('fontsize', 8) <= 8 else 0.024
    pdf.savefig(figure)
    plt.close(figure)


def build_pdf(path, report, entries, header, title, images, wcs, fwhm, scale, noise_level):
    science = images[0]
    candidates = report.get('candidates') or []
    generated = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    centre = wcs.pixel_to_world_values(science.shape[1] / 2, science.shape[0] / 2)
    ra_centre, dec_centre = sexagesimal(float(centre[0]), float(centre[1]))
    registration = report.get('registration') or {}
    auto = report.get('autoSettings') or {}
    reference = report.get('reference') or {}
    lines = [
        (f'{title}', {'fontsize': 11, 'family': 'sans-serif', 'weight': 'bold'}),
        f"Generated {generated} by AstroviaBin · analysis {report.get('runId')}",
        '',
        ('Observation', {'fontsize': 10, 'family': 'sans-serif', 'weight': 'bold'}),
        f"Object        {header.get('OBJECT', '—')}",
        f"Date (UTC)    {header.get('DATE-OBS', '—')}   exposure {header.get('EXPTIME', '—')} s",
        f"Filter        {header.get('FILTER', '—')}   instrument {header.get('INSTRUME', '—')}   telescope {header.get('TELESCOP', '—')}",
        f"Site          {header.get('SITEID', header.get('SITE', '—'))}",
        f"Field centre  {ra_centre} {dec_centre}   scale {scale:.3f}\"/px   {science.shape[1]}×{science.shape[0]} px",
        '',
        ('Method', {'fontsize': 10, 'family': 'sans-serif', 'weight': 'bold'}),
        f"Reference     {reference.get('survey') or ('local FITS #' + str(reference.get('localImageId')))}"
        + (f"  (auto: band {reference['autoSelection']['band']}, {reference['autoSelection']['reason']})" if reference.get('autoSelection') else ''),
        f"Registration  WCS + {registration.get('matchedStars', 0)} matched stars, residual {registration.get('rmsBeforePx', '?')} → {registration.get('rmsAfterPx', '?')} px",
        f"Seeing        science {auto.get('fwhmSciencePx', '?')} px, reference {auto.get('fwhmReferencePx', '?')} px",
        f"Cleaning      cosmic-ray/hot pixels removed: {report.get('cosmicRayPixels') if report.get('cosmicRayPixels') is not None else 'not needed (stack)'}",
        f"Masked        {100 * (report.get('brightStarMaskFraction') or 0):.1f}% around bright/saturated reference stars",
        f"Subtraction   HOTPANTS {' '.join(auto.get('hotpantsArgs') or [])}",
        f"Detection     S/N ≥ {(report.get('settings') or {}).get('thresholdSigma')}; {report.get('detectedTotal', 0)} raw peaks; "
        f"{len(candidates)} passed point-source, reference, dipole and mask checks",
        f"Rejected      " + ', '.join(f'{key} {value}' for key, value in (report.get('rejectedCandidates') or {}).items()),
        f"Asteroids     {report.get('solarSystemCheck') or 'not checked'}",
        '',
        ('Candidates', {'fontsize': 10, 'family': 'sans-serif', 'weight': 'bold'}),
    ]
    if not candidates:
        lines.append('No candidate passed every check: no new point source was found above the threshold.')
    else:
        lines.append(f"{'#':>3}  {'RA (ICRS)':<14} {'Dec (ICRS)':<13} {'±\"':>5} {'S/N':>6} {'mag':>11}  verdict")
        for index, candidate in enumerate(candidates):
            entry = entries[index] if index < len(entries) else None
            if entry is None:
                ra, dec = sexagesimal(candidate['ra'], candidate['dec'])
                lines.append(f"{index + 1:>3}  {ra:<14} {dec:<13} {'':>5} {candidate['snr']:>6.1f} {'':>11}  (not verified: list limit)")
                continue
            magnitude = entry.get('magnitude')
            magnitude_text = f"{magnitude['value']:.2f}±{magnitude['error']:.2f}" if magnitude else '—'
            lines.append(f"{index + 1:>3}  {entry['raSexagesimal']:<14} {entry['decSexagesimal']:<13} "
                         f"{entry['positionErrorArcsec']:>5.2f} {candidate['snr']:>6.1f} {magnitude_text:>11}  {entry['verdictCode'].replace('_', ' ')}")
    lines += ['', ('Caveat', {'fontsize': 10, 'family': 'sans-serif', 'weight': 'bold'}),
              'Survey references differ in bandpass, depth, resolution and epoch. A candidate is an unconfirmed',
              'difference until it is seen again in an independent same-filter exposure and checked against TNS/MPC.']
    with PdfPages(path) as pdf:
        text_page(pdf, lines, 'HOTPANTS transient search report')
        figure = overview_figure(science, wcs, candidates, entries, title, scale)
        pdf.savefig(figure)
        plt.close(figure)
        for index, entry in enumerate(entries):
            candidate = candidates[index]
            figure = plt.figure(figsize=(8.27, 11.69), dpi=100)
            grid = figure.add_gridspec(2, 3, height_ratios=[1, 1.35], left=0.05, right=0.95, top=0.93, bottom=0.40, hspace=0.18, wspace=0.08)
            figure.text(0.05, 0.965, f"Candidate {index + 1}", fontsize=15, weight='bold')
            figure.text(0.30, 0.966, f"{entry['raSexagesimal']}  {entry['decSexagesimal']}  (±{entry['positionErrorArcsec']}\")",
                        fontsize=11, family='monospace')
            x, y = entry['pixel']['x'], entry['pixel']['y']
            error_px = entry['positionErrorArcsec'] / scale
            half = max(15, int(round(7 * fwhm)))
            for column, (data, label, noise) in enumerate(((images[0], 'Science', None), (images[1], 'Reference (aligned)', None),
                                                           (images[2], 'Difference', noise_level))):
                stamp_axis(figure.add_subplot(grid[0, column]), data, wcs, x, y, half, label, fwhm, error_px,
                           noise_level=noise, compass=column == 0, scale=scale if column == 0 else None)
            finder_half = max(half * 4, int(round(150 / scale)))
            stamp_axis(figure.add_subplot(grid[1, :2]), images[0], wcs, x, y, finder_half,
                       f"Finder chart {2 * finder_half * scale / 60:.1f}' (science)", fwhm * 2.2, 0, compass=True, scale=scale)
            info = figure.add_subplot(grid[1, 2])
            info.axis('off')
            magnitude = entry.get('magnitude')
            details = [
                f"RA   {entry['ra']:.7f}°", f"Dec  {entry['dec']:+.7f}°", f"σpos {entry['positionErrorArcsec']}\"",
                f"x, y {x:.2f}, {y:.2f} px", f"S/N  {candidate['snr']}",
                f"FWHM {entry['fit']['fwhm']:.2f} px" if entry.get('fit') else 'FWHM —',
                f"mag  {magnitude['value']:.2f} ± {magnitude['error']:.2f}" if magnitude else 'mag  — (no calibration)',
            ]
            if magnitude:
                details += ['     ' + piece for piece in wrap(f"({magnitude['system']})", 30)]
            info.text(0, 1, '\n'.join(details), va='top', fontsize=8, family='monospace', transform=info.transAxes)
            checks = entry['checks']
            mark = lambda value: '✔' if value else '✘'
            second = checks.get('secondEpoch')
            body = [
                ('Verdict', {'weight': 'bold', 'fontsize': 10}),
                *[(line, {}) for line in wrap(entry['verdict'], 95)],
                ('', {}),
                ('Checks', {'weight': 'bold', 'fontsize': 10}),
                (f"{mark(True)} point source in the difference, absent from the reference, outside masks", {}),
                (f"{mark(checks['notKnownAsteroid'])} not a known asteroid/comet (IMCCE SkyBoT, topocentric)", {}),
                (f"{mark(checks['noGaiaStar'])} no Gaia DR3 star at the position"
                 + (f" (nearest {entry['gaiaNearest']['separationArcsec']}\", G {entry['gaiaNearest']['g']:.1f})" if entry.get('gaiaNearest') else ''), {}),
                (f"{mark(checks['noKnownVariable'])} not a known variable star (AAVSO VSX)"
                 + (f" (nearest {entry['vsxNearest']['name']}, {entry['vsxNearest']['separationArcsec']}\")" if entry.get('vsxNearest') else ''), {}),
                (f"{'✔' if second == 'repeat_detection' else '•'} second epoch: {second.replace('_', ' ') if second else 'not checked yet'}", {}),
                (f"• host: {entry['host']['name']} ({entry['host']['type']}, {entry['host']['separationArcsec']}\")" if entry.get('host') else '• host: no catalogued galaxy (OpenNGC ellipse, SIMBAD ≤ 30")', {}),
                (f"• astrometry: {entry['astrometry']}", {}),
            ]
            if entry.get('simbad'):
                body.append(('• SIMBAD within 90": ' + ', '.join(f"{item['name']} ({item['type']}, {item['separationArcsec']}\")" for item in entry['simbad'][:4]), {}))
            for note in entry.get('notes', []):
                body.append((f'! {note}', {'color': '#b45309'}))
            y_text = 0.36
            for line, style in body:
                for piece in (wrap(line, 105) if not style.get('weight') else [line]):
                    figure.text(0.05, y_text, piece, fontsize=style.get('fontsize', 8), weight=style.get('weight', 'normal'),
                                color=style.get('color', 'black'))
                    y_text -= 0.017 if style.get('fontsize', 8) <= 8 else 0.022
            figure.text(0.05, y_text - 0.01, 'Open:', fontsize=8, weight='bold')
            x_link = 0.11
            for name, url in entry['links'].items():
                figure.text(x_link, y_text - 0.01, name, fontsize=8, color='#0645ad', url=url)
                x_link += 0.025 + 0.0085 * len(name)
            pdf.savefig(figure)
            plt.close(figure)
        info = pdf.infodict()
        info['Title'] = f'HOTPANTS report — {title}'
        info['Author'] = 'AstroviaBin'


def wrap(text, width):
    words, lines, current = str(text).split(), [], ''
    for word in words:
        if len(current) + len(word) + 1 > width and current:
            lines.append(current)
            current = word
        else:
            current = f'{current} {word}'.strip()
    if current:
        lines.append(current)
    return lines or ['']


def main(work, title):
    work = Path(work)
    report = json.loads((work / 'report.json').read_text())
    science, header = load(work / 'science.fits')
    reference, _ = load(work / 'reference-aligned.fits')
    difference, _ = load(work / 'difference.fits')
    noise, _ = load(work / 'noise.fits') if (work / 'noise.fits').exists() else (None, None)
    convolved = load(work / 'convolved.fits')[0] if (work / 'convolved.fits').exists() else reference
    wcs = WCS(header).celestial
    fwhm = float((report.get('autoSettings') or {}).get('detectionFwhmPx') or 3)
    scale = pixel_scale_arcsec(wcs)
    finite_noise = noise[np.isfinite(noise) & (noise > 0)] if noise is not None else np.array([])
    noise_level = float(np.median(finite_noise)) if finite_noise.size else float(np.nanstd(difference))
    entries = verify(work, report, science, header, difference, noise, wcs)
    files = []
    for entry in entries:
        index = entry['index']
        figure = candidate_figure(index, entry, (science, reference, difference), wcs, fwhm, scale, noise_level)
        name = f'candidate-{index + 1}.png'
        figure.savefig(work / name, facecolor='white')
        plt.close(figure)
        blink = f'candidate-{index + 1}-blink.gif'
        blink_gif(work / blink, science, convolved, entry['pixel']['x'], entry['pixel']['y'], fwhm,
                  'REFERENCE (PSF-matched)' if convolved is not reference else 'REFERENCE')
        entry['stamp'], entry['blink'] = name, blink
        files += [name, blink]
    build_pdf(work / 'report.pdf', report, entries, header, title, (science, reference, difference), wcs, fwhm, scale, noise_level)
    files.append('report.pdf')
    result = {'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'online': any(entry['online'] for entry in entries), 'candidates': entries,
              'verifiedCount': len(entries), 'files': files}
    (work / 'verification.json').write_text(json.dumps(result, indent=1, default=float))
    print(json.dumps({'files': files, 'verified': len(entries)}))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'FITS image')
