import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./images');
const { storage } = await import('../services/storage');
const { parseWcsHeaders } = await import('../services/wcs');
const { setSkyCatalog } = await import('../services/sky-catalog');

it('auto-annotations fills and persists missing annotations without re-solving or uploading images', async t => {
  const previousOnline = process.env.ASTROVIABIN_ONLINE_CATALOGS;
  process.env.ASTROVIABIN_ONLINE_CATALOGS = 'false';
  setSkyCatalog({
    stars: { epoch: 2000, count: 0, ra: new Float64Array(), dec: new Float64Array(), mag: new Float32Array(), pmra: new Float32Array(), pmdec: new Float32Array(), hd: new Int32Array(), hip: new Int32Array(), name: [], bayer: [], flam: [] },
    tycho: null,
    dso: [{ name: 'M 42', messier: 'M42', common: ['Orion Nebula'], type: 'HII', ra: 83.8221, dec: -5.3911, maj: 10, min: 8, pa: 0, mag: 4 }],
    constellations: [],
  });
  t.after(() => {
    if (previousOnline === undefined) delete process.env.ASTROVIABIN_ONLINE_CATALOGS;
    else process.env.ASTROVIABIN_ONLINE_CATALOGS = previousOnline;
    setSkyCatalog(null);
  });

  const wcs = parseWcsHeaders({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 50.5, CRPIX2: 40.5, CRVAL1: 83.8221, CRVAL2: -5.3911, CD1_1: -0.001, CD1_2: 0, CD2_1: 0, CD2_2: 0.001 }, 100, 80);
  t.mock.method(storage, 'getAstroImages', async filters => {
    assert.deepEqual(filters, { plateSolved: true });
    return [{ id: 42, plateSolved: true, captureDate: null }] as never;
  });
  t.mock.method(storage, 'getLatestPlateSolvingJob', async id => {
    assert.equal(id, 42);
    return { id: 99, imageId: 42, status: 'success', result: { ra: 83.8221, dec: -5.3911, pixscale: 3.6, radius: 0.1, orientation: 0, wcs } } as never;
  });
  let persisted: Record<string, unknown> | undefined;
  t.mock.method(storage, 'updatePlateSolvingJob', async (_jobId, updates) => {
    persisted = updates.result as Record<string, unknown>;
    return undefined;
  });

  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/auto-annotations', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { scanned: 1, annotated: 1, skipped: 0, failed: 0, failures: [] });
  assert.equal((persisted?.annotations as unknown[]).length, 1);
});

it('keeps ordinary and untagged images in Not Solved but hides non-Deep-Sky Solar System frames', async t => {
  t.mock.method(storage, 'getAstroImages', async () => [
    { id: 1, tags: ['Solar System', 'Mars'], plateSolved: false },
    { id: 2, tags: ['Comet'], plateSolved: false },
    { id: 3, tags: ['Deep Sky', 'Comet'], plateSolved: false },
    { id: 4, tags: ['Deep Sky', 'M 42'], plateSolved: false },
    { id: 5, tags: [], plateSolved: false },
    { id: 6, tags: ['M 31'], plateSolved: false },
    { id: 7, tags: ['Asteroid'], plateSolved: false },
    { id: 8, tags: ['Deep Sky', 'Asteroid'], plateSolved: false },
    { id: 9, tags: ['Deep Sky', 'Jupiter'], plateSolved: false },
    { id: 10, tags: undefined, plateSolved: false },
    { id: 11, tags: null, plateSolved: false },
  ] as never);
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images?plateSolved=false');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as Array<{ id: number }>).map(image => image.id), [3, 4, 5, 6, 8, 10, 11]);
});

it('coerces a captureDate update into a Date and marks its source as manual', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: [], objectType: null }));
  let received: Record<string, unknown> | undefined;
  t.mock.method(storage, 'updateAstroImage', async (_id: number, updates: Record<string, unknown>) => {
    received = updates;
    return { id: 1, ...updates };
  });
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ captureDate: '2026-01-15T10:30:00.000Z' }),
  });
  assert.equal(response.status, 200);
  assert.ok(received?.captureDate instanceof Date);
  assert.equal((received!.captureDate as Date).toISOString(), '2026-01-15T10:30:00.000Z');
  assert.equal(received!.captureDateSource, 'manual');
});

it('clears captureDateSource when captureDate is cleared', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: [], objectType: null }));
  let received: Record<string, unknown> | undefined;
  t.mock.method(storage, 'updateAstroImage', async (_id: number, updates: Record<string, unknown>) => {
    received = updates;
    return { id: 1, ...updates };
  });
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ captureDate: null }),
  });
  assert.equal(response.status, 200);
  assert.equal(received?.captureDate, null);
  assert.equal(received?.captureDateSource, null);
});

