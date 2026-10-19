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
