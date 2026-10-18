import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
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
