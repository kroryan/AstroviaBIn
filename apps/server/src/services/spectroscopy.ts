import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { resolveFitsFile } from './fits';
import { onlineCatalogsEnabled } from './online-catalogs';
import { storage } from './storage';
import { wcsFromStored } from './wcs';

/**
 * Stellar spectroscopy runs (tools/scripts/spectroscopy.py): every usable star of a slitless
 * (Star Analyser-type) FITS, or a 1-D spectrum. Each run lives in
 * <FITS analysis folder>/<imageId>/spectroscopy/<runId>/ with result.json, summary.csv, star-N.csv,
 * spectra.fits and report.pdf.
 */

export const spectroscopyRequestSchema = z.object({
  mode: z.enum(['auto', 'slitless', 'trace', 'spectrum1d']).default('auto'),
  dispersionNmPerPixel: z.number().positive().max(50).optional(),
  dispersionAngle: z.number().min(0).max(360).optional(),
  fwhm: z.number().positive().max(30).optional(),
  detectionSigma: z.number().min(2).max(100).default(6),
  maxStars: z.number().int().min(1).max(300).default(60),
  minTraceSnr: z.number().min(1).max(100).default(5),
  extractionHalfWidth: z.number().min(1).max(40).optional(),
  traceStart: z.number().min(0).max(5000).optional(),
  traceEnd: z.number().min(1).max(10000).optional(),
  cosmicRays: z.boolean().default(true),
  // Compare with the earlier spectroscopy found by the pre-check ("Check known spectroscopy").
  compareWithKnown: z.boolean().default(false),
  biasImageId: z.number().int().positive().optional(),
  darkImageId: z.number().int().positive().optional(),
  flatImageId: z.number().int().positive().optional(),
});
export type SpectroscopyRequest = z.infer<typeof spectroscopyRequestSchema>;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^(summary\.csv|spectra\.fits|report\.pdf|result\.json|star-\d{1,3}\.csv|comparison\.csv|comparison\.json)$/;
const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8', '.fits': 'application/fits', '.pdf': 'application/pdf', '.json': 'application/json',
};
const running = new Map<string, string>();

function analysisPython(): string {
  return process.env.ASTROVIABIN_ANALYSIS_PYTHON || '/opt/astroviabin-python/bin/python';
}

function scriptPath(): string {
  if (process.env.SPECTROSCOPY_SCRIPT) return process.env.SPECTROSCOPY_SCRIPT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(process.cwd(), 'tools/scripts/spectroscopy.py'), path.resolve(here, '..', 'tools/scripts/spectroscopy.py'),
    path.resolve(here, '../../../../tools/scripts/spectroscopy.py')].find(candidate => existsSync(candidate)) ?? path.resolve(process.cwd(), 'tools/scripts/spectroscopy.py');
}

const root = () => path.resolve(process.env.FITS_ANALYSIS_DIR || (process.env.NODE_ENV === 'production' ? '/app/fits-analysis' : './data/fits-analysis'));

/** Astropy/astroquery/Matplotlib caches inside AstroviaBin's own data folder (removed with it), never in ~/.astropy. */
function pythonEnv(): NodeJS.ProcessEnv {
  const home = path.join(root(), '.python-cache');
  try {
    for (const sub of ['config/astropy', 'cache/astropy', 'matplotlib']) mkdirSync(path.join(home, sub), { recursive: true });
  } catch {
    return process.env; // Unwritable data folder: the libraries fall back to their defaults; never block the caller.
  }
  return { ...process.env, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), MPLCONFIGDIR: path.join(home, 'matplotlib') };
}

