import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

/**
 * Single-user login for a self-hosted install. Credentials come from SIDEREAL_ADMIN_USER and
 * SIDEREAL_ADMIN_PASSWORD (default admin / admin — change them). Sessions are HMAC-signed cookies;
 * the signing secret is SIDEREAL_SESSION_SECRET or a random value persisted next to the database.
 * The background worker authenticates with a per-boot internal token instead of a cookie.
 */

export const SESSION_COOKIE = 'sidereal_session';
const SESSION_DAYS = 30;
const INTERNAL_HEADER = 'x-sidereal-internal';

export function authDisabled(): boolean {
  return process.env.SIDEREAL_AUTH_DISABLED === 'true';
}

export function adminUser(): string {
  return process.env.SIDEREAL_ADMIN_USER || 'admin';
}

function adminPassword(): string {
  return process.env.SIDEREAL_ADMIN_PASSWORD || 'admin';
}

export function usingDefaultCredentials(): boolean {
  return !process.env.SIDEREAL_ADMIN_USER && !process.env.SIDEREAL_ADMIN_PASSWORD;
}

let cachedSecret: Buffer | null = null;
function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  if (process.env.SIDEREAL_SESSION_SECRET) {
    cachedSecret = Buffer.from(process.env.SIDEREAL_SESSION_SECRET);
    return cachedSecret;
  }
  const directory = path.dirname(path.resolve(process.env.SQLITE_DB_PATH || (process.env.NODE_ENV === 'production' ? '/app/config/sidereal.db' : 'local.db')));
  const file = path.join(directory, '.session-secret');
  try {
    cachedSecret = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (cachedSecret.length >= 32) return cachedSecret;
  } catch { /* create below */ }
  cachedSecret = randomBytes(32);
  try {
    fs.writeFileSync(file, cachedSecret.toString('hex'), { mode: 0o600 });
  } catch (error) {
    console.warn('Could not persist the session secret; sessions will reset on restart:', error instanceof Error ? error.message : error);
  }
  return cachedSecret;
}

/** Token shared with the worker process through the environment it inherits. */
export function internalToken(): string {
  if (!process.env.SIDEREAL_INTERNAL_TOKEN) process.env.SIDEREAL_INTERNAL_TOKEN = randomBytes(32).toString('hex');
  return process.env.SIDEREAL_INTERNAL_TOKEN;
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function checkCredentials(user: string, password: string): boolean {
  // Evaluate both comparisons so timing does not reveal which field was wrong.
  const userOk = safeEqual(user, adminUser());
  const passwordOk = safeEqual(password, adminPassword());
  return userOk && passwordOk;
}

export function createSessionToken(user: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: now + SESSION_DAYS * 86_400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { u?: string; exp?: number };
    return data.u === adminUser() && typeof data.exp === 'number' && data.exp > now;
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined | null, name: string): string | undefined {
  for (const part of (header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function isInternalRequest(headerValue: string | undefined | null): boolean {
  return Boolean(headerValue) && safeEqual(String(headerValue), internalToken());
}

export function isAuthenticatedRequest(cookieHeader: string | undefined | null, internalHeader: string | undefined | null): boolean {
  return authDisabled() || isInternalRequest(internalHeader) || verifySessionToken(readCookie(cookieHeader, SESSION_COOKIE));
}

/** For the WebSocket upgrade, which bypasses Hono's middleware. */
export function isAuthenticatedUpgrade(request: IncomingMessage): boolean {
  const internal = request.headers[INTERNAL_HEADER];
  return isAuthenticatedRequest(request.headers.cookie, Array.isArray(internal) ? internal[0] : internal);
}

export { INTERNAL_HEADER };

// Brute-force protection: at most 10 failed logins per client address every 15 minutes.
const failures = new Map<string, { count: number; resetAt: number }>();
export function loginBlocked(address: string, now = Date.now()): boolean {
  const entry = failures.get(address);
  return Boolean(entry && entry.resetAt > now && entry.count >= 10);
}
export function recordLoginFailure(address: string, now = Date.now()): void {
  const entry = failures.get(address);
  if (!entry || entry.resetAt <= now) failures.set(address, { count: 1, resetAt: now + 15 * 60_000 });
  else entry.count++;
}
export function clearLoginFailures(address: string): void {
  failures.delete(address);
}

/** Only same-site relative paths are accepted as post-login redirects. */
export function safeNextPath(value: string | undefined | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}
