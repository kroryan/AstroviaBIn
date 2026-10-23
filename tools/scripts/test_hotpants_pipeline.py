"""Focused synthetic checks for AstroviaBin's post-HOTPANTS candidate validation."""

import tempfile
import unittest
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from hotpants_pipeline import (auto_reference_order, binned_wcs, bright_source_mask, elongated_source_mask, check_candidate, default_hotpants_args,
                               detect_candidates, estimate_fwhm, flag_known_objects, reduced_image,
                               science_band, write_candidate_products)


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

    def analyze(self, science_point=True, reference_point=False, dipole=False, bad=False, bad_value=0x8000 | 0x80 | 0x01):
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
        bad_mask = np.zeros((96, 96), dtype=np.int32)
        if bad:
            # What HOTPANTS writes for an unusable pixel (FLAG_OUTPUT_ISBAD | FLAG_INPUT_ISBAD | FLAG_BAD_PIXVAL).
            bad_mask[46:51, 46:51] = bad_value
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

    def test_ok_conv_flag_keeps_a_real_source(self):
        """Regression: FLAG_OK_CONV (0x40) marks valid pixels; it must not hide a new source."""
        candidates, _, rejected = self.analyze(bad=True, bad_value=0x40)
        self.assertEqual(len(candidates), 1, rejected)

    def test_masked_source_is_rejected(self):
        candidates, _, _ = self.analyze(bad=True)
        self.assertEqual(candidates, [])

    def test_downsample_conserves_integrated_flux_and_keeps_wcs_pixel_grid_exact(self):
        header = self.wcs.to_header()
        header['BUNIT'] = 'adu'
        header['NCOMBINE'] = 2  # a one-pixel source is a cosmic ray in a single exposure
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



