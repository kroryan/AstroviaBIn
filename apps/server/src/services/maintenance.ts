import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { db, isPostgres, sqliteDbPath } from '../db';
import { fitsCacheDirectory } from './fits';
import { tileCacheDirectory } from './tiles';
import { storage } from './storage';
import { getConstellationFromCoordinates } from './constellation-utils';

interface CacheFile {
  path: string;
  size: number;
  mtimeMs: number;
}

async function walk(directory: string): Promise<CacheFile[]> {
  const files: CacheFile[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(candidate));
    else if (entry.isFile()) {
      try {
        const info = await stat(candidate);
        files.push({ path: candidate, size: info.size, mtimeMs: info.mtimeMs });
      } catch { /* removed concurrently */ }
    }
  }
  return files;
}

/**
 * Keeps a regenerable cache directory bounded: drops files older than `maxAgeDays`, then the oldest
 * files until the total fits `maxBytes`. Only ever touches derived previews/tiles, never originals.
 */
export async function pruneCacheDirectory(directory: string, maxBytes: number, maxAgeDays: number, now = Date.now()): Promise<{ removed: number; freedBytes: number }> {
  const files = (await walk(directory)).sort((left, right) => left.mtimeMs - right.mtimeMs);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  let removed = 0;
  let freedBytes = 0;
  const cutoff = now - maxAgeDays * 86_400_000;
  for (const file of files) {
    if (file.mtimeMs >= cutoff && total <= maxBytes) break;
    if (file.mtimeMs < cutoff || total > maxBytes) {
      await rm(file.path, { force: true });
      total -= file.size;
      freedBytes += file.size;
      removed++;
    }
  }
  return { removed, freedBytes };
}

export function cacheDirectories(): string[] {
  const thumbnails = process.env.THUMBNAIL_CACHE_DIR;
  return [fitsCacheDirectory(), tileCacheDirectory(), ...(thumbnails ? [path.resolve(thumbnails)] : [])];
}

export async function pruneCaches(): Promise<{ removed: number; freedBytes: number }> {
  const maxBytes = Number(process.env.ASTROVIABIN_CACHE_MAX_BYTES) > 0 ? Number(process.env.ASTROVIABIN_CACHE_MAX_BYTES) : 10 * 1024 ** 3;
  const maxAgeDays = Number(process.env.ASTROVIABIN_CACHE_MAX_AGE_DAYS) > 0 ? Number(process.env.ASTROVIABIN_CACHE_MAX_AGE_DAYS) : 60;
  let removed = 0;
  let freedBytes = 0;
  for (const directory of cacheDirectories()) {
    const result = await pruneCacheDirectory(directory, maxBytes, maxAgeDays);
    removed += result.removed;
    freedBytes += result.freedBytes;
  }
  return { removed, freedBytes };
}

export function databaseBackupDirectory(): string | null {
  if (isPostgres || !sqliteDbPath || sqliteDbPath === ':memory:') return null;
  return path.resolve(process.env.ASTROVIABIN_BACKUP_DIR || path.join(path.dirname(path.resolve(sqliteDbPath)), 'backups'));
}

/** Writes a transactionally consistent copy of the SQLite database (VACUUM INTO). */
export async function snapshotDatabase(outputPath: string): Promise<void> {
  const client = (db as { $client?: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).$client;
  if (!client) throw new Error('SQLite client is unavailable for backups');
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await rm(outputPath, { force: true });
  client.prepare('VACUUM INTO ?').run(outputPath);
}

/** Daily SQLite backup, keeping the newest `ASTROVIABIN_BACKUP_KEEP` (default 14) copies. */
export async function backupDatabase(now = new Date()): Promise<string | null> {
  const directory = databaseBackupDirectory();
  if (!directory) return null;
  const name = `astroviabin-${now.toISOString().slice(0, 10)}.db`;
  const output = path.join(directory, name);
  await snapshotDatabase(output);
  const keep = Number(process.env.ASTROVIABIN_BACKUP_KEEP) > 0 ? Number(process.env.ASTROVIABIN_BACKUP_KEEP) : 14;
  const backups = (await readdir(directory)).filter(file => /^astroviabin-\d{4}-\d{2}-\d{2}\.db$/.test(file)).sort().reverse();
  for (const old of backups.slice(keep)) await rm(path.join(directory, old), { force: true });
  return output;
}

/**
 * Re-derives the constellation of solved images from their stored centre with the exact IAU
 * boundaries; earlier releases used rough rectangles and mislabelled some fields.
 */
export async function refreshImageConstellations(): Promise<number> {
  let corrected = 0;
  for (const image of await storage.getAstroImages()) {
    const ra = Number(image.ra);
    const dec = Number(image.dec);
    if (!image.plateSolved || !image.ra || !image.dec || !Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    const constellation = getConstellationFromCoordinates(ra, dec);
    if (constellation && constellation !== image.constellation) {
      await storage.updateAstroImage(image.id, { constellation } as Parameters<typeof storage.updateAstroImage>[1]);
      corrected++;
    }
  }
  return corrected;
}
