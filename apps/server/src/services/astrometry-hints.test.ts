import { it } from 'node:test';
import assert from 'node:assert/strict';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { headerScale, starHint, coordinateNameHint } = await import('./astrometry-local');
const { setSkyCatalog } = await import('./sky-catalog');

// Header of a real Slooh T2 frame (hd19373_…_b_cal.fit) — it has no RA/Dec at all.
const slooh = {
  NAXIS1: 1092, NAXIS2: 736, XPIXSZ: 13.6, XBINNING: 2, FOCALLEN: 480.79998779296875,
  INSTRUME: 'Slooh.com T2-UWF-85 SBIG ST-10XME @ 2.94arcsec/pix @ Binning 1x1', OBJECT: '',
} as Record<string, string | number | boolean>;

it('reads the pixel scale of binned frames correctly (it solved at 5.84″/px)', () => {
  const scale = headerScale(slooh)!;
  assert.ok(scale.scaleLowArcsec < 5.84 && scale.scaleHighArcsec > 5.84, JSON.stringify(scale));
  assert.ok(scale.scaleHighArcsec / scale.scaleLowArcsec < 1.3, 'a narrow range, not 5′–2000′');
  // Without the INSTRUME text, XPIXSZ (already binned in the SBIG/MaxIm convention) still covers it.
  const fromOptics = headerScale({ XPIXSZ: 13.6, XBINNING: 2, FOCALLEN: 480.8 })!;
  assert.ok(fromOptics.scaleLowArcsec < 5.84 && fromOptics.scaleHighArcsec > 5.84, JSON.stringify(fromOptics));
  // An existing WCS wins.
  const wcs = headerScale({ CRVAL1: 10, CD1_1: -0.0005, CD2_2: 0.0005, CD1_2: 0, CD2_1: 0 })!;
  assert.ok(wcs.scaleLowArcsec < 1.8 && wcs.scaleHighArcsec > 1.8);
  assert.equal(headerScale({ OBJECT: 'nothing useful' }), null);
});

it('reads coordinates written into file names', () => {
  const hint = coordinateNameHint(['095102p115201 20261017 060057 0 ko6dnc m cal'])!;
  assert.ok(Math.abs(hint.ra - (9 + 51 / 60 + 2 / 3600) * 15) < 1e-6);
  assert.ok(Math.abs(hint.dec - (11 + 52 / 60 + 1 / 3600)) < 1e-6);
  const south = coordinateNameHint(['J053045-052301'])!;
  assert.ok(south.dec < 0);
  assert.equal(coordinateNameHint(['hd19373 20261017 022127 0 cc7pwb b cal']), null, 'dates and times are not coordinates');
});

it('resolves HD/HIP numbers and proper star names from the offline catalogue', () => {
  const names = ['Algol', '', ''];
  setSkyCatalog({
    stars: {
      epoch: 2000, count: 3, ra: Float64Array.from([47.04, 47.37, 355.95]), dec: Float64Array.from([40.96, 49.61, -15.34]),
      mag: Float32Array.from([2.1, 4.1, 6.5]), pmra: new Float32Array(3), pmdec: new Float32Array(3),
      hd: Int32Array.from([19356, 19373, 222800]), hip: Int32Array.from([14576, 14632, 117054]),
      name: names, bayer: ['β Per', 'ι Per', 'R Aqr'], flam: ['', '', ''],
    },
    dso: [], constellations: [],
  });
  assert.equal(starHint(['hd19373 20261017 022127 0 cc7pwb b cal'])!.dec, 49.61);
  assert.equal(starHint(['hip117054 20261017 014616 4 zk25pv g cal'])!.ra, 355.95);
  assert.equal(starHint(['algolbetapersei 20261017 031909 0 87dgzl r cal'])!.label, 'star Algol');
  assert.equal(starHint(['m45 20261017 032749 1 itkgvx m cal']), null);
  setSkyCatalog(null);
});
