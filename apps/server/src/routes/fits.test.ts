import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import sharp from 'sharp';

delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./fits');

function card(key: string, value?: string): string {
  return (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
}

function testFits(values = [0, 100, 500, 1000]): Buffer {
  const header = Buffer.from([
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '2'), card('NAXIS2', '2'),
    card('OBJECT', "'M 42'"), card('EXPTIME', '120'), card('END'),
  ].join(''), 'ascii');
  const data = Buffer.alloc(8);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  return Buffer.concat([header, Buffer.alloc(2880 - header.length, ' '), data, Buffer.alloc(2880 - data.length)]);
}

function largeHeaderTestFits(): Buffer {
  const cards = [card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '2'), card('NAXIS2', '2')];
  // Real camera/software headers can exceed the old 1 MiB read limit.
  for (let index = 0; index < 14_000; index++) cards.push(`COMMENT header metadata ${index}`.padEnd(80, ' ').slice(0, 80));
  cards.push(card('END'));
  const rawHeader = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.alloc(Math.ceil(rawHeader.length / 2880) * 2880, 32);
  rawHeader.copy(paddedHeader);
  const data = Buffer.alloc(2880);
  [0, 100, 500, 1000].forEach((value, index) => data.writeInt16BE(value, index * 2));
  return Buffer.concat([paddedHeader, data]);
}

/** A mono FITS wider than the default 2048px preview cap, to tell "full" resolution apart from it. */
function wideTestFits(width: number): Buffer {
  const header = Buffer.from([
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', String(width)), card('NAXIS2', '2'), card('END'),
  ].join(''), 'ascii');
  const values = new Array(width * 2).fill(500);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16BE(value, index * 2));
  const dataBlocks = Math.ceil(data.length / 2880) * 2880;
  return Buffer.concat([header, Buffer.alloc(2880 - header.length, ' '), data, Buffer.alloc(dataBlocks - data.length)]);
}

