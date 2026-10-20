import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createProcessedFits, readFitsMetadata, renderFitsPreview } from './fits';

function card(key: string, value?: string): string {
  return (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
}

function testFits(values: number[]): Buffer {
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '2'), card('NAXIS2', '2'),
    card('OBJECT', "'M 42'"), card('EXPTIME', '120'), card('END'),
  ];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  return Buffer.concat([paddedHeader, data, Buffer.alloc(2880 - data.length)]);
}

/** Builds a square mono FITS of arbitrary size from a flat row-major array of values. */
function testFitsMono(size: number, values: number[]): Buffer {
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(size)), card('NAXIS2', String(size)), card('END'),
  ];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  const dataBlocks = Math.ceil(data.length / 2880) * 2880;
  return Buffer.concat([paddedHeader, data, Buffer.alloc(dataBlocks - data.length)]);
}

/** Builds a square RGB FITS, planes given as flat row-major [R, G, B] arrays. */
function testFitsRgb(size: number, planes: [number[], number[], number[]]): Buffer {
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '3'), card('NAXIS1', String(size)), card('NAXIS2', String(size)), card('NAXIS3', '3'),
    card('OBJECT', "'M 42'"), card('END'),
  ];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(2880 - header.length, ' ')]);
  const values = planes.flat();
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  const dataBlocks = Math.ceil(data.length / 2880) * 2880;
  return Buffer.concat([paddedHeader, data, Buffer.alloc(dataBlocks - data.length)]);
}

