import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const TILE_SIZE = 256;
const deepZoomJobs = new Map<string, Promise<DeepZoomInfo>>();
const levelImageJobs = new Map<string, Promise<string>>();
const tileImageJobs = new Map<string, Promise<string>>();

export interface TileInfo {
  width: number;
  height: number;
  tileSize: number;
  maxLevel: number;
}

export interface DeepZoomInfo extends TileInfo {
  descriptorPath: string;
  tilesDirectory: string;
  format: string;
}

export function computeMaxLevel(width: number, height: number): number {
  return Math.max(0, Math.ceil(Math.log2(Math.max(width, height))));
}

export function tileInfo(width: number, height: number): TileInfo {
  return { width, height, tileSize: TILE_SIZE, maxLevel: computeMaxLevel(width, height) };
}

export function tileCacheDirectory(): string {
  return path.resolve(process.env.TILE_CACHE_DIR || path.join(process.cwd(), 'data', 'deep-zoom-cache'));
}

function safeCacheKey(cacheKey: string): string {
  const safe = cacheKey.replace(/[^a-z0-9_-]/gi, '_');
  if (!safe) throw new Error('Invalid deep-zoom cache key');
  return safe;
}

async function readDescriptor(descriptorPath: string): Promise<DeepZoomInfo> {
  const xml = await readFile(descriptorPath, 'utf8');
  const value = (name: string) => {
    const match = xml.match(new RegExp(`\\b${name}="([^"]+)"`));
    if (!match) throw new Error(`Invalid Deep Zoom descriptor: missing ${name}`);
    return match[1];
  };
  const width = Number(value('Width'));
  const height = Number(value('Height'));
  const tileSize = Number(value('TileSize'));
  const format = value('Format');
  if (![width, height, tileSize].every(Number.isSafeInteger) || width < 1 || height < 1 || tileSize < 1) {
    throw new Error('Invalid Deep Zoom descriptor dimensions');
  }
  return {
    width,
    height,
    tileSize,
    maxLevel: computeMaxLevel(width, height),
    format,
    descriptorPath,
    tilesDirectory: descriptorPath.replace(/\.dzi$/, '_files'),
  };
}

