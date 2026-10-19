import { it } from 'node:test';
import assert from 'node:assert/strict';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { computeSkyOverlay, offsetPoint } = await import('./sky-overlay');
const { parseWcsHeaders, skyToPixel } = await import('./wcs');
import type { SkyCatalog } from './sky-catalog';

// 2"/px, north up, east left, 1800 x 1200 frame centred on RA 56.75, Dec +24.1 (the Pleiades).
const wcs = parseWcsHeaders({
  CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 56.75, CRVAL2: 24.1,
  CRPIX1: 900.5, CRPIX2: 600.5, CD1_1: -2 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 2 / 3600,
}, 1800, 1200);

function catalog(): SkyCatalog {
  const stars = [
    // Alcyone with a strong (fictional) proper motion to make the epoch shift measurable.
    { ra: 56.871, dec: 24.105, mag: 2.87, pmra: 1000, pmdec: -2000, hd: 23630, hip: 17702, name: 'Alcyone', bayer: 'η Tau', flam: '25 Tau' },
    // HD-only entry without magnitude or proper motion; Tycho-2 has the same star 2" away.
    { ra: 56.70, dec: 24.20, mag: null, pmra: 0, pmdec: 0, hd: 23511, hip: 0, name: '', bayer: '', flam: '' },
    // Far away: never in the field.
    { ra: 120, dec: -40, mag: 1, pmra: 0, pmdec: 0, hd: 1, hip: 0, name: 'Faraway', bayer: '', flam: '' },
  ].sort((a, b) => a.dec - b.dec);
  const column = <K extends keyof typeof stars[number]>(key: K) => stars.map(star => star[key]);
  const tycho = [
    { ra: 56.70 + 2 / 3600 / Math.cos(24.2 * Math.PI / 180), dec: 24.20, mag: 9.12, tyc: [1800, 1, 1] },
    { ra: 56.60, dec: 24.00, mag: 11.5, tyc: [1800, 2, 1] },
  ].sort((a, b) => a.dec - b.dec);
  return {
    stars: {
      epoch: 2000, count: stars.length,
      ra: Float64Array.from(column('ra') as number[]), dec: Float64Array.from(column('dec') as number[]),
      mag: Float32Array.from(column('mag').map(value => value ?? Number.NaN) as number[]),
      pmra: Float32Array.from(column('pmra') as number[]), pmdec: Float32Array.from(column('pmdec') as number[]),
      hd: Int32Array.from(column('hd') as number[]), hip: Int32Array.from(column('hip') as number[]),
      name: column('name') as string[], bayer: column('bayer') as string[], flam: column('flam') as string[],
    },
    tycho: {
      epoch: 2000, count: tycho.length,
      ra: Float32Array.from(tycho.map(star => star.ra)), dec: Float32Array.from(tycho.map(star => star.dec)),
      mag: Int16Array.from(tycho.map(star => Math.round(star.mag * 1000))),
      pmra: new Int16Array(tycho.length), pmdec: new Int16Array(tycho.length),
      tyc1: Uint16Array.from(tycho.map(star => star.tyc[0])), tyc2: Uint16Array.from(tycho.map(star => star.tyc[1])), tyc3: Uint8Array.from(tycho.map(star => star.tyc[2])),
    },
    dso: [
      { name: 'NGC 1435', messier: '', common: ['Merope Nebula'], type: 'RfN', ra: 56.75, dec: 23.9, maj: 10, min: 5, pa: 90, mag: null },
      { name: 'NGC 9999', messier: '', common: [], type: 'G', ra: 200, dec: 10, maj: 1, min: 1, pa: 0, mag: 12 },
    ],
    constellations: [{ id: 'Tau', name: 'Taurus', genitive: 'Tauri', label: [56.75, 24.1], lines: [[[56.0, 24.0], [57.5, 24.2]]] }],
  };
}

it('places named stars through the WCS with their proper motion at the capture epoch', () => {
  const overlay = computeSkyOverlay(wcs, { epoch: 2001, catalog: catalog() })!;
  const alcyone = overlay.stars.find(star => star.names.includes('Alcyone'))!;
  assert.equal(alcyone.label, 'Alcyone (η Tau)');
  // +1 year: +1000 mas/yr (RA·cos δ) and −2000 mas/yr → +1"/cosδ in RA, −2" in Dec.
  const moved = skyToPixel(wcs, 56.871 + 1 / 3600 / Math.cos(24.105 * Math.PI / 180), 24.105 - 2 / 3600)!;
  assert.ok(Math.abs(alcyone.x - (moved.x - 0.5)) < 1e-6 && Math.abs(alcyone.y - (moved.y - 0.5)) < 1e-6, `${alcyone.x},${alcyone.y} vs ${moved.x - 0.5},${moved.y - 0.5}`);
  assert.ok(!overlay.stars.some(star => star.names.includes('Faraway')));
});

it('merges an HD-only star with its Tycho-2 counterpart and adopts the Tycho magnitude', () => {
  const overlay = computeSkyOverlay(wcs, { epoch: 2000, catalog: catalog() })!;
  const merged = overlay.stars.filter(star => star.names.includes('HD 23511'));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].names, ['HD 23511', 'TYC 1800-1-1']);
  assert.equal(merged[0].mag, 9.12);
  assert.ok(overlay.stars.some(star => star.label === 'TYC 1800-2-1'));
  assert.equal(overlay.stars.length, 3);
});

it('draws deep-sky outlines with catalogue size and position angle', () => {
  const overlay = computeSkyOverlay(wcs, { epoch: 2000, catalog: catalog() })!;
  assert.equal(overlay.objects.length, 1);
  const nebula = overlay.objects[0];
  assert.deepEqual(nebula.names, ['NGC 1435', 'Merope Nebula']);
  // 10' x 5' at 2"/px → semi-axes 150 and 75 px; PA 90° points east, i.e. towards −x here.
  assert.ok(Math.abs(nebula.rx - 150) < 0.5, `rx ${nebula.rx}`);
  assert.ok(Math.abs(nebula.ry - 75) < 0.5, `ry ${nebula.ry}`);
  assert.ok(Math.abs(Math.abs(nebula.angle) - 180) < 0.5, `angle ${nebula.angle}`);
});

it('projects constellation figures and an RA/Dec grid', () => {
  const overlay = computeSkyOverlay(wcs, { epoch: 2000, catalog: catalog() })!;
  assert.equal(overlay.constellations.labels[0].name, 'Taurus');
  assert.ok(overlay.constellations.lines.length >= 1);
  assert.ok(overlay.constellations.lines[0].points.length > 2, 'segments are densified along the great circle');
  const decLines = overlay.grid.lines.filter(line => line.kind === 'dec');
  const raLines = overlay.grid.lines.filter(line => line.kind === 'ra');
  assert.ok(decLines.length >= 2 && raLines.length >= 2);
  assert.match(decLines[0].label, /^[+−]2[34]°\d\d′$/);
  assert.match(raLines[0].label, /^3h\d\dm/);
});

it('computes destination points along a position angle on the sphere', () => {
  const north = offsetPoint(10, 20, 0, 1);
  assert.ok(Math.abs(north.ra - 10) < 1e-9 && Math.abs(north.dec - 21) < 1e-9);
  const east = offsetPoint(10, 0, 90, 1);
  assert.ok(Math.abs(east.ra - 11) < 1e-9 && Math.abs(east.dec) < 1e-9);
});

it('returns null without the sky bundle so callers can fall back', () => {
  assert.equal(computeSkyOverlay(wcs, { catalog: null }), null);
});
