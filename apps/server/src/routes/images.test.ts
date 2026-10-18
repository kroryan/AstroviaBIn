import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./images');
const { storage } = await import('../services/storage');
const { configService } = await import('../services/config');

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

it('proxies the Immich original inline (no attachment disposition) for /:id/full', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, originalPath: '/data/library/photo.jpg', immichId: 'abc-123' }));
  t.mock.method(configService, 'getImmichConfig', async () => ({ host: 'http://immich:2283', apiKey: 'key' }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.match(url, /\/api\/assets\/abc-123\/original$/);
    return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  try {
    const app = new Hono().route('/api/images', routes);
    const response = await app.request('/api/images/1/full');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('content-disposition'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

it('returns 404 from /:id/full when the image has no Immich original and is not FITS', async t => {
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, originalPath: '/data/library/photo.jpg', immichId: null }));
  const app = new Hono().route('/api/images', routes);
  const response = await app.request('/api/images/1/full');
  assert.equal(response.status, 404);
});
