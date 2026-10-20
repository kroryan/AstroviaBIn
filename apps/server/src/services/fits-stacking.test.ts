import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFitsMetadata, readPixels } from './fits';
import { stackFits } from './fits-stacking';

function card(key: string, value?: string): string {
  return (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
}

function fitsMono(width: number, height: number, values: number[], extra: string[] = []): Buffer {
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '2'), card('NAXIS1', String(width)),
    card('NAXIS2', String(height)), card('BUNIT', "'adu'"), ...extra, card('END')];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 2880) * 2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatBE(value, index * 4));
  return Buffer.concat([paddedHeader, data, Buffer.alloc(Math.ceil(data.length / 2880) * 2880 - data.length)]);
}

async function outputPixels(filePath: string) {
  const metadata = await readFitsMetadata(filePath);
  return { metadata, pixels: readPixels(await readFile(filePath), metadata) };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-ccdproc-'));
  return { directory, output: path.join(directory, 'stacked.fits') };
}

test('CCDProc mean stack writes a float FITS with engine provenance and uncertainty', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  await writeFile(a, fitsMono(4, 4, new Array(16).fill(10).map((value, index) => index === 0 ? 9 : value)));
  await writeFile(b, fitsMono(4, 4, new Array(16).fill(10).map((value, index) => index === 0 ? 11 : value)));
  try {
    const result = await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'none' });
    assert.equal(result.engine.name, 'Astropy/CCDProc');
    assert.match(result.engine.ccdproc, /^2\./);
    assert.equal(result.frameCount, 2);
    const { metadata, pixels } = await outputPixels(output);
    assert.equal(metadata.bitpix, -32);
    assert.equal(metadata.headers.NCOMBINE, 2);
    assert.equal(pixels[0], 10);
    assert.ok((await readFile(output)).includes(Buffer.from('UNCERT  ')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc exposure normalization scales every light to the reference exposure', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, '10s.fits'), b = path.join(directory, '20s.fits');
  await writeFile(a, fitsMono(3, 3, new Array(9).fill(100), [card('EXPTIME', '10'), card('FILTER', "'R'")]));
  await writeFile(b, fitsMono(3, 3, new Array(9).fill(200), [card('EXPTIME', '20'), card('FILTER', "'R'")]));
  try {
    await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'exposure' });
    const { pixels } = await outputPixels(output);
    assert.ok(pixels.every(value => Math.abs(value - 100) < 1e-4));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc sigma clipping with MAD rejects a one-frame cosmic-ray outlier', async () => {
  const { directory, output } = await fixture();
  const paths = Array.from({ length: 5 }, (_, index) => path.join(directory, `${index}.fits`));
  await Promise.all(paths.map((filePath, frame) => {
    const values = new Array(25).fill(100); values[24] += frame - 2;
    if (frame === 4) values[12] = 50_000;
    return writeFile(filePath, fitsMono(5, 5, values));
  }));
  try {
    await stackFits(paths, output, { method: 'sigma-clip', sigmaClipLow: 2, sigmaClipHigh: 2, register: false, normalization: 'none' });
    const { pixels } = await outputPixels(output);
    assert.ok(pixels[12] < 500, `expected the outlier to be rejected, got ${pixels[12]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc ccd_process applies master bias and flat calibration before combining', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  const bias = path.join(directory, 'master-bias.fits'), flat = path.join(directory, 'master-flat.fits');
  await writeFile(a, fitsMono(2, 2, [30, 50, 30, 50]));
  await writeFile(b, fitsMono(2, 2, [32, 52, 32, 52]));
  await writeFile(bias, fitsMono(2, 2, [10, 10, 10, 10]));
  await writeFile(flat, fitsMono(2, 2, [1, 2, 1, 2]));
  try {
    await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'none',
      calibration: { biasPath: bias, flatPath: flat } });
    const { pixels } = await outputPixels(output);
    assert.ok(Math.abs(pixels[0] - 31.5) < 1e-4);
    assert.ok(Math.abs(pixels[1] - 30.75) < 1e-4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc wcs_project aligns a shifted plate-solved frame to the reference grid', async () => {
  const { directory, output } = await fixture();
  const reference = path.join(directory, 'reference.fits'), shifted = path.join(directory, 'shifted.fits');
  const baseWcs = [card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRPIX1', '3'), card('CRPIX2', '3'),
    card('CRVAL1', '83'), card('CRVAL2', '-5'), card('CD1_1', '-0.001'), card('CD1_2', '0'), card('CD2_1', '0'), card('CD2_2', '0.001')];
  const shiftedWcs = [...baseWcs.slice(0, 2), card('CRPIX1', '4'), ...baseWcs.slice(3)];
  const refPixels = new Array(25).fill(0); refPixels[12] = 100;
  const shiftedPixels = new Array(25).fill(0); shiftedPixels[13] = 100;
  await writeFile(reference, fitsMono(5, 5, refPixels, baseWcs));
  await writeFile(shifted, fitsMono(5, 5, shiftedPixels, shiftedWcs));
  try {
    const result = await stackFits([reference, shifted], output, { method: 'mean', register: true,
      interpolation: 'nearest-neighbor', normalization: 'none' });
    const { pixels } = await outputPixels(output);
    assert.equal(result.frames[1].method, 'CCDProc WCS/nearest-neighbor');
    assert.ok(pixels[12] > 90, `registered signal should remain at reference pixel, got ${pixels[12]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('duplicate frames and unregistered dimension mismatches are rejected clearly', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), duplicate = path.join(directory, 'duplicate.fits'), different = path.join(directory, 'different.fits');
  const data = fitsMono(2, 2, [1, 2, 3, 4]);
  await writeFile(a, data); await writeFile(duplicate, data); await writeFile(different, fitsMono(3, 3, new Array(9).fill(1)));
  try {
    await assert.rejects(() => stackFits([a, duplicate], output, { register: false, normalization: 'none' }), /only contains duplicates/);
    await assert.rejects(() => stackFits([a, different], output, { register: false, normalization: 'none' }), /Fewer than two frames could be aligned/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc median cosmic-ray cleaning masks and replaces an isolated hit', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  const clean = new Array(21 * 21).fill(100);
  const hit = [...clean]; hit[220] = 40_000; hit[0] = 101;
  await writeFile(a, fitsMono(21, 21, clean));
  await writeFile(b, fitsMono(21, 21, hit));
  try {
    await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'none', cosmicMethod: 'median',
      medianCosmicThreshold: 4, medianCosmicBox: 5, medianCosmicGrowBox: 0, medianCosmicReplaceBox: 5 });
    const { pixels } = await outputPixels(output);
    assert.ok(pixels[220] < 200, `median cleaner should remove the isolated hit, got ${pixels[220]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CCDProc weighted combination and sum are available without custom pixel arithmetic', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  await writeFile(a, fitsMono(2, 2, [1, 1, 1, 1], [card('EXPTIME', '1')]));
  await writeFile(b, fitsMono(2, 2, [3, 3, 3, 4], [card('EXPTIME', '3')]));
  try {
    await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'none', weighting: 'exposure' });
    let result = await outputPixels(output);
    assert.ok(Math.abs(result.pixels[0] - 2.5) < 1e-4);
    const summed = path.join(directory, 'summed.fits');
    await stackFits([a, b], summed, { method: 'sum', register: false, normalization: 'none' });
    result = await outputPixels(summed);
    assert.ok(Math.abs(result.pixels[0] - 4) < 1e-4);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Unsigned 16-bit FITS as cameras write them: BITPIX 16 with BZERO = 32768. */
function fitsUint16(width: number, height: number, values: number[], extra: string[] = []): Buffer {
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(width)),
    card('NAXIS2', String(height)), card('BZERO', '32768'), card('BSCALE', '1'), ...extra, card('END')];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 2880) * 2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value - 32768, index * 2));
  return Buffer.concat([paddedHeader, data, Buffer.alloc(Math.ceil(data.length / 2880) * 2880 - data.length)]);
}

test('CCDProc stacks unsigned 16-bit camera frames (BZERO 32768) with the right values', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'u16-a.fits'), b = path.join(directory, 'u16-b.fits');
  // Values above 32767 only fit an unsigned frame through BZERO.
  await writeFile(a, fitsUint16(4, 4, new Array(16).fill(40000)));
  await writeFile(b, fitsUint16(4, 4, new Array(16).fill(40002)));
  try {
    await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'none' });
    const { metadata, pixels } = await outputPixels(output);
    assert.equal(metadata.bitpix, -32);
    assert.equal(metadata.headers.BZERO, undefined, 'float output carries no integer scaling keywords');
    assert.ok(pixels.every(value => Math.abs(value - 40001) < 1e-3), `mean of 40000 and 40002, got ${pixels[0]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Colour cube (planes, y, x) as written by OSC cameras and colour composites. */
function fitsCube(width: number, height: number, planes: number[][], extra: string[] = []): Buffer {
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '3'), card('NAXIS1', String(width)),
    card('NAXIS2', String(height)), card('NAXIS3', String(planes.length)), card('BUNIT', "'adu'"), ...extra, card('END')];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 2880) * 2880 - header.length, ' ')]);
  const values = planes.flat();
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatBE(value, index * 4));
  return Buffer.concat([paddedHeader, data, Buffer.alloc(Math.ceil(data.length / 2880) * 2880 - data.length)]);
}

