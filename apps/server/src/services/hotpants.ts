import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { and, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { storage } from './storage';
import { cachedFitsPreview, resolveFitsFile } from './fits';
import { sanitizedUploadFilename, writeUploadBody } from './upload-stream';

export const analysisRequestSchema = z.object({
  referenceMode: z.enum(['survey', 'local']).default('survey'),
  referenceImageId: z.number().int().positive().optional(),
  // "Auto" picks the deepest survey in the band matching the science FILTER (Pan-STARRS1, Legacy Surveys, SDSS, then DSS).
  survey: z.enum(['Auto',
    'Pan-STARRS1 g stack', 'Pan-STARRS1 r stack', 'Pan-STARRS1 i stack', 'Pan-STARRS1 z stack', 'Pan-STARRS1 y stack',
    'Legacy Surveys DR10 g', 'Legacy Surveys DR10 r', 'Legacy Surveys DR10 i', 'Legacy Surveys DR10 z',
    'SDSS u', 'SDSS g', 'SDSS r', 'SDSS i', 'SDSS z',
    'DSS2 Red', 'DSS2 Blue', 'DSS2 IR', 'DSS1 Red', '2MASS J', '2MASS H', '2MASS K']).default('Auto'),
  maxDimension: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192)]).default(2048),
  thresholdSigma: z.number().min(3).max(30).default(6),
  // Omitted or null: measured from the science image.
  sourceFwhm: z.number().min(1.5).max(12).nullable().optional(),
  maxCandidates: z.number().int().min(1).max(500).default(100),
  hotpantsOptions: z.string().max(3000).default(''),
});
export type AnalysisRequest = z.infer<typeof analysisRequestSchema>;

/** The Python with the analysis stack (astropy, photutils…). */
function analysisPython(): string {
  return process.env.ASTROVIABIN_ANALYSIS_PYTHON || '/opt/astroviabin-python/bin/python';
}

/** A HOTPANTS helper program from HOTPANTS_BIN_DIR (the Docker image installs them in /usr/local/bin). */
function hotpantsTool(name: string): string {
  return path.join(process.env.HOTPANTS_BIN_DIR || '/usr/local/bin', process.platform === 'win32' ? `${name}.exe` : name);
}

const root = () => path.resolve(process.env.FITS_ANALYSIS_DIR || (process.env.NODE_ENV === 'production' ? '/app/fits-analysis' : './data/fits-analysis'));
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILES = new Set(['science.fits', 'reference.fits', 'reference-aligned.fits', 'reference-mask.fits', 'difference.fits', 'difference-candidates.fits', 'difference-candidates.reg', 'noise.fits', 'convolved.fits', 'bad-pixels.fits', 'hotpants.log', 'kernel.fits', 'kernel-stamps.txt', 'noise-scaled.fits']);
const GENERATED_FILE = /^(kernel|masked)-[0-9a-f-]{36}\.fits$/i;
const VERIFICATION_FILE = /^(candidate-\d{1,3}\.png|candidate-\d{1,3}-blink\.gif|report\.pdf|verification\.json|verification\.log)$/;
const CONTENT_TYPES: Record<string, string> = { '.png': 'image/png', '.gif': 'image/gif', '.pdf': 'application/pdf', '.json': 'application/json', '.log': 'text/plain; charset=utf-8' };
const INPUT_FILE_FLAGS = new Set(['-tni', '-tmi', '-ini', '-imi', '-ki', '-rf', '-ssf', '-cmp']);
const OUTPUT_FILE_FLAGS: Record<string, string> = {
  '-oni': 'noise.fits', '-ond': 'noise-scaled.fits', '-oci': 'convolved.fits',
  '-omi': 'bad-pixels.fits', '-oki': 'kernel.fits', '-savexy': 'kernel-stamps.txt',
};
const NUMERIC_FLAGS = new Set('tu tuk tl tg tr tp iu iuk il ig ir ip r kcs ft sft nft mins mous nrx nry nsx nsy afssc nss rss ko bgo ssig ks kfm fi fin obs obz nbs nbz v'.split(' ').map(value => `-${value}`));
const BOOLEAN_FLAGS = new Set('sconv okn convvar nim ndm cim allm nc hki sht nsht'.split(' ').map(value => `-${value}`));
const CHOICE_FLAGS: Record<string, string[]> = { '-c': ['t', 'i'], '-n': ['t', 'i', 'u'], '-fom': ['v', 's', 'h'] };
const running = new Map<string, string>();
const verifying = new Set<string>();
const reporting = new Set<string>();

