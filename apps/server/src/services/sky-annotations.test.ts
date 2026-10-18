import { it } from 'node:test';
import assert from 'node:assert/strict';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { annotateField } = await import('./sky-annotations');
const { parseWcsHeaders, skyToPixel } = await import('./wcs');

// 1"/px, north up, east left, 2000 x 1000 frame centred on M 42.
const wcs = parseWcsHeaders({
  CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 83.82, CRVAL2: -5.39,
  CRPIX1: 1000.5, CRPIX2: 500.5, CD1_1: -1 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 1 / 3600,
}, 2000, 1000);

const entry = (name: string, raDeg: number, decDeg: number, extra: Record<string, unknown> = {}) => ({
  name, type: 'Neb', raDeg, decDeg, majorAxis: null, minorAxis: null, vMag: null, bMag: null, messier: null, commonNames: null, ...extra,
});

it('places catalogue objects at their WCS pixel position in image-content coordinates', () => {
  const [annotation] = annotateField(wcs, [entry('NGC 1976', 83.82, -5.39, { messier: 'M 42', majorAxis: 10, commonNames: 'Orion Nebula' })]);
  // FITS pixel 1000.5 (1-based centre) → content coordinate 1000.
  assert.ok(Math.abs(annotation.pixelx - 1000) < 1e-6);
  assert.ok(Math.abs(annotation.pixely - 500) < 1e-6);
  assert.deepEqual(annotation.names, ['M 42', 'NGC 1976', 'Orion Nebula']);
  assert.equal(annotation.type, 'messier');
  // 10' diameter at 1"/px → 300 px radius.
  assert.ok(Math.abs(annotation.radius! - 300) < 1e-6);
});

it('keeps off-centre objects exactly where the projection puts them', () => {
  const ra = 83.82 + 0.1;
  const dec = -5.39 + 0.05;
  const [annotation] = annotateField(wcs, [entry('NGC 1977', ra, dec)]);
  const expected = skyToPixel(wcs, ra, dec)!;
  assert.ok(Math.abs(annotation.pixelx - (expected.x - 0.5)) < 1e-9);
  assert.ok(Math.abs(annotation.pixely - (expected.y - 0.5)) < 1e-9);
});

it('drops objects outside the frame but keeps large ones that overlap it', () => {
  const annotations = annotateField(wcs, [
    entry('NGC 1', 83.82, -4.0),
    entry('NGC 2', 83.82, -5.39 + 0.15, { majorAxis: 30 }),
  ]);
  assert.deepEqual(annotations.map(item => item.names[0]), ['NGC 2']);
});
