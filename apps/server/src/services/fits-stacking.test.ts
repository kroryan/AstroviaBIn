import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFitsMetadata, readPixels } from './fits';
import { runStackInThread, stackFits } from './fits-stacking';

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
  // Three distinct exposures of the same scene (+1, 0, −1 in one corner pixel) average back to it.
  const variants = [1, 0, -1].map(delta => values.map((value, index) => index === 0 ? value + delta : value));
  const framePaths = [path.join(directory, 'a.fits'), path.join(directory, 'b.fits'), path.join(directory, 'c.fits')];
  await Promise.all(framePaths.map((filePath, index) => writeFile(filePath, testFitsMono(size, variants[index]))));
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
    await assert.rejects(() => stackFits([a, b], output, {}), /different size and no plate solution/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('sigma-clip rejects a one-frame outlier (satellite trail / cosmic ray) that mean stacking would not', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 10;
  const base = new Array(size * size).fill(200);
  const outlierIndex = 42;
  // Distinct exposures (a different value in the last pixel) so none is skipped as a duplicate.
  const frames = [
    base.map((value, index) => (index === 99 ? 201 : value)),
    base.map((value, index) => (index === 99 ? 199 : value)),
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
  await Promise.all(framePaths.map((filePath, index) => writeFile(filePath, testFitsMono(40, new Array(40 * 40).fill(100 + index)))));
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
  // Fixed format: logical/numeric values end in column 30.
  assert.equal(fitsCard('SIMPLE', 'T').slice(0, 30), 'SIMPLE  =                    T');
  assert.equal(fitsCard('OBJECT', "'M 42'").slice(0, 16), "OBJECT  = 'M 42'");
});

/** Float FITS with arbitrary header cards. */
function testFitsFloat(width: number, height: number, values: Float32Array, extraHeaders: string[] = []): Buffer {
  const cards = [
    card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '2'), card('NAXIS1', String(width)), card('NAXIS2', String(height)),
    ...extraHeaders, card('END'),
  ];
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / 2880) * 2880 - header.length, ' ')]);
  const data = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => data.writeFloatBE(value, index * 4));
  return Buffer.concat([paddedHeader, data, Buffer.alloc(Math.ceil(data.length / 2880) * 2880 - data.length)]);
}

/** Deterministic pseudo-random numbers. */
function generator(seed: number) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
}

/**
 * A star field (Gaussian stars, sky noise) seen through a camera rotated by `angle` degrees and
 * shifted by (shiftX, shiftY) pixels relative to the reference camera. Returns the pixels and,
 * optionally, the matching TAN WCS cards.
 */
function starField(size: number, stars: Array<[number, number, number]>, angle: number, shiftX: number, shiftY: number, seed: number) {
  const random = generator(seed);
  const values = new Float32Array(size * size);
  for (let index = 0; index < values.length; index++) values[index] = 100 + (random() - 0.5) * 6;
  const c = (size - 1) / 2;
  const cos = Math.cos(angle * Math.PI / 180), sin = Math.sin(angle * Math.PI / 180);
  const position = ([x, y]: [number, number, number]) => [c + cos * (x - c) - sin * (y - c) + shiftX, c + sin * (x - c) + cos * (y - c) + shiftY];
  for (const star of stars) {
    const [px, py] = position(star);
    for (let y = Math.max(0, Math.floor(py - 8)); y <= Math.min(size - 1, Math.ceil(py + 8)); y++) {
      for (let x = Math.max(0, Math.floor(px - 8)); x <= Math.min(size - 1, Math.ceil(px + 8)); x++) {
        values[y * size + x] += star[2] * Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * 1.6 ** 2));
      }
    }
  }
  // The reference pixel (CRPIX, 1-based) maps to a fixed sky point; the frame's CD matrix is rotated.
  const scale = 0.0003;
  const [rx, ry] = position([c, c, 0]);
  const wcs = [card('CTYPE1', "'RA---TAN'"), card('CTYPE2', "'DEC--TAN'"),
    card('CRPIX1', String(rx + 1)), card('CRPIX2', String(ry + 1)), card('CRVAL1', '150.0'), card('CRVAL2', '20.0'),
    // Pixel → sky: undo the camera rotation, then the reference scale (RA increases to the left).
    card('CD1_1', String(-scale * cos)), card('CD1_2', String(-scale * sin)),
    card('CD2_1', String(-scale * sin)), card('CD2_2', String(scale * cos))];
  return { values, wcs, position };
}

function randomStars(count: number, size: number, seed: number): Array<[number, number, number]> {
  const random = generator(seed);
  return Array.from({ length: count }, () => [20 + random() * (size - 40), 20 + random() * (size - 40), 400 + random() * 3000] as [number, number, number]);
}

