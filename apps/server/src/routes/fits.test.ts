import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./fits');

function card(key: string, value?: string): string {
  return (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
}

function testFits(): Buffer {
  const header = Buffer.from([
    card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '2'), card('NAXIS1', '2'), card('NAXIS2', '2'),
    card('OBJECT', "'M 42'"), card('EXPTIME', '120'), card('END'),
  ].join(''), 'ascii');
  const data = Buffer.alloc(8);
  [0, 100, 500, 1000].forEach((value, index) => data.writeInt16BE(value, index * 2));
  return Buffer.concat([header, Buffer.alloc(2880 - header.length, ' '), data, Buffer.alloc(2880 - data.length)]);
}

test('scan indexes FITS into the existing gallery and serves a preview', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-fits-route-'));
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

    const uploadForm = new FormData();
    uploadForm.set('file', new File([testFits()], 'M42 final.FITS', { type: 'application/fits' }));
    const upload = await app.request('/api/fits/upload', { method: 'POST', body: uploadForm });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { image: { originalPath: string } };
    assert.match(uploaded.image.originalPath, /^fits-upload:\/\/M42_final-\d+\.fits$/);

    const images = await app.request('/api/fits');
    const image = (await images.json() as Array<{ id: number; originalPath: string; targetName: string; tags: string[] }>).find(item => item.originalPath === 'fits://m42.fits');
    assert.ok(image);
    assert.equal(image.originalPath, 'fits://m42.fits');
    assert.equal(image.targetName, 'M 42');
    assert.ok(image.tags.includes('Deep Sky'));

    const preview = await app.request(`/api/fits/${image.id}/preview?stretch=asinh`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(preview.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()).slice(1, 4), new Uint8Array([80, 78, 71]));

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

    await writeFile(path.join(sourceDirectory, 'm42-b.fits'), testFits());
    await app.request('/api/fits/scan', { method: 'POST' });
    const allImages = await (await app.request('/api/fits')).json() as Array<{ id: number; originalPath: string }>;
    const secondFrame = allImages.find(item => item.originalPath === 'fits://m42-b.fits');
    assert.ok(secondFrame);

    const stacked = await app.request('/api/fits/stack', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageIds: [image.id, secondFrame!.id], method: 'median', outputName: 'm42-stacked' }),
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
