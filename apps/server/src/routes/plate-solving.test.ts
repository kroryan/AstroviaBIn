import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: routes } = await import('./plate-solving');
const { astrometryService } = await import('../services/astrometry');
const { storage } = await import('../services/storage');
const { configService } = await import('../services/config');

for (const status of ['processing', 'success', 'failed']) {
  it(`single-image route preserves ${status} response`, async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true, apiKey: 'test' }));
    t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: ['Deep Sky'] }));
    const result = { calibration: { ra: 1, dec: 2, pixscale: 3, radius: 4, orientation: 5 }, annotations: [], machineTags: [] };
    const processing = { status: 'processing', message: 'Still processing. Check status later.', jobId: 14, submissionId: '16141301' };
    t.mock.method(astrometryService, 'completePlateSolvingWorkflow', async image => {
      assert.equal(image.id, 1);
      if (status === 'failed') throw new Error('bad image');
      return status === 'success' ? { status, result } : processing;
    });
    const app = new Hono().route('/api/plate-solving', routes());
    const response = await app.request('/api/plate-solving/images/1/plate-solve', { method: 'POST' });
    assert.equal(response.status, status === 'processing' ? 202 : status === 'success' ? 200 : 500);
    assert.deepEqual(await response.json(), status === 'processing' ? processing : status === 'success' ? { message: 'Image plate solving completed successfully', result } : { message: 'Failed to complete plate solving' });
  });
}

it('update route reports the stored job state without starting another solve', async t => {
  t.mock.method(storage, 'getPlateSolvingJob', async (id: number) => { assert.equal(id, 14); return { id: 14, status: 'processing', result: null }; });
  t.mock.method(astrometryService, 'checkJobStatus', async () => assert.fail('No solve from a status check'));
  t.mock.method(astrometryService, 'submitImageForPlateSolving', async () => assert.fail('No upload'));
  t.mock.method(storage, 'createPlateSolvingJob', async () => assert.fail('No new job'));
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/update/14', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'processing', result: null });
});

it('update route returns 404 for an unknown job', async t => {
  t.mock.method(storage, 'getPlateSolvingJob', async () => undefined);
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/update/99', { method: 'POST' });
  assert.equal(response.status, 404);
});

it('passes a sexagesimal coordinate hint to the local solver workflow', async t => {
  t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true }));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: ['Deep Sky'] }));
  t.mock.method(storage, 'getLatestPlateSolvingJob', async () => undefined);
  let received: unknown;
  t.mock.method(astrometryService, 'completePlateSolvingWorkflow', async (_image: unknown, hint: unknown) => {
    received = hint;
    return { status: 'processing', jobId: 3, submissionId: 'local-x', message: 'queued' };
  });
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/images/1/plate-solve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hint: { ra: '12:05:15', dec: '+76:54:21', radius: '2' } }),
  });
  assert.equal(response.status, 202);
  const hint = received as { ra: number; dec: number; radiusDeg: number };
  assert.ok(Math.abs(hint.ra - 181.3125) < 1e-9);
  assert.ok(Math.abs(hint.dec - 76.905833) < 1e-5);
  assert.equal(hint.radiusDeg, 2);
});

it('rejects an unparseable coordinate hint', async t => {
  t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true }));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: ['Deep Sky'] }));
  t.mock.method(storage, 'getLatestPlateSolvingJob', async () => undefined);
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/images/1/plate-solve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hint: { ra: 'north', dec: '+76' } }),
  });
  assert.equal(response.status, 400);
});

it('rejects a Solar System image before it reaches Astrometry.net', async t => {
  t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true, apiKey: 'test' }));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: ['Mars'] }));
  t.mock.method(astrometryService, 'completePlateSolvingWorkflow', async () => assert.fail('Solar System image must not be submitted'));
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/images/1/plate-solve', { method: 'POST' });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { message: string }).message, /Solar System/);
});

it('rejects images without the Deep Sky tag before they reach Astrometry.net', async t => {
  t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true, apiKey: 'test' }));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 1, tags: ['FITS'] }));
  t.mock.method(astrometryService, 'completePlateSolvingWorkflow', async () => assert.fail('An untagged image must not be submitted'));
  const app = new Hono().route('/api/plate-solving', routes());
  const response = await app.request('/api/plate-solving/images/1/plate-solve', { method: 'POST' });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { message: string }).message, /Deep Sky/);
});

it('bulk submission only re-solves already solved images when forced', async t => {
  t.mock.method(configService, 'getAstrometryConfig', async () => ({ enabled: true }));
  t.mock.method(storage, 'getAstroImage', async () => ({ id: 5, tags: ['Deep Sky'], plateSolved: true }));
  t.mock.method(storage, 'getLatestPlateSolvingJob', async () => ({ id: 1, status: 'success' }));
  let submitted = 0;
  t.mock.method(astrometryService, 'submitImageForPlateSolving', async () => { submitted++; return { submissionId: 'local-a', jobId: 9 }; });
  const app = new Hono().route('/api/plate-solving', routes());
  const request = (body: unknown) => app.request('/api/plate-solving/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const plain = await (await request({ imageIds: [5] })).json() as { results: Array<{ success: boolean }> };
  assert.equal(plain.results[0].success, false);
  const forced = await (await request({ imageIds: [5], force: true })).json() as { results: Array<{ success: boolean }> };
  assert.equal(forced.results[0].success, true);
  assert.equal(submitted, 1);
});