class BinnedWcsTests(unittest.TestCase):
    def sip_wcs(self):
        header = fits.Header({
            'NAXIS': 2, 'NAXIS1': 2400, 'NAXIS2': 2400,
            'CTYPE1': 'RA---TAN-SIP', 'CTYPE2': 'DEC--TAN-SIP', 'CRVAL1': 347.6689, 'CRVAL2': 26.7322,
            'CRPIX1': 1200.5, 'CRPIX2': 1200.5, 'CD1_1': -2.0684735e-4, 'CD1_2': 9.36e-7,
            'CD2_1': 9.04e-7, 'CD2_2': 2.0682117e-4,
            'A_ORDER': 2, 'A_0_2': 6.58e-8, 'A_1_1': -7.97e-8, 'A_2_0': 5.73e-8,
            'B_ORDER': 2, 'B_0_2': -3.50e-8, 'B_1_1': -6.03e-8, 'B_2_0': -1.24e-7,
        })
        return WCS(header)

    def test_binned_wcs_with_cd_and_sip_matches_the_source(self):
        """Regression: WCS.slice() failed on SIP (read-only Sip.crpix) and ignored CD scaling."""
        source = self.sip_wcs()
        for factor in (2, 3, 4):
            binned = binned_wcs(source, factor)
            for x, y in ((0, 0), (250, 120), (599, 599)):
                expected = source.all_pix2world([[factor * x + (factor - 1) / 2, factor * y + (factor - 1) / 2]], 0)[0]
                actual = binned.all_pix2world([[x, y]], 0)[0]
                self.assertLess(np.hypot((actual[0] - expected[0]) * np.cos(np.radians(expected[1])),
                                         actual[1] - expected[1]) * 3600, 1e-3)

    def test_reduced_image_keeps_a_sip_wcs(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'stack.fits'
            header = self.sip_wcs().to_header(relax=True)
            fits.writeto(source, np.ones((2400, 2400), dtype=np.float32), header=header)
            output = Path(directory) / 'science.fits'
            factor = reduced_image(source, output, 800)
            self.assertEqual(factor, 3)
            reduced = WCS(fits.getheader(output))
            self.assertIsNotNone(reduced.sip)
            # astropy may write the linear part as PC+CDELT instead of CD; compare the effective matrix.
            self.assertAlmostEqual(abs(reduced.pixel_scale_matrix[0, 0]), 3 * 2.0684735e-4, places=10)


class KnownObjectTests(unittest.TestCase):
    def test_candidate_at_a_known_asteroid_is_flagged(self):
        wcs = WCS(naxis=2)
        wcs.wcs.crpix = [500, 500]
        wcs.wcs.cdelt = [-0.0002, 0.0002]
        wcs.wcs.crval = [347.6, 26.7]
        wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
        asteroid = {'name': '(1620) Geographos', 'class': 'NEA>Apollo', 'vmag': 14.6, 'ra': 347.6, 'dec': 26.7,
                    'positionErrorArcsec': 0.02, 'rateArcsecPerHour': [-35.9, -34.1]}
        candidates = [{'ra': 347.6 + 2 / 3600, 'dec': 26.7, 'status': 'needs_followup'},
                      {'ra': 347.7, 'dec': 26.75, 'status': 'needs_followup'}]
        flag_known_objects(candidates, [asteroid], wcs, 120)
        self.assertEqual(candidates[0]['status'], 'known_solar_system_object')
        self.assertEqual(candidates[0]['knownObject']['name'], '(1620) Geographos')
        self.assertEqual(candidates[1]['status'], 'needs_followup')


class ReferenceAndDefaultsTests(unittest.TestCase):
    def test_filter_names_map_to_survey_bands(self):
        cases = {'rp': 'r', 'zs': 'z', 'gp': 'g', 'ip': 'i', 'R': 'r', 'Ic': 'i', 'V': 'r', 'Ha': 'r', 'OIII': 'g', 'L': 'r', 'Ks': 'K'}
        for value, band in cases.items():
            self.assertEqual(science_band({'FILTER': value})[0], band, value)
        self.assertEqual(science_band({})[0], 'r')

    def test_auto_order_prefers_deep_matching_band_surveys(self):
        self.assertEqual(auto_reference_order('r', 26.7, 0.3)[:3], ['Pan-STARRS1 r stack', 'Legacy Surveys DR10 r', 'SDSS r'])
        wide = auto_reference_order('z', 26.7, 0.8)
        self.assertNotIn('Pan-STARRS1 z stack', wide, 'PS1 cutouts are limited to ~25 arcmin')
        self.assertEqual(wide[0], 'Legacy Surveys DR10 z')
        south = auto_reference_order('g', -45, 0.2)
        self.assertNotIn('Pan-STARRS1 g stack', south)
        self.assertEqual(south[-1], 'DSS2 Red')

    def test_fwhm_is_measured_from_isolated_stars(self):
        rng = np.random.default_rng(1)
        size = 400
        image = rng.normal(100, 3, (size, size))
        yy, xx = np.mgrid[:size, :size]
        sigma = 4.0 / 2.3548
        for x, y in rng.uniform(30, size - 30, (40, 2)):
            image += 2000 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * sigma ** 2))
        fwhm = estimate_fwhm(image.astype(np.float32))
        self.assertIsNotNone(fwhm)
        self.assertAlmostEqual(fwhm, 4.0, delta=0.4)

    def test_user_hotpants_flags_override_automatic_ones(self):
        science = np.random.default_rng(2).normal(0, 1, (64, 64)).astype(np.float32)
        args, info = default_hotpants_args(['-r', '12'], science, {'GAIN': 1.5, 'RDNOISE': 3.0, 'NCOMBINE': 4},
                                           science, np.zeros((64, 64), dtype=np.uint8), 3.0, 4.5,
                                           np.zeros((64, 64), dtype=bool))
        self.assertNotIn('-r', args)
        self.assertIn('-rss', args)
        self.assertEqual(args[args.index('-ig') + 1], '6')
        self.assertLess(float(args[args.index('-il') + 1]), 0, 'negative background-subtracted values stay valid')


