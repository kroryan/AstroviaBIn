import './env-compat';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import path from 'path';
import fs from 'fs';
import { registerRoutes } from './routes';
import { WsManager } from './services/ws-manager';
import { cronManager, setWsManager as setCronWsManager } from './services/cron-manager';
import { setWsManager } from './services/astrometry';
import { workerManager } from './services/worker-manager';
import { catalogService } from './services/catalog';
import { storage } from './services/storage';
import { registerAuth } from './routes/auth';
import { loadSkyCatalog } from './services/sky-catalog';
import { refreshImageConstellations } from './services/maintenance';
import { classifyLooseSpectra } from './services/gallery-auto-classify';
import { authDisabled, internalToken, usingDefaultCredentials } from './services/auth';

const app = new Hono();

// Authentication guards every page, API route and asset except the login page and health check.
// The UI is served from the same origin, so no CORS headers are emitted.
internalToken();
registerAuth(app);
if (authDisabled()) {
  console.warn('Authentication is DISABLED (ASTROVIABIN_AUTH_DISABLED=true). Only use this behind another authenticating proxy.');
} else if (usingDefaultCredentials()) {
  console.warn('Using the default admin / admin login. Set ASTROVIABIN_ADMIN_USER and ASTROVIABIN_ADMIN_PASSWORD.');
}

// Setup routes (wsManager set after server starts)
// We'll register routes after creating wsManager
let wsManager: WsManager;

// Main startup function
async function startServer() {
  try {
    const importedSolutions = await storage.importExistingPlateSolutions();
    if (importedSolutions > 0) {
      console.log(`Imported ${importedSolutions} existing plate solutions as completed jobs; no images were re-solved.`);
    }
  } catch (error) {
    console.error('Failed to import existing plate solutions; the saved image metadata remains untouched:', error);
  }

  const PORT = parseInt(process.env.PORT || '5000', 10);

  // Start Hono with @hono/node-server — returns a Node http.Server
  const server = serve({
    fetch: app.fetch,
    port: PORT,
    // HOST=127.0.0.1 keeps the server private to this computer; the default listens on every interface.
    ...(process.env.HOST ? { hostname: process.env.HOST } : {}),
  });

  // Create WebSocket manager attached to the Node HTTP server
  wsManager = new WsManager(server as any);

  // Register routes with wsManager
  registerRoutes(app, wsManager);

  // Serve static files (in production, frontend is pre-built to dist/public)
  const publicPath = path.resolve(process.cwd(), 'dist/public');

  app.use('/assets/*', serveStatic({ root: publicPath, rewriteRequestPath: (p) => p }));
  app.use('/favicon.ico', serveStatic({ root: publicPath, rewriteRequestPath: () => '/favicon.ico' }));
  app.use('/fonts/*', serveStatic({ root: publicPath, rewriteRequestPath: (p) => p }));
  for (const file of ['/logo.png', '/logo.svg', '/favicon-32.png', '/icon-192.png', '/apple-touch-icon.png']) {
    app.use(file, serveStatic({ root: publicPath, rewriteRequestPath: () => file }));
  }

  // SPA fallback: serve index.html for all non-API routes
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ message: 'Not found' }, 404);
    }
    const indexPath = path.join(publicPath, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      return c.html(html);
    } catch {
      return c.text('Frontend not built. Run npm run build first.', 404);
    }
  });

  // Initialize cron manager
  cronManager.initialize();

  // Auto-load catalog if not yet loaded
  catalogService.getStatus().then(status => {
    if (!status.count) {
      console.log('Catalog not loaded, fetching OpenNGC catalog...');
      catalogService.loadCatalog()
        .then(result => console.log(`Catalog loaded: ${result.count} objects`))
        .catch(err => console.error('Failed to auto-load catalog:', err));
    } else {
      console.log(`Catalog already loaded: ${status.count} objects`);
    }
  }).catch(err => console.error('Failed to check catalog status:', err));

  // Warm the offline star/deep-sky data so the first annotated image opens instantly.
  setTimeout(() => { loadSkyCatalog(); }, 1000);
  refreshImageConstellations()
    .then(count => { if (count > 0) console.log(`Corrected the constellation of ${count} solved image(s) using the IAU boundaries`); })
    .catch(error => console.error('Could not refresh image constellations:', error));
  classifyLooseSpectra()
    .then(count => { if (count > 0) console.log(`Placed ${count} spectroscopy FITS in the catalog of their field`); })
    .catch(error => console.error('Could not classify spectroscopy FITS:', error));

  // Set WebSocket manager in services for real-time updates
  setWsManager(wsManager);
  setCronWsManager(wsManager);

  // Start worker manager in production (in development, worker runs separately)
  if (process.env.NODE_ENV === 'production') {
    console.log('Starting worker manager...');
    workerManager.start().catch(error => {
      console.error('Failed to start worker manager:', error);
    });
  }

  console.log(`AstroviaBin server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite'}`);
  console.log(`Worker manager available in production mode`);
}

// Start the server
startServer().catch(console.error);

// Graceful shutdown handling
const gracefulShutdown = async (signal: string) => {
  console.log(`Received ${signal}. Starting graceful shutdown...`);

  // Stop worker manager
  if (process.env.NODE_ENV === 'production') {
    try {
      await workerManager.gracefulShutdown();
    } catch (error) {
      console.error('Error during worker shutdown:', error);
    }
  }

  // Stop cron manager
  try {
    cronManager.shutdown();
  } catch (error) {
    console.error('Error during cron manager shutdown:', error);
  }

  console.log('Graceful shutdown complete');
  process.exit(0);
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// Export wsManager for use in other modules
export { wsManager };