type Candidate = { ra: number; dec: number; [key: string]: unknown };
type PipelineResult = { candidates?: Candidate[]; [key: string]: unknown };

async function annotateKnownObjects(result: PipelineResult): Promise<PipelineResult> {
  if (!result.candidates?.length) return { ...result, catalogCheck: 'OpenNGC checked; no candidates' };
  const objects = await db.select({ name: schema.catalogObjects.name, ra: schema.catalogObjects.raDeg, dec: schema.catalogObjects.decDeg })
    .from(schema.catalogObjects)
    .where(and(isNotNull(schema.catalogObjects.raDeg), isNotNull(schema.catalogObjects.decDeg))) as Array<{ name: string; ra: number | null; dec: number | null }>;
  const radius = 3 / 60;
  const candidates = result.candidates.map(candidate => {
    const nearbyCatalogObjects = objects.flatMap((object: { name: string; ra: number | null; dec: number | null }) => {
      if (object.ra == null || object.dec == null) return [];
      const deltaRa = (((object.ra - candidate.ra + 540) % 360) - 180) * Math.cos(candidate.dec * Math.PI / 180);
      const separation = Math.hypot(deltaRa, object.dec - candidate.dec);
      return separation <= radius ? [{ name: object.name, separationArcsec: Math.round(separation * 3600) }] : [];
    }).sort((left: { separationArcsec: number }, right: { separationArcsec: number }) => left.separationArcsec - right.separationArcsec).slice(0, 3);
    return { ...candidate, nearbyCatalogObjects };
  });
  return { ...result, candidates, catalogCheck: 'OpenNGC positional proximity only; transient registries not checked' };
}

function runDirectory(imageId: number, runId: string): string {
  if (!Number.isInteger(imageId) || imageId <= 0 || !RUN_ID.test(runId)) throw new Error('Invalid analysis identifier');
  return path.join(root(), String(imageId), runId);
}

