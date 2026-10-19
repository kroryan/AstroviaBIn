"""Focused synthetic checks for AstroviaBin's post-HOTPANTS candidate validation."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from hotpants_pipeline import check_candidate, detect_candidates, reduced_image, write_candidate_products


class CandidateValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.work = Path(self.temporary.name)
        self.wcs = WCS(naxis=2)
        self.wcs.wcs.crpix = [49, 49]
        self.wcs.wcs.cdelt = [-0.001, 0.001]
        self.wcs.wcs.crval = [10, -20]
        self.wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
        self.rng = np.random.default_rng(5)
        self.yy, self.xx = np.mgrid[:96, :96]
        self.point = 100 * np.exp(-((self.xx - 48)**2 + (self.yy - 48)**2) / (2 * 1.3**2))

    def tearDown(self):
        self.temporary.cleanup()

    def analyze(self, science_point=True, reference_point=False, dipole=False, bad=False):
        science = self.rng.normal(30, 2, (96, 96))
        reference = self.rng.normal(100, 2, (96, 96))
        difference = self.rng.normal(0, 2, (96, 96)) + self.point
        if science_point:
            science += self.point
        if reference_point:
            reference += self.point * 2
        if dipole:
            difference[48, 54] = -80
        noise = np.full((96, 96), 2.0)
        mask = np.zeros((96, 96), dtype=np.uint8)
        bad_mask = np.zeros_like(mask)
        if bad:
            bad_mask[48, 48] = 1
        for name, data in [('science', science), ('reference-aligned', reference),
                           ('difference', difference), ('noise', noise),
                           ('bad-pixels', bad_mask)]:
            fits.writeto(self.work / f'{name}.fits', data, self.wcs.to_header(), overwrite=True)
        return detect_candidates(
            self.work / 'difference.fits', self.work / 'noise.fits',
            self.work / 'bad-pixels.fits', mask, self.work / 'science.fits',
            self.work / 'reference-aligned.fits', self.wcs, 6, 10, 3)

    def test_new_point_source_passes(self):
        candidates, raw, rejected = self.analyze()
        self.assertGreater(raw, 0)
        self.assertEqual(len(candidates), 1, rejected)
        self.assertEqual(candidates[0]['status'], 'needs_followup')

    def test_existing_reference_star_is_rejected(self):
        candidates, _, rejected = self.analyze(reference_point=True)
        self.assertEqual(candidates, [])
        self.assertGreater(rejected['presentInReference'], 0)

    def test_non_point_source_and_dipole_are_rejected(self):
        candidates, _, rejected = self.analyze(science_point=False)
        self.assertEqual(candidates, [])
        self.assertGreater(rejected['notPointSourceInScience'], 0)
        candidates, _, rejected = self.analyze(dipole=True)
        self.assertEqual(candidates, [])
        self.assertGreater(rejected['subtractionDipole'], 0)

    def test_masked_source_is_rejected(self):
        candidates, _, _ = self.analyze(bad=True)
        self.assertEqual(candidates, [])

    def test_downsample_conserves_integrated_flux_and_keeps_wcs_pixel_grid_exact(self):
        header = self.wcs.to_header()
        header['BUNIT'] = 'adu'
        source_data = np.zeros((96, 96), dtype=np.float32)
        source_data[49, 49] = 1000
        source = self.work / 'large.fits'
        reduced = self.work / 'reduced.fits'
        fits.writeto(source, source_data, header)
        factor = reduced_image(source, reduced, 32)
        self.assertEqual(factor, 3)
        output, output_header = fits.getdata(reduced, header=True)
        self.assertAlmostEqual(float(output.sum()), 1000, delta=1.0)
        self.assertEqual(output.shape, (32, 32))
        output_wcs = WCS(output_header).celestial
        source_world = self.wcs.pixel_to_world_values(49, 49)
        output_world = output_wcs.pixel_to_world_values(16, 16)
        self.assertAlmostEqual(float(source_world[0]), float(output_world[0]), places=10)
        self.assertAlmostEqual(float(source_world[1]), float(output_world[1]), places=10)
        self.assertEqual(int(fits.getdata(self.work / 'reduced-invalid-mask.fits').sum()), 0)

    def test_even_factor_wcs_points_to_integrated_block_centres(self):
        header = self.wcs.to_header()
        header['BUNIT'] = 'adu'
        source = self.work / 'even-factor.fits'
        reduced = self.work / 'even-factor-reduced.fits'
        fits.writeto(source, np.ones((96, 96), dtype=np.float32), header)
        factor = reduced_image(source, reduced, 48)
        self.assertEqual(factor, 2)
        reduced_wcs = WCS(fits.getheader(reduced)).celestial
        # Reduced pixel (24, 24) is the integrated bin covering source pixels 48..49.
        expected_world = self.wcs.pixel_to_world_values(48.5, 48.5)
        actual_world = reduced_wcs.pixel_to_world_values(24, 24)
        np.testing.assert_allclose(actual_world, expected_world, rtol=0, atol=1e-10)

    def test_candidate_fits_keeps_difference_unchanged_and_exports_precise_circles(self):
        original = np.zeros((96, 96), dtype=np.float32)
        original[48, 48] = 19.25
        difference = self.work / 'difference.fits'
        marked = self.work / 'difference-candidates.fits'
        regions = self.work / 'difference-candidates.reg'
        fits.writeto(difference, original, self.wcs.to_header())
        candidate = {'x': 48, 'y': 48, 'centroidX': 48.25, 'centroidY': 47.75,
                     'ringRadiusPx': 9, 'ra': 10.123456789, 'dec': -20.987654321,
                     'snr': 12.5, 'scienceContrast': 8.25}
        write_candidate_products(difference, [candidate], marked, regions)
        with fits.open(marked) as hdus:
            np.testing.assert_array_equal(hdus[0].data, original)
            self.assertEqual(hdus['CANDIDATE_MASK'].data.dtype, np.uint16)
            self.assertEqual(int(hdus['CANDIDATE_MASK'].data[47, 57]), 1)
            row = hdus['CANDIDATES'].data[0]
            self.assertAlmostEqual(float(row['X_CENTROID']), 48.25)
            self.assertAlmostEqual(float(row['Y_CENTROID']), 47.75)
            self.assertAlmostEqual(float(row['RA_DEG']), 10.123456789)
        region_text = regions.read_text()
        self.assertIn('circle(49.250000,48.750000,9.000)', region_text)

    def test_independent_same_filter_followup_is_support_not_confirmation(self):
        followup = self.rng.normal(30, 2, (96, 96)) + self.point
        header = self.wcs.to_header()
        header['FILTER'] = 'zs'
        header['DATE-OBS'] = '2026-10-20T01:00:00'
        source = self.work / 'followup-original.fits'
        fits.writeto(source, followup, header)
        ra, dec = self.wcs.pixel_to_world_values(48, 48)
        result = check_candidate({
            'work': str(self.work / 'check'), 'comparison': str(source),
            'comparisonImageId': 2, 'maxDimension': 2048, 'sourceFwhm': 3,
            'sourceFilter': 'zs', 'sourceDate': '2026-10-19T01:00:00',
            'ra': float(ra), 'dec': float(dec),
        })
        self.assertEqual(result['status'], 'repeat_detection')
        self.assertTrue(result['sourceFound'])


if __name__ == '__main__':
    unittest.main()
