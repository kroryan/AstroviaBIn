"""Synthetic checks for AstroviaBin's HOTPANTS verification products."""

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

import hotpants_report as report


def make_wcs(size=200, scale_deg=0.0004):
    wcs = WCS(naxis=2)
    wcs.wcs.crpix = [size / 2 + 1, size / 2 + 1]
    wcs.wcs.cdelt = [-scale_deg, scale_deg]
    wcs.wcs.crval = [150.0, 20.0]
    wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    return wcs


def star(image, x, y, flux, sigma=1.2):
    yy, xx = np.mgrid[:image.shape[0], :image.shape[1]]
    image += flux / (2 * math.pi * sigma ** 2) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))


class PositionTests(unittest.TestCase):
    def test_gaussian_fit_recovers_subpixel_position_with_honest_errors(self):
        rng = np.random.default_rng(1)
        misses = []
        for trial in range(20):
            image = rng.normal(0, 5, (60, 60))
            truth = (30.37 + rng.uniform(-0.5, 0.5), 29.81 + rng.uniform(-0.5, 0.5))
            star(image, *truth, flux=4000)
            fit = report.gaussian_fit(image, np.full(image.shape, 5.0), 30, 30, 2.8)
            misses.append(math.hypot(fit['x'] - truth[0], fit['y'] - truth[1]) / math.hypot(fit['xErr'], fit['yErr']))
        self.assertLess(np.median(misses), 1.5, 'formal errors describe the real scatter')
        self.assertLess(max(misses), 4)

    def test_local_calibration_measures_wcs_offset_and_zero_point(self):
        wcs = make_wcs()
        rng = np.random.default_rng(2)
        image = rng.normal(100, 3, (200, 200))
        stars, shift = [], (0.8, -0.6)  # the image is offset from its WCS by this many pixels
        for _ in range(40):
            x, y = rng.uniform(15, 185, 2)
            g = rng.uniform(13, 17)
            flux = 10 ** ((25 - g) / 2.5)
            star(image, x + shift[0], y + shift[1], flux)
            ra, dec = wcs.pixel_to_world_values(x, y)
            stars.append({'source': '1', 'ra': float(ra), 'dec': float(dec), 'g': g, 'ruwe': 1.0})
        result = report.local_calibration(image, wcs, 100, 100, 2.8, stars, None)
        self.assertAlmostEqual(result['dxPx'], shift[0], delta=0.08)
        self.assertAlmostEqual(result['dyPx'], shift[1], delta=0.08)
        self.assertAlmostEqual(result['zeroPoint'], 25, delta=0.15)


class HostAndVerdictTests(unittest.TestCase):
    def test_host_uses_the_galaxy_ellipse_and_position_angle(self):
        galaxy = {'name': 'NGC 1', 'messier': '', 'type': 'G', 'ra': 10.0, 'dec': 0.0, 'maj': 10.0, 'min': 2.0, 'pa': 0.0}
        with mock.patch.object(report, '_open_ngc', [galaxy]):
            self.assertIsNotNone(report.open_ngc_host(10.0, 0.0 + 6 / 60), 'along the major axis (north)')
            self.assertIsNone(report.open_ngc_host(10.0 + 3 / 60, 0.0), 'same distance across the minor axis')

    def test_verdict_order(self):
        candidate = {'status': 'needs_followup'}
        self.assertEqual(report.verdict_for({'online': True, 'positionErrorArcsec': 0.3,
                                             'gaiaNearest': {'source': '1', 'g': 15.0, 'separationArcsec': 0.4}}, candidate)[0],
                         'stellar_variability')
        self.assertEqual(report.verdict_for({'online': True, 'positionErrorArcsec': 0.3,
                                             'vsxNearest': {'name': 'V1', 'type': 'RRAB', 'separationArcsec': 1.0}}, candidate)[0],
                         'known_variable_star')
        self.assertEqual(report.verdict_for({'online': True, 'positionErrorArcsec': 0.3,
                                             'host': {'name': 'NGC 1', 'type': 'G', 'separationArcsec': 12}}, candidate)[0],
                         'possible_extragalactic_transient')
        self.assertEqual(report.verdict_for({'online': False, 'positionErrorArcsec': 0.3}, candidate)[0], 'unverified')
        known = {'status': 'known_solar_system_object', 'knownObject': {'name': '(1) Ceres', 'separationArcsec': 0.4}}
        self.assertEqual(report.verdict_for({'online': True, 'positionErrorArcsec': 0.3}, known)[0], 'known_solar_system_object')


class OfflineProductsTests(unittest.TestCase):
    def test_products_are_written_without_a_network(self):
        wcs = make_wcs()
        rng = np.random.default_rng(3)
        science = rng.normal(100, 3, (200, 200))
        reference = rng.normal(100, 3, (200, 200))
        for x, y in rng.uniform(20, 180, (25, 2)):
            star(science, x, y, 3000)
            star(reference, x, y, 3000)
        star(science, 120.4, 80.6, 2500)
        difference = science - reference
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            header = wcs.to_header()
            header['DATE-OBS'] = '2026-10-18T03:49:37'
            header['FILTER'] = 'rp'
            for name, data in (('science', science), ('reference-aligned', reference), ('difference', difference),
                               ('noise', np.full((200, 200), 4.3))):
                fits.writeto(work / f'{name}.fits', data.astype(np.float32), header)
            ra, dec = wcs.pixel_to_world_values(120.4, 80.6)
            (work / 'report.json').write_text(json.dumps({
                'runId': 'test', 'settings': {'thresholdSigma': 6}, 'autoSettings': {'detectionFwhmPx': 2.8},
                'candidates': [{'x': 120, 'y': 81, 'centroidX': 120.4, 'centroidY': 80.6, 'ra': float(ra), 'dec': float(dec),
                                'snr': 40.0, 'status': 'needs_followup'}]}))
            with mock.patch.object(report, 'fetch', side_effect=OSError('offline')):
                report.main(work, 'Synthetic')
            verification = json.loads((work / 'verification.json').read_text())
            entry = verification['candidates'][0]
            self.assertFalse(verification['online'])
            self.assertEqual(entry['verdictCode'], 'unverified')
            self.assertAlmostEqual(entry['pixel']['x'], 120.4, delta=0.1)
            self.assertAlmostEqual(entry['pixel']['y'], 80.6, delta=0.1)
            for name in ('candidate-1.png', 'candidate-1-blink.gif', 'report.pdf'):
                self.assertGreater((work / name).stat().st_size, 1000, name)
            self.assertTrue((work / 'report.pdf').read_bytes().startswith(b'%PDF'))


if __name__ == '__main__':
    unittest.main()
