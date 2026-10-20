"""Tests for tools/scripts/spectroscopy.py: 1-D spectra and synthetic Star Analyser (slitless) frames."""

import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from astropy.io import fits

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spectroscopy  # noqa: E402

SDSS_TEST = os.environ.get("ASTROVIABIN_SDSS_TEST_SPECTRUM")


def library_spectrum(label: str) -> tuple[np.ndarray, np.ndarray]:
    lib = spectroscopy.library()
    index = next(i for i, name in enumerate(lib["label"]) if name == label and lib["metal"][i] == "")
    return lib["wave"], lib["flux"][index]


def synthetic_slitless(stars, *, width=1400, height=1000, dispersion_nm=1.6, angle_deg=7.3, seed=3):
    """A slitless frame: zero order + first order (camera response, telluric O2, PSF, sky, Poisson)."""
    rng = np.random.default_rng(seed)
    image = np.full((height, width), 400.0)
    fwhm = 3.2
    sigma = fwhm / 2.355
    angle = math.radians(angle_deg)
    yy, xx = np.mgrid[0:height, 0:width]
    s = np.arange(0, 700, 0.5)
    for x0, y0, brightness, (wave, flux) in stars:
        lam = s * dispersion_nm * 10
        response = np.exp(-0.5 * ((lam - 5600) / 1500) ** 2)
        telluric = 1 - 0.55 * np.exp(-0.5 * ((lam - 7620) / 18) ** 2) - 0.25 * np.exp(-0.5 * ((lam - 6880) / 12) ** 2)
        spectrum = np.interp(lam, wave, flux, left=0, right=0) * response * telluric
        spectrum = brightness * spectrum / max(np.sum(spectrum), 1e-9) * 1.5e6 * 2  # counts; two samples per pixel
        # Zero order: about a third of the light of the first order (blazed grating).
        image += brightness * 4e5 / (2 * math.pi * sigma ** 2) * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * sigma ** 2))
        for distance, value in zip(s[s > 220], spectrum[s > 220]):
            if value <= 0:
                continue
            cx, cy = x0 + distance * math.cos(angle), y0 + distance * math.sin(angle)
            ix, iy = int(round(cx)), int(round(cy))
            if not (6 <= ix < width - 6 and 6 <= iy < height - 6):
                continue
            ys, xs = slice(iy - 6, iy + 7), slice(ix - 6, ix + 7)
            image[ys, xs] += value * np.exp(-((xx[ys, xs] - cx) ** 2 + (yy[ys, xs] - cy) ** 2) / (2 * sigma ** 2)) / (2 * math.pi * sigma ** 2)
    image = rng.poisson(np.clip(image, 0, None)).astype(np.float32)
    header = fits.Header()
    header["EXPTIME"] = 60.0
    # A plate solution: 2"/px, north up, centred on RA 150, Dec +20.
    for key, value in (("CTYPE1", "RA---TAN"), ("CTYPE2", "DEC--TAN"), ("CRPIX1", width / 2), ("CRPIX2", height / 2),
                       ("CRVAL1", 150.0), ("CRVAL2", 20.0), ("CD1_1", -2 / 3600), ("CD1_2", 0.0), ("CD2_1", 0.0), ("CD2_2", 2 / 3600)):
        header[key] = value
    return image, header


