"""Focused synthetic checks for AstroviaBin's post-HOTPANTS candidate validation."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from hotpants_pipeline import check_candidate, detect_candidates


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
