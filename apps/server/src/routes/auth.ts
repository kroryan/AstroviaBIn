import type { Context, Hono, Next } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import {
  authDisabled, authenticate, authenticateRequest, clearedSessionCookie, clearLoginFailures, createSessionToken,
  INTERNAL_HEADER, isAllowed, loginBlocked, recordLoginFailure, safeNextPath, sessionCookie, type AuthUser,
} from '../services/auth';

const PUBLIC_PATHS = new Set(['/login', '/api/health', '/api/auth/status', '/api/auth/logout', '/favicon.ico', '/logo.png', '/logo.svg', '/favicon-32.png', '/icon-192.png', '/apple-touch-icon.png']);

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
<meta name="theme-color" content="#07040f">
<link rel="icon" type="image/svg+xml" href="/logo.svg">
<title>AstroviaBin · Sign in</title>
<style>
  @font-face { font-family: "Orbitron"; font-weight: 700; font-display: swap; src: url(/fonts/orbitron-latin-700-normal.woff2) format("woff2"); }
  @font-face { font-family: "Orbitron"; font-weight: 800; font-display: swap; src: url(/fonts/orbitron-latin-800-normal.woff2) format("woff2"); }
  @font-face { font-family: "Rajdhani"; font-weight: 500; font-display: swap; src: url(/fonts/rajdhani-latin-500-normal.woff2) format("woff2"); }
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #e9e6ff;
    font-family: "Rajdhani", "Share Tech Mono", ui-monospace, system-ui, sans-serif; background-color: #07040f;
    background-image: radial-gradient(900px 500px at 85% -10%, rgb(255 43 214 / .18), transparent 60%),
      radial-gradient(800px 500px at -10% 110%, rgb(0 240 255 / .16), transparent 60%),
      linear-gradient(rgb(122 92 255 / .08) 1px, transparent 1px), linear-gradient(90deg, rgb(122 92 255 / .08) 1px, transparent 1px);
    background-size: auto, auto, 44px 44px, 44px 44px; }
  body::after { content: ""; position: fixed; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(to bottom, rgb(255 255 255 / .025) 0 1px, transparent 1px 3px); }
  form { width: min(360px, calc(100vw - 32px)); padding: 30px 28px; position: relative;
    background: linear-gradient(160deg, rgb(20 15 42 / .95), rgb(10 7 22 / .95)); border: 1px solid rgb(0 240 255 / .45);
    box-shadow: 0 0 40px rgb(0 240 255 / .15), 0 0 0 1px rgb(255 43 214 / .15);
    clip-path: polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px)); }
  img { display: block; width: 92px; margin: 0 auto 10px; filter: drop-shadow(0 0 14px rgb(0 240 255 / .5)); }
  h1 { font-family: "Orbitron", "Rajdhani", sans-serif; font-size: 22px; text-align: center; margin: 0 0 4px; letter-spacing: .14em;
    background: linear-gradient(90deg, #00f0ff, #ff2bd6); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tagline { text-align: center; margin: 0 0 18px; font-size: 12px; letter-spacing: .3em; color: #9a96c8; text-transform: uppercase; }
  label { display: block; font-size: 12px; letter-spacing: .2em; text-transform: uppercase; color: #00f0ff; margin: 14px 0 4px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid rgb(122 92 255 / .55); background: #0a0716; color: inherit; font: inherit; font-size: 16px; }
  input:focus { outline: none; border-color: #00f0ff; box-shadow: 0 0 14px rgb(0 240 255 / .35); }
  button { width: 100%; margin-top: 22px; padding: 11px; border: 0; cursor: pointer; color: #04020a; font-weight: 700;
    font-family: "Orbitron", "Rajdhani", sans-serif; letter-spacing: .2em; text-transform: uppercase; font-size: 13px;
    background: linear-gradient(90deg, #00f0ff, #7a5cff); clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
  button:hover { filter: brightness(1.15); box-shadow: 0 0 20px rgb(0 240 255 / .5); }
  .error { color: #ff3b6b; font-size: 14px; margin-top: 14px; text-align: center; text-shadow: 0 0 8px rgb(255 59 107 / .5); }
</style>
</head>
<body>
<form method="post" action="/login">
  <img src="/logo.svg" alt="">
  <h1>ASTROVIABIN</h1>
  <p class="tagline">astro image vault</p>
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <label for="user">User</label>
  <input id="user" name="user" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Jack in</button>
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
    if (PUBLIC_PATHS.has(requestPath) || requestPath.startsWith('/assets/') || requestPath.startsWith('/fonts/')) return next();
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