test('reads standard FITS headers and renders a display preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'm42.fits');
  await writeFile(source, testFits([0, 100, 500, 1000]));
  try {
    const metadata = await readFitsMetadata(source);
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);
    assert.equal(metadata.channels, 1);
    assert.equal(metadata.headers.OBJECT, 'M 42');

    const preview = await renderFitsPreview(source, { stretch: 'asinh', strength: 8 });
    const linearPreview = await renderFitsPreview(source, { stretch: 'linear' });
    const logarithmicPreview = await renderFitsPreview(source, { stretch: 'log', strength: 8 });
    const info = await sharp(preview.buffer).metadata();
    assert.equal(info.format, 'png');
    assert.equal(info.width, 2);
    assert.equal(info.height, 2);
    assert.notDeepEqual(preview.buffer, linearPreview.buffer);
    assert.notDeepEqual(logarithmicPreview.buffer, linearPreview.buffer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('creates a float FITS derivative without changing the source', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'source.fits');
  const output = path.join(directory, 'processed.fits');
  await writeFile(source, testFits([0, 100, 500, 1000]));
  try {
    await createProcessedFits(source, output, { stretch: 'log', backgroundNeutralization: true });
    const metadata = await readFitsMetadata(output);
    assert.equal(metadata.bitpix, -32);
    assert.equal(metadata.headers.OBJECT, 'M 42');
    assert.equal((await readFitsMetadata(source)).bitpix, 16);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('midtones transfer function stretch differs from a linear stretch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'm42.fits');
  await writeFile(source, testFits([0, 100, 500, 1000]));
  try {
    const mtfPreview = await renderFitsPreview(source, { stretch: 'mtf', midtones: 0.25 });
    const linearPreview = await renderFitsPreview(source, { stretch: 'linear' });
    assert.notDeepEqual(mtfPreview.buffer, linearPreview.buffer);
    // At the neutral midtones balance (0.5), the MTF curve is the identity.
    const neutralPreview = await renderFitsPreview(source, { stretch: 'mtf', midtones: 0.5 });
    assert.deepEqual(neutralPreview.buffer, linearPreview.buffer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SCNR pulls an isolated green pixel back toward the red/blue average', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'green-cast.fits');
  await writeFile(source, testFitsRgb(1, [[0], [1000], [0]]));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000, saturation: 1 };
    const untouched = await renderFitsPreview(source, settings);
    const corrected = await renderFitsPreview(source, { ...settings, scnrAmount: 1 });
    const untouchedPixel = await sharp(untouched.buffer).raw().toBuffer();
    const correctedPixel = await sharp(corrected.buffer).raw().toBuffer();
    assert.equal(untouchedPixel[1], 255);
    assert.equal(correctedPixel[1], 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsharp mask sharpening changes the rendered preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'bump.fits');
  const size = 5;
  // A mid-grey background with a brighter centre, so the unsharp mask boosts
  // local contrast without immediately clipping at 0 or 1.
  const values = new Array(size * size).fill(300);
  values[Math.floor(values.length / 2)] = 700;
  await writeFile(source, testFitsMono(size, values));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000 };
    const soft = await renderFitsPreview(source, settings);
    const sharpened = await renderFitsPreview(source, { ...settings, sharpenAmount: 0.5, sharpenRadius: 1 });
    assert.notDeepEqual(soft.buffer, sharpened.buffer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('square root and squared stretches differ from a linear stretch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'm42.fits');
  await writeFile(source, testFits([0, 100, 500, 1000]));
  try {
    const linearPreview = await renderFitsPreview(source, { stretch: 'linear' });
    const sqrtPreview = await renderFitsPreview(source, { stretch: 'sqrt' });
    const squarePreview = await renderFitsPreview(source, { stretch: 'square' });
    assert.notDeepEqual(sqrtPreview.buffer, linearPreview.buffer);
    assert.notDeepEqual(squarePreview.buffer, linearPreview.buffer);
    assert.notDeepEqual(sqrtPreview.buffer, squarePreview.buffer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('colour maps only affect the preview, not a saved derivative, and grey stays mono', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'm42.fits');
  const output = path.join(directory, 'processed.fits');
  await writeFile(source, testFits([0, 100, 500, 1000]));
  try {
    const grey = await renderFitsPreview(source, { stretch: 'linear', colorMap: 'grey' });
    assert.equal((await sharp(grey.buffer).metadata()).channels, 1);

    const heat = await renderFitsPreview(source, { stretch: 'linear', colorMap: 'heat' });
    assert.equal((await sharp(heat.buffer).metadata()).channels, 3);
    assert.notDeepEqual(heat.buffer, grey.buffer);

    await createProcessedFits(source, output, { stretch: 'linear', colorMap: 'heat' });
    const derivative = await readFitsMetadata(output);
    assert.equal(derivative.channels, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inverted colour map flips an RGB preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'rgb.fits');
  await writeFile(source, testFitsRgb(1, [[200], [400], [600]]));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000, saturation: 1 };
    const normal = await renderFitsPreview(source, settings);
    const inverted = await renderFitsPreview(source, { ...settings, colorMap: 'inverted' as const });
    const normalPixel = await sharp(normal.buffer).raw().toBuffer();
    const invertedPixel = await sharp(inverted.buffer).raw().toBuffer();
    for (let channel = 0; channel < 3; channel++) assert.equal(invertedPixel[channel], 255 - normalPixel[channel]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hot pixel removal replaces an isolated spike with its local median', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'hot-pixel.fits');
  const size = 5;
  const values = new Array(size * size).fill(300);
  values[Math.floor(values.length / 2)] = 20000; // an isolated sensor spike
  await writeFile(source, testFitsMono(size, values));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000 };
    const untouched = await renderFitsPreview(source, settings);
    const corrected = await renderFitsPreview(source, { ...settings, hotPixelThreshold: 3 });
    // sharp's raw() decode upsamples to sRGB unless told the source is single-channel.
    const untouchedPixels = await sharp(untouched.buffer).toColourspace('b-w').raw().toBuffer();
    const correctedPixels = await sharp(corrected.buffer).toColourspace('b-w').raw().toBuffer();
    const centreIndex = Math.floor(values.length / 2);
    assert.equal(untouchedPixels[centreIndex], 255); // clipped bright, uncorrected
    assert.ok(correctedPixels[centreIndex] < 100); // pulled back down to the ~300 background
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('background extraction flattens a large-scale gradient', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'gradient.fits');
  const size = 16;
  const values: number[] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values.push(Math.round(100 + (x / (size - 1)) * 800));
  await writeFile(source, testFitsMono(size, values));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000 };
    const untouched = await renderFitsPreview(source, settings);
    const extracted = await renderFitsPreview(source, { ...settings, backgroundExtractionAmount: 1 });
    // sharp's raw() decode upsamples to sRGB unless told the source is single-channel.
    const untouchedPixels = await sharp(untouched.buffer).toColourspace('b-w').raw().toBuffer();
    const extractedPixels = await sharp(extracted.buffer).toColourspace('b-w').raw().toBuffer();
    const row = 8 * size;
    const untouchedSpread = Math.abs(untouchedPixels[row + size - 1] - untouchedPixels[row]);
    const extractedSpread = Math.abs(extractedPixels[row + size - 1] - extractedPixels[row]);
    assert.ok(extractedSpread < untouchedSpread);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('denoise changes the rendered preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'noisy.fits');
  const size = 6;
  const values = Array.from({ length: size * size }, (_, index) => (index % 2 === 0 ? 200 : 800));
  await writeFile(source, testFitsMono(size, values));
  try {
    const settings = { stretch: 'linear' as const, blackPoint: 0, whitePoint: 1000 };
    const noisy = await renderFitsPreview(source, settings);
    const denoised = await renderFitsPreview(source, { ...settings, denoiseAmount: 1, denoiseRadius: 2 });
    assert.notDeepEqual(noisy.buffer, denoised.buffer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('creates a derivative with cosmetic correction, denoise, and background extraction applied together', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const source = path.join(directory, 'combo.fits');
  const output = path.join(directory, 'combo-processed.fits');
  const size = 8;
  const values = new Array(size * size).fill(300);
  values[0] = 20000;
  await writeFile(source, testFitsMono(size, values));
  try {
    await createProcessedFits(source, output, {
      stretch: 'asinh', hotPixelThreshold: 3, denoiseAmount: 0.3, backgroundExtractionAmount: 0.5,
    });
    const metadata = await readFitsMetadata(output);
    assert.equal(metadata.bitpix, -32);
    assert.equal(metadata.width, size);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function noise(seed: number) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
}

test('false-colour maps apply to RGB images too (on their luminance)', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const size = 32;
  const ramp = Array.from({ length: size * size }, (_, index) => (index % size) * 1000);
  const filePath = path.join(directory, 'rgb.fits');
  await writeFile(filePath, testFitsRgb(size, [ramp, ramp, ramp]));
  try {
    const means = async (colorMap: string) => (await sharp((await renderFitsPreview(filePath, { stretch: 'linear', colorMap: colorMap as never })).buffer).stats()).channels.slice(0, 3).map(channel => Math.round(channel.mean));
    const grey = await means('grey');
    for (const map of ['heat', 'cool', 'rainbow', 'viridis']) assert.notDeepEqual(await means(map), grey, `${map} must change an RGB preview`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('hot pixel removal leaves ordinary noise alone and removes a spike', async () => {
  const { mkdtemp: _m } = await import('node:fs/promises');
  const directory = await _m(path.join(tmpdir(), 'astroviabin-fits-'));
  const size = 40;
  const random = noise(3);
  // Quantized sky: most 3×3 neighbourhoods have MAD 0, which used to flag every ±1 ADU pixel.
  const values = Array.from({ length: size * size }, () => 1000 + Math.round((random() - 0.5) * 2));
  values[20 * size + 20] = 9000;
  const source = path.join(directory, 'hot.fits');
  const output = path.join(directory, 'hot-clean.fits');
  await writeFile(source, testFitsMono(size, values));
  try {
    await createProcessedFits(source, output, { stretch: 'linear', hotPixelThreshold: 5, blackPoint: 990, whitePoint: 1010 });
    const { readFile } = await import('node:fs/promises');
    const { readPixels } = await import('./fits');
    const metadata = await readFitsMetadata(output);
    const pixels = readPixels(await readFile(output), metadata);
    const expected = values.map(value => Math.max(0, Math.min(1, (value - 990) / 20)));
    let changed = 0;
    for (let index = 0; index < pixels.length; index++) if (index !== 20 * size + 20 && Math.abs(pixels[index] - expected[index]) > 1e-6) changed++;
    assert.ok(changed < pixels.length * 0.01, `only real outliers may change (changed ${changed})`);
    assert.ok(pixels[20 * size + 20] < 0.9, 'the hot pixel is replaced');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('background model follows a gradient but ignores stars and a galaxy', async () => {
  const { backgroundModel } = await import('./fits');
  const width = 240, height = 160;
  const plane = new Float64Array(width * height);
  const random = noise(5);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) plane[y * width + x] = 500 + 2 * x + y + (random() - 0.5) * 10;
  const stars = [[40, 40], [120, 80], [200, 120], [60, 130]];
  for (const [sx, sy] of stars) for (let y = sy - 6; y <= sy + 6; y++) for (let x = sx - 6; x <= sx + 6; x++) {
    plane[y * width + x] += 20000 * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / (2 * 1.5 ** 2));
  }
  const model = backgroundModel(plane, width, height);
  let worst = 0;
  for (let y = 10; y < height - 10; y += 5) for (let x = 10; x < width - 10; x += 5) worst = Math.max(worst, Math.abs(model[y * width + x] - (500 + 2 * x + y)));
  assert.ok(worst < 25, `model within 25 ADU of the true sky everywhere (worst ${worst.toFixed(1)}), stars excluded`);
});

test('a processed derivative keeps the WCS and records every setting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const size = 16;
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(size)), card('NAXIS2', String(size)),
    card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRPIX1', '8.5'), card('CRPIX2', '8.5'),
    card('CRVAL1', '83.82'), card('CRVAL2', '-5.39'), card('CD1_1', '-0.0004'), card('CD2_2', '0.0004'), card('END')];
  const header = Buffer.from(cards.join(''), 'ascii');
  const data = Buffer.alloc(size * size * 2);
  for (let index = 0; index < size * size; index++) data.writeInt16BE(100 + index, index * 2);
  const source = path.join(directory, 'wcs.fits');
  const output = path.join(directory, 'wcs-processed.fits');
  await writeFile(source, Buffer.concat([header, Buffer.alloc(2880 - header.length, ' '), data, Buffer.alloc(2880 - data.length)]));
  try {
    await createProcessedFits(source, output, { stretch: 'mtf', midtones: 0.2, gamma: 1.4, saturation: 1.3, sharpenAmount: 0.5 });
    const metadata = await readFitsMetadata(output);
    assert.equal(metadata.headers.CRVAL1, 83.82);
    assert.equal(metadata.headers.CD2_2, 0.0004);
    const history = metadata.cards.filter(line => line.startsWith('HISTORY')).join(' ');
    for (const text of ['stretch=mtf', 'midtones=0.2', 'saturation=1.3', 'sharpenAmount=0.5']) assert.ok(history.includes(text), `${text} in HISTORY`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview downscaling averages blocks instead of skipping pixels', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-'));
  const size = 64;
  // A checkerboard of 0/2000: point sampling every other pixel sees only one colour.
  const values = Array.from({ length: size * size }, (_, index) => ((index % size) + Math.floor(index / size)) % 2 ? 2000 : 0);
  const filePath = path.join(directory, 'checker.fits');
  await writeFile(filePath, testFitsMono(size, values));
  try {
    const preview = await renderFitsPreview(filePath, { stretch: 'linear', blackPoint: 0, whitePoint: 2000 }, 32);
    const mean = (await sharp(preview.buffer).stats()).channels[0].mean;
    assert.ok(Math.abs(mean - 127.5) < 3, `average grey, not black or white (mean ${mean})`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
