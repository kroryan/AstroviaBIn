import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { or, eq } from 'drizzle-orm';
import { db, schema } from '../db';
import { normalizeObjectName } from '@shared/catalog-utils';
import { storage } from './storage';
import { resolveLibraryAssetPath } from './library';
import { readFitsMetadata, readFitsHeader, resolveFitsFile } from './fits';
import { computeSkyAnnotations } from './sky-annotations';
import { computeSkyOverlay, overlayToAnnotations } from './sky-overlay';
import { parseWcsHeaders, pixelScaleArcsec, pixelToSky, type WcsSolution } from './wcs';
import type { AstrometryCalibration, PlateSolvingResult } from './astrometry';

interface LocalImage {
  id: number;
  originalPath?: string | null;
  filename?: string | null;
  title?: string | null;
  updatedAt?: Date | string | null;
  tags?: string[] | null;
  ra?: string | number | null;
  dec?: string | number | null;
  pixelScale?: number | null;
  targetName?: string | null;
}

/** Optional position (and scale) supplied by the user to speed up or rescue a solve. */
export interface SolveHint {
  ra: number;
  dec: number;
  radiusDeg?: number;
  scaleLowArcsec?: number;
  scaleHighArcsec?: number;
}

interface HintAttempt extends SolveHint {
  label: string;
}

interface SolveSource {
  path: string;
  width: number;
  height: number;
  kind: 'fits' | 'image';
  headers?: Record<string, string | number | boolean>;
}

function appendOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString('utf8')}`.slice(-6000);
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    let errorOutput = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // Fall back to killing the direct child if the process group is already gone.
        }
      }
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { output = appendOutput(output, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { errorOutput = appendOutput(errorOutput, chunk); });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve(output);
      else if (timedOut) reject(new Error(`Local astrometry solver timed out after ${timeoutMs}ms: ${(errorOutput || output).trim() || 'no details'}`));
      else reject(new Error(`Local astrometry solver exited with code ${code}: ${(errorOutput || output).trim() || 'no details'}`));
    });
  });
}

function validPosition(ra: number, dec: number): boolean {
  return Number.isFinite(ra) && ra >= 0 && ra < 360 && Number.isFinite(dec) && dec >= -90 && dec <= 90;
}

/** Parses decimal degrees or sexagesimal ("12 05 15.1", "12:05:15", "12h05m15s"); RA sexagesimal is in hours. */
export function parseCoordinate(value: unknown, kind: 'ra' | 'dec'): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return Number(text);
  const sign = text.startsWith('-') ? -1 : 1;
  const parts = text.replace(/^[+-]/, '').split(/[\s:hdms°'"]+/i).filter(Boolean).map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part))) return undefined;
  const magnitude = parts[0] + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
  return kind === 'ra' ? magnitude * 15 : sign * magnitude;
}

function headerNumber(headers: Record<string, string | number | boolean> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = headers?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function fitsHeaderHint(headers: Record<string, string | number | boolean> | undefined): HintAttempt | null {
  if (!headers) return null;
  // Numeric RA values are degrees; sexagesimal strings (RA/OBJCTRA) are hours.
  const ra = parseCoordinate(headers.RA ?? headers.OBJCTRA ?? headers.CRVAL1, 'ra');
  const dec = parseCoordinate(headers.DEC ?? headers.OBJCTDEC ?? headers.CRVAL2, 'dec');
  if (ra === undefined || dec === undefined || !validPosition(ra, dec)) return null;
  let scale = headerNumber(headers, 'PIXSCALE', 'SECPIX', 'SCALE');
  const focal = headerNumber(headers, 'FOCALLEN');
  const pixel = headerNumber(headers, 'XPIXSZ', 'PIXSIZE1');
  const binning = headerNumber(headers, 'XBINNING') ?? 1;
  if (!scale && focal && pixel) scale = 206.265 * pixel * binning / focal;
  // An existing WCS (observatory pipelines, earlier solves, stacks registered to a solved frame)
  // pins both scale and position, so search tightly around it.
  const cd11 = headerNumber(headers, 'CD1_1');
  const cd12 = headerNumber(headers, 'CD1_2') ?? 0;
  const cd21 = headerNumber(headers, 'CD2_1') ?? 0;
  const cd22 = headerNumber(headers, 'CD2_2');
  const fromWcs = headers.CRVAL1 !== undefined && cd11 !== undefined && cd22 !== undefined;
  if (fromWcs) scale = Math.sqrt(Math.abs(cd11! * cd22! - cd12 * cd21)) * 3600 || scale;
  return {
    label: fromWcs ? 'FITS header WCS' : 'FITS header pointing',
    ra, dec, radiusDeg: fromWcs ? 1 : 3,
    ...(scale ? { scaleLowArcsec: scale * (fromWcs ? 0.9 : 0.8), scaleHighArcsec: scale * (fromWcs ? 1.1 : 1.25) } : {}),
  };
}

/** Finds M/NGC/IC designations in the title, filename, target and tags and resolves them in OpenNGC. */
async function catalogHint(image: LocalImage): Promise<HintAttempt | null> {
  const labels = [image.targetName, image.title, image.filename, ...(image.tags || [])].filter(Boolean) as string[];
  const designations = new Set<string>();
  for (const label of labels) {
    for (const match of label.matchAll(/\b(NGC|IC|M)\s*0*(\d+)([A-Z]?)\b/gi)) {
      designations.add(normalizeObjectName(`${match[1]} ${match[2]}${match[3]}`).toUpperCase());
    }
  }
  for (const designation of designations) {
    const messier = designation.replace(/^M\s*/, 'M ');
    const rows = await db.select().from(schema.catalogObjects)
      .where(or(eq(schema.catalogObjects.name, designation), eq(schema.catalogObjects.messier, messier)))
      .execute();
    const row = (rows as Array<{ raDeg: number | null; decDeg: number | null }>).find(item => item.raDeg !== null && item.decDeg !== null);
    if (row) return { label: `catalog target ${designation}`, ra: row.raDeg!, dec: row.decDeg!, radiusDeg: 3 };
  }
  return null;
}

async function hintAttempts(image: LocalImage, source: SolveSource, userHint?: SolveHint): Promise<HintAttempt[]> {
  const attempts: HintAttempt[] = [];
  if (userHint && validPosition(userHint.ra, userHint.dec)) {
    attempts.push({ label: 'user hint', radiusDeg: 3, ...userHint });
  }
  const ra = Number(image.ra);
  const dec = Number(image.dec);
  if (image.ra && image.dec && validPosition(ra, dec)) {
    // A previous solution's scale may come from a resized upload, so only trust the position.
    attempts.push({ label: 'previous solution', ra, dec, radiusDeg: 2 });
  }
  const header = fitsHeaderHint(source.headers);
  if (header) attempts.push(header);
  const catalog = await catalogHint(image).catch(() => null);
  if (catalog) attempts.push(catalog);
  const unique: HintAttempt[] = [];
  for (const attempt of attempts) {
    if (!unique.some(item => Math.abs(item.ra - attempt.ra) < 0.05 && Math.abs(item.dec - attempt.dec) < 0.05)) unique.push(attempt);
  }
  return unique.slice(0, 3);
}

function indexDirectories(): string[] {
  const extra = (process.env.ASTROMETRY_EXTRA_INDEX_DIRS ?? '/app/config/astrometry-index').split(':').filter(Boolean);
  return [path.resolve(process.env.ASTROMETRY_INDEX_DIR || '/usr/share/astrometry'), ...extra.map(dir => path.resolve(dir))];
}

async function availableIndexDirectories(): Promise<{ directories: string[]; indexCount: number }> {
  const directories: string[] = [];
  let indexCount = 0;
  for (const directory of indexDirectories()) {
    try {
      const count = (await readdir(directory)).filter(name => /^index-.*\.fits$/i.test(name)).length;
      if (count > 0) {
        directories.push(directory);
        indexCount += count;
      }
    } catch { /* optional directory */ }
  }
  return { directories, indexCount };
}

export async function localAstrometryStatus(): Promise<{ available: boolean; solver: string; indexCount: number }> {
  const solver = process.env.ASTROMETRY_SOLVE_FIELD || 'solve-field';
  let solverAvailable = false;
  try {
    await run(solver, ['--help'], 10_000);
    solverAvailable = true;
  } catch {
    solverAvailable = false;
  }
  const { indexCount } = await availableIndexDirectories();
  return { available: solverAvailable && indexCount > 0, solver, indexCount };
}

async function sourceFor(image: LocalImage): Promise<SolveSource> {
  const fitsPath = resolveFitsFile(image.originalPath || null);
  if (fitsPath) {
    const metadata = await readFitsMetadata(fitsPath);
    return { path: fitsPath, width: metadata.width, height: metadata.height, kind: 'fits', headers: metadata.headers };
  }
  const asset = await storage.getLibraryAssetForAstroImage(image.id);
  if (!asset) throw new Error('This image has no private local original in the AstroviaBin library');
  const imagePath = resolveLibraryAssetPath(asset);
  const metadata = await sharp(imagePath, { limitInputPixels: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions for plate solving');
  // Pixel coordinates are in the stored orientation (EXIF rotation is not applied), which is how the
  // tiled viewer renders the original as well.
  return { path: imagePath, width: metadata.width, height: metadata.height, kind: 'image' };
}

/**
 * Runs the noise-robust star extractor and returns an astrometry.net xylist, or null when the
 * Python stack is unavailable or finds too few stars (solve-field then extracts on its own).
 */
async function extractStars(source: SolveSource, workDirectory: string): Promise<string | null> {
  const python = process.env.ASTROVIABIN_ANALYSIS_PYTHON || '/opt/astroviabin-python/bin/python';
  const script = process.env.STAR_EXTRACT_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/star_extract.py');
  const output = path.join(workDirectory, 'stars.xyls');
  try {
    await access(script);
    let summary: string;
    if (source.kind === 'fits') {
      summary = await run(python, [script, 'fits', source.path, output, '300'], 180_000);
    } else {
      const rawPath = path.join(workDirectory, 'luminance.u16');
      const { data, info } = await sharp(source.path, { limitInputPixels: false })
        .greyscale().toColourspace('grey16').raw({ depth: 'ushort' })
        .toBuffer({ resolveWithObject: true });
      if (info.width !== source.width || info.height !== source.height) throw new Error('Unexpected decoded size');
      await writeFile(rawPath, data);
      summary = await run(python, [script, 'raw', rawPath, String(info.width), String(info.height), output, '300'], 180_000);
      await rm(rawPath, { force: true });
    }
    const sources = Number(JSON.parse(summary.trim().split('\n').pop() || '{}').sources);
    return sources >= 8 ? output : null;
  } catch (error) {
    console.warn('Star extraction unavailable, falling back to solve-field source extraction:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function solveFieldAttempt(
  source: SolveSource,
  input: { xylist: string | null },
  workDirectory: string,
  backendConfig: string,
  options: { cpuLimitSeconds: number; timeoutMs: number; hint?: HintAttempt },
): Promise<string> {
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const wcsPath = path.join(workDirectory, 'solution.wcs');
  const args = [
    '--overwrite', '--no-plots',
    '--backend-config', backendConfig,
    '--dir', workDirectory,
    '--wcs', wcsPath,
    '--new-fits', 'none', '--rdls', 'none', '--corr', 'none', '--index-xyls', 'none', '--match', 'none',
  ];
  if (input.xylist) {
    args.push('--width', String(source.width), '--height', String(source.height),
      '--x-column', 'X', '--y-column', 'Y', '--sort-column', 'FLUX');
  } else {
    args.push('--downsample', String(Math.max(source.width, source.height) > 4000 ? 4 : 2));
  }
  const hint = options.hint;
  if (hint) args.push('--ra', String(hint.ra), '--dec', String(hint.dec), '--radius', String(hint.radiusDeg ?? 3));
  if (hint?.scaleLowArcsec && hint.scaleHighArcsec) {
    args.push('--scale-units', 'arcsecperpix', '--scale-low', String(hint.scaleLowArcsec), '--scale-high', String(hint.scaleHighArcsec));
  } else {
    args.push(
      '--scale-units', 'arcminwidth',
      '--scale-low', process.env.ASTROMETRY_SCALE_LOW_ARCMIN || '5',
      '--scale-high', process.env.ASTROMETRY_SCALE_HIGH_ARCMIN || '2000',
    );
  }
  args.push('--cpulimit', String(options.cpuLimitSeconds), input.xylist || source.path);
  await run(process.env.ASTROMETRY_SOLVE_FIELD || 'solve-field', args, options.timeoutMs);
  await access(wcsPath);
  return wcsPath;
}

export interface LocalSolveResult extends PlateSolvingResult {
  wcs: WcsSolution;
}

export function calibrationFromWcs(wcs: WcsSolution): AstrometryCalibration {
  const center = pixelToSky(wcs, (wcs.imageWidth + 1) / 2, (wcs.imageHeight + 1) / 2);
  const scaleX = Math.hypot(wcs.cd11, wcs.cd21) * 3600;
  const scaleY = Math.hypot(wcs.cd12, wcs.cd22) * 3600;
  const widthArcsec = wcs.imageWidth * scaleX;
  const heightArcsec = wcs.imageHeight * scaleY;
  const determinant = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  return {
    ra: center.ra,
    dec: center.dec,
    pixscale: pixelScaleArcsec(wcs),
    radius: Math.hypot(widthArcsec, heightArcsec) / 7200,
    orientation: (Math.atan2(-wcs.cd12, wcs.cd22) * 180 / Math.PI + 360) % 360,
    width_arcsec: widthArcsec,
    height_arcsec: heightArcsec,
    parity: determinant < 0 ? -1 : 1,
  };
}

export async function solveImageLocally(image: LocalImage, options: { hint?: SolveHint } = {}): Promise<LocalSolveResult> {
  const status = await localAstrometryStatus();
  if (!status.available) {
    throw new Error(`Local Astrometry.net is not ready (solver: ${status.solver}, index files: ${status.indexCount})`);
  }
  const source = await sourceFor(image);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'astroviabin-solve-'));
  const backendConfig = path.join(workDirectory, 'backend.cfg');
  const totalBudgetMs = Number(process.env.ASTROMETRY_TIMEOUT_MS || 900_000);
  const startedAt = Date.now();
  const { directories } = await availableIndexDirectories();
  await writeFile(backendConfig, `${directories.map(directory => `add_path ${directory}`).join('\n')}\nautoindex\n`, { mode: 0o600 });
  try {
    const xylist = await extractStars(source, workDirectory);
    const hints = await hintAttempts(image, source, options.hint);
    const attempts: Array<{ label: string; xylist: string | null; hint?: HintAttempt; budgetMs: number }> = [];
    const hintBudget = Number(process.env.ASTROMETRY_HINT_TIMEOUT_MS || 120_000);
    for (const hint of hints) {
      attempts.push({ label: `${hint.label} (${xylist ? 'robust star list' : 'solve-field extraction'})`, xylist, hint, budgetMs: hintBudget });
    }
    attempts.push({ label: `blind (${xylist ? 'robust star list' : 'solve-field extraction'})`, xylist, budgetMs: Infinity });
    if (xylist) attempts.push({ label: 'blind (solve-field extraction)', xylist: null, budgetMs: Infinity });

    const failures: string[] = [];
    let wcsPath: string | undefined;
    for (const [index, attempt] of attempts.entries()) {
      const remaining = totalBudgetMs - (Date.now() - startedAt);
      if (remaining < 20_000) break;
      // The last two blind attempts share what is left; hinted ones are capped.
      const blindShare = attempt.hint ? attempt.budgetMs : index === attempts.length - 1 ? remaining : remaining * 0.6;
      const timeoutMs = Math.max(20_000, Math.min(remaining, blindShare));
      try {
        wcsPath = await solveFieldAttempt(source, attempt, path.join(workDirectory, `attempt-${index}`), backendConfig, {
          cpuLimitSeconds: Math.max(10, Math.floor(timeoutMs / 1000) - 10),
          timeoutMs,
          hint: attempt.hint,
        });
        console.log(`Local solve for image ${image.id} succeeded with ${attempt.label}`);
        break;
      } catch (error) {
        failures.push(`${attempt.label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      }
    }
    if (!wcsPath) {
      throw new Error(`Local Astrometry.net could not solve this image. Attempts: ${failures.join(' | ') || 'none (time budget exhausted)'}. ` +
        'Very sparse or noisy frames solve best with a coordinate hint (RA/Dec of the target).');
    }

    const wcs = parseWcsHeaders(await readFitsHeader(wcsPath), source.width, source.height);
    const calibration = calibrationFromWcs(wcs);
    const overlay = computeSkyOverlay(wcs);
    const annotations = overlay ? overlayToAnnotations(overlay) : await computeSkyAnnotations(wcs);
    return { calibration, annotations, machineTags: [], wcs };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
