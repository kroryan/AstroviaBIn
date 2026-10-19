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