class BrightStarMaskTests(unittest.TestCase):
    def test_saturated_star_and_bleed_trail_are_masked_but_faint_stars_are_not(self):
        image = np.random.default_rng(3).normal(10, 1, (200, 200))
        yy, xx = np.mgrid[:200, :200]
        image += np.minimum(5000, 20000 * np.exp(-((xx - 60) ** 2 + (yy - 60) ** 2) / 8))  # clipped star
        image[59:62, 30:95] = 5000  # bleed trail
        image += 300 * np.exp(-((xx - 150) ** 2 + (yy - 150) ** 2) / 4)  # ordinary star
        mask = bright_source_mask(image, np.zeros(image.shape, dtype=bool), 2.5)
        self.assertTrue(mask[60, 60] and mask[60, 32] and mask[60, 92])
        self.assertFalse(mask[150, 150])
        self.assertFalse(mask[180, 20])

    def test_bleeding_stars_are_masked_and_round_stars_are_kept(self):
        rng = np.random.default_rng(4)
        image = rng.normal(0, 1, (240, 240))
        yy, xx = np.mgrid[:240, :240]
        image += 800 * np.exp(-((xx - 60) ** 2 / (2 * 6.0 ** 2) + (yy - 60) ** 2 / (2 * 1.3 ** 2)))  # bleed-elongated
        image += 800 * np.exp(-((xx - 170) ** 2 + (yy - 170) ** 2) / (2 * 1.3 ** 2))  # round
        mask = elongated_source_mask(image, np.zeros(image.shape, dtype=bool), 3.0)
        self.assertTrue(mask[60, 60] and mask[60, 72])
        self.assertFalse(mask[170, 170])


class GalaxyIsNeverMaskedTests(unittest.TestCase):
    def test_extended_bright_galaxy_stays_unmasked(self):
        """Transients are searched in galaxies: a wide, elongated, bright disk must not be masked."""
        rng = np.random.default_rng(6)
        image = rng.normal(0, 1, (300, 300))
        yy, xx = np.mgrid[:300, :300]
        angle = np.radians(50)
        u = (xx - 150) * np.cos(angle) + (yy - 150) * np.sin(angle)
        v = -(xx - 150) * np.sin(angle) + (yy - 150) * np.cos(angle)
        image += 3000 * np.exp(-(u ** 2 / (2 * 60 ** 2) + v ** 2 / (2 * 12 ** 2)))  # galaxy disk
        image += 5000 * np.exp(-((xx - 40) ** 2 + (yy - 260) ** 2) / (2 * 1.3 ** 2))  # a bright star
        invalid = np.zeros(image.shape, dtype=bool)
        mask = bright_source_mask(image, invalid, 3.0) | elongated_source_mask(image, invalid, 3.0)
        self.assertFalse(mask[150, 150], 'galaxy nucleus must stay searchable')
        self.assertLess(mask[100:200, 100:200].mean(), 0.01)
        self.assertTrue(mask[260, 40], 'the bright star is still masked')

class ReferenceHoleTests(unittest.TestCase):
    def test_zero_filled_survey_holes_are_masked_after_alignment(self):
        """Regression: Legacy coadds zero saturated star cores; a science star there is not new."""
        from hotpants_pipeline import align_reference
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            wcs = WCS(naxis=2)
            wcs.wcs.crpix = [50, 50]
            wcs.wcs.cdelt = [-0.001, 0.001]
            wcs.wcs.crval = [10, -20]
            wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
            reference = np.random.default_rng(7).normal(1, 0.1, (100, 100)).astype(np.float32)
            reference[60:63, 30:33] = 0.0
            fits.writeto(work / 'reference.fits', reference, wcs.to_header(), overwrite=True)
            _, mask, _ = align_reference(work / 'reference.fits', wcs, fits.Header(), (100, 100), work / 'aligned.fits')
            self.assertTrue(mask[59:64, 29:34].all(), 'hole and its resampled edge are invalid')
            self.assertFalse(mask[20:40, 60:80].any(), 'normal sky stays valid')