/** Build and persist a Deep Zoom pyramid once, then serve only the tiles the viewer requests. */
export async function ensureDeepZoom(source: string | Buffer, cacheKey: string): Promise<DeepZoomInfo> {
  const safeKey = safeCacheKey(cacheKey);
  const cacheDir = tileCacheDirectory();
  const descriptorPath = path.join(cacheDir, `${safeKey}.dzi`);
  try {
    return await readDescriptor(descriptorPath);
  } catch {
    // A missing or interrupted cache entry is regenerated below.
  }

  const pending = deepZoomJobs.get(safeKey);
  if (pending) return pending;

  const work = (async () => {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const temporaryDescriptor = path.join(cacheDir, `${safeKey}.building-${randomUUID()}.dzi`);
    const temporaryTiles = temporaryDescriptor.replace(/\.dzi$/, '_files');
    try {
      const output = await sharp(source, { limitInputPixels: false })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
        .tile({ layout: 'dz', size: TILE_SIZE, overlap: 0, depth: 'onepixel' })
        .toFile(temporaryDescriptor);
      const finalTiles = descriptorPath.replace(/\.dzi$/, '_files');
      await rm(finalTiles, { recursive: true, force: true });
      await rename(temporaryTiles, finalTiles);
      await rename(temporaryDescriptor, descriptorPath);
      return {
        width: output.width,
        height: output.height,
        tileSize: TILE_SIZE,
        maxLevel: computeMaxLevel(output.width, output.height),
        format: 'jpg',
        descriptorPath,
        tilesDirectory: descriptorPath.replace(/\.dzi$/, '_files'),
      };
    } catch (error) {
      await rm(temporaryDescriptor, { force: true }).catch(() => {});
      await rm(temporaryTiles, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })();

  deepZoomJobs.set(safeKey, work);
  try {
    return await work;
  } finally {
    deepZoomJobs.delete(safeKey);
  }
}

export async function readDeepZoomTile(info: DeepZoomInfo, level: number, x: number, y: number): Promise<Buffer> {
  if (!Number.isInteger(level) || level < 0 || level > info.maxLevel) throw new Error('Invalid tile level');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw new Error('Invalid tile coordinates');
  const scale = 2 ** (info.maxLevel - level);
  const levelWidth = Math.max(1, Math.ceil(info.width / scale));
  const levelHeight = Math.max(1, Math.ceil(info.height / scale));
  if (x * info.tileSize >= levelWidth || y * info.tileSize >= levelHeight) throw new Error('Tile out of bounds');
  const tilePath = path.join(info.tilesDirectory, String(level), `${x}_${y}.${info.format}`);
  return readFile(tilePath);
}

/**
 * Resizes `source` down to one pyramid level and caches the result, so repeated tile
 * requests at that level only ever crop a small, already-resized file instead of each
 * re-decoding and resizing the (potentially huge) original.
 */
async function cachedLevelImage(source: string | Buffer, cacheDir: string, cacheKey: string, nativeWidth: number, nativeHeight: number, levelWidth: number, levelHeight: number): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  const leveledPath = path.join(cacheDir, `${cacheKey}-${levelWidth}x${levelHeight}.jpg`);
  try {
    const file = await stat(leveledPath);
    if (file.size > 0) {
      const metadata = await sharp(leveledPath).metadata();
      if (metadata.width === levelWidth && metadata.height === levelHeight) return leveledPath;
    }
    await rm(leveledPath, { force: true });
  } catch { /* not cached or a partial cache entry; build it below */ }

  const pending = levelImageJobs.get(leveledPath);
  if (pending) return pending;

  const work = (async () => {
    const temporaryPath = `${leveledPath}.${randomUUID()}.tmp`;
    try {
      const pipeline = sharp(source, { limitInputPixels: false });
      if (levelWidth !== nativeWidth || levelHeight !== nativeHeight) pipeline.resize(levelWidth, levelHeight, { fit: 'fill' });
      await pipeline.jpeg({ quality: 90 }).toFile(temporaryPath);
      await rename(temporaryPath, leveledPath);
      return leveledPath;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  })();
  levelImageJobs.set(leveledPath, work);
  try {
    return await work;
  } finally {
    levelImageJobs.delete(leveledPath);
  }
}

/**
 * Renders one DZI-style tile: a 256x256 (edge tiles may be smaller) JPEG crop of `source`
 * at the requested pyramid level, where level 0 is a single tile covering the whole image
 * and `maxLevel` is native resolution. No tile overlap, to keep the level math simple.
 */
export async function renderTile(source: string | Buffer, cacheDir: string, cacheKey: string, nativeWidth: number, nativeHeight: number, level: number, x: number, y: number): Promise<Buffer> {
  const maxLevel = computeMaxLevel(nativeWidth, nativeHeight);
  if (!Number.isInteger(level) || level < 0 || level > maxLevel) throw new Error('Invalid tile level');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw new Error('Invalid tile coordinates');
  const scale = 2 ** (maxLevel - level);
  const levelWidth = Math.max(1, Math.ceil(nativeWidth / scale));
  const levelHeight = Math.max(1, Math.ceil(nativeHeight / scale));
  const left = x * TILE_SIZE;
  const top = y * TILE_SIZE;
  if (left >= levelWidth || top >= levelHeight) throw new Error('Tile out of bounds');
  const tileWidth = Math.min(TILE_SIZE, levelWidth - left);
  const tileHeight = Math.min(TILE_SIZE, levelHeight - top);
  const tilePath = path.join(cacheDir, safeCacheKey(cacheKey), String(level), `${x}_${y}.jpg`);
  try {
    const cached = await stat(tilePath);
    if (cached.size > 0) return readFile(tilePath);
  } catch { /* Render this tile on first request. */ }

  const pending = tileImageJobs.get(tilePath);
  if (pending) return readFile(await pending);
  const work = (async () => {
    await mkdir(path.dirname(tilePath), { recursive: true });
    const temporaryPath = `${tilePath}.${randomUUID()}.tmp`;
    try {
      if (level === maxLevel) {
        // At native resolution crop only this tile; never build/write a second full-size
        // copy of a very large original just to serve a 256 px viewport region.
        await sharp(source, { limitInputPixels: false })
          .extract({ left, top, width: tileWidth, height: tileHeight })
          .jpeg({ quality: 88 }).toFile(temporaryPath);
      } else {
        const leveledPath = await cachedLevelImage(source, cacheDir, safeCacheKey(cacheKey), nativeWidth, nativeHeight, levelWidth, levelHeight);
        await sharp(leveledPath).extract({ left, top, width: tileWidth, height: tileHeight })
          .jpeg({ quality: 85 }).toFile(temporaryPath);
      }
      await rename(temporaryPath, tilePath);
      return tilePath;
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  })();
  tileImageJobs.set(tilePath, work);
  try {
    return await readFile(await work);
  } finally {
    tileImageJobs.delete(tilePath);
  }
}
