import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFitsMetadata, type FitsMetadata } from './fits';
import type { WcsSolution } from './wcs';

export type StackMethod = 'mean' | 'median' | 'sum' | 'sigma-clip';
export type StackNormalization = 'none' | 'exposure' | 'median';
export type StackWeighting = 'none' | 'exposure' | 'inverse-variance';
export type StackInterpolation = 'nearest-neighbor' | 'bilinear' | 'biquadratic' | 'bicubic';

export interface StackSettings {
  method?: StackMethod;
  sigmaClipThreshold?: number;
  sigmaClipLow?: number;
  sigmaClipHigh?: number;
  register?: boolean;
  interpolation?: StackInterpolation;
  normalization?: StackNormalization;
  weighting?: StackWeighting;
  memoryLimitMb?: number;
  clipExtrema?: boolean;
  clipLowCount?: number;
  clipHighCount?: number;
  minimumClip?: number;
  maximumClip?: number;
  overscan?: string;
  overscanMedian?: boolean;
  overscanPolynomialDegree?: number;
  trim?: string;
  gain?: number;
  readNoise?: number;
  flatMinimum?: number;
  darkScale?: boolean;
  calibrationMastersGainCorrected?: boolean;
  exposureKeyword?: string;
  cosmicMethod?: 'none' | 'lacosmic' | 'median';
  cosmicSigma?: number;
  cosmicFraction?: number;
  cosmicObjectLimit?: number;
  cosmicIterations?: number;
  cosmicCleanType?: 'median' | 'medmask' | 'meanmask' | 'idw';
  cosmicSeparateMedian?: boolean;
  cosmicFineStructureMode?: 'median' | 'convolve';
  cosmicPsfModel?: 'gauss' | 'gaussx' | 'gaussy' | 'moffat';
  cosmicPsfFwhm?: number;
  cosmicPsfSize?: number;
  cosmicPsfBeta?: number;
  saturationLevel?: number;
  medianCosmicThreshold?: number;
  medianCosmicBox?: number;
  medianCosmicGrowBox?: number;
  medianCosmicReplaceBox?: number;
  ccdMaskFindBadColumns?: boolean;
  ccdMaskByBlocks?: boolean;
  ccdMaskLowSigma?: number;
  ccdMaskHighSigma?: number;
  ccdMaskColumnMedian?: number;
  ccdMaskLineMedian?: number;
  ccdMaskColumnSigmaBox?: number;
  ccdMaskLineSigmaBox?: number;
  ccdMaskGoodPixelGap?: number;
  calibration?: {
    biasPath?: string;
    darkPath?: string;
    flatPath?: string;
    badPixelMaskPath?: string;
    ccdMaskRatioPath?: string;
  };
  frameWcs?: Array<WcsSolution | null | undefined>;
  frameNames?: string[];
}

export interface FrameReport {
  name: string;
  used: boolean;
  method?: string;
  dx?: number;
  dy?: number;
  reason?: string;
}

export interface StackResult {
  metadata: FitsMetadata;
  frameCount: number;
  offsets: { dx: number; dy: number }[];
  frames: FrameReport[];
  warnings: string[];
  engine: { name: string; ccdproc: string };
}

type PythonResult = Omit<StackResult, 'metadata'>;

function analysisPython(): string {
  return process.env.ASTROVIABIN_ANALYSIS_PYTHON || '/opt/astroviabin-python/bin/python';
}

/**
 * Runs the Astropy/CCDProc pipeline in its own process. Python owns every
 * numerical operation, so the Node event loop remains responsive and there is
 * no parallel JavaScript implementation that can drift from CCDProc.
 */
export async function stackFits(filePaths: string[], outputPath: string, settings: StackSettings = {}): Promise<StackResult> {
  if (filePaths.length < 2) throw new Error('Stacking requires at least two FITS frames');
  const script = process.env.CCDPROC_STACK_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/ccdproc_stack.py');
  const request = JSON.stringify({ filePaths, outputPath, settings });
  const result = await new Promise<PythonResult>((resolve, reject) => {
    const child = spawn(analysisPython(), [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-2_000_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-200_000); });
    child.on('error', reject);
    child.on('close', code => {
      let message: { ok?: boolean; result?: PythonResult; error?: string } | undefined;
      try { message = JSON.parse(stdout.trim().split('\n').at(-1) || '{}'); } catch { /* handled below */ }
      if (code === 0 && message?.ok && message.result) resolve(message.result);
      else reject(new Error(message?.error || stderr.trim().split('\n').at(-1) || `CCDProc exited with code ${code}`));
    });
    child.stdin.end(request);
  });
  return { ...result, metadata: await readFitsMetadata(outputPath) };
}

/** Compatibility name retained for the route; Python is already an isolated worker process. */
export const runStackInThread = stackFits;
