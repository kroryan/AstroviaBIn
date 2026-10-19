import type { Context, Hono, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  authDisabled, authenticate, authenticateRequest, clearedSessionCookie, clearLoginFailures, createSessionToken,
  INTERNAL_HEADER, isAllowed, loginBlocked, recordLoginFailure, safeNextPath, sessionCookie, type AuthUser,
} from '../services/auth';

const PUBLIC_PATHS = new Set(['/login', '/api/health', '/api/auth/status', '/api/auth/logout', '/favicon.ico', '/logo.png']);

type AuthEnv = { Variables: { authUser: AuthUser } };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function loginPage(next: string, error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sidereal · Sign in</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05070d; color: #e5e7eb;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
  form { width: min(340px, calc(100vw - 32px)); background: #0f1422; border: 1px solid #1f2937; border-radius: 14px; padding: 28px; box-sizing: border-box; }
  img { display: block; width: 96px; margin: 0 auto 12px; }
  h1 { font-size: 20px; text-align: center; margin: 0 0 20px; letter-spacing: .08em; }
  label { display: block; font-size: 13px; color: #9ca3af; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #374151; background: #070a12; color: inherit; font-size: 15px; }
  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px; background: #4f46e5; color: white; font-size: 15px; cursor: pointer; }
  .error { color: #f87171; font-size: 13px; margin-top: 12px; text-align: center; }
</style>
</head>
<body>
<form method="post" action="/login">
  <img src="/logo.png" alt="">
  <h1>SIDEREAL</h1>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label for="user">User</label>
  <input id="user" name="user" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
</form>
</body>
</html>`;
}

function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address || 'unknown';
  } catch {
    return 'unknown';
  }
}

function isSecure(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

export function registerAuth(app: Hono<any>) {
  app.use('*', async (c: Context<AuthEnv>, next: Next) => {
    const requestPath = c.req.path;
    if (PUBLIC_PATHS.has(requestPath) || requestPath.startsWith('/assets/')) return next();
    const user = await authenticateRequest(c.req.header('cookie'), c.req.header(INTERNAL_HEADER));
    if (user) {
      if (!isAllowed(user.role, c.req.method, requestPath)) {
        return c.json({ message: user.role === 'viewer' ? 'Your account is read-only' : 'Only administrators can do this' }, 403);
      }
      c.set('authUser', user);
      return next();
    }
    if (requestPath.startsWith('/api/') || requestPath === '/ws') return c.json({ message: 'Authentication required' }, 401);
    const target = `${requestPath}${new URL(c.req.url).search}`;
    return c.redirect(`/login?next=${encodeURIComponent(target)}`, 302);
  });

  app.get('/login', async c => {
    const next = safeNextPath(c.req.query('next'));
    if (!authDisabled() && await authenticateRequest(c.req.header('cookie'), null)) return c.redirect(next, 302);
    return c.html(loginPage(next));
  });

  app.post('/login', async c => {
    const form = await c.req.parseBody();
    const next = safeNextPath(String(form.next || '/'));
    const address = clientAddress(c);
    if (loginBlocked(address)) return c.html(loginPage(next, 'Too many failed attempts. Try again in 15 minutes.'), 429);
    const user = await authenticate(String(form.user || '').trim(), String(form.password || ''));
    if (!user) {
      recordLoginFailure(address);
      return c.html(loginPage(next, 'Incorrect user or password.'), 401);
    }
    clearLoginFailures(address);
    c.header('set-cookie', sessionCookie(createSessionToken(user.username, user.fingerprint), isSecure(c)));
    return c.redirect(next, 302);
  });

  app.post('/api/auth/logout', c => {
    c.header('set-cookie', clearedSessionCookie());
    return c.json({ ok: true });
  });

  app.get('/api/auth/status', async c => c.json({
    authenticated: Boolean(await authenticateRequest(c.req.header('cookie'), null)),
    enabled: !authDisabled(),
  }));

  // The signed-in account and role, for the UI to hide actions the role cannot perform.
  app.get('/api/auth/me', c => {
    const user = (c as Context<AuthEnv>).get('authUser');
    return c.json({ username: user.username, role: user.role, builtin: user.builtin, authEnabled: !authDisabled() });
  });
}