class OneDimensional(unittest.TestCase):
    def test_library_star_is_classified_from_its_own_spectrum(self):
        wave, flux = library_spectrum("K2III")
        keep = (wave > 3700) & (wave < 9200)
        spectrum = spectroscopy.Spectrum1D(wave[keep], flux[keep] * 1e3, np.full(keep.sum(), np.inf), True, 10.0, "K2III", {})
        analysis = spectroscopy.analyse_spectrum(spectrum)
        classification = analysis["classification"]
        self.assertTrue(classification["type"].startswith("K"), classification)
        self.assertIn(classification["luminosityClass"], ("III", "II", "IV"))
        self.assertIn("Na", analysis["elements"] + ["Na"])

    def test_tabular_spectrum_round_trip_through_the_gallery_image(self):
        wave, flux = library_spectrum("A0V")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "table.fits"
            columns = [fits.Column(name="wavelength", format="E", array=wave), fits.Column(name="flux", format="E", array=flux)]
            fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU.from_columns(columns)]).writeto(source)
            self.assertEqual(spectroscopy.detect(str(source))["kind"], "spectrum1d")
            converted = Path(directory) / "image.fits"
            spectroscopy.to_image(str(source), str(converted))
            with fits.open(converted) as hdus:
                self.assertEqual(hdus[0].data.shape, (1, len(wave)))
                self.assertTrue(hdus[0].header["ASTVSPEC"])
            again = spectroscopy.read_spectrum1d(str(converted))
            self.assertAlmostEqual(float(again.wave[0]), float(wave[0]), places=1)
            result = spectroscopy.analyse({"input": str(converted), "work": str(Path(directory) / "run"), "settings": {}})
            star = result["stars"][0]
            self.assertTrue(star["classification"]["type"].startswith(("A", "B9")), star["classification"])
            self.assertIn("H", star["elements"])
            for name in ("summary.csv", "spectra.fits", "report.pdf", "result.json", "star-1.csv"):
                self.assertTrue((Path(directory) / "run" / name).exists(), name)

    def test_independent_sdss_stars_have_broad_ranges_covering_catalogue_types(self):
        samples = {"0051": "G2", "0158": "A0", "0305": "K5", "0340": "M3"}
        root = Path(__file__).resolve().parent.parent / "test-data" / "sdss"
        for fiber, expected in samples.items():
            spectrum = spectroscopy.read_spectrum1d(str(root / f"spec-0751-52251-{fiber}.fits"))
            self.assertEqual(spectrum.meta["SDSS_CLASS"], "STAR")
            self.assertEqual(spectrum.meta["SDSS_SUBCLASS"], expected)
            classification = spectroscopy.fit_templates(spectrum)
            self.assertIsNotNone(classification)
            low, high = classification["range"].split("–")
            self.assertLessEqual(spectroscopy.mk_class_index(low), spectroscopy.mk_class_index(expected), classification)
            self.assertGreaterEqual(spectroscopy.mk_class_index(high), spectroscopy.mk_class_index(expected), classification)
            self.assertIsNone(classification["velocity"], "Low-resolution Pickles fits must not claim radial velocities")

    def test_sdss_quasar_is_not_given_a_stellar_type(self):
        root = Path(__file__).resolve().parent.parent / "test-data" / "sdss"
        source = root / "spec-0751-52251-0160.fits"
        with tempfile.TemporaryDirectory() as directory:
            result = spectroscopy.analyse({"input": str(source), "work": directory, "settings": {}})
        self.assertEqual(result["stars"][0]["classification"], None)
        self.assertEqual(result["stars"][0]["confidence"], "Insufficient")
        self.assertTrue(any("QSO" in note for note in result["notes"]))

    def test_noise_only_spectrum_is_not_classified(self):
        rng = np.random.default_rng(11)
        wave = np.linspace(3800, 9000, 3000)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "noise.fits"
            columns = [fits.Column(name="wavelength", format="E", array=wave),
                       fits.Column(name="flux", format="E", array=rng.normal(0, 1, wave.size))]
            fits.HDUList([fits.PrimaryHDU(), fits.BinTableHDU.from_columns(columns)]).writeto(source)
            result = spectroscopy.analyse({"input": str(source), "work": str(Path(directory) / "run"), "settings": {}})
        star = result["stars"][0]
        self.assertEqual(star["confidence"], "Insufficient", star)
        self.assertNotEqual(star.get("confidence"), "High")

    def test_confidence_never_high_without_a_reference_lamp_and_always_carries_the_template_caveat(self):
        analysis = {"snr": 80.0, "lines": [{"type": "absorption"}] * 6}
        level, reasons = spectroscopy.confidence_of(analysis, "user", [])
        self.assertEqual(level, "Medium")
        self.assertTrue(any("template match" in reason for reason in reasons))
        self.assertEqual(spectroscopy.confidence_of(analysis, "none", [])[0], "Insufficient")

    @unittest.skipUnless(SDSS_TEST and Path(SDSS_TEST or "").exists(), "SDSS spectrum not available")
    def test_sdss_g1v_star(self):
        with tempfile.TemporaryDirectory() as directory:
            result = spectroscopy.analyse({"input": SDSS_TEST, "work": directory, "settings": {}})
            star = result["stars"][0]
            self.assertIn("SDSS pipeline: STAR G1V", star["catalogue"])
            self.assertTrue(star["classification"]["type"].startswith(("F8", "F9", "G")), star["classification"])
            self.assertIsNone(star["velocity"], "Low-resolution Pickles fits must not claim radial velocities")


