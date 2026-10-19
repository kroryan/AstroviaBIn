import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FITS_BLOCK_SIZE,
  copyHeaderValue,
  fitsCard,
  readFitsMetadata,
  readPixels,
  type FitsMetadata,
} from './fits';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { bicubic, detectStars, registerFrame, type Registration } from './fits-registration';
import { parseWcsHeaders, type WcsSolution } from './wcs';

export type StackMethod = 'mean' | 'median' | 'sigma-clip';

export interface StackSettings {
  method?: StackMethod;
  /** Standard deviations from the mean beyond which a sample is rejected, for the 'sigma-clip' method. */
  sigmaClipThreshold?: number;
  /** Align frames to the first one before combining. Defaults to true. */
  register?: boolean;
  /** Plate solutions to use instead of (or when missing from) each frame's FITS header, e.g. the latest local solve. */
  frameWcs?: Array<WcsSolution | null | undefined>;
  /** Display names for the per-frame report. */
  frameNames?: string[];
}

export interface FrameReport {
  name: string;
  used: boolean;
  method?: Registration['method'] | 'reference' | 'none';
  matchedStars?: number;
  rmsPx?: number | null;
  /** Displacement of the frame relative to the reference, at the reference centre. */
  dx?: number;
  dy?: number;
  reason?: string;
}

export interface StackResult {
  metadata: FitsMetadata;
  /** Frames actually combined. */
  frameCount: number;
  offsets: { dx: number; dy: number }[];
  frames: FrameReport[];
  warnings: string[];
}

function luminancePlane(pixels: Float64Array, metadata: FitsMetadata): Float32Array {
  const planeSize = metadata.width * metadata.height;
  const plane = new Float32Array(planeSize);
  if (metadata.channels === 3) {
    for (let index = 0; index < planeSize; index++) {
      plane[index] = pixels[index] * 0.2126 + pixels[planeSize + index] * 0.7152 + pixels[2 * planeSize + index] * 0.0722;
    }
  } else {
    for (let index = 0; index < planeSize; index++) plane[index] = pixels[index];
  }
  return plane;
}

/** Anti-aliased block-average downsample, used only to make registration affordable. */
function downsample(plane: Float32Array, width: number, height: number, maxDimension: number): { plane: Float32Array; width: number; height: number; factor: number } {
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / maxDimension));
  if (factor === 1) return { plane, width, height, factor };
  const outWidth = Math.floor(width / factor);
  const outHeight = Math.floor(height / factor);
  const result = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) sum += plane[(y * factor + dy) * width + x * factor + dx];
      }
      result[y * outWidth + x] = sum / (factor * factor);
    }
  }
  return { plane: result, width: outWidth, height: outHeight, factor };
}

/** Cross-correlation score between `reference` and `target` shifted by (dx, dy), sampled on a grid for speed. */
/** Subtracts the plane's own mean, so correlation lines up structure rather than overall brightness. */
function zeroMean(plane: Float32Array): Float32Array {
  let sum = 0;
  let finiteCount = 0;
  for (let index = 0; index < plane.length; index++) {
    if (!Number.isFinite(plane[index])) continue;
    sum += plane[index];
    finiteCount++;
  }
  const mean = finiteCount ? sum / finiteCount : 0;
  const result = new Float32Array(plane.length);
  for (let index = 0; index < plane.length; index++) result[index] = Number.isFinite(plane[index]) ? plane[index] - mean : 0;
  return result;
}

function correlationScore(reference: Float32Array, target: Float32Array, width: number, height: number, dx: number, dy: number, margin: number, step: number): number {
  let sum = 0;
  let referencePower = 0;
  let targetPower = 0;
  let count = 0;
  for (let y = margin; y < height - margin; y += step) {
    const targetY = y + dy;
    for (let x = margin; x < width - margin; x += step) {
      const targetX = x + dx;
      const referenceValue = reference[y * width + x];
      const targetValue = target[targetY * width + targetX];
      sum += referenceValue * targetValue;
      referencePower += referenceValue * referenceValue;
      targetPower += targetValue * targetValue;
      count++;
    }
  }
  const denominator = Math.sqrt(referencePower * targetPower);
  return count > 0 && denominator > Number.EPSILON ? sum / denominator : -Infinity;
}