function splitOptions(source: string): string[] {
  const tokens = source.match(/(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g) || [];
  return tokens.map(value => value.replace(/^(['"])(.*)\1$/, '$2'));
}

async function hotpantsArgs(source: string, imageId: number, directory: string): Promise<string[]> {
  const tokens = splitOptions(source);
  const args: string[] = [];
  const addNumber = (value: string, flag: string) => {
    if (!Number.isFinite(Number(value))) throw new Error(`${flag} requires a finite number`);
    args.push(value);
  };
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (!flag?.startsWith('-')) throw new Error(`Unexpected HOTPANTS value: ${flag}`);
    if (BOOLEAN_FLAGS.has(flag)) { args.push(flag); continue; }
    if (NUMERIC_FLAGS.has(flag)) {
      const value = tokens[++index];
      if (!value) throw new Error(`${flag} needs a number`);
      args.push(flag);
      addNumber(value, flag);
      continue;
    }
    if (CHOICE_FLAGS[flag]) {
      const value = tokens[++index];
      if (!value || !CHOICE_FLAGS[flag].includes(value)) throw new Error(`${flag} must be ${CHOICE_FLAGS[flag].join(', ')}`);
      args.push(flag, value);
      continue;
    }
    if (flag === '-gd' || flag === '-ng') {
      const count = flag === '-gd' ? 4 : Number(tokens[++index]);
      if (!Number.isInteger(count) || count < 1 || count > (flag === '-gd' ? 4 : 10)) throw new Error(`${flag} has an invalid count`);
      args.push(flag);
      if (flag === '-ng') args.push(String(count));
      for (let n = 0; n < (flag === '-gd' ? 4 : count * 2); n++) {
        const value = tokens[++index];
        if (!value) throw new Error(`${flag} has too few numbers`);
        addNumber(value, flag);
      }
      continue;
    }
    if (flag === '-rkw') {
      const keyword = tokens[++index];
      const count = tokens[++index];
      if (!keyword || !/^[A-Z][A-Z0-9_-]{0,7}$/i.test(keyword) || !count || !Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 1000) {
        throw new Error('-rkw requires a FITS keyword and a positive region count');
      }
      args.push(flag, keyword, count);
      continue;
    }
    if (OUTPUT_FILE_FLAGS[flag]) {
      const discarded = tokens[++index];
      if (!discarded) throw new Error(`${flag} needs an output name`);
      args.push(flag, path.join(directory, OUTPUT_FILE_FLAGS[flag]));
      continue;
    }
    if (INPUT_FILE_FLAGS.has(flag)) {
      const filename = tokens[++index];
      if (!filename || !/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(filename)) throw new Error(`${flag} needs an uploaded attachment filename`);
      const filePath = path.join(root(), String(imageId), 'inputs', filename);
      await access(filePath);
      args.push(flag, filePath);
      continue;
    }
    if (flag === '-pca') {
      const count = Number(tokens[++index]);
      if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error('-pca requires 1–20 uploaded kernel FITS files');
      args.push(flag, String(count));
      for (let n = 0; n < count; n++) {
        const filename = tokens[++index];
        if (!filename || !/^[a-z0-9][a-z0-9._-]{0,159}\.(fit|fits|fts)$/i.test(filename)) throw new Error('-pca requires uploaded FITS filenames');
        const filePath = path.join(root(), String(imageId), 'inputs', filename);
        await access(filePath);
        args.push(filePath);
      }
      continue;
    }
    throw new Error(`Unsupported or protected HOTPANTS option: ${flag}`);
  }
  return args;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, filePath);
}

function hint(image: { ra?: string | null; dec?: string | null; pixelScale?: number | null }): { ra: number; dec: number; pixelScale: number | null } | null {
  const ra = Number(image.ra);
  const dec = Number(image.dec);
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90 || !image.ra || !image.dec) return null;
  return { ra, dec, pixelScale: image.pixelScale || null };
}

/** The WCS of the latest successful plate solve of an image (as stored with the job), if any. */
async function storedPlateSolution(imageId: number): Promise<Record<string, unknown> | null> {
  const image = await storage.getAstroImage(imageId);
  if (!image?.plateSolved) return null;
  const jobs = (await storage.getPlateSolvingJobs()).filter(job => job.imageId === imageId && job.status === 'success');
  const latest = jobs.sort((a, b) => b.id - a.id)[0];
  const wcs = (latest?.result as { wcs?: Record<string, unknown> } | null)?.wcs;
  return wcs && typeof wcs === 'object' ? wcs : null;
}

export async function startHotpantsAnalysis(imageId: number, request: AnalysisRequest) {
  const image = await storage.getAstroImage(imageId);
  const science = resolveFitsFile(image?.originalPath || null);
  if (!image || !science) throw new Error('Only locally stored FITS images can be analyzed');
  let reference: string | null = null;
  let referenceHint: ReturnType<typeof hint> = null;
  if (request.referenceMode === 'local') {
    if (!request.referenceImageId || request.referenceImageId === imageId) throw new Error('Choose another FITS image as the reference');
    const chosen = await storage.getAstroImage(request.referenceImageId);
    reference = resolveFitsFile(chosen?.originalPath || null);
    if (!chosen || !reference) throw new Error('The selected reference FITS is unavailable');
    referenceHint = hint(chosen);
  }
  const activeKey = String(imageId);
  if (running.has(activeKey)) throw new Error('An analysis is already running for this FITS');
  if (running.size >= 2) throw new Error('Two analyses are already running. Try again when one finishes.');
  const runId = randomUUID();
  const directory = runDirectory(imageId, runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const args = await hotpantsArgs(request.hotpantsOptions, imageId, directory);
  const report = { runId, imageId, status: 'running', startedAt: new Date().toISOString(),
    settings: request, reference: null, candidates: [] as unknown[] };
  await writeJson(path.join(directory, 'report.json'), report);
  const config = {
    work: directory, science, scienceHint: hint(image), referenceMode: request.referenceMode,
    reference, referenceHint, referenceImageId: request.referenceImageId,
    // Plate solutions AstroviaBin already verified: the pipeline reuses them instead of solving again.
    scienceWcs: await storedPlateSolution(imageId),
    referenceWcs: request.referenceMode === 'local' && request.referenceImageId ? await storedPlateSolution(request.referenceImageId) : null,
    survey: request.survey, maxDimension: request.maxDimension, thresholdSigma: request.thresholdSigma,
    sourceFwhm: request.sourceFwhm,
    maxCandidates: request.maxCandidates, hotpantsArgs: args, timeoutSeconds: 900,
  };
  await writeJson(path.join(directory, 'config.json'), config);
  running.set(activeKey, runId);
  const script = process.env.HOTPANTS_PIPELINE_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/hotpants_pipeline.py');
  const child = spawn(analysisPython(),
    [script, path.join(directory, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-2_000_000); });
  child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-100_000); });
  child.on('error', error => { errors = String(error); });
  child.on('close', async code => {
    try {
      if (code === 0) {
        const resultPath = path.join(directory, 'result.json');
        const pipelineResult = JSON.parse(await readFile(resultPath, 'utf8')) as PipelineResult;
        const result = await annotateKnownObjects(pipelineResult).catch(error => {
          console.warn('OpenNGC candidate proximity check unavailable:', error);
          return { ...pipelineResult, catalogCheck: 'Unavailable' };
        });
        await writeJson(path.join(directory, 'report.json'), { ...report, ...result, status: 'complete', completedAt: new Date().toISOString() });
        // Verification products (cross-matches, marked stamps, blink GIFs, PDF) follow in the background.
        buildVerification(imageId, runId).catch(error => console.warn(`HOTPANTS verification for ${runId} failed:`, error));
      } else {
        console.error(`[hotpants] analysis ${runId} (${analysisPython()} ${script}) exited with code ${code}:\n${errors.slice(-20_000)}`);
        await writeJson(path.join(directory, 'report.json'), { ...report, status: 'failed', completedAt: new Date().toISOString(), error: errors.slice(-4000) || `Pipeline exited ${code}` });
      }
    } catch (error) {
      console.error(`Could not finalize HOTPANTS analysis ${runId}:`, error);
      await writeJson(path.join(directory, 'report.json'), { ...report, status: 'failed',
        completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
        pipelineOutput: output.slice(-1000) }).catch(writeError => console.error('Could not record HOTPANTS failure:', writeError));
    } finally {
      running.delete(activeKey);
    }
  });
  return report;
}