class RegistrationTests(unittest.TestCase):
    def test_edge_misregistration_is_measured_and_corrected(self):
        """Regression: a WCS off by ~2 px at the edge made every star there a false candidate."""
        from hotpants_pipeline import registration_correction
        rng = np.random.default_rng(10)
        size = 400
        yy, xx = np.mgrid[:size, :size]
        positions = rng.uniform(15, size - 15, (220, 2))
        offset = lambda x, y: (2.0 * ((x - 200) / 200) ** 2, -0.8 * (y - 200) / 200)

        def render(shift):
            image = rng.normal(0, 1, (size, size))
            for x, y in positions:
                dx, dy = offset(x, y) if shift else (0, 0)
                image += 400 * np.exp(-((xx - x - dx) ** 2 + (yy - y - dy) ** 2) / (2 * 0.9 ** 2))
            return image
        science, reference = render(False), render(True)
        invalid = np.zeros((size, size), dtype=bool)
        correction, report = registration_correction(science, invalid, reference, invalid, 2.1)
        self.assertIsNotNone(correction)
        self.assertGreater(report['rmsBeforePx'], 0.8)
        self.assertLess(report['rmsAfterPx'], 0.15)
        for x, y in ((20, 30), (380, 200), (200, 380)):
            expected = offset(x, y)
            actual = correction(np.array([x]), np.array([y]))
            self.assertAlmostEqual(float(actual[0][0]), expected[0], delta=0.15)
            self.assertAlmostEqual(float(actual[1][0]), expected[1], delta=0.15)


class SaturatedReferenceStarTests(unittest.TestCase):
    def test_bleeding_reference_star_counts_as_present(self):
        """Regression: a DECam star with a cross-shaped bleed failed the PSF test and its
        subtraction residual was reported as a new source."""
        from hotpants_pipeline import reference_peak_present
        rng = np.random.default_rng(11)
        reference = rng.normal(0, 1, (96, 96))
        yy, xx = np.mgrid[:96, :96]
        reference += np.minimum(500, 3000 * np.exp(-((xx - 48) ** 2 + (yy - 48) ** 2) / (2 * 1.0 ** 2)))
        reference[48, 40:57] += 400  # bleed trail
        self.assertTrue(reference_peak_present(reference, 48, 48, 1.5))
        self.assertFalse(reference_peak_present(rng.normal(0, 1, (96, 96)), 48, 48, 1.5))


class DoubleStarTests(unittest.TestCase):
    def test_close_star_pairs_are_not_bleed_trails(self):
        """Regression: two neighbouring round stars masked ~8% of an undersampled field."""
        rng = np.random.default_rng(9)
        image = rng.normal(0, 1, (200, 200))
        yy, xx = np.mgrid[:200, :200]
        for x, y in ((60, 60), (66, 63), (140, 120), (145, 126)):
            image += 3000 * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 0.8 ** 2))
        mask = elongated_source_mask(image, np.zeros(image.shape, dtype=bool), 1.9)
        self.assertFalse(mask.any())


class CosmicRayTests(unittest.TestCase):
    def test_single_exposure_hits_are_removed_and_stars_kept(self):
        """Regression: cosmic rays and hot pixels in single frames became hundreds of candidates."""
        from hotpants_pipeline import clean_cosmic_rays
        rng = np.random.default_rng(8)
        image = rng.normal(500, 10, (200, 200)).astype(np.float32)
        yy, xx = np.mgrid[:200, :200]
        star = 4000 * np.exp(-((xx - 100) ** 2 + (yy - 60) ** 2) / (2 * 2.5 ** 2))
        image += star.astype(np.float32)
        hits = [(30, 40), (150, 170), (120, 20)]
        for y, x in hits:
            image[y, x] += 3000
        cleaned, count = clean_cosmic_rays(image, fits.Header({'GAIN': 1.0, 'RDNOISE': 10.0}))
        self.assertGreaterEqual(count, len(hits))
        for y, x in hits:
            self.assertLess(cleaned[y, x], 600)
        self.assertGreater(cleaned[60, 100], 4000, 'the star core is untouched')
        _, skipped = clean_cosmic_rays(image, fits.Header({'NCOMBINE': 7}))
        self.assertIsNone(skipped, 'stacks are already cosmic-ray rejected')


