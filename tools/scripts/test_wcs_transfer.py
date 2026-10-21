"""Tests for tools/scripts/wcs_transfer.py (synthetic star fields with a known WCS)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

SCRIPT = Path(__file__).resolve().parent / "wcs_transfer.py"


def star_field(stars, shape=(800, 800), seed=0):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:shape[0], 0:shape[1]]
    image = rng.normal(100, 5, shape)
    for x, y, flux in stars:
        image += flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.5 ** 2))
    return image.astype(np.float32)


def stored_wcs(centre=(150.0, 20.0), scale_deg=1.27 / 3600, shape=(800, 800)):
    return {"crval1": centre[0], "crval2": centre[1], "crpix1": shape[1] / 2 + 0.5, "crpix2": shape[0] / 2 + 0.5,
            "cd11": -scale_deg, "cd12": 0.0, "cd21": 0.0, "cd22": scale_deg, "imageWidth": shape[1], "imageHeight": shape[0]}


class WcsTransfer(unittest.TestCase):
    def run_transfer(self, target, reference, wcs):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fits.PrimaryHDU(target).writeto(root / "target.fits")
            fits.PrimaryHDU(reference).writeto(root / "reference.fits")
            (root / "wcs.json").write_text(json.dumps(wcs))
            done = subprocess.run([sys.executable, str(SCRIPT), str(root / "target.fits"), str(root / "reference.fits"),
                                   str(root / "wcs.json"), str(root / "out.wcs")], capture_output=True, text=True)
            summary = json.loads(done.stdout.strip().splitlines()[-1])
            header = fits.getheader(root / "out.wcs") if done.returncode == 0 else None
        return done.returncode, summary, header

    def test_same_pointing_inherits_the_wcs_with_the_measured_shift(self):
        rng = np.random.default_rng(1)
        stars = [(x, y, f) for x, y, f in zip(rng.uniform(30, 770, 60), rng.uniform(30, 770, 60), rng.uniform(300, 5000, 60))]
        reference = star_field(stars, seed=2)
        shift = (3.4, -2.1)  # target = reference field moved by a few pixels (filter change, tracking)
        target = star_field([(x + shift[0], y + shift[1], f * 0.3) for x, y, f in stars], seed=3)  # fainter (blue, 4 s)
        wcs = stored_wcs()
        code, summary, header = self.run_transfer(target, reference, wcs)
        self.assertEqual(code, 0, summary)
        self.assertGreaterEqual(summary["stars"], 15)
        self.assertLess(summary["rmsPx"], 0.5)
        # A star at reference pixel (400, 400) is at target pixel (400 + dx, 400 + dy): same sky position.
        sky_reference = WCS(fits.Header({"CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN", "CRVAL1": wcs["crval1"], "CRVAL2": wcs["crval2"],
                                         "CRPIX1": wcs["crpix1"], "CRPIX2": wcs["crpix2"], "CD1_1": wcs["cd11"], "CD1_2": 0.0,
                                         "CD2_1": 0.0, "CD2_2": wcs["cd22"]})).pixel_to_world(400, 400)
        sky_target = WCS(header).pixel_to_world(400 + shift[0], 400 + shift[1])
        self.assertLess(sky_reference.separation(sky_target).arcsec, 0.5)

    def test_a_different_field_is_rejected(self):
        rng = np.random.default_rng(4)
        reference = star_field([(x, y, f) for x, y, f in zip(rng.uniform(30, 770, 60), rng.uniform(30, 770, 60), rng.uniform(300, 5000, 60))], seed=5)
        other = star_field([(x, y, f) for x, y, f in zip(rng.uniform(30, 770, 60), rng.uniform(30, 770, 60), rng.uniform(300, 5000, 60))], seed=6)
        code, summary, header = self.run_transfer(other, reference, stored_wcs())
        self.assertNotEqual(code, 0, summary)
        self.assertFalse(summary["ok"])
        self.assertIsNone(header)


if __name__ == "__main__":
    unittest.main()