export async function getHotpantsReport(imageId: number, runId: string) {
  const directory = runDirectory(imageId, runId);
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  if (report.verificationStatus === 'running' && !reporting.has(`${imageId}/${runId}`)) {
    report.verificationStatus = 'interrupted';
  }
  if (report.status === 'running') {
    if (running.get(String(imageId)) !== runId) return { ...report, status: 'interrupted', error: 'AstroviaBin restarted during this analysis. Start a new run.' };
    try { return { ...report, progress: JSON.parse(await readFile(path.join(directory, 'progress.json'), 'utf8')) }; }
    catch { return report; }
  }
  return report;
}

export async function listHotpantsReports(imageId: number) {
  const directory = path.join(root(), String(imageId));
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const reports = await Promise.all(entries.filter(entry => entry.isDirectory() && RUN_ID.test(entry.name)).map(async entry => {
    try { return await getHotpantsReport(imageId, entry.name); } catch { return null; }
  }));
  return reports.filter(Boolean).sort((left: any, right: any) => String(right.startedAt).localeCompare(String(left.startedAt)));
}

export async function deleteHotpantsReport(imageId: number, runId: string): Promise<void> {
  const directory = runDirectory(imageId, runId);
  if (running.get(String(imageId)) === runId || verifying.has(`${imageId}/${runId}`) || reporting.has(`${imageId}/${runId}`)) {
    throw new Error('A running analysis cannot be deleted');
  }
  const image = await storage.getAstroImage(imageId);
  if (!image) throw new Error('FITS image not found');
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid analysis directory');
  await readFile(path.join(directory, 'report.json'), 'utf8');
  await rm(directory, { recursive: true });
}

export const candidateCheckSchema = z.object({ followupImageId: z.number().int().positive() });