const celestial = (crpix1: number) => [card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRPIX1', String(crpix1)),
  card('CRPIX2', '3'), card('CRVAL1', '337.41'), card('CRVAL2', '-20.84'), card('CD1_1', '-0.001'), card('CD1_2', '0'),
  card('CD2_1', '0'), card('CD2_2', '0.001')];

test('colour FITS are aligned through their WCS and combined plane by plane', async () => {
  const { directory, output } = await fixture();
  const reference = path.join(directory, 'rgb-a.fits'), shifted = path.join(directory, 'rgb-b.fits');
  const star = (index: number, levels: number[]) => levels.map(level => { const plane = new Array(25).fill(1); plane[index] = level; return plane; });
  // Same star (R 300, G 200, B 100) one pixel to the right in the second frame, whose WCS says so.
  await writeFile(reference, fitsCube(5, 5, star(12, [300, 200, 100]), celestial(3)));
  await writeFile(shifted, fitsCube(5, 5, star(13, [300, 200, 100]), celestial(4)));
  try {
    const result = await stackFits([reference, shifted], output, { method: 'mean', register: true,
      interpolation: 'nearest-neighbor', normalization: 'none' });
    assert.equal(result.frameCount, 2);
    assert.equal(result.frames[1].method, 'CCDProc WCS/nearest-neighbor');
    const { metadata, pixels } = await outputPixels(output);
    assert.equal(metadata.channels, 3);
    assert.deepEqual([pixels[12], pixels[25 + 12], pixels[50 + 12]].map(Math.round), [300, 200, 100]);
    assert.equal(metadata.headers.CTYPE1, 'RA---TAN');
    assert.ok(!('PC1_1' in metadata.headers && 'CD1_1' in metadata.headers), 'one WCS convention only');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('mono and colour frames are not mixed, and a missing EXPTIME falls back to median normalization', async () => {
  const { directory, output } = await fixture();
  const mono = path.join(directory, 'mono.fits'), rgb = path.join(directory, 'rgb.fits');
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  await writeFile(mono, fitsMono(2, 2, [1, 2, 3, 4]));
  await writeFile(rgb, fitsCube(2, 2, [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]]));
  await writeFile(a, fitsMono(3, 3, new Array(9).fill(100)));
  await writeFile(b, fitsMono(3, 3, new Array(9).fill(200)));
  try {
    await assert.rejects(() => stackFits([mono, rgb], output, { register: false }), /Mono \(2-D\) and colour \(3-D\)/);
    const result = await stackFits([a, b], output, { method: 'mean', register: false, normalization: 'exposure' });
    assert.ok(result.warnings.some(warning => /EXPTIME is missing/.test(warning)));
    const { pixels } = await outputPixels(output);
    assert.ok(pixels.every(value => Math.abs(value - 100) < 1e-4), `scaled to the reference median, got ${pixels[0]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('blank (NaN) pixels are masked instead of poisoning the stack', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits'), c = path.join(directory, 'c.fits');
  await writeFile(a, fitsMono(2, 2, [Number.NaN, 10, 10, 10]));
  await writeFile(b, fitsMono(2, 2, [12, 10, 10, 10.5]));
  await writeFile(c, fitsMono(2, 2, [14, 10, 10, 9.5]));
  try {
    await stackFits([a, b, c], output, { method: 'mean', register: false, normalization: 'none' });
    const { pixels } = await outputPixels(output);
    assert.ok(Math.abs(pixels[0] - 13) < 1e-4, `mean of the valid values, got ${pixels[0]}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a missing analysis Python is reported clearly', async () => {
  const { directory, output } = await fixture();
  const a = path.join(directory, 'a.fits'), b = path.join(directory, 'b.fits');
  await writeFile(a, fitsMono(2, 2, [1, 2, 3, 4])); await writeFile(b, fitsMono(2, 2, [2, 3, 4, 5]));
  const previous = process.env.ASTROVIABIN_ANALYSIS_PYTHON;
  process.env.ASTROVIABIN_ANALYSIS_PYTHON = path.join(directory, 'no-such-python');
  try {
    await assert.rejects(() => stackFits([a, b], output, { register: false }), /Python used for stacking was not found/);
  } finally {
    if (previous === undefined) delete process.env.ASTROVIABIN_ANALYSIS_PYTHON; else process.env.ASTROVIABIN_ANALYSIS_PYTHON = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
