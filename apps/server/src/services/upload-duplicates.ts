import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storage } from './storage';
import { fitsCacheDirectory, resolveFitsFile } from './fits';
import { uploadNameKey } from '@shared/upload-names';

/**
 * Duplicate detection for uploads, by content (byte size + SHA-256), never by file name: a different
 * FITS that happens to share a name is uploaded normally, and existing files are never changed.
 * Photos already store their SHA-256; FITS are hashed on demand (the bytes as uploaded, i.e. the
 * ".orig" kept next to a normalized FITS) and the hashes cached in the FITS cache folder.
 */

interface CachedHash { size: number; mtimeMs: number; sha256: string }
interface KnownFile { file: string; size: number; mtimeMs: number; name: string }

let cache: Map<string, CachedHash> | null = null;
const cacheFile = () => path.join(fitsCacheDirectory(), 'upload-hashes.json');

async function loadCache(): Promise<Map<string, CachedHash>> {
  if (cache) return cache;
  try {
    cache = new Map(Object.entries(JSON.parse(await readFile(cacheFile(), 'utf8')) as Record<string, CachedHash>));
  } catch {
    cache = new Map();
  }
  return cache;
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(path.dirname(cacheFile()), { recursive: true });
    const temporary = `${cacheFile()}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(cache)));
    await rename(temporary, cacheFile());
  } catch {
    // A cache only: hashes are recomputed next time.
  }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The FITS files in the library as they were received (".orig" when the stored copy was normalized). */
async function knownFits(): Promise<KnownFile[]> {
  const files: KnownFile[] = [];
  for (const image of await storage.getAstroImages()) {
    const stored = resolveFitsFile(image.originalPath || null);
    if (!stored) continue;
    const file = existsSync(`${stored}.orig`) ? `${stored}.orig` : stored;
    try {
      const info = await stat(file);
      files.push({ file, size: info.size, mtimeMs: info.mtimeMs, name: image.filename || path.basename(stored) });
    } catch {
      // Missing file: nothing to compare against.
    }
  }
  return files;
}

async function fitsHash(known: KnownFile, hashes: Map<string, CachedHash>): Promise<string | null> {
  const cached = hashes.get(known.file);
  if (cached && cached.size === known.size && cached.mtimeMs === known.mtimeMs) return cached.sha256;
  try {
    const sha256 = await hashFile(known.file);
    hashes.set(known.file, { size: known.size, mtimeMs: known.mtimeMs, sha256 });
    return sha256;
  } catch {
    return null;
  }
}

/**
 * What is stored, for the client's pre-check: every byte size (only files of one of these sizes need
 * hashing) and every (name key, size) pair (a file with the same name and size is the same upload).
 */
export async function knownUploads(): Promise<{ sizes: number[]; named: string[] }> {
  const sizes = new Set<number>();
  const named = new Set<string>();
  for (const asset of await storage.getLibraryAssets()) {
    sizes.add(asset.byteSize);
    named.add(`${uploadNameKey(asset.filename)}:${asset.byteSize}`);
  }
  for (const fits of await knownFits()) {
    sizes.add(fits.size);
    named.add(`${uploadNameKey(fits.name)}:${fits.size}`);
  }
  return { sizes: [...sizes], named: [...named] };
}

/** The SHA-256 values (of the given files) whose exact content is already in the library. */
export async function existingUploads(files: Array<{ size: number; sha256: string }>): Promise<Set<string>> {
  const found = new Set<string>();
  if (!files.length) return found;
  const wanted = new Map<number, Set<string>>();
  for (const { size, sha256 } of files) {
    if (!wanted.has(size)) wanted.set(size, new Set());
    wanted.get(size)!.add(sha256.toLowerCase());
  }
  for (const asset of await storage.getLibraryAssets()) {
    if (wanted.get(asset.byteSize)?.has(asset.sha256)) found.add(asset.sha256);
  }
  const hashes = await loadCache();
  let changed = false;
  for (const fits of await knownFits()) {
    const candidates = wanted.get(fits.size);
    if (!candidates) continue;
    const before = hashes.get(fits.file);
    const sha256 = await fitsHash(fits, hashes);
    if (hashes.get(fits.file) !== before) changed = true;
    if (sha256 && candidates.has(sha256)) found.add(sha256);
  }
  if (changed) await saveCache();
  return found;
}

/** Records the hash of a FITS just stored, so the next duplicate check does not read it again. */
export async function rememberFitsUpload(storedPath: string, sha256: string): Promise<void> {
  const file = existsSync(`${storedPath}.orig`) ? `${storedPath}.orig` : storedPath;
  try {
    const info = await stat(file);
    (await loadCache()).set(file, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    await saveCache();
  } catch {
    // Cache only.
  }
}

/**
 * Hashes every stored FITS once in the background (after start-up), so the first duplicate check of a
 * large folder does not have to read the whole library from disk while the user waits.
 */
export async function warmUploadHashes(): Promise<number> {
  const hashes = await loadCache();
  let computed = 0;
  for (const fits of await knownFits()) {
    const cached = hashes.get(fits.file);
    if (cached && cached.size === fits.size && cached.mtimeMs === fits.mtimeMs) continue;
    if (await fitsHash(fits, hashes)) computed++;
    if (computed % 50 === 0) await saveCache();
  }
  if (computed) await saveCache();
  return computed;
}