export async function checkHotpantsCandidate(
  imageId: number, runId: string, candidateIndex: number, followupImageId: number,
) {
  const directory = runDirectory(imageId, runId);
  const key = `${imageId}/${runId}`;
  if (verifying.has(key)) throw new Error('A candidate check is already running for this analysis');
  const report = await getHotpantsReport(imageId, runId);
  if (report.status !== 'complete' || report.analysisVersion !== 2) throw new Error('Run the improved analysis before checking candidates');
  if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= report.candidates.length) {
    throw new Error('Invalid candidate');
  }
  if (followupImageId === imageId) throw new Error('Choose a different FITS exposure');
  const followup = await storage.getAstroImage(followupImageId);
  const comparison = resolveFitsFile(followup?.originalPath || null);
  if (!followup || !comparison) throw new Error('Follow-up FITS is unavailable');
  const candidate = report.candidates[candidateIndex];
  if (!Number.isFinite(candidate.ra) || !Number.isFinite(candidate.dec)) throw new Error('Candidate has invalid coordinates');
  const work = path.join(directory, 'verification', `${candidateIndex}-${followupImageId}-${randomUUID()}`);
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeJson(path.join(work, 'config.json'), {
    mode: 'candidate-check', work, comparison, comparisonHint: hint(followup),
    comparisonImageId: followupImageId, ra: candidate.ra, dec: candidate.dec,
    maxDimension: report.settings.maxDimension,
    sourceFwhm: report.settings.sourceFwhm || report.autoSettings?.detectionFwhmPx || 3,
    sourceFilter: report.sourceFilter, sourceDate: report.sourceDate,
  });
  verifying.add(key);
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const script = process.env.HOTPANTS_PIPELINE_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/hotpants_pipeline.py');
      const child = spawn(analysisPython(),
        [script, path.join(work, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-100_000); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-10_000); });
      child.on('error', reject);
      const timer = setTimeout(() => child.kill('SIGKILL'), 360_000);
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr || `Candidate check exited ${code}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Candidate check returned invalid data')); }
      });
    });
    const updated = await getHotpantsReport(imageId, runId);
    const checks = { ...(updated.candidateChecks || {}), [candidateIndex]: {
      ...result, checkedAt: new Date().toISOString(),
    } };
    await writeJson(path.join(directory, 'report.json'), { ...updated, candidateChecks: checks });
    return checks[candidateIndex];
  } finally {
    verifying.delete(key);
  }
}

/**
 * Runs tools/scripts/hotpants_report.py on a completed analysis: Gaia-tied positions, cross-matches,
 * marked stamps, blink GIFs and a PDF report. Re-run after a follow-up check to include it.
 */
const verificationProcesses = new Map<string, { child: ReturnType<typeof spawn>; stopped: boolean }>();

/**
 * Runs tools/scripts/hotpants_report.py on a completed analysis: Gaia-tied positions, cross-matches,
 * marked stamps, blink GIFs and a PDF report. Re-run after a follow-up check to include it.
 * There is no time limit: the script reports its progress and a time-stamped log (shown in the
 * verification console), and the user can stop it.
 */
export async function buildVerification(imageId: number, runId: string): Promise<void> {
  const key = `${imageId}/${runId}`;
  if (reporting.has(key)) throw new Error('Verification is already being generated for this analysis');
  const directory = runDirectory(imageId, runId);
  const current = await getHotpantsReport(imageId, runId);
  if (current.status !== 'complete') throw new Error('Only completed analyses can be verified');
  reporting.add(key);
  const logLines: string[] = [];
  let progress = { percent: 0, step: 'Starting' };
  let dirty = true;
  let finished = false;
  let inflight: Promise<void> = Promise.resolve();
  // Progress writes are serialised and stop once the final state is being written.
  const flush = () => (inflight = inflight.then(async () => {
    if (!dirty || finished) return;
    dirty = false;
    await writeFile(path.join(directory, 'verification.log'), `${logLines.join('\n')}\n`).catch(() => undefined);
    const latest = await getHotpantsReport(imageId, runId).catch(() => null);
    if (latest && reporting.has(key)) {
      await writeJson(path.join(directory, 'report.json'), { ...latest, verificationStatus: 'running',
        verificationProgress: { ...progress, updatedAt: new Date().toISOString() }, verificationLog: logLines.slice(-80) }).catch(() => undefined);
    }
  }));
  const finish = async () => {
    clearInterval(timer);
    dirty = true;
    await flush();
    finished = true;
  };
  const timer = setInterval(() => { void flush(); }, 1000);
  try {
    await writeJson(path.join(directory, 'report.json'), { ...current, verificationStatus: 'running', verificationError: undefined,
      verificationProgress: { ...progress, updatedAt: new Date().toISOString() }, verificationLog: [] });
    const image = await storage.getAstroImage(imageId);
    const script = process.env.HOTPANTS_REPORT_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/hotpants_report.py');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(analysisPython(), [script, directory, image?.title || `FITS #${imageId}`],
        { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
      const handle = { child, stopped: false };
      verificationProcesses.set(key, handle);
      let pending = '';
      child.stderr?.on('data', chunk => {
        pending += String(chunk);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines.map(item => item.trimEnd()).filter(Boolean)) {
          if (line.startsWith('PROGRESS ')) {
            try { progress = JSON.parse(line.slice(9)); } catch { /* ignore a malformed line */ }
          } else {
            logLines.push(line);
            if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000);
          }
          dirty = true;
        }
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        verificationProcesses.delete(key);
        if (pending.trim()) logLines.push(pending.trim());
        if (code === 0) resolve();
        else if (handle.stopped) reject(new Error('Stopped by the user'));
        else {
          const lastErrors = logLines.filter(line => !line.startsWith('[')).slice(-3).join(' ');
          reject(new Error(lastErrors || (signal ? `Verification process was killed (${signal})` : `Verification exited with code ${code}`)));
        }
      });
    });
    const verification = JSON.parse(await readFile(path.join(directory, 'verification.json'), 'utf8'));
    await finish();
    const latest = await getHotpantsReport(imageId, runId);
    const files = [...new Set([...(latest.files || []).filter((name: string) => !VERIFICATION_FILE.test(name)), ...verification.files])];
    await writeJson(path.join(directory, 'report.json'), { ...latest, verification, files, verificationStatus: 'complete', verificationError: undefined,
      verificationProgress: { percent: 100, step: 'Done', updatedAt: new Date().toISOString() }, verificationLog: logLines.slice(-80) });
  } catch (error) {
    await finish();
    const latest = await getHotpantsReport(imageId, runId).catch(() => current);
    await writeJson(path.join(directory, 'report.json'), { ...latest, verificationStatus: 'failed',
      verificationError: error instanceof Error ? error.message : String(error), verificationLog: logLines.slice(-80) }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(timer);
    reporting.delete(key);
  }
}