function runDirectory(imageId: number, runId: string): string {
  if (!Number.isInteger(imageId) || imageId <= 0 || !RUN_ID.test(runId)) throw new Error('Invalid spectroscopy run');
  return path.join(root(), String(imageId), 'spectroscopy', runId);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

/** The FITS to analyse: an uploaded spectrum keeps its original file (full table and metadata) beside it. */
async function inputFor(imageId: number): Promise<{ file: string; name: string; image: Awaited<ReturnType<typeof storage.getAstroImage>> }> {
  const image = await storage.getAstroImage(imageId);
  const file = resolveFitsFile(image?.originalPath || null);
  if (!image || !file) throw new Error('Only locally stored FITS images can be analysed');
  const original = `${file}.orig`;
  const isSpectrum = (image.tags ?? []).includes('Spectrum');
  return { file: isSpectrum && await exists(original) ? original : file, name: image.filename || path.basename(file), image };
}

async function masterPath(id: number | undefined): Promise<string | undefined> {
  if (!id) return undefined;
  const image = await storage.getAstroImage(id);
  const file = resolveFitsFile(image?.originalPath || null);
  if (!file) throw new Error(`Calibration frame #${id} is not a locally stored FITS`);
  return file;
}

export async function startSpectroscopy(imageId: number, request: SpectroscopyRequest) {
  const { file, name, image } = await inputFor(imageId);
  const key = String(imageId);
  if (running.has(key)) throw new Error('A spectroscopic analysis is already running for this FITS');
  if (running.size >= 2) throw new Error('Two spectroscopic analyses are already running. Try again when one finishes.');
  const runId = randomUUID();
  const directory = runDirectory(imageId, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const job = await storage.getLatestPlateSolvingJob(imageId, 'success');
  const wcs = wcsFromStored((job?.result as Record<string, unknown> | undefined)?.wcs) ?? null;
  const { biasImageId, darkImageId, flatImageId, compareWithKnown, ...settings } = request;
  let known: unknown = null;
  if (compareWithKnown) {
    try {
      known = JSON.parse(await readFile(knownPath(imageId), 'utf8'));
    } catch {
      throw new Error('Run "Check known spectroscopy" first: the comparison uses its results');
    }
  }
  const calibration = {
    biasPath: await masterPath(biasImageId), darkPath: await masterPath(darkImageId), flatPath: await masterPath(flatImageId),
  };
  const config = {
    input: file, name, work: directory, wcs, ...(known ? { known } : {}),
    settings: { ...settings, calibration, onlineCatalogs: onlineCatalogsEnabled(), pixelScaleArcsec: image?.pixelScale ?? undefined },
  };
  await writeJson(path.join(directory, 'config.json'), config);
  const report = { runId, imageId, status: 'running', startedAt: new Date().toISOString(), settings: request };
  await writeJson(path.join(directory, 'report.json'), report);
  running.set(key, runId);
  const child = spawn(analysisPython(), [scriptPath(), 'analyse', path.join(directory, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: pythonEnv() });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-200_000); });
  child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-50_000); });
  child.on('error', error => {
    errors = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `The Python used for spectroscopy was not found (${analysisPython()}). Set "Python with the analysis packages" in the server settings.`
      : String(error);
  });
  child.on('close', async code => {
    try {
      let message: { ok?: boolean; error?: string } = {};
      try { message = JSON.parse(output.trim().split('\n').at(-1) || '{}'); } catch { /* reported below */ }
      if (code === 0 && message.ok) {
        await writeJson(path.join(directory, 'report.json'), { ...report, status: 'complete', completedAt: new Date().toISOString() });
      } else {
        const missing = /No module named '?([\w.]+)/.exec(errors);
        const reason = message.error || (missing ? `The analysis Python lacks the "${missing[1]}" package` : errors.trim().split('\n').at(-1)) || `Spectroscopy exited with code ${code}`;
        await writeJson(path.join(directory, 'report.json'), { ...report, status: 'failed', completedAt: new Date().toISOString(), error: reason });
      }
    } catch (error) {
      console.error(`Could not finalize spectroscopy run ${runId}:`, error);
    } finally {
      running.delete(key);
    }
  });
  return report;
}