/**
 * Translation-only frame registration via brute-force zero-mean cross-correlation, searched
 * coarse-to-fine: a wide search on a downsampled plane, refined with a small local search at
 * full resolution. Subtracting each plane's own mean before correlating lines frames up on
 * structure rather than overall brightness, so a different sky background or exposure between
 * frames doesn't bias the match. Only the starting point for frames without a plate solution:
 * registerFrame adds rotation (and any residual) from matched stars.
 */
function estimateTranslation(rawReference: Float32Array, rawTarget: Float32Array, width: number, height: number): { dx: number; dy: number } {
  if (Math.min(width, height) < 16) return { dx: 0, dy: 0 };
  const reference = zeroMean(rawReference);
  const target = zeroMean(rawTarget);
  const referenceEnergy = reference.reduce((sum, value) => sum + value * value, 0);
  const targetEnergy = target.reduce((sum, value) => sum + value * value, 0);
  // A flat frame contains no registration information. Do not invent an offset from
  // numerical ties: keeping its original grid is safer than moving it arbitrarily.
  if (referenceEnergy <= Number.EPSILON && targetEnergy <= Number.EPSILON) return { dx: 0, dy: 0 };
  if (referenceEnergy <= Number.EPSILON || targetEnergy <= Number.EPSILON) {
    throw new Error('Could not reliably register FITS frame: one frame has no image structure');
  }
  const coarseMax = 192;
  const coarseReference = downsample(reference, width, height, coarseMax);
  const coarseTarget = downsample(target, width, height, coarseMax);
  const coarseShift = Math.max(4, Math.round(Math.min(coarseReference.width, coarseReference.height) * 0.08));
  const coarseMargin = coarseShift;
  let best = { dx: 0, dy: 0, score: -Infinity };
  for (let dy = -coarseShift; dy <= coarseShift; dy++) {
    for (let dx = -coarseShift; dx <= coarseShift; dx++) {
      if (coarseMargin + dx < 0 || coarseMargin - dx < 0 || coarseMargin + dy < 0 || coarseMargin - dy < 0) continue;
      const score = correlationScore(coarseReference.plane, coarseTarget.plane, coarseReference.width, coarseReference.height, dx, dy, coarseMargin, 1);
      if (score > best.score) best = { dx, dy, score };
    }
  }
  if (!Number.isFinite(best.score) || best.score < 0.05) {
    throw new Error('Could not reliably register FITS frame: insufficient shared image structure');
  }
  const scale = coarseReference.factor;
  const roughDx = best.dx * scale;
  const roughDy = best.dy * scale;

  const refineRadius = Math.max(2, Math.round(2 / scale));
  const refineMargin = Math.max(refineRadius, Math.round(Math.min(width, height) * 0.1));
  let refined = { dx: roughDx, dy: roughDy, score: -Infinity };
  for (let dy = roughDy - refineRadius; dy <= roughDy + refineRadius; dy++) {
    for (let dx = roughDx - refineRadius; dx <= roughDx + refineRadius; dx++) {
      if (refineMargin + dx < 0 || refineMargin - dx < 0 || refineMargin + dy < 0 || refineMargin - dy < 0) continue;
      const step = Math.max(1, Math.round(Math.min(width, height) / 256));
      const score = correlationScore(reference, target, width, height, dx, dy, refineMargin, step);
      if (score > refined.score) refined = { dx, dy, score };
    }
  }
  return { dx: refined.dx, dy: refined.dy };
}

