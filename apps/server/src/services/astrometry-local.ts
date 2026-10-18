import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { catalogService } from './catalog';
import { storage } from './storage';
import { resolveLibraryAssetPath } from './library';
import { readFitsMetadata, readFitsHeader, resolveFitsFile } from './fits';
import type { AstrometryAnnotation, AstrometryCalibration, PlateSolvingResult } from './astrometry';

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
}

interface WcsTransform {
  ra: number;
  dec: number;
  crpix1: number;
  crpix2: number;
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
}

function numberHeader(headers: Record<string, string | number | boolean>, key: string): number | undefined {
  const value = headers[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function radians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function degrees(radiansValue: number): number {
  return radiansValue * 180 / Math.PI;
}

function getWcsTransform(headers: Record<string, string | number | boolean>): WcsTransform {
  const ra = numberHeader(headers, 'CRVAL1');
  const dec = numberHeader(headers, 'CRVAL2');
  const crpix1 = numberHeader(headers, 'CRPIX1');
  const crpix2 = numberHeader(headers, 'CRPIX2');
  const cdelt1 = numberHeader(headers, 'CDELT1');
  const cdelt2 = numberHeader(headers, 'CDELT2');
  const cd11 = numberHeader(headers, 'CD1_1') ?? (cdelt1 === undefined ? undefined : cdelt1 * (numberHeader(headers, 'PC1_1') ?? 1));
  const cd12 = numberHeader(headers, 'CD1_2') ?? (cdelt1 === undefined ? undefined : cdelt1 * (numberHeader(headers, 'PC1_2') ?? 0));
  const cd21 = numberHeader(headers, 'CD2_1') ?? (cdelt2 === undefined ? undefined : cdelt2 * (numberHeader(headers, 'PC2_1') ?? 0));
  const cd22 = numberHeader(headers, 'CD2_2') ?? (cdelt2 === undefined ? undefined : cdelt2 * (numberHeader(headers, 'PC2_2') ?? 1));
  if ([ra, dec, crpix1, crpix2, cd11, cd12, cd21, cd22].some(value => value === undefined)) {
    throw new Error('Local solver returned an incomplete WCS calibration');
  }
  if (Math.abs((cd11! * cd22!) - (cd12! * cd21!)) < Number.EPSILON) {
    throw new Error('Local solver returned a singular WCS calibration');
  }
  return { ra: ra!, dec: dec!, crpix1: crpix1!, crpix2: crpix2!, cd11: cd11!, cd12: cd12!, cd21: cd21!, cd22: cd22! };
}

function pixelToSky(wcs: WcsTransform, x: number, y: number): { ra: number; dec: number } {
  const dx = x + 1 - wcs.crpix1;
  const dy = y + 1 - wcs.crpix2;
  const xi = radians(wcs.cd11 * dx + wcs.cd12 * dy);
  const eta = radians(wcs.cd21 * dx + wcs.cd22 * dy);
  const ra0 = radians(wcs.ra);
  const dec0 = radians(wcs.dec);
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = (degrees(ra0 + Math.atan2(xi, denominator)) + 360) % 360;
  const dec = degrees(Math.atan2(
    Math.sin(dec0) + eta * Math.cos(dec0),
    Math.sqrt(denominator * denominator + xi * xi),
  ));
  return { ra, dec };
}

function skyToPixel(wcs: WcsTransform, ra: number, dec: number): { x: number; y: number } | null {
  const ra0 = radians(wcs.ra);
  const dec0 = radians(wcs.dec);
  const targetRa = radians(ra);
  const targetDec = radians(dec);
  const deltaRa = Math.atan2(Math.sin(targetRa - ra0), Math.cos(targetRa - ra0));
  const cosineDistance = Math.sin(dec0) * Math.sin(targetDec) + Math.cos(dec0) * Math.cos(targetDec) * Math.cos(deltaRa);
  if (cosineDistance <= 0) return null;
  const xi = Math.cos(targetDec) * Math.sin(deltaRa) / cosineDistance;
  const eta = (Math.cos(dec0) * Math.sin(targetDec) - Math.sin(dec0) * Math.cos(targetDec) * Math.cos(deltaRa)) / cosineDistance;
  const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  const xiDegrees = degrees(xi);
  const etaDegrees = degrees(eta);
  const dx = (wcs.cd22 * xiDegrees - wcs.cd12 * etaDegrees) / det;
  const dy = (-wcs.cd21 * xiDegrees + wcs.cd11 * etaDegrees) / det;
  return { x: dx + wcs.crpix1 - 1, y: dy + wcs.crpix2 - 1 };
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

function coordinateHint(image: LocalImage): { ra: number; dec: number; pixelScale: number } | null {
  const ra = Number(image.ra);
  const dec = Number(image.dec);
  const pixelScale = Number(image.pixelScale);
  if (!Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90 || !Number.isFinite(pixelScale) || pixelScale <= 0) {
    return null;
  }
  return { ra, dec, pixelScale };
}

async function solveFieldAttempt(
  sourcePath: string,
  workDirectory: string,
  backendConfig: string,
  options: { cpuLimitSeconds: number; timeoutMs: number; hint?: { ra: number; dec: number; pixelScale: number } },
): Promise<string> {
  await mkdir(workDirectory, { recursive: true, mode: 0o700 });
  const wcsPath = path.join(workDirectory, 'solution.wcs');
  const args = [
    '--overwrite', '--no-plots', '--downsample', '2',
    '--backend-config', backendConfig,
    '--dir', workDirectory,
    '--wcs', wcsPath,
  ];
  if (options.hint) {
    const low = Math.max(0.01, options.hint.pixelScale * 0.7);
    const high = options.hint.pixelScale * 1.3;
    args.push(
      '--ra', String(options.hint.ra),
      '--dec', String(options.hint.dec),
      '--radius', '5',
      '--scale-units', 'arcsecperpix',
      '--scale-low', String(low),
      '--scale-high', String(high),
    );
  } else {
    args.push(
      '--scale-units', 'arcminwidth',
      '--scale-low', process.env.ASTROMETRY_SCALE_LOW_ARCMIN || '15',
      '--scale-high', process.env.ASTROMETRY_SCALE_HIGH_ARCMIN || '2000',
    );
  }
  args.push('--cpulimit', String(options.cpuLimitSeconds), sourcePath);
  await run(process.env.ASTROMETRY_SOLVE_FIELD || 'solve-field', args, options.timeoutMs);
  await access(wcsPath);
  return wcsPath;
}

function indexDirectory(): string {
  return path.resolve(process.env.ASTROMETRY_INDEX_DIR || '/usr/share/astrometry');
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
  let indexCount = 0;
  try {
    const names = await readdir(indexDirectory());
    indexCount = names.filter(name => /^index-\d+.*\.fits$/i.test(name)).length;
  } catch {
    indexCount = 0;
  }
  return { available: solverAvailable && indexCount > 0, solver, indexCount };
}

async function sourceFor(image: LocalImage): Promise<{ path: string; width: number; height: number }> {
  const fitsPath = resolveFitsFile(image.originalPath || null);
  if (fitsPath) {
    const metadata = await readFitsMetadata(fitsPath);
    return { path: fitsPath, width: metadata.width, height: metadata.height };
  }
  const asset = await storage.getLibraryAssetForAstroImage(image.id);
  if (!asset) throw new Error('This image has no private local original in the Sidereal library');
  const imagePath = resolveLibraryAssetPath(asset);
  const metadata = await sharp(imagePath, { limitInputPixels: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions for plate solving');
  return { path: imagePath, width: metadata.width, height: metadata.height };
}

export async function solveImageLocally(image: LocalImage): Promise<PlateSolvingResult> {
  const status = await localAstrometryStatus();
  if (!status.available) {
    throw new Error(`Local Astrometry.net is not ready (solver: ${status.solver}, index files: ${status.indexCount})`);
  }
  const source = await sourceFor(image);
  const workDirectory = await mkdtemp(path.join(os.tmpdir(), 'sidereal-solve-'));
  const backendConfig = path.join(workDirectory, 'backend.cfg');
  const timeoutMs = Number(process.env.ASTROMETRY_TIMEOUT_MS || 300_000);
  const cpuLimitSeconds = Number(process.env.ASTROMETRY_CPU_LIMIT_SECONDS || 240);
  await writeFile(backendConfig, `add_path ${indexDirectory()}\nautoindex\n`, { mode: 0o600 });
  try {
    let wcsPath: string | undefined;
    const hint = coordinateHint(image);
    if (hint) {
      try {
        const hintTimeoutMs = Math.min(timeoutMs, Number(process.env.ASTROMETRY_HINT_TIMEOUT_MS || 90_000));
        const hintCpuLimitSeconds = Math.max(1, Math.floor(hintTimeoutMs / 1000) - 10);
        wcsPath = await solveFieldAttempt(source.path, path.join(workDirectory, 'hinted'), backendConfig, {
          cpuLimitSeconds: hintCpuLimitSeconds,
          timeoutMs: hintTimeoutMs,
          hint,
        });
      } catch (error) {
        console.warn(`Coordinate-guided local solve failed for image ${image.id}; retrying blind against local indexes:`, error);
      }
    }
    if (!wcsPath) {
      const hintBudgetMs = hint ? Math.min(timeoutMs, Number(process.env.ASTROMETRY_HINT_TIMEOUT_MS || 90_000)) : 0;
      const fallbackTimeoutMs = Math.max(30_000, timeoutMs - hintBudgetMs);
      const fallbackCpuLimitSeconds = Math.max(1, Math.min(cpuLimitSeconds, Math.floor(fallbackTimeoutMs / 1000) - 10));
      wcsPath = await solveFieldAttempt(source.path, path.join(workDirectory, 'blind'), backendConfig, {
        cpuLimitSeconds: fallbackCpuLimitSeconds,
        timeoutMs: fallbackTimeoutMs,
      });
    }
    const headers = await readFitsHeader(wcsPath);
    const wcs = getWcsTransform(headers);
    const center = pixelToSky(wcs, (source.width - 1) / 2, (source.height - 1) / 2);
    const scaleX = Math.hypot(wcs.cd11, wcs.cd21) * 3600;
    const scaleY = Math.hypot(wcs.cd12, wcs.cd22) * 3600;
    const widthArcsec = source.width * scaleX;
    const heightArcsec = source.height * scaleY;
    const radius = Math.hypot(widthArcsec, heightArcsec) / 7200;
    const determinant = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
    const calibration: AstrometryCalibration = {
      ra: center.ra,
      dec: center.dec,
      pixscale: Math.sqrt(Math.abs(determinant)) * 3600,
      radius,
      orientation: (Math.atan2(-wcs.cd12, wcs.cd22) * 180 / Math.PI + 360) % 360,
      width_arcsec: widthArcsec,
      height_arcsec: heightArcsec,
      parity: determinant < 0 ? -1 : 1,
    };

    const target = await catalogService.matchTargetAtCoordinates(center.ra, center.dec, radius, [
      image.title || '',
      image.filename || '',
      ...(image.tags || []),
    ]);
    const annotations: AstrometryAnnotation[] = [];
    if (target?.raDeg != null && target.decDeg != null) {
      const pixel = skyToPixel(wcs, target.raDeg, target.decDeg);
      if (pixel && pixel.x >= 0 && pixel.x < source.width && pixel.y >= 0 && pixel.y < source.height) {
        annotations.push({
          type: 'ngc',
          names: [target.name],
          pixelx: pixel.x,
          pixely: pixel.y,
          ra: target.raDeg,
          dec: target.decDeg,
          radius: Math.max(target.majorAxis || 0, target.minorAxis || 0) * 30 / Math.max(calibration.pixscale, 0.001),
        });
      }
    }
    return { calibration, annotations, machineTags: [] };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}