export async function getSpectroscopyRun(imageId: number, runId: string) {
  const directory = runDirectory(imageId, runId);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  if (report.status === 'running') {
    if (running.get(String(imageId)) !== runId) return { ...report, status: 'interrupted', error: 'AstroviaBin restarted during this analysis. Run it again.' };
    try { return { ...report, progress: JSON.parse(await readFile(path.join(directory, 'progress.json'), 'utf8')) }; } catch { return report; }
  }
  if (report.status === 'complete') {
    try { return { ...report, result: JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')) }; } catch { return report; }
  }
  return report;
}

export async function listSpectroscopyRuns(imageId: number) {
  const directory = path.join(root(), String(imageId), 'spectroscopy');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const runs = await Promise.all(entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(async entry => {
    try {
      const run = await getSpectroscopyRun(imageId, entry.name);
      // The list carries the summary only; the full result is fetched per run.
      const { result, ...rest } = run as { result?: { summary?: unknown; mode?: string; calibration?: unknown } };
      return { ...rest, summary: result?.summary, mode: result?.mode, calibration: result?.calibration };
    } catch { return null; }
  }));
  return runs.filter(Boolean).sort((left: any, right: any) => String(right.startedAt).localeCompare(String(left.startedAt)));
}

export async function deleteSpectroscopyRun(imageId: number, runId: string): Promise<void> {
  if (running.get(String(imageId)) === runId) throw new Error('A running analysis cannot be deleted');
  await rm(runDirectory(imageId, runId), { recursive: true, force: true });
}

export async function spectroscopyFile(imageId: number, runId: string, filename: string) {
  if (!FILE.test(filename)) throw new Error('Unknown spectroscopy file');
  const filePath = path.join(runDirectory(imageId, runId), filename);
  return { filePath, contentType: CONTENT_TYPES[path.extname(filename)] ?? 'application/octet-stream', body: await readFile(filePath) };
}

function knownPath(imageId: number): string {
  if (!Number.isInteger(imageId) || imageId <= 0) throw new Error('Invalid image id');
  return path.join(root(), String(imageId), 'spectroscopy', 'known.json');
}

export const knownRequestSchema = spectroscopyRequestSchema.pick({ mode: true, detectionSigma: true, maxStars: true, fwhm: true });

/**
 * Before any analysis: the stars of the frame (or the 1-D target) and which already have spectroscopy in
 * SIMBAD, Gaia DR3 (XP/RVS) or SDSS DR18. Saved per image; an analysis asked to compare reuses it.
 */
export async function checkKnownSpectroscopy(imageId: number, request: z.infer<typeof knownRequestSchema>) {
  if (!onlineCatalogsEnabled()) throw new Error('Online catalogues are disabled on this server (ASTROVIABIN_ONLINE_CATALOGS=false)');
  const { file } = await inputFor(imageId);
  const key = `${imageId}/known`;
  if (running.has(key)) throw new Error('The known-spectroscopy check is already running for this FITS');
  const output = knownPath(imageId);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const job = await storage.getLatestPlateSolvingJob(imageId, 'success');
  const wcs = wcsFromStored((job?.result as Record<string, unknown> | undefined)?.wcs) ?? null;
  const configPath = path.join(path.dirname(output), 'known-config.json');
  await writeJson(configPath, { input: file, wcs, settings: request, output: `${output}.partial` });
  running.set(key, 'known');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(analysisPython(), [scriptPath(), 'known', configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: pythonEnv() });
      let stdout = '';
      let errors = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-20_000); });
      child.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? new Error(`The Python used for spectroscopy was not found (${analysisPython()})`) : error));
      child.on('close', code => {
        clearTimeout(timer);
        let message: { ok?: boolean; error?: string } = {};
        try { message = JSON.parse(stdout.trim().split('\n').at(-1) || '{}'); } catch { /* below */ }
        if (code === 0 && message.ok) resolve();
        else reject(new Error(message.error || errors.trim().split('\n').at(-1) || `The check exited with code ${code}`));
      });
    });
    const known = JSON.parse(await readFile(`${output}.partial`, 'utf8'));
    await writeJson(output, known);
    await rm(`${output}.partial`, { force: true });
    return known;
  } finally {
    running.delete(key);
    await rm(configPath, { force: true }).catch(() => undefined);
  }
}

export async function getKnownSpectroscopy(imageId: number) {
  return JSON.parse(await readFile(knownPath(imageId), 'utf8'));
}

export interface SpectroscopyDetection { kind: 'spectrum1d' | 'slitless' | 'image2d' | 'unknown'; reason?: string; angleDeg?: number }

const SPECTROSCOPY_WORDS = ['SA100', 'SA-100', 'SA200', 'SA-200', 'STAR ANALYSER', 'STAR ANALYZER', 'STARANALYSER', 'GRATING',
  'GRISM', 'SLITLESS', 'SPECTRO', 'SPECTRUM', 'SPECTRA', 'RAINBOW OPTICS', 'TRANSMISSION GRATING'];

/** Header-only check (library scans): a FILTER/INSTRUME/IMAGETYP… that names a grating or spectroscope. */
export function spectroscopyHeaderHint(headers: Record<string, string | number | boolean>): string | null {
  const words = ['FILTER', 'INSTRUME', 'IMAGETYP', 'FRAMETYP', 'OBJECT', 'GRATING', 'DISPERSR', 'OBSTYPE']
    .map(key => String(headers[key] ?? '')).join(' ').toUpperCase();
  return SPECTROSCOPY_WORDS.find(word => words.includes(word)) ?? null;
}

/** Full check for uploads: 1-D spectrum, slitless spectroscopic frame (stars with a one-sided first order
 * at a common angle) or ordinary image. Never fails an upload: problems return null. */
export async function detectSpectroscopy(filePath: string): Promise<SpectroscopyDetection | null> {
  return new Promise(resolve => {
    let stdout = '';
    const child = spawn(analysisPython(), [scriptPath(), 'detect', filePath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: pythonEnv() });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      try { resolve(code === 0 ? JSON.parse(stdout.trim().split('\n').at(-1) || 'null') : null); } catch { resolve(null); }
    });
  });
}
