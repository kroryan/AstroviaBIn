import { Hono } from 'hono';
import { storage } from '../services/storage';
import { configService } from '../services/config';
import { cronManager } from '../services/cron-manager';
import { workerManager } from '../services/worker-manager';
import { localAstrometryStatus } from '../services/astrometry-local';
import { filterRelevantTags } from '../services/tags-utils';
import { handleRouteError } from './route-utils';
import { isPostgres, sqliteDbPath } from '../db';
import { stat, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshotDatabase } from '../services/maintenance';
import { skyDataDirectories } from '../services/sky-catalog';
import type { WsManager } from '../services/ws-manager';
import { readFileSync } from 'node:fs';

let cachedVersion: string | undefined;
/** `npm_package_version` is only set under `npm run`; the container starts node directly. */
function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    cachedVersion = String(JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version || 'unknown');
  } catch {
    cachedVersion = process.env.npm_package_version || 'unknown';
  }
  return cachedVersion;
}

export default function systemRoutes(wsManager?: WsManager) {
  const app = new Hono();

  app.get('/licenses/astroviabin', async c => {
    try {
      const source = process.env.NODE_ENV === 'production'
        ? '/usr/share/doc/astroviabin/LICENSE' : path.resolve(process.cwd(), 'LICENSE');
      return c.text(await readFile(source, 'utf8'), 200, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    } catch { return c.text('License file unavailable', 404); }
  });

  app.get('/licenses/hotpants/:file', async c => {
    const file = c.req.param('file');
    if (!['LICENSE', 'COPYING'].includes(file)) return c.text('Not found', 404);
    try {
      const source = process.env.NODE_ENV === 'production'
        ? path.join('/usr/share/doc/hotpants', file)
        : path.resolve(process.cwd(), 'vendor/hotpants', file);
      const contents = await readFile(source, 'utf8');
      return c.text(contents, 200, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    } catch { return c.text('License file unavailable', 404); }
  });

  // Astrometry.net software and index-data notices as installed in the image (Debian copyright
  // files) plus the 4200-series index license kept next to any extra downloaded index files.
  app.get('/licenses/astrometry/:document', async c => {
    const extraIndexDir = (process.env.ASTROMETRY_EXTRA_INDEX_DIRS ?? '/app/config/astrometry-index').split(path.delimiter).filter(Boolean)[0];
    const documents: Record<string, string> = {
      software: '/usr/share/doc/astrometry.net/copyright',
      'index-2mass': '/usr/share/doc/astrometry-data-2mass-08-19/copyright',
      ...(extraIndexDir ? { 'index-4200': path.join(path.resolve(extraIndexDir), 'LICENSE-4200.txt') } : {}),
    };
    const source = documents[c.req.param('document')];
    if (!source) return c.text('Not found', 404);
    try {
      return c.text(await readFile(source, 'utf8'), 200, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
    } catch { return c.text('License file unavailable on this installation', 404); }
  });

  // Provenance and licences of the offline sky-annotation data (stars, deep-sky, constellations).
  app.get('/licenses/sky/:document', async c => {
    const files: Record<string, string> = {
      sources: 'SOURCES.txt',
      hyg: 'LICENSES/HYG-LICENSE.md',
      'd3-celestial': 'LICENSES/d3-celestial-LICENSE.txt',
      tycho2: 'LICENSES/Tycho-2-ReadMe.txt',
    };
    const file = files[c.req.param('document')];
    if (!file) return c.text('Not found', 404);
    for (const directory of skyDataDirectories()) {
      try {
        return c.text(await readFile(path.join(directory, file), 'utf8'), 200, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
      } catch { /* try the next location */ }
    }
    return c.text('Sky data licence file unavailable on this installation', 404);
  });

  // Save admin settings
  app.post('/admin/settings', async (c) => {
    try {
      const settings = await c.req.json();

      await configService.updateConfig(settings);
      return c.json({ message: 'Settings saved successfully' });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to save settings');
    }
  });

  // Get admin settings; local plate solving has no remote API key.
  app.get('/admin/settings', async (c) => {
    try {
      const config = await configService.getConfig();
      return c.json(config);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to get settings');
    }
  });

  // Check the private local solver installation and index files.
  app.post('/test-astrometry-connection', async (c) => {
    try {
      const status = await localAstrometryStatus();
      if (!status.available) {
        return c.json({ success: false, message: `Local solver is missing or has no index files (${status.indexCount} found).` });
      }
      return c.json({ success: true, message: `Local solver ready with ${status.indexCount} index files. Images stay on this server.` });
    } catch (error) {
      return c.json({ success: false, message: error instanceof Error ? error.message : 'Local solver check failed' }, 500);
    }
  });

  // Get stats
  app.get('/stats', async (c) => {
    try {
      const stats = await storage.getStats();
      return c.json(stats);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch stats');
    }
  });

  // Get popular tags
  app.get('/tags', async (c) => {
    try {
      const images = await storage.getAstroImages();
      const tagCounts: Record<string, number> = {};

      images.forEach((image) => {
        if (Array.isArray(image.tags)) {
          const relevantTags = filterRelevantTags(image.tags);
          relevantTags.forEach((tag) => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        }
      });

      const popularTags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([tag, count]) => ({ tag, count }));

      return c.json(popularTags);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch tags');
    }
  });

  // Get constellations
  app.get('/constellations', async (c) => {
    try {
      const images = await storage.getAstroImages();
      const constellations = Array.from(
        new Set(images.filter((img) => img.constellation).map((img) => img.constellation!)),
      ).sort();
      return c.json(constellations);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch constellations');
    }
  });

  // Get notifications
  app.get('/notifications', async (c) => {
    try {
      const notifications = await storage.getNotifications();
      return c.json(notifications);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to get notifications');
    }
  });

  // Acknowledge all notifications
  app.post('/notifications/acknowledge-all', async (c) => {
    try {
      await storage.acknowledgeAllNotifications();
      if (wsManager) {
        wsManager.broadcast('notifications-updated', {});
      }
      return c.json({ message: 'All notifications acknowledged' });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to acknowledge all notifications');
    }
  });

  // Acknowledge notification
  app.post('/notifications/:id/acknowledge', async (c) => {
    try {
      const id = parseInt(c.req.param('id'));
      await storage.acknowledgeNotification(id);
      if (wsManager) {
        wsManager.broadcast('notifications-updated', {});
      }
      return c.json({ message: 'Notification acknowledged' });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to acknowledge notification');
    }
  });

  // Get cron job status
  app.get('/admin/cron-jobs', async (c) => {
    try {
      const jobs = cronManager.getAllJobs();
      return c.json(jobs);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to get cron jobs');
    }
  });

  // Database info (type, size, path)
  app.get('/admin/database', async (c) => {
    try {
      const dbType = isPostgres ? 'postgresql' : 'sqlite';
      const info: Record<string, unknown> = { type: dbType };

      if (!isPostgres && sqliteDbPath) {
        info.path = sqliteDbPath;
        try {
          const stats = await stat(sqliteDbPath);
          info.sizeBytes = stats.size;
          info.lastModified = stats.mtime.toISOString();
        } catch {
          info.sizeBytes = 0;
        }
      }

      return c.json(info);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to get database info');
    }
  });

  // Download SQLite database backup
  app.get('/admin/database/backup', async (c) => {
    try {
      if (isPostgres) {
        return c.json({ message: 'Backup download is only available for SQLite databases. Use pg_dump for PostgreSQL.' }, 400);
      }
      if (!sqliteDbPath) {
        return c.json({ message: 'SQLite database path not configured' }, 500);
      }

      // A VACUUM INTO snapshot is consistent even while the app is writing (unlike copying the file).
      const snapshot = path.join(os.tmpdir(), `astroviabin-backup-${randomUUID()}.db`);
      await snapshotDatabase(snapshot);
      const dbBuffer = await readFile(snapshot);
      await rm(snapshot, { force: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `astroviabin-backup-${timestamp}.db`;

      return new Response(dbBuffer, {
        headers: {
          'Content-Type': 'application/x-sqlite3',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(dbBuffer.length),
        },
      });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to create database backup');
    }
  });

  // Health check endpoint for container monitoring
  app.get('/health', async (c) => {
    try {
      // Check database connection
      let databaseStatus = 'healthy';
      try {
        await storage.getStats();
      } catch (dbError) {
        console.error('Database health check failed:', dbError);
        databaseStatus = 'unhealthy';
      }

      // Get worker status
      const workerStatus = workerManager.getStatus();

      const healthStatus = {
        status: databaseStatus === 'healthy' ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: databaseStatus,
        worker: {
          enabled: workerStatus.enabled,
          running: workerStatus.running,
          pid: workerStatus.pid,
          restartAttempts: workerStatus.restartAttempts,
        },
        version: appVersion(),
        nodeVersion: process.version,
      };

      const statusCode = databaseStatus === 'healthy' ? 200 : 503;
      return c.json(healthStatus, statusCode as 200);
    } catch (error) {
      console.error('Health check error:', error);
      return c.json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Health check failed',
      }, 503);
    }
  });

  return app;
}