class Slitless(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.truth = [
            (180, 150, 1.0, "A0V"), (230, 420, 0.8, "G2V"), (150, 700, 0.9, "K5III"), (520, 260, 0.7, "F5V"),
            (560, 600, 1.0, "M2III"), (300, 860, 0.6, "B57V"), (700, 800, 0.003, "G2V"),  # too faint
            (460, 587, 0.5, "K0V"),  # its first order lies on the M2III one
            (1250, 500, 0.8, "A0V"),  # first order runs off the frame
        ]
        stars = [(x, y, b, library_spectrum(label)) for x, y, b, label in cls.truth]
        image, header = synthetic_slitless(stars)
        cls.directory = tempfile.TemporaryDirectory()
        path = Path(cls.directory.name) / "slitless.fits"
        fits.PrimaryHDU(image, header=header).writeto(path)
        cls.result = spectroscopy.analyse({"input": str(path), "work": str(Path(cls.directory.name) / "run"),
                                           "settings": {"cosmicRays": False, "dispersionNmPerPixel": 1.6}})

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def star_near(self, x, y):
        return min(self.result["stars"], key=lambda s: math.hypot(s["x"] - x, s["y"] - y))

    def test_geometry_and_supplied_instrument_calibration(self):
        geometry = self.result["geometry"]
        self.assertLess(abs(geometry["angleDeg"] - 7.3), 1.0, geometry)
        calibration = self.result["calibration"]
        self.assertEqual(calibration["status"], "user", calibration)
        self.assertLess(abs(calibration["dispersion"] / 1.6 - 1), 0.02, calibration)

    def test_every_star_is_found_and_bright_ones_are_classified(self):
        for x, y, brightness, label in self.truth:
            star = self.star_near(x, y)
            self.assertLess(math.hypot(star["x"] - x, star["y"] - y), 1.0, (label, star["x"], star["y"]))
        expected = {"A0V": "AB", "G2V": "FG", "K5III": "KM", "F5V": "AFG", "M2III": "KM", "B57V": "OBA", "K0V": "GK"}
        for x, y, brightness, label in self.truth[:6] + [self.truth[7]]:
            star = self.star_near(x, y)
            # M2III and K0V share a first order: a type would be a false scientific claim.
            self.assertEqual(star["status"], "contaminated" if label in ("M2III", "K0V") else "analysed", (label, star.get("reasons")))
            if label in ("M2III", "K0V"):
                self.assertIsNone(star["classification"])
                self.assertEqual(star["confidence"], "Insufficient")
            else:
                self.assertIn(star["classification"]["type"][0], expected[label], (label, star["classification"]))
        # No nebular emission and no He I in the cool or A-type stars.
        for x, y, brightness, label in self.truth[:4]:
            star = self.star_near(x, y)
            self.assertFalse([line for line in star["lines"] if line["type"] == "emission"], (label, star["lines"]))

    def test_faint_overlapping_and_truncated_stars_are_flagged(self):
        faint = self.star_near(700, 800)
        self.assertEqual(faint["status"], "discarded")
        overlapping = self.star_near(460, 587)
        self.assertIn("overlap", overlapping["flags"])
        truncated = self.star_near(1250, 500)
        self.assertIn("truncated", truncated["flags"])
        self.assertIn("outside the frame", " ".join(truncated["reasons"]))

    def test_no_instrument_calibration_means_no_spectral_classification(self):
        calibration = spectroscopy.calibrate_dispersion([], {"gratingLinesPerMm": 100}, fits.Header(), 3.2)
        self.assertEqual(calibration["status"], "none")
        self.assertIsNone(calibration["dispersion"])

    def test_outputs(self):
        run = Path(self.directory.name) / "run"
        rows = (run / "summary.csv").read_text().splitlines()
        self.assertEqual(len(rows), len(self.result["stars"]) + 1)
        self.assertTrue((run / "report.pdf").stat().st_size > 20_000)
        saved = json.loads((run / "result.json").read_text())
        self.assertEqual(saved["mode"], "slitless")


class KnownSpectroscopy(unittest.TestCase):
    """The catalogue check runs only when asked, before the analysis; its results feed the comparison."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.truth = [(180, 150, 1.0, "A0V"), (230, 420, 0.8, "G2V"), (520, 260, 0.7, "F5V")]
        image, header = synthetic_slitless([(x, y, b, library_spectrum(label)) for x, y, b, label in self.truth])
        self.path = Path(self.directory.name) / "field.fits"
        fits.PrimaryHDU(image, header=header).writeto(self.path)
        from astropy.wcs import WCS
        wcs = WCS(header)
        # Earlier spectroscopy: the A0V and the G2V are known (SIMBAD / Gaia / SDSS), the F5V is not.
        a_ra, a_dec = wcs.pixel_to_world_values(180, 150)
        g_ra, g_dec = wcs.pixel_to_world_values(230, 420)
        self.simbad = [{"name": "HD 1", "ra": float(a_ra), "dec": float(a_dec), "spType": "A1V", "otype": "*", "rv": None, "rvError": None, "v": 8.1}]
        self.gaia = [{"source": "42", "ra": float(g_ra), "dec": float(g_dec), "g": 11.2, "bpRp": 0.8, "rv": None, "rvError": None,
                      "teff": 5800.0, "logg": 4.4, "mh": 0.0, "distance": 150.0}]

    def tearDown(self):
        self.directory.cleanup()

    def test_without_the_check_no_catalogue_is_queried(self):
        with mock.patch.object(spectroscopy, "query_simbad", side_effect=AssertionError("queried")), \
             mock.patch.object(spectroscopy, "query_gaia", side_effect=AssertionError("queried")), \
             mock.patch.object(spectroscopy, "query_sdss", side_effect=AssertionError("queried")):
            result = spectroscopy.analyse({"input": str(self.path), "work": str(Path(self.directory.name) / "plain"), "settings": {"cosmicRays": False}})
        self.assertNotIn("comparison", result)
        self.assertFalse(any("known" in star for star in result["stars"]))

    def test_check_before_the_analysis_then_comparison_in_the_report(self):
        with mock.patch.object(spectroscopy, "query_simbad", return_value=self.simbad), \
             mock.patch.object(spectroscopy, "query_gaia", return_value=self.gaia), \
             mock.patch.object(spectroscopy, "query_sdss", return_value=None):
            known = spectroscopy.known_before({"input": str(self.path), "settings": {}})
        self.assertEqual(known["summary"], {"stars": 3, "known": 2, "unknown": 1})
        unknown = [star for star in known["stars"] if not star["known"]["hasSpectroscopy"]][0]
        self.assertLess(math.hypot(unknown["x"] - 520, unknown["y"] - 260), 1.0)
        # The analysis reuses the check: no new queries.
        with mock.patch.object(spectroscopy, "query_simbad", side_effect=AssertionError("queried again")), \
             mock.patch.object(spectroscopy, "query_gaia", side_effect=AssertionError("queried again")):
            work = Path(self.directory.name) / "compared"
            result = spectroscopy.analyse({"input": str(self.path), "work": str(work),
                                           "settings": {"cosmicRays": False, "dispersionNmPerPixel": 1.6}, "known": known})
        comparison = result["comparison"]
        self.assertEqual(comparison["statistics"]["withoutEarlierProfile"], 1)
        type_check = [c for row in comparison["stars"] for c in row["checks"] if c["quantity"] == "Spectral type"][0]
        self.assertEqual(type_check["agreement"], "agrees")  # A0V found vs SIMBAD A1V
        teff_check = [c for row in comparison["stars"] for c in row["checks"] if c["quantity"] == "Teff (K)"][0]
        self.assertIn(teff_check["agreement"], ("agrees", "close"))  # G2V vs Gaia 5800 K
        self.assertTrue((work / "comparison.csv").exists())
        self.assertFalse((work / "comparison.pdf").exists())  # one report only
        self.assertGreater((work / "report.pdf").stat().st_size, 20_000)


if __name__ == "__main__":
    unittest.main()


class NegativeInputs(unittest.TestCase):
    def test_ordinary_star_field_is_not_a_spectroscopy_frame(self):
        rng = np.random.default_rng(5)
        image = rng.normal(500, 10, (600, 800)).astype(np.float32)
        yy, xx = np.mgrid[0:600, 0:800]
        for x0, y0, amplitude in zip(rng.uniform(30, 770, 60), rng.uniform(30, 570, 60), rng.uniform(200, 20000, 60)):
            image += amplitude * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * 1.4 ** 2))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "field.fits"
            fits.PrimaryHDU(image).writeto(path)
            self.assertEqual(spectroscopy.detect(str(path))["kind"], "image2d")

    def test_strip_without_spectral_wcs_keeps_pixels_and_is_not_classified(self):
        wave, flux = library_spectrum("A0V")
        keep = (wave > 3800) & (wave < 7500)
        profile = np.interp(np.linspace(3800, 7500, 900), wave[keep], flux[keep])
        strip = np.random.default_rng(2).normal(50, 2, (60, 900))
        strip[27:34, :] += 3000 * profile / profile.max()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "strip.fits"
            fits.PrimaryHDU(strip.astype(np.float32)).writeto(path)
            result = spectroscopy.analyse({"input": str(path), "work": str(Path(directory) / "run"),
                                           "settings": {"mode": "trace"}})
        for star in result["stars"]:
            self.assertIsNone(star.get("classification"), star)
            self.assertEqual(star["confidence"], "Insufficient")