class SkyBotQueryTests(unittest.TestCase):
    def test_observer_code_is_sent_as_observer(self):
        """Regression: SkyBoT ignores "-loc"; the topocentric site must be passed as "-observer"."""
        import hotpants_pipeline as pipeline
        wcs = WCS(naxis=2)
        wcs.wcs.crpix = [600, 600]
        wcs.wcs.cdelt = [-0.0004, 0.0004]
        wcs.wcs.crval = [347.67, 26.73]
        wcs.wcs.ctype = ['RA---TAN', 'DEC--TAN']
        seen = {}

        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self, size=-1): return b'[]'

        def fake_urlopen(request, timeout=60):
            seen['url'] = request.full_url
            return Response()

        original = pipeline.urllib.request.urlopen
        pipeline.urllib.request.urlopen = fake_urlopen
        try:
            pipeline.known_solar_system_objects(wcs, (1200, 1200), {'DATE-OBS': '2026-10-14T01:53:10', 'EXPTIME': 120, 'SITEID': 'tfn'})
        finally:
            pipeline.urllib.request.urlopen = original
        self.assertIn('-observer=Z21', seen['url'])
        self.assertNotIn('-loc=', seen['url'])

if __name__ == '__main__':
    unittest.main()


class StoredSolutionTests(unittest.TestCase):
    """The plate solution AstroviaBin already verified is reused; solving again is only a fallback."""

    stored = {'crval1': 38.7514, 'crval2': 61.5502, 'crpix1': 364.5, 'crpix2': 245.5, 'cd11': -0.00243, 'cd12': 1.0e-5,
              'cd21': -1.1e-5, 'cd22': -0.00243, 'imageWidth': 728, 'imageHeight': 490,
              'sip': {'a': {'order': 2, 'terms': {'2_0': 1.0e-7}}, 'b': {'order': 2, 'terms': {'0_2': -2.0e-7}}}}

    def test_stored_solution_is_used_and_rescaled_to_the_binned_image(self):
        import hotpants_pipeline as pipeline
        from unittest import mock
        from wcs_transfer import reference_wcs
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fits.writeto(root / 'original.fits', np.zeros((490, 728), dtype=np.float32))
            fits.writeto(root / 'science.fits', np.zeros((245, 364), dtype=np.float32))  # block-integrated by 2
            with mock.patch.object(pipeline.subprocess, 'run', side_effect=AssertionError('must not solve again')):
                solution = pipeline.ensure_wcs(root / 'science.fits', root / 'original.fits', {'factor': 2}, root / 'solve', self.stored)
            expected = binned_wcs(reference_wcs(self.stored).celestial, 2)
            for x, y in ((0, 0), (100, 200), (363, 244)):
                self.assertAlmostEqual(float(solution.pixel_to_world_values(x, y)[0]), float(expected.pixel_to_world_values(x, y)[0]), places=9)
            self.assertTrue(WCS(fits.getheader(root / 'science.fits')).has_celestial, 'written into the prepared image')

    def test_a_solution_for_other_dimensions_is_not_used_and_a_timed_out_attempt_moves_on(self):
        import subprocess
        import hotpants_pipeline as pipeline
        from unittest import mock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fits.writeto(root / 'original.fits', np.zeros((100, 100), dtype=np.float32))  # not the stored 728x490
            fits.writeto(root / 'science.fits', np.zeros((100, 100), dtype=np.float32))
            calls = []

            def fake_run(command, **kwargs):
                calls.append(command)
                raise subprocess.TimeoutExpired(command, 150)
            with mock.patch.object(pipeline.subprocess, 'run', side_effect=fake_run):
                with self.assertRaises(RuntimeError) as failure:
                    pipeline.ensure_wcs(root / 'science.fits', root / 'original.fits', {'ra': 10.0, 'dec': 20.0, 'pixelScale': 2.0},
                                        root / 'solve', self.stored)
            self.assertEqual(len(calls), 3, 'every attempt is tried even after a timeout')
            self.assertIn('timed out', str(failure.exception))
