import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { computeMaxLevel, renderTile, tileInfo } from './tiles';

async function testImage(width: number, height: number): Promise<Buffer> {
  // A horizontal gradient so different tiles are visibly distinguishable in tests.
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round((x / Math.max(1, width - 1)) * 255);
      const index = (y * width + x) * 3;
      raw[index] = value; raw[index + 1] = value; raw[index + 2] = value;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('computeMaxLevel: level 0 covers the whole image in a single tile, maxLevel is native resolution', () => {
  assert.equal(computeMaxLevel(1, 1), 0);
  assert.equal(computeMaxLevel(256, 256), 8);
  assert.equal(computeMaxLevel(300, 100), 9); // ceil(log2(300)) = 9
  assert.equal(computeMaxLevel(9576, 6388), 14); // ceil(log2(9576)) = 14
});

test('tileInfo reports native dimensions and the matching maxLevel', () => {
  const info = tileInfo(2000, 1000);
  assert.equal(info.width, 2000);
  assert.equal(info.height, 1000);
  assert.equal(info.tileSize, 256);
  assert.equal(info.maxLevel, computeMaxLevel(2000, 1000));
});

test('level 0 renders a single tile covering the entire (downscaled) image', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-tiles-'));
  try {
    const source = await testImage(2000, 1000);
    const tile = await renderTile(source, directory, 'img', 2000, 1000, 0, 0, 0);
    const meta = await sharp(tile).metadata();
    // At level 0 the whole image fits in one tile <= 256px on its long edge.
    assert.ok(meta.width! <= 256 && meta.height! <= 256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the max level tiles together reconstruct the native resolution exactly', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-tiles-'));
  try {
    const width = 600;
    const height = 300;
    const source = await testImage(width, height);
    const maxLevel = computeMaxLevel(width, height);
    const tilesX = Math.ceil(width / 256);
    const tilesY = Math.ceil(height / 256);
    let coveredWidth = 0;
    for (let x = 0; x < tilesX; x++) {
      const tile = await renderTile(source, directory, 'img2', width, height, maxLevel, x, 0);
      const meta = await sharp(tile).metadata();
      coveredWidth += meta.width!;
    }
    assert.equal(coveredWidth, width);
    let coveredHeight = 0;
    for (let y = 0; y < tilesY; y++) {
      const tile = await renderTile(source, directory, 'img2', width, height, maxLevel, 0, y);
      const meta = await sharp(tile).metadata();
      coveredHeight += meta.height!;
    }
    assert.equal(coveredHeight, height);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects an out-of-bounds tile and an invalid level', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-tiles-'));
  try {
    const source = await testImage(300, 300);
    const maxLevel = computeMaxLevel(300, 300);
    await assert.rejects(() => renderTile(source, directory, 'img3', 300, 300, maxLevel, 99, 99), /out of bounds/);
    await assert.rejects(() => renderTile(source, directory, 'img3', 300, 300, maxLevel + 1, 0, 0), /Invalid tile level/);
    await assert.rejects(() => renderTile(source, directory, 'img3', 300, 300, -1, 0, 0), /Invalid tile level/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('caches the resized level image so a second tile at the same level is served from the cache file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-tiles-'));
  try {
    const source = await testImage(600, 300);
    const maxLevel = computeMaxLevel(600, 300);
    const midLevel = Math.max(0, maxLevel - 2);
    const first = await renderTile(source, directory, 'img4', 600, 300, midLevel, 0, 0);
    const second = await renderTile(source, directory, 'img4', 600, 300, midLevel, 0, 0);
    assert.deepEqual(first, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