function headerWcs(metadata: FitsMetadata): WcsSolution | null {
  try {
    return metadata.headers.CRVAL1 === undefined ? null : parseWcsHeaders(metadata.headers, metadata.width, metadata.height);
  } catch {
    return null;
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function combineSamples(samples: number[], method: StackMethod, sigmaClipThreshold: number): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0];
  if (method === 'median') return medianOf(samples);
  if (method === 'sigma-clip') {
    // Rejects against the median and its MAD (scaled by the standard 1.4826 factor into a
    // robust sigma estimate) rather than the mean/stddev: with only a handful of frames, a
    // single outlier drags the mean and stddev along with it, which would otherwise hide it
    // from its own rejection test.
    let kept = samples;
    for (let pass = 0; pass < 5 && kept.length > 2; pass++) {
      const median = medianOf(kept);
      const mad = medianOf(kept.map(value => Math.abs(value - median)));
      const scale = Math.max(mad * 1.4826, Number.EPSILON);
      const next = kept.filter(value => Math.abs(value - median) <= sigmaClipThreshold * scale);
      if (next.length === kept.length || next.length < 2) break;
      kept = next;
    }
    return kept.reduce((sum, value) => sum + value, 0) / kept.length;
  }
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

/**
 * Stacks FITS frames onto the first frame's pixel grid and combines each pixel with mean, median or
 * sigma-clipped mean (the rejection Siril uses against satellite trails, cosmic rays and other
 * one-frame outliers).
 *
 * Registration is sub-pixel and geometric: every frame is resampled (Catmull-Rom bicubic) through
 * its own WCS — rotation, scale and SIP distortion included — refined with stars matched to the
 * reference; frames without a plate solution start from a cross-correlation translation and the
 * star fit adds rotation. Exact duplicate frames are skipped, frames whose stars cannot be lined up
 * are rejected with a reason, and the residual of every frame is written to the header.
 */
export async function stackFits(filePaths: string[], outputPath: string, settings: StackSettings = {}): Promise<StackResult> {
  if (filePaths.length < 2) throw new Error('Stacking requires at least two FITS frames');
  const method = settings.method ?? 'sigma-clip';
  const sigmaClipThreshold = Math.max(0.5, settings.sigmaClipThreshold ?? 3);
  const register = settings.register ?? true;
  const names = filePaths.map((filePath, index) => settings.frameNames?.[index] || path.basename(filePath));

  const loaded = await Promise.all(filePaths.map(async filePath => {
    const metadata = await readFitsMetadata(filePath);
    const file = await readFile(filePath);
    const pixels = readPixels(file, metadata);
    const hash = createHash('sha1').update(new Uint8Array(pixels.buffer)).digest('hex');
    return { metadata, pixels, hash };
  }));

  const reference = loaded[0].metadata;
  const warnings: string[] = [];
  const reports: FrameReport[] = names.map(name => ({ name, used: false }));
  const seen = new Map<string, number>();
  const candidates: number[] = [];
  loaded.forEach((frame, index) => {
    if (frame.metadata.channels !== reference.channels) throw new Error('All frames must have the same number of colour channels to stack');
    if (!register && (frame.metadata.width !== reference.width || frame.metadata.height !== reference.height)) {
      throw new Error('All frames must share the same dimensions to stack without alignment');
    }
    const duplicate = seen.get(frame.hash);
    if (duplicate !== undefined) {
      reports[index].reason = `identical pixels to frame ${duplicate + 1} (${names[duplicate]}): duplicate skipped`;
      reports[index].method = 'none';
      warnings.push(`${names[index]}: ${reports[index].reason}`);
      return;
    }
    seen.set(frame.hash, index);
    candidates.push(index);
  });
  if (candidates.length < 2) throw new Error('Stacking needs at least two different frames: the selection only contains duplicates');

  const normalizedHeaderValue = (value: unknown) => String(value ?? '').trim().toLowerCase();
  const frames = candidates.map(index => loaded[index]);
  for (const key of ['FILTER', 'BUNIT']) {
    const values = frames.map(frame => normalizedHeaderValue(frame.metadata.headers[key]));
    if (values.some(Boolean) && values.some(value => !value || value !== values[0])) {
      throw new Error(`All frames must have the same ${key} to stack scientifically`);
    }
  }
  const exposureOf = (metadata: FitsMetadata) => {
    const value = metadata.headers.EXPTIME;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  const exposureValues = frames.map(frame => exposureOf(frame.metadata));
  if (exposureValues.some(Boolean) && exposureValues.some(value => value == null)) {
    throw new Error('Either every frame must have a valid EXPTIME or none may specify one');
  }
  const referenceExposure = exposureValues[0];
  const brightnessUnit = normalizedHeaderValue(reference.headers.BUNIT);
  const alreadyRateCalibrated = /(?:\/s|s\^-1|s-1|\/sec|sec\^-1|sec-1)$/.test(brightnessUnit);
  const surfaceBrightness = /(\/sr|sr-1|sr\*\*-1|\/arcsec2|arcsec-2|deg-2)/.test(brightnessUnit.replace(/\s/g, ''));

  const { width, height, channels } = reference;
  const planeSize = width * height;
  // The FITS header's own solution first; otherwise the latest stored plate solve of that frame.
  const wcsOf = (index: number) => {
    const fromHeader = headerWcs(loaded[index].metadata);
    if (fromHeader) return fromHeader;
    const stored = settings.frameWcs?.[index];
    const { width: frameWidth, height: frameHeight } = loaded[index].metadata;
    return stored && stored.imageWidth === frameWidth && stored.imageHeight === frameHeight ? stored : null;
  };
  const referenceWcs = wcsOf(0);
  const saturationOf = (metadata: FitsMetadata) => {
    const value = metadata.headers.SATURATE ?? metadata.headers.SATLEVEL;
    return typeof value === 'number' && value > 0 ? value : undefined;
  };
  const referenceLuminance = luminancePlane(loaded[0].pixels, reference);
  const referenceStars = register ? detectStars(referenceLuminance, width, height, 400, saturationOf(reference)) : [];

  interface Source { pixels: Float64Array; width: number; height: number; scale: number; registration: Registration | null }
  const sources: Source[] = [];
  const offsets: { dx: number; dy: number }[] = [];
  for (const index of candidates) {
    const frame = loaded[index];
    const exposure = exposureOf(frame.metadata);
    const fluxScale = !alreadyRateCalibrated && referenceExposure && exposure ? referenceExposure / exposure : 1;
    if (index === 0 || !register) {
      sources.push({ pixels: frame.pixels, width: frame.metadata.width, height: frame.metadata.height, scale: fluxScale, registration: null });
      reports[index] = { ...reports[index], used: true, method: index === 0 ? 'reference' : 'none', dx: 0, dy: 0 };
      offsets.push({ dx: 0, dy: 0 });
      continue;
    }
    try {
      const frameLuminance = luminancePlane(frame.pixels, frame.metadata);
      const registration = registerFrame({
        width, height, referenceStars,
        frameStars: detectStars(frameLuminance, frame.metadata.width, frame.metadata.height, 400, saturationOf(frame.metadata)),
        referenceWcs, frameWcs: wcsOf(index),
        translation: () => {
          if (frame.metadata.width !== width || frame.metadata.height !== height) {
            throw new Error('it has a different size and no plate solution; plate-solve it to align it');
          }
          return estimateTranslation(referenceLuminance, frameLuminance, width, height);
        },
      });
      const [cx, cy] = registration.map((width - 1) / 2, (height - 1) / 2);
      const dx = Math.round((cx - (width - 1) / 2) * 100) / 100;
      const dy = Math.round((cy - (height - 1) / 2) * 100) / 100;
      // Flux per output pixel: a reference pixel covers `areaRatio` frame pixels (≈1 for one camera).
      const area = surfaceBrightness ? 1 : registration.areaRatio((width - 1) / 2, (height - 1) / 2);
      sources.push({ pixels: frame.pixels, width: frame.metadata.width, height: frame.metadata.height, scale: fluxScale * area, registration });
      reports[index] = { ...reports[index], used: true, method: registration.method, matchedStars: registration.matchedStars, rmsPx: registration.rmsPx, dx, dy };
      offsets.push({ dx, dy });
      if (registration.rmsPx === null) {
        warnings.push(`${names[index]}: too few stars to verify the alignment; used its ${registration.method === 'wcs' ? 'plate solution' : 'cross-correlation shift'} only`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reports[index] = { ...reports[index], used: false, method: 'none', reason: `not aligned: ${reason}` };
      warnings.push(`${names[index]}: excluded, ${reason}`);
    }
  }
  if (sources.length < 2) {
    throw new Error(`Fewer than two frames could be aligned. ${warnings.join(' · ')}`);
  }

  const stacked = new Float64Array(planeSize * channels);
  const samples: number[] = new Array(sources.length);
  const mapped = new Float64Array(sources.length * 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let s = 0; s < sources.length; s++) {
        const registration = sources[s].registration;
        if (registration) {
          const [fx, fy] = registration.map(x, y);
          mapped[2 * s] = fx;
          mapped[2 * s + 1] = fy;
        } else {
          mapped[2 * s] = x;
          mapped[2 * s + 1] = y;
        }
      }
      for (let channel = 0; channel < channels; channel++) {
        let count = 0;
        for (let s = 0; s < sources.length; s++) {
          const source = sources[s];
          const sourcePlane = source.width * source.height;
          const value = source.registration
            ? bicubic(source.pixels, channel * sourcePlane, source.width, source.height, mapped[2 * s], mapped[2 * s + 1])
            : source.pixels[channel * sourcePlane + y * source.width + x];
          if (Number.isFinite(value)) samples[count++] = value * source.scale;
        }
        stacked[channel * planeSize + y * width + x] = count > 0
          ? combineSamples(samples.slice(0, count), method, sigmaClipThreshold)
          : Number.NaN;
      }
    }
  }

  const cards = [
    fitsCard('SIMPLE', 'T'),
    fitsCard('BITPIX', '-32'),
    fitsCard('NAXIS', String(channels === 1 ? 2 : 3)),
    fitsCard('NAXIS1', String(width)),
    fitsCard('NAXIS2', String(height)),
  ];
  if (channels === 3) cards.push(fitsCard('NAXIS3', '3'));
  // Observatory keywords let HOTPANTS's SkyBoT check use the right site; GAIN/RDNOISE/SATURATE describe the noise model.
  for (const key of ['OBJECT', 'DATE-OBS', 'MJD-OBS', 'INSTRUME', 'TELESCOP', 'FILTER', 'FOCALLEN', 'XPIXSZ', 'YPIXSZ',
    'GAIN', 'RDNOISE', 'SATURATE', 'SITEID', 'SITE', 'MPCCODE', 'OBSCODE', 'LATITUDE', 'LONGITUD', 'HEIGHT']) {
    const value = copyHeaderValue(reference.headers, key);
    if (value !== undefined) cards.push(fitsCard(key, value));
  }
  if (referenceExposure) cards.push(fitsCard('EXPTIME', String(referenceExposure)));
  // Every frame is resampled onto the reference frame's pixel grid, so the reference's complete
  // celestial WCS (including distortion terms) describes the stack.
  if (!headerWcs(reference) && referenceWcs) {
    for (const card of wcsCards(referenceWcs)) cards.push(card);
  } else {
    for (const rawCard of reference.cards) {
      const key = rawCard.slice(0, 8).trim();
      if (/^(CTYPE|CRPIX|CRVAL|CUNIT|CDELT|CROTA|CD\d|PC\d|WCSAXES|RADESYS|EQUINOX|LONPOLE|LATPOLE|PV\d|PS\d|A_|B_|AP_|BP_|A_ORDER|B_ORDER|AP_ORDER|BP_ORDER)/.test(key)) {
        cards.push(rawCard);
      }
    }
  }
  cards.push(fitsCard('NCOMBINE', String(sources.length)));
  cards.push(fitsCard('HISTORY', `AstroviaBin stack of ${sources.length} frames (method=${method})`));
  cards.push(fitsCard('HISTORY', 'Sub-pixel registration: WCS (TAN-SIP) + matched-star polynomial, bicubic'));
  reports.forEach((report, index) => {
    const detail = report.used
      ? `${report.method}${report.matchedStars ? ` ${report.matchedStars} stars` : ''}${report.rmsPx != null ? ` rms ${report.rmsPx} px` : ''}${report.dx !== undefined ? ` dx=${report.dx} dy=${report.dy}` : ''}`
      : `excluded: ${report.reason ?? ''}`;
    cards.push(fitsCard('HISTORY', `frame ${index}: ${detail}`.slice(0, 72)));
  });
  cards.push(fitsCard('END'));
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - header.length, ' ')]);

  const data = Buffer.alloc(stacked.length * 4);
  for (let index = 0; index < stacked.length; index++) data.writeFloatBE(stacked[index], index * 4);
  const paddedData = Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - data.length)]);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat([paddedHeader, paddedData]));
  return { metadata: await readFitsMetadata(outputPath), frameCount: sources.length, offsets, frames: reports, warnings };
}

