import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
process.env.SIDEREAL_SESSION_SECRET = 'test-secret';
delete process.env.SIDEREAL_ADMIN_USER;
delete process.env.SIDEREAL_ADMIN_PASSWORD;
const { registerAuth } = await import('./auth');
const { default: userRoutes } = await import('./users');
const auth = await import('../services/auth');

const app = new Hono();
registerAuth(app);
app.route('/api/users', userRoutes);
app.get('/api/images', c => c.json([]));
app.patch('/api/images/:id', c => c.json({ ok: true }));

async function sessionFor(username: string, password: string) {
  const user = await auth.authenticate(username, password);
  assert.ok(user, `login for ${username}`);
  return `${auth.SESSION_COOKIE}=${auth.createSessionToken(user.username, user.fingerprint)}`;
}
const send = (cookie: string, path: string, method = 'GET', body?: unknown) => app.request(path, {
  method,
  headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

it('lets administrators create users with roles that the middleware then enforces', async () => {
  const admin = await sessionFor('admin', 'admin');
  assert.equal((await send(admin, '/api/users', 'POST', { username: 'admin', password: 'whatever1', role: 'viewer' })).status, 409);
  assert.equal((await send(admin, '/api/users', 'POST', { username: 'x', password: 'short', role: 'viewer' })).status, 400);

  const created = await send(admin, '/api/users', 'POST', { username: 'visitor', password: 'visitor-pass', role: 'viewer' });
  assert.equal(created.status, 201);
  const visitor = await created.json() as { id: number; role: string; passwordHash?: string };
  assert.equal(visitor.role, 'viewer');
  assert.equal(visitor.passwordHash, undefined, 'password hashes are never returned');

  const viewerCookie = await sessionFor('visitor', 'visitor-pass');
  assert.equal((await send(viewerCookie, '/api/images')).status, 200);
  assert.equal((await send(viewerCookie, '/api/images/1', 'PATCH', { title: 'x' })).status, 403);
  assert.equal((await send(viewerCookie, '/api/users')).status, 403);

  assert.equal((await send(admin, `/api/users/${visitor.id}`, 'PATCH', { role: 'editor' })).status, 200);
  assert.equal((await send(viewerCookie, '/api/images/1', 'PATCH', { title: 'x' })).status, 200, 'editor can now edit');
  assert.equal((await send(viewerCookie, '/api/users')).status, 403, 'editors cannot manage accounts');

  const listed = await (await send(admin, '/api/users')).json() as { builtinAdmin: { username: string }; users: Array<{ username: string }> };
  assert.equal(listed.builtinAdmin.username, 'admin');
  assert.deepEqual(listed.users.map(user => user.username), ['visitor']);

  assert.equal((await send(admin, `/api/users/${visitor.id}`, 'DELETE')).status, 204);
  assert.equal((await send(viewerCookie, '/api/images')).status, 401, 'deleted accounts are signed out');
});
