import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFitsMetadata, readPixels } from './fits';
import { stackFits } from './fits-stacking';

function card(key: string, value?: string): string {
  return (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
}

/** Builds a square mono FITS of arbitrary size from a flat row-major array of values. */
function testFitsMono(size: number, values: number[], extraHeaders: string[] = []): Buffer {
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(size)), card('NAXIS2', String(size)),
    ...extraHeaders, card('END'),
  ];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  const dataBlocks = Math.ceil(data.length / 2880) * 2880;
  return Buffer.concat([paddedHeader, data, Buffer.alloc(dataBlocks - data.length)]);
}

/** A flat background with a distinct square patch, optionally shifted, so registration has texture to lock onto. */
function patchFrame(size: number, offsetX: number, offsetY: number, background = 100, foreground = 900, patchSize = 6): number[] {
  const values = new Array(size * size).fill(background);
  const start = Math.floor(size / 2) - Math.floor(patchSize / 2);
  for (let y = start + offsetY; y < start + offsetY + patchSize; y++) {
    for (let x = start + offsetX; x < start + offsetX + patchSize; x++) {
      if (x >= 0 && x < size && y >= 0 && y < size) values[y * size + x] = foreground;
    }
  }
  return values;
}

async function readOutputPixels(outputPath: string): Promise<{ metadata: Awaited<ReturnType<typeof readFitsMetadata>>; pixels: Float64Array }> {
  const metadata = await readFitsMetadata(outputPath);
  const file = await import('node:fs/promises').then(fs => fs.readFile(outputPath));
  return { metadata, pixels: readPixels(file, metadata) };
}

