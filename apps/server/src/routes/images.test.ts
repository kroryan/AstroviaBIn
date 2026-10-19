import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./images');
const { storage } = await import('../services/storage');

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