/** FITS cards for a stored WCS solution (TAN, plus SIP when present). */
function wcsCards(wcs: WcsSolution): string[] {
  const number = (value: number) => value.toExponential(12).toUpperCase();
  const cards = [
    fitsCard('CTYPE1', wcs.sip ? "'RA---TAN-SIP'" : "'RA---TAN'"), fitsCard('CTYPE2', wcs.sip ? "'DEC--TAN-SIP'" : "'DEC--TAN'"),
    fitsCard('CRPIX1', number(wcs.crpix1)), fitsCard('CRPIX2', number(wcs.crpix2)),
    fitsCard('CRVAL1', number(wcs.crval1)), fitsCard('CRVAL2', number(wcs.crval2)),
    fitsCard('CD1_1', number(wcs.cd11)), fitsCard('CD1_2', number(wcs.cd12)),
    fitsCard('CD2_1', number(wcs.cd21)), fitsCard('CD2_2', number(wcs.cd22)),
  ];
  if (wcs.sip) {
    for (const [prefix, poly] of [['A', wcs.sip.a], ['B', wcs.sip.b], ['AP', wcs.sip.ap], ['BP', wcs.sip.bp]] as const) {
      if (!poly) continue;
      cards.push(fitsCard(`${prefix}_ORDER`, String(poly.order)));
      for (const [key, value] of Object.entries(poly.terms)) cards.push(fitsCard(`${prefix}_${key}`, number(value)));
    }
  }
  return cards;
}

/**
 * stackFits in a worker thread: resampling millions of pixels per frame takes tens of seconds,
 * which must not freeze the web server. Uses dist/stack-thread.js in production and the
 * TypeScript source under tsx in development.
 */
export function runStackInThread(filePaths: string[], outputPath: string, settings: StackSettings = {}): Promise<StackResult> {
  const source = import.meta.url.endsWith('.ts');
  const url = source ? new URL('../workers/stack-thread.ts', import.meta.url) : new URL('./stack-thread.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { workerData: { filePaths, outputPath, settings }, execArgv: source ? ['--import', 'tsx'] : undefined });
    worker.once('message', (message: { ok: boolean; result?: StackResult; error?: string }) => {
      if (message.ok && message.result) resolve(message.result);
      else reject(new Error(message.error || 'Stacking failed'));
    });
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`Stacking thread exited with code ${code}`)); });
  });
}