test('stacks identical frames back to the same pixel values', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 20;
  const values = patchFrame(size, 0, 0);
  const framePaths = [path.join(directory, 'a.fits'), path.join(directory, 'b.fits'), path.join(directory, 'c.fits')];
  await Promise.all(framePaths.map(filePath => writeFile(filePath, testFitsMono(size, values))));
  const output = path.join(directory, 'stacked.fits');
  try {
    const result = await stackFits(framePaths, output, { method: 'mean', register: false });
    assert.equal(result.frameCount, 3);
    const { metadata, pixels } = await readOutputPixels(output);
    assert.equal(metadata.bitpix, -32);
    for (let index = 0; index < values.length; index++) assert.ok(Math.abs(pixels[index] - values[index]) < 1e-3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('normalizes different exposure times and preserves the reference celestial WCS', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 10;
  const wcs = [card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"), card('CRPIX1', '5.5'), card('CRPIX2', '5.5'),
    card('CRVAL1', '83.25'), card('CRVAL2', '-5.2'), card('CDELT1', '-0.001'), card('CDELT2', '0.001')];
  const first = path.join(directory, 'first.fits');
  const second = path.join(directory, 'second.fits');
  await writeFile(first, testFitsMono(size, new Array(size * size).fill(100), [...wcs, card('EXPTIME', '10'), card('FILTER', "'R'"), card('BUNIT', "'adu'")]));
  await writeFile(second, testFitsMono(size, new Array(size * size).fill(200), [...wcs, card('EXPTIME', '20'), card('FILTER', "'R'"), card('BUNIT', "'adu'")]));
  const output = path.join(directory, 'stacked.fits');
  try {
    await stackFits([first, second], output, { method: 'mean', register: false });
    const { metadata, pixels } = await readOutputPixels(output);
    assert.ok(Math.abs(pixels[55] - 100) < 1e-3, `exposure-normalized pixel should be 100, got ${pixels[55]}`);
    assert.equal(metadata.headers.CRVAL1, 83.25);
    assert.equal(metadata.headers.CRVAL2, -5.2);
    assert.equal(metadata.headers.EXPTIME, 10);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects frames with mismatched dimensions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const a = path.join(directory, 'a.fits');
  const b = path.join(directory, 'b.fits');
  await writeFile(a, testFitsMono(10, new Array(100).fill(100)));
  await writeFile(b, testFitsMono(12, new Array(144).fill(100)));
  const output = path.join(directory, 'stacked.fits');
  try {
    await assert.rejects(() => stackFits([a, b], output, {}), /same dimensions/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sigma-clip rejects a one-frame outlier (satellite trail / cosmic ray) that mean stacking would not', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 10;
  const base = new Array(size * size).fill(200);
  const outlierIndex = 42;
  const frames = [
    [...base],
    [...base],
    [...base],
    base.map((value, index) => (index === outlierIndex ? 20000 : value)), // one frame has a spike
  ];
  const framePaths = frames.map((_, index) => path.join(directory, `frame-${index}.fits`));
  await Promise.all(frames.map((values, index) => writeFile(framePaths[index], testFitsMono(size, values))));
  const output = path.join(directory, 'stacked.fits');
  try {
    const clipped = await stackFits(framePaths, output, { method: 'sigma-clip', sigmaClipThreshold: 2, register: false });
    const { pixels: clippedPixels } = await readOutputPixels(output);
    const meanOutput = path.join(directory, 'stacked-mean.fits');
    const meanResult = await stackFits(framePaths, meanOutput, { method: 'mean', register: false });
    const { pixels: meanPixels } = await readOutputPixels(meanOutput);
    assert.ok(clippedPixels[outlierIndex] < 1000, `sigma-clip should reject the outlier, got ${clippedPixels[outlierIndex]}`);
    assert.ok(meanPixels[outlierIndex] > 1000, `mean stacking is expected to be dragged up by the outlier, got ${meanPixels[outlierIndex]}`);
    assert.ok(meanResult.frameCount === clipped.frameCount);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('registers a shifted frame before stacking', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 40;
  const reference = patchFrame(size, 0, 0);
  const shifted = patchFrame(size, 3, -2);
  const framePaths = [path.join(directory, 'ref.fits'), path.join(directory, 'shifted.fits')];
  await writeFile(framePaths[0], testFitsMono(size, reference));
  await writeFile(framePaths[1], testFitsMono(size, shifted));
  const output = path.join(directory, 'stacked.fits');
  try {
    const result = await stackFits(framePaths, output, { method: 'mean', register: true });
    assert.equal(result.offsets[0].dx, 0);
    assert.equal(result.offsets[0].dy, 0);
    assert.equal(result.offsets[1].dx, 3);
    assert.equal(result.offsets[1].dy, -2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('keeps the original grid instead of inventing an offset for textureless frames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const framePaths = [path.join(directory, 'flat-a.fits'), path.join(directory, 'flat-b.fits')];
  await Promise.all(framePaths.map(filePath => writeFile(filePath, testFitsMono(40, new Array(40 * 40).fill(100)))));
  try {
    const result = await stackFits(framePaths, path.join(directory, 'stacked.fits'), { method: 'mean' });
    assert.deepEqual(result.offsets, [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration is not thrown off by a different overall background level between frames', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 40;
  const reference = patchFrame(size, 0, 0, 100, 900);
  // Same shift as above, but this frame also has a much brighter sky background —
  // a plain (non-zero-mean) cross-correlation would be biased toward that, not the shift.
  const shiftedWithBrighterSky = patchFrame(size, 3, -2, 500, 900);
  const framePaths = [path.join(directory, 'ref.fits'), path.join(directory, 'shifted.fits')];
  await writeFile(framePaths[0], testFitsMono(size, reference));
  await writeFile(framePaths[1], testFitsMono(size, shiftedWithBrighterSky));
  const output = path.join(directory, 'stacked.fits');
  try {
    const result = await stackFits(framePaths, output, { method: 'mean', register: true });
    assert.equal(result.offsets[1].dx, 3);
    assert.equal(result.offsets[1].dy, -2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stacked output keeps a shifted frame aligned with the reference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 40;
  const framePaths = [path.join(directory, 'ref.fits'), path.join(directory, 'shifted.fits')];
  await writeFile(framePaths[0], testFitsMono(size, patchFrame(size, 0, 0)));
  await writeFile(framePaths[1], testFitsMono(size, patchFrame(size, 3, -2)));
  const output = path.join(directory, 'stacked.fits');
  try {
    await stackFits(framePaths, output, { method: 'mean', register: true });
    const { pixels } = await readOutputPixels(output);
    // The patch must stay where the reference has it: centre pixels at full foreground value,
    // and nothing left behind at the shifted frame's original position.
    const centre = Math.floor(size / 2);
    assert.equal(pixels[centre * size + centre], 900);
    assert.equal(pixels[(centre - 2 - 3) * size + (centre + 3 + 3)], 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('writes standard HISTORY cards that CFITSIO readers accept', async () => {
  const { fitsCard } = await import('./fits');
  assert.equal(fitsCard('HISTORY', 'stack of 7 frames').slice(0, 10), 'HISTORY st');
  assert.equal(fitsCard('EXPTIME', '120').slice(0, 10), 'EXPTIME = ');
});
