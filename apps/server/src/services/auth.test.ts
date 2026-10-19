import { it } from 'node:test';
import assert from 'node:assert/strict';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
process.env.ASTROVIABIN_SESSION_SECRET = 'test-secret';
delete process.env.ASTROVIABIN_ADMIN_USER;
delete process.env.ASTROVIABIN_ADMIN_PASSWORD;
const auth = await import('./auth');
const users = await import('./users');

it('defaults to the built-in admin / admin account', async () => {
  assert.equal(auth.usingDefaultCredentials(), true);
  const user = await auth.authenticate('admin', 'admin');
  assert.equal(user?.role, 'admin');
  assert.equal(user?.builtin, true);
  assert.equal(await auth.authenticate('admin', 'wrong'), null);
});

it('uses configured built-in credentials instead of the default', async () => {
  process.env.ASTROVIABIN_ADMIN_USER = 'astro';
  process.env.ASTROVIABIN_ADMIN_PASSWORD = 's3cret';
  try {
    assert.equal(await auth.authenticate('admin', 'admin'), null);
    assert.equal((await auth.authenticate('astro', 's3cret'))?.role, 'admin');
  } finally {
    delete process.env.ASTROVIABIN_ADMIN_USER;
    delete process.env.ASTROVIABIN_ADMIN_PASSWORD;
  }
});

it('signs in database users with their role and resolves it on every request', async () => {
  const created = await users.createUser({ username: 'guest', password: 'look-only-1', role: 'viewer' });
  const login = await auth.authenticate('Guest', 'look-only-1');
  assert.equal(login?.role, 'viewer');
  assert.equal(await auth.authenticate('guest', 'nope'), null);

  const token = auth.createSessionToken(login!.username, login!.fingerprint);
  assert.equal((await auth.resolveSession(token))?.role, 'viewer');

  await users.updateUser(created.id, { role: 'editor' });
  assert.equal((await auth.resolveSession(token))?.role, 'editor', 'role changes apply to existing sessions');

  await users.updateUser(created.id, { password: 'new-password-2' });
  assert.equal(await auth.resolveSession(token), null, 'a password change signs existing sessions out');

  const again = await auth.authenticate('guest', 'new-password-2');
  const fresh = auth.createSessionToken(again!.username, again!.fingerprint);
  await users.deleteUser(created.id);
  assert.equal(await auth.resolveSession(fresh), null, 'deleting the account signs it out');
});

it('rejects tampered and expired session tokens', async () => {
  const now = Date.now();
  const builtin = await auth.authenticate('admin', 'admin');
  const token = auth.createSessionToken('admin', builtin!.fingerprint, now);
  assert.equal((await auth.resolveSession(token, now))?.username, 'admin');
  assert.equal(await auth.resolveSession(`${token}x`, now), null);
  assert.equal(await auth.resolveSession(token, now + 31 * 86_400_000), null);
  assert.equal(await auth.resolveSession(undefined, now), null);
});

it('authenticates requests by cookie or the internal worker token', async () => {
  const builtin = await auth.authenticate('admin', 'admin');
  const cookie = `other=1; ${auth.SESSION_COOKIE}=${auth.createSessionToken('admin', builtin!.fingerprint)}`;
  assert.equal((await auth.authenticateRequest(cookie, null))?.role, 'admin');
  assert.equal(await auth.authenticateRequest('other=1', null), null);
  assert.ok(await auth.authenticateRequest(undefined, auth.internalToken()));
  assert.equal(await auth.authenticateRequest(undefined, 'guess'), null);
});

it('enforces role permissions', () => {
  assert.equal(auth.isAllowed('admin', 'POST', '/api/admin/settings'), true);
  assert.equal(auth.isAllowed('editor', 'POST', '/api/fits/upload'), true);
  assert.equal(auth.isAllowed('editor', 'GET', '/api/admin/settings'), false);
  assert.equal(auth.isAllowed('editor', 'POST', '/api/users'), false);
  assert.equal(auth.isAllowed('editor', 'POST', '/api/catalog/load'), false);
  assert.equal(auth.isAllowed('viewer', 'GET', '/api/images'), true);
  assert.equal(auth.isAllowed('viewer', 'PATCH', '/api/images/1'), false);
  assert.equal(auth.isAllowed('viewer', 'GET', '/api/users'), false);
});

it('only follows same-site redirect targets after login', () => {
  assert.equal(auth.safeNextPath('/targets?image=3'), '/targets?image=3');
  assert.equal(auth.safeNextPath('//evil.example'), '/');
  assert.equal(auth.safeNextPath('https://evil.example'), '/');
  assert.equal(auth.safeNextPath(undefined), '/');
});

it('throttles repeated failed logins per address', () => {
  for (let attempt = 0; attempt < 10; attempt++) auth.recordLoginFailure('10.0.0.9');
  assert.equal(auth.loginBlocked('10.0.0.9'), true);
  auth.clearLoginFailures('10.0.0.9');
  assert.equal(auth.loginBlocked('10.0.0.9'), false);
});
