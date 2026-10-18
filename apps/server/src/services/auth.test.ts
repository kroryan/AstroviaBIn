import { it } from 'node:test';
import assert from 'node:assert/strict';
process.env.SIDEREAL_SESSION_SECRET = 'test-secret';
delete process.env.SIDEREAL_ADMIN_USER;
delete process.env.SIDEREAL_ADMIN_PASSWORD;
const auth = await import('./auth');

it('defaults to admin / admin when no credentials are configured', () => {
  assert.equal(auth.usingDefaultCredentials(), true);
  assert.equal(auth.checkCredentials('admin', 'admin'), true);
  assert.equal(auth.checkCredentials('admin', 'wrong'), false);
});

it('uses configured credentials instead of the default', () => {
  process.env.SIDEREAL_ADMIN_USER = 'astro';
  process.env.SIDEREAL_ADMIN_PASSWORD = 's3cret';
  try {
    assert.equal(auth.checkCredentials('admin', 'admin'), false);
    assert.equal(auth.checkCredentials('astro', 's3cret'), true);
  } finally {
    delete process.env.SIDEREAL_ADMIN_USER;
    delete process.env.SIDEREAL_ADMIN_PASSWORD;
  }
});

it('accepts its own session tokens and rejects tampered or expired ones', () => {
  const now = Date.now();
  const token = auth.createSessionToken('admin', now);
  assert.equal(auth.verifySessionToken(token, now), true);
  assert.equal(auth.verifySessionToken(`${token}x`, now), false);
  assert.equal(auth.verifySessionToken(token.replace(/^./, character => character === 'a' ? 'b' : 'a'), now), false);
  assert.equal(auth.verifySessionToken(token, now + 31 * 86_400_000), false);
  assert.equal(auth.verifySessionToken(undefined, now), false);
});

it('authenticates requests by cookie or the internal worker token', () => {
  const cookie = `other=1; ${auth.SESSION_COOKIE}=${auth.createSessionToken('admin')}`;
  assert.equal(auth.isAuthenticatedRequest(cookie, null), true);
  assert.equal(auth.isAuthenticatedRequest('other=1', null), false);
  assert.equal(auth.isAuthenticatedRequest(undefined, auth.internalToken()), true);
  assert.equal(auth.isAuthenticatedRequest(undefined, 'guess'), false);
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