test('scan indexes FITS into the existing gallery and serves a preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-route-'));
  const sourceDirectory = path.join(directory, 'source');
  const derivativesDirectory = path.join(directory, 'derivatives');
  const uploadsDirectory = path.join(directory, 'uploads');
  const cacheDirectory = path.join(directory, 'cache');
  const oldEnvironment = {
    library: process.env.FITS_LIBRARY_DIR,
    derivatives: process.env.FITS_DERIVATIVES_DIR,
    uploads: process.env.FITS_UPLOAD_DIR,
    cache: process.env.FITS_CACHE_DIR,
  };
  process.env.FITS_LIBRARY_DIR = sourceDirectory;
  process.env.FITS_DERIVATIVES_DIR = derivativesDirectory;
  process.env.FITS_UPLOAD_DIR = uploadsDirectory;
  process.env.FITS_CACHE_DIR = cacheDirectory;
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(path.join(sourceDirectory, 'm42.fits'), testFits());

  try {
    const app = new Hono().route('/api/fits', routes);
    const scan = await app.request('/api/fits/scan', { method: 'POST' });
    assert.equal(scan.status, 200);
    assert.deepEqual(await scan.json(), { imported: 1, updated: 0, errors: [] });

    // Uploads stream the raw request body to disk; the original name travels in the query string.
    const upload = await app.request(`/api/fits/upload?filename=${encodeURIComponent('M42 final.FITS')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/fits' },
      body: new Uint8Array(testFits([1, 100, 500, 1000])),
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { image: { originalPath: string } };
    assert.match(uploaded.image.originalPath, /^fits-upload:\/\/M42_final-\d+\.fits$/);

    // Duplicates are found by content, not by name: the scanned file under another name and the same
    // upload again are dropped; a different FITS with an already used name is stored normally.
    for (const [name, bytes] of [['renamed copy.fits', testFits()], ['M42 final.FITS', testFits([1, 100, 500, 1000])]] as const) {
      const duplicate = await app.request(`/api/fits/upload?filename=${encodeURIComponent(name)}`, { method: 'POST', body: new Uint8Array(bytes) });
      assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json() as { duplicate?: boolean }).duplicate, true);
    }
    const sameName = await app.request(`/api/fits/upload?filename=${encodeURIComponent('M42 final.FITS')}`, { method: 'POST', body: new Uint8Array(testFits([2, 100, 500, 1000])) });
    assert.equal(sameName.status, 201);
    const sameNameImage = (await sameName.json() as { image: { id: number; originalPath: string } }).image;
    assert.notEqual(sameNameImage.originalPath, uploaded.image.originalPath);
    const uploadedFiles = (await readdir(uploadsDirectory)).filter(name => !name.endsWith('.orig'));
    assert.equal(uploadedFiles.length, 2, 'the existing upload is kept and only the new content is added');

    const largeHeaderUpload = await app.request('/api/fits/upload?filename=long-header.fits', {
      method: 'POST',
      headers: { 'content-type': 'application/fits' },
      body: new Uint8Array(largeHeaderTestFits()),
    });
    assert.equal(largeHeaderUpload.status, 201, await largeHeaderUpload.text());

    const missingEndUpload = await app.request('/api/fits/upload?filename=missing-end.fits', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(Buffer.alloc(2880, 32)),
    });
    assert.equal(missingEndUpload.status, 400);
    assert.match((await missingEndUpload.json() as { message: string }).message, /missing END header card after scanning 2880 header bytes \(2880 file bytes\)/);

    const images = await app.request('/api/fits');
    const image = (await images.json() as Array<{ id: number; originalPath: string; targetName: string; tags: string[] }>).find(item => item.originalPath === 'fits://m42.fits');
    assert.ok(image);
    assert.equal(image.originalPath, 'fits://m42.fits');
    assert.equal(image.targetName, 'M 42');
    assert.ok(image.tags.includes('Deep Sky'));

    const preview = await app.request(`/api/fits/${image.id}/preview?stretch=asinh`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(preview.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()).slice(1, 4), new Uint8Array([80, 78, 71]));

    const paletteMean = async (colorMap: string) => {
      const response = await app.request(`/api/fits/${image.id}/preview?preview=interactive&stretch=linear&blackPoint=0&whitePoint=1000&colorMap=${colorMap}`);
      assert.equal(response.status, 200, `${colorMap} preview should render`);
      const stats = await sharp(await response.arrayBuffer()).toColourspace('srgb').stats();
      return stats.channels.slice(0, 3).map(channel => Math.round(channel.mean));
    };
    const grey = await paletteMean('grey');
    for (const palette of ['inverted', 'heat', 'cool', 'rainbow', 'viridis']) {
      assert.notDeepEqual(await paletteMean(palette), grey, `${palette} must change the endpoint preview`);
    }

    const processed = await app.request(`/api/fits/${image.id}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stretch: 'asinh', strength: 8, outputName: 'm42-interactive-result' }),
    });
    assert.equal(processed.status, 200);
    assert.equal((await processed.json() as { output: string }).output, 'm42-interactive-result.fits');
    const duplicate = await app.request(`/api/fits/${image.id}/process`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outputName: 'm42-interactive-result' }),
    });
    assert.equal(duplicate.status, 409);

    // A second, different exposure (identical frames are skipped as duplicates).
    await writeFile(path.join(sourceDirectory, 'm42-b.fits'), testFits([2, 98, 502, 1001]));
    await app.request('/api/fits/scan', { method: 'POST' });
    const allImages = await (await app.request('/api/fits')).json() as Array<{ id: number; originalPath: string }>;
    const secondFrame = allImages.find(item => item.originalPath === 'fits://m42-b.fits');
    assert.ok(secondFrame);

    const stacked = await app.request('/api/fits/stack', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageIds: [image.id, secondFrame!.id], method: 'median', register: false,
        normalization: 'none', outputName: 'm42-stacked' }),
    });
    assert.equal(stacked.status, 200);
    const stackedBody = await stacked.json() as { output: string; frameCount: number };
    assert.equal(stackedBody.output, 'm42-stacked.fits');
    assert.equal(stackedBody.frameCount, 2);

    const tooFew = await app.request('/api/fits/stack', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageIds: [image.id] }),
    });
    assert.equal(tooFew.status, 400);
  } finally {
    for (const [name, value] of Object.entries({
      FITS_LIBRARY_DIR: oldEnvironment.library,
      FITS_DERIVATIVES_DIR: oldEnvironment.derivatives,
      FITS_UPLOAD_DIR: oldEnvironment.uploads,
      FITS_CACHE_DIR: oldEnvironment.cache,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('preview=full renders at native resolution instead of the capped preview size', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-fits-route-'));
  const sourceDirectory = path.join(directory, 'source');
  const cacheDirectory = path.join(directory, 'cache');
  const oldLibraryDir = process.env.FITS_LIBRARY_DIR;
  const oldCacheDir = process.env.FITS_CACHE_DIR;
  process.env.FITS_LIBRARY_DIR = sourceDirectory;
  process.env.FITS_CACHE_DIR = cacheDirectory;
  await mkdir(sourceDirectory, { recursive: true });
  const width = 2500;
  await writeFile(path.join(sourceDirectory, 'wide.fits'), wideTestFits(width));

  try {
    const app = new Hono().route('/api/fits', routes);
    await app.request('/api/fits/scan', { method: 'POST' });
    const images = await (await app.request('/api/fits')).json() as Array<{ id: number; originalPath: string }>;
    const image = images.find(item => item.originalPath === 'fits://wide.fits');
    assert.ok(image);

    const capped = await app.request(`/api/fits/${image.id}/preview`);
    const cappedMeta = await sharp(await capped.arrayBuffer()).metadata();
    assert.ok(cappedMeta.width! <= 2048, `expected capped width <= 2048, got ${cappedMeta.width}`);

    const full = await app.request(`/api/fits/${image.id}/preview?preview=full`);
    const fullMeta = await sharp(await full.arrayBuffer()).metadata();
    assert.equal(fullMeta.width, width);

    process.env.FITS_FULL_PREVIEW_MAX = '1000';
    const bounded = await app.request(`/api/fits/${image.id}/preview?preview=full`);
    const boundedMeta = await sharp(await bounded.arrayBuffer()).metadata();
    assert.equal(boundedMeta.width, 1000, 'full previews stay within FITS_FULL_PREVIEW_MAX');
  } finally {
    delete process.env.FITS_FULL_PREVIEW_MAX;
    if (oldLibraryDir === undefined) delete process.env.FITS_LIBRARY_DIR;
    else process.env.FITS_LIBRARY_DIR = oldLibraryDir;
    if (oldCacheDir === undefined) delete process.env.FITS_CACHE_DIR;
    else process.env.FITS_CACHE_DIR = oldCacheDir;
    await rm(directory, { recursive: true, force: true });
  }
});