/** Flux-weighted centroid of the stack around a predicted position. */
function centroid(pixels: Float64Array, size: number, x: number, y: number): [number, number] {
  let sum = 0, sx = 0, sy = 0;
  for (let j = Math.round(y) - 4; j <= Math.round(y) + 4; j++) {
    for (let i = Math.round(x) - 4; i <= Math.round(x) + 4; i++) {
      const value = pixels[j * size + i] - 100;
      if (value > 0) { sum += value; sx += value * i; sy += value * j; }
    }
  }
  return [sx / sum, sy / sum];
}

for (const withWcs of [true, false]) {
  test(`aligns a rotated and sub-pixel shifted frame ${withWcs ? 'through its WCS' : 'from stars alone'}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
    const size = 320;
    const stars = randomStars(140, size, 11);
    const reference = starField(size, stars, 0, 0, 0, 1);
    // 0.4° is twice the old translation-only tolerance; 1.6 px of rotation at the frame edges.
    const rotated = starField(size, stars, 0.4, 7.3, -4.6, 2);
    const framePaths = [path.join(directory, 'ref.fits'), path.join(directory, 'rotated.fits')];
    await writeFile(framePaths[0], testFitsFloat(size, size, reference.values, withWcs ? reference.wcs : []));
    await writeFile(framePaths[1], testFitsFloat(size, size, rotated.values, withWcs ? rotated.wcs : []));
    const output = path.join(directory, 'stacked.fits');
    try {
      const result = await stackFits(framePaths, output, { method: 'mean' });
      assert.equal(result.frameCount, 2);
      assert.equal(result.frames[1].method, withWcs ? 'wcs+stars' : 'translation+stars');
      assert.ok((result.frames[1].rmsPx ?? 9) < 0.2, `registration residual ${result.frames[1].rmsPx}`);
      const { pixels } = await readOutputPixels(output);
      // Every star in the stack sits where the reference has it, including at the edges.
      let worst = 0;
      const isolated = stars.filter(([x, y]) => x > 30 && y > 30 && x < size - 30 && y < size - 30 &&
        stars.every(other => other[0] === x && other[1] === y || Math.hypot(other[0] - x, other[1] - y) > 12));
      for (const star of isolated) {
        const [cx, cy] = centroid(pixels, size, star[0], star[1]);
        if (process.env.DEBUG_STACK) console.log(star[0].toFixed(1), star[1].toFixed(1), Math.hypot(cx - star[0], cy - star[1]).toFixed(3));
        worst = Math.max(worst, Math.hypot(cx - star[0], cy - star[1]));
      }
      assert.ok(worst < 0.15, `worst stacked star offset ${worst.toFixed(3)} px`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('skips an exact duplicate frame and reports it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 200;
  const stars = randomStars(60, size, 3);
  const a = starField(size, stars, 0, 0, 0, 1);
  const b = starField(size, stars, 0, 2, 1, 2);
  const framePaths = ['a', 'b', 'a-again'].map(name => path.join(directory, `${name}.fits`));
  await writeFile(framePaths[0], testFitsFloat(size, size, a.values));
  await writeFile(framePaths[1], testFitsFloat(size, size, b.values));
  await writeFile(framePaths[2], testFitsFloat(size, size, a.values));
  try {
    const result = await stackFits(framePaths, path.join(directory, 'stacked.fits'), { method: 'mean' });
    assert.equal(result.frameCount, 2);
    assert.equal(result.frames[2].used, false);
    assert.match(result.frames[2].reason ?? '', /duplicate/);
    assert.ok(result.warnings.some(warning => /duplicate/.test(warning)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('excludes a frame whose stars do not line up instead of blending it in', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 200;
  const stars = randomStars(60, size, 4);
  const frames = [starField(size, stars, 0, 0, 0, 1), starField(size, stars, 0, 1.5, -2.5, 2),
    starField(size, randomStars(60, size, 99), 0, 0, 0, 3)]; // a different field
  const framePaths = frames.map((_, index) => path.join(directory, `f${index}.fits`));
  await Promise.all(frames.map((frame, index) => writeFile(framePaths[index], testFitsFloat(size, size, frame.values))));
  try {
    const result = await stackFits(framePaths, path.join(directory, 'stacked.fits'), { method: 'mean' });
    assert.equal(result.frameCount, 2);
    assert.equal(result.frames[1].used, true);
    assert.equal(result.frames[2].used, false);
    assert.match(result.frames[2].reason ?? '', /not aligned/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runs a stack in a worker thread without blocking the caller', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-stack-'));
  const size = 120;
  const stars = randomStars(30, size, 5);
  const framePaths = [0, 1].map(index => path.join(directory, `t${index}.fits`));
  await writeFile(framePaths[0], testFitsFloat(size, size, starField(size, stars, 0, 0, 0, 1).values));
  await writeFile(framePaths[1], testFitsFloat(size, size, starField(size, stars, 0, 2, -1, 2).values));
  try {
    const result = await runStackInThread(framePaths, path.join(directory, 'stacked.fits'), { method: 'mean' });
    assert.equal(result.frameCount, 2);
    assert.equal(result.frames[1].used, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