/** Stops a running verification (its whole process group); the report says it was stopped and can be re-run. */
export function stopVerification(imageId: number, runId: string): boolean {
  const handle = verificationProcesses.get(`${imageId}/${runId}`);
  if (!handle?.child.pid) return false;
  handle.stopped = true;
  try {
    if (process.platform !== 'win32') process.kill(-handle.child.pid, 'SIGKILL');
    else handle.child.kill('SIGKILL');
  } catch {
    handle.child.kill('SIGKILL');
  }
  return true;
}

export async function startVerification(imageId: number, runId: string): Promise<{ status: string }> {
  const key = `${imageId}/${runId}`;
  if (reporting.has(key)) throw new Error('Verification is already being generated for this analysis');
  const report = await getHotpantsReport(imageId, runId);
  if (report.status !== 'complete') throw new Error('Only completed analyses can be verified');
  buildVerification(imageId, runId).catch(error => console.warn(`HOTPANTS verification for ${runId} failed:`, error));
  return { status: 'running' };
}

export async function analysisFile(imageId: number, runId: string, filename: string, preview: boolean) {
  if (!FILES.has(filename) && !GENERATED_FILE.test(filename) && !VERIFICATION_FILE.test(filename)) throw new Error('Unknown analysis file');
  const filePath = path.join(runDirectory(imageId, runId), filename);
  await stat(filePath);
  if (VERIFICATION_FILE.test(filename)) {
    const extension = path.extname(filename);
    const download = extension === '.pdf' ? `hotpants-report-${imageId}-${runId.slice(0, 8)}.pdf` : null;
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: {
      'content-type': CONTENT_TYPES[extension] || 'application/octet-stream',
      'content-disposition': download ? `attachment; filename="${download}"` : 'inline',
      'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff',
    } });
  }
  if (preview) {
    if (!filename.endsWith('.fits')) throw new Error('Only FITS layers have a preview');
    const image = await cachedFitsPreview(filePath, { stretch: 'asinh', backgroundNeutralization: true }, 2048);
    const bytes = new Uint8Array(new ArrayBuffer(image.byteLength));
    bytes.set(image);
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: {
    'content-type': filename.endsWith('.fits') ? 'application/fits' : 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  } });
}

