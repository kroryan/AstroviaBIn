import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';

delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: systemRoutes } = await import('./system');

test('every license document linked from Admin → About is served', async () => {
  const app = new Hono().route('/api', systemRoutes());
  for (const [url, expected] of [
    ['/api/licenses/astroviabin', /MIT License/],
    ['/api/licenses/hotpants/COPYING', /GNU GENERAL PUBLIC LICENSE/],
    ['/api/licenses/third-party/notices', /Licenses, credits and legal notices/],
    ['/api/licenses/third-party/python-packages', /\| astropy \|/],
    ['/api/licenses/third-party/javascript-packages', /\| react-leaflet \|/],
    ['/api/licenses/third-party/javascript-licenses', /Third-party JavaScript licenses/],
  ] as const) {
    const response = await app.request(url);
    assert.equal(response.status, 200, url);
    assert.match(await response.text(), expected, url);
  }
  assert.equal((await app.request('/api/licenses/third-party/../../etc/passwd')).status, 404);
});