it('keeps Deep Sky compatible with comet and asteroid tags but not planet tags', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: [], objectType: null }));
  let receivedTags: string[] | undefined;
  t.mock.method(storage, 'updateAstroImage', async (_id: number, updates: Record<string, unknown>) => {
    receivedTags = updates.tags as string[];
    return { id: 1, ...updates };
  });
  const app = new Hono().route('/api/images', routes);
  const compatible = await app.request('/api/images/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['Deep Sky', 'Comet', 'Solar System'] }),
  });
  assert.equal(compatible.status, 200);
  assert.deepEqual(receivedTags, ['Deep Sky', 'Comet', 'Solar System']);

  const incompatible = await app.request('/api/images/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['Deep Sky', 'Comet', 'Mars'] }),
  });
  assert.equal(incompatible.status, 200);
  assert.deepEqual(receivedTags, ['Comet', 'Mars']);
});

it('rejects an unparsable captureDate', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: [], objectType: null }));
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ captureDate: 'not-a-date' }),
  });
  assert.equal(response.status, 400);
});

it('redirects /:id/full to the FITS native-resolution preview for FITS-backed images', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, originalPath: 'fits-upload://m42.fits' }));
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1/full', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/api/fits/1/preview?preview=full');
});

it('streams the private library original inline (no attachment disposition) for /:id/full', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-library-'));
  const previousLibrary = process.env.LIBRARY_STORAGE_DIR;
  process.env.LIBRARY_STORAGE_DIR = directory;
  await mkdir(path.join(directory, 'originals'), { recursive: true });
  await writeFile(path.join(directory, 'originals', 'photo.jpg'), new Uint8Array([1, 2, 3]));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, originalPath: 'sidereal-library://7', libraryAssetId: 7 }));
  t.mock.method(storage, 'getLibraryAssetForAstroImage', async () => ({ id: 7, relativePath: 'originals/photo.jpg', mimeType: 'image/jpeg' }));
  try {
    const app = new Hono().route('/api/images', routes);
    const response = await app.request('/api/images/1/full');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('content-disposition'), null);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
  } finally {
    if (previousLibrary === undefined) delete process.env.LIBRARY_STORAGE_DIR; else process.env.LIBRARY_STORAGE_DIR = previousLibrary;
    await rm(directory, { recursive: true, force: true });
  }
});

it('returns 404 from /:id/full when the image has no private original and is not FITS', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, originalPath: '/data/library/photo.jpg', immichId: null }));
  t.mock.method(storage, 'getLibraryAssetForAstroImage', async () => undefined);
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1/full');
  assert.equal(response.status, 404);
});

it('deletes a private-library image and its local original', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-delete-'));
  const previousLibrary = process.env.LIBRARY_STORAGE_DIR;
  process.env.LIBRARY_STORAGE_DIR = directory;
  const original = path.join(directory, 'originals', 'photo.jpg');
  await mkdir(path.dirname(original), { recursive: true });
  await writeFile(original, new Uint8Array([1, 2, 3]));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 42, originalPath: 'sidereal-library://7' }));
  t.mock.method(storage, 'getLibraryAssetForAstroImage', async () => ({ id: 7, relativePath: 'originals/photo.jpg' }));
  let deletedAsset: number | undefined;
  let deletedImage: number | undefined;
  t.mock.method(storage, 'deleteLibraryAsset', async (id: number) => { deletedAsset = id; });
  t.mock.method(storage, 'deleteAstroImage', async (id: number) => { deletedImage = id; return true; });
  try {
    const app = new Hono().route('/api/images', routes);
    const response = await app.request('/api/images/42', { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, id: 42 });
    assert.equal(deletedAsset, 7);
    assert.equal(deletedImage, 42);
    await assert.rejects(access(original));
  } finally {
    if (previousLibrary === undefined) delete process.env.LIBRARY_STORAGE_DIR; else process.env.LIBRARY_STORAGE_DIR = previousLibrary;
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses to delete an image whose original is not managed locally', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 43, originalPath: 'legacy-external://photo' }));
  t.mock.method(storage, 'getLibraryAssetForAstroImage', async () => undefined);
  let deleted = false;
  t.mock.method(storage, 'deleteAstroImage', async () => { deleted = true; return true; });
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/43', { method: 'DELETE' });
  assert.equal(response.status, 409);
  assert.equal(deleted, false);
});