async function runHelper(binary: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + String(chunk)).slice(-4000); });
    child.on('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', code => {
      clearTimeout(timer);
      const legacyExtractorSucceeded = path.basename(binary) === 'extractkern-ones' && code === 1 &&
        Number.isFinite(Number(errorText.match(/Actual sum of pixels in convolved image\s*:\s*([^\s]+)/)?.[1]));
      if (code === 0 || legacyExtractorSucceeded) resolve();
      else reject(new Error(`${path.basename(binary)} failed: ${errorText || `exit ${code}`}`));
    });
  });
}

export const helperRequestSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('extractkern'), mode: z.enum(['position', 'full', 'image']),
    x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(),
    kernelWidths: z.number().min(0.5).max(20).default(2),
    imageLayer: z.enum(['science.fits', 'reference-aligned.fits', 'convolved.fits']).optional() }),
  z.object({ tool: z.literal('maskim'), imageLayer: z.enum(['science.fits', 'reference-aligned.fits', 'difference.fits', 'convolved.fits']).default('difference.fits'),
    mask: z.number().int().min(0).max(65535).default(32768), fillValue: z.number().finite().default(0) }),
]);

export async function runAnalysisHelper(imageId: number, runId: string, request: z.infer<typeof helperRequestSchema>) {
  const report = await getHotpantsReport(imageId, runId);
  if (report.status !== 'complete') throw new Error('Only completed analyses support HOTPANTS utilities');
  const directory = runDirectory(imageId, runId);
  const name = `${request.tool === 'extractkern' ? 'kernel' : 'masked'}-${randomUUID()}.fits`;
  const output = path.join(directory, name);
  if (request.tool === 'extractkern') {
    const args = ['-nkw', String(request.kernelWidths)];
    if (request.mode === 'position') {
      if (request.x == null || request.y == null || request.x >= Number(report.width) || request.y >= Number(report.height)) throw new Error('Select a candidate pixel within the image');
      args.push('-xy', String(request.x), String(request.y));
    } else if (request.mode === 'full') {
      const lattice = path.join(directory, 'kernel-lattice.fits');
      await runHelper(analysisPython(), [path.resolve(process.cwd(), 'tools/scripts/hotpants_aux.py'),
        'lattice', path.join(directory, 'difference.fits'), lattice]);
      args.push('-im', lattice);
    }
    else {
      if (!request.imageLayer) throw new Error('Choose an image layer to convolve');
      args.push('-im', path.join(directory, request.imageLayer));
    }
    args.push(path.join(directory, 'difference.fits'), output);
    await runHelper(hotpantsTool('extractkern-ones'), args);
    await runHelper(analysisPython(), [path.resolve(process.cwd(), 'tools/scripts/hotpants_aux.py'), 'validate', output]);
  } else {
    await runHelper(hotpantsTool('maskim'), ['-inim', path.join(directory, request.imageLayer),
      '-maskim', path.join(directory, 'bad-pixels.fits'), '-outim', output,
      '-fi', String(request.fillValue), '-mask', String(request.mask)]);
  }
  await stat(output);
  const current = await getHotpantsReport(imageId, runId);
  await writeJson(path.join(directory, 'report.json'), { ...current, files: [...new Set([...(current.files || []), name])] });
  return { filename: name };
}

export async function listAnalysisInputs(imageId: number): Promise<string[]> {
  if (!Number.isInteger(imageId) || imageId <= 0) throw new Error('Invalid FITS image');
  const entries = await readdir(path.join(root(), String(imageId), 'inputs'), { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  return entries.filter(entry => entry.isFile()).map(entry => entry.name).sort();
}

export async function saveAnalysisInput(imageId: number, filenameValue: string | undefined, body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!Number.isInteger(imageId) || imageId <= 0) throw new Error('Invalid FITS image');
  const filename = sanitizedUploadFilename(filenameValue);
  if (!/^[a-z0-9][a-z0-9._-]{0,159}\.(fit|fits|fts|txt|csv|cmp)$/i.test(filename)) {
    throw new Error('Attachment must be FITS or a .txt, .csv, or .cmp stamp/region list');
  }
  const image = await storage.getAstroImage(imageId);
  if (!resolveFitsFile(image?.originalPath || null)) throw new Error('Only a local FITS can have HOTPANTS attachments');
  await writeUploadBody(body, path.join(root(), String(imageId), 'inputs', filename), 120 * 1024 * 1024);
  return filename;
}
