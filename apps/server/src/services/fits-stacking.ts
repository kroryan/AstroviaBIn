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

export type StackMethod = 'mean' | 'median' | 'sigma-clip';

export interface StackSettings {
  method?: StackMethod;
  /** Standard deviations from the mean beyond which a sample is rejected, for the 'sigma-clip' method. */
  sigmaClipThreshold?: number;
  /** Align frames to the first one before combining (translation only). Defaults to true. */
  register?: boolean;
}

export interface StackResult {
  metadata: FitsMetadata;
  frameCount: number;
  offsets: { dx: number; dy: number }[];
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

/** Area-average downsample, used only to make registration search affordable on large frames. */
function downsample(plane: Float32Array, width: number, height: number, maxDimension: number): { plane: Float32Array; width: number; height: number; scale: number } {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale >= 1) return { plane, width, height, scale: 1 };
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  const result = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale));
      result[y * outWidth + x] = plane[sourceY * width + sourceX];
    }
  }
  return { plane: result, width: outWidth, height: outHeight, scale: outWidth / width };
}

/** Cross-correlation score between `reference` and `target` shifted by (dx, dy), sampled on a grid for speed. */
/** Subtracts the plane's own mean, so correlation lines up structure rather than overall brightness. */
function zeroMean(plane: Float32Array): Float32Array {
  let sum = 0;
  for (let index = 0; index < plane.length; index++) sum += plane[index];
  const mean = sum / plane.length;
  const result = new Float32Array(plane.length);
  for (let index = 0; index < plane.length; index++) result[index] = plane[index] - mean;
  return result;
}

function correlationScore(reference: Float32Array, target: Float32Array, width: number, height: number, dx: number, dy: number, margin: number, step: number): number {
  let sum = 0;
  let count = 0;
  for (let y = margin; y < height - margin; y += step) {
    const targetY = y + dy;
    for (let x = margin; x < width - margin; x += step) {
      const targetX = x + dx;
      sum += reference[y * width + x] * target[targetY * width + targetX];
      count++;
    }
  }
  return count > 0 ? sum / count : -Infinity;
}

/**
 * Translation-only frame registration via brute-force zero-mean cross-correlation, searched
 * coarse-to-fine: a wide search on a downsampled plane, refined with a small local search at
 * full resolution. Subtracting each plane's own mean before correlating lines frames up on
 * structure rather than overall brightness, so a different sky background or exposure between
 * frames doesn't bias the match. This purposefully stops at translation (no rotation/scale) —
 * full astrometric registration already exists through the Astrometry.net plate-solving workflow.
 */
function estimateTranslation(rawReference: Float32Array, rawTarget: Float32Array, width: number, height: number): { dx: number; dy: number } {
  const reference = zeroMean(rawReference);
  const target = zeroMean(rawTarget);
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
  const scale = coarseReference.scale;
  const roughDx = Math.round(best.dx / scale);
  const roughDy = Math.round(best.dy / scale);

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
 * Stacks several same-sized FITS frames into one, aligning them (translation only) against the
 * first frame and combining each pixel with mean / median / sigma-clipped mean, the same
 * rejection idea Siril's stacking tool uses to reject satellite trails, cosmic rays, and other
 * one-frame outliers.
 */
export async function stackFits(filePaths: string[], outputPath: string, settings: StackSettings = {}): Promise<StackResult> {
  if (filePaths.length < 2) throw new Error('Stacking requires at least two FITS frames');
  const method = settings.method ?? 'sigma-clip';
  const sigmaClipThreshold = Math.max(0.5, settings.sigmaClipThreshold ?? 3);
  const register = settings.register ?? true;

  const frames = await Promise.all(filePaths.map(async filePath => {
    const metadata = await readFitsMetadata(filePath);
    const file = await readFile(filePath);
    return { metadata, pixels: readPixels(file, metadata) };
  }));

  const reference = frames[0].metadata;
  for (const frame of frames) {
    if (frame.metadata.width !== reference.width || frame.metadata.height !== reference.height || frame.metadata.channels !== reference.channels) {
      throw new Error('All frames must share the same dimensions and channel count to stack');
    }
  }

  const { width, height, channels } = reference;
  const planeSize = width * height;
  const referenceLuminance = luminancePlane(frames[0].pixels, reference);
  const offsets = frames.map((frame, index) => {
    if (!register || index === 0) return { dx: 0, dy: 0 };
    return estimateTranslation(referenceLuminance, luminancePlane(frame.pixels, frame.metadata), width, height);
  });

  const stacked = new Float64Array(planeSize * channels);
  const samples: number[] = new Array(frames.length);
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * planeSize;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let count = 0;
        for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
          const sourceX = x - offsets[frameIndex].dx;
          const sourceY = y - offsets[frameIndex].dy;
          if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) continue;
          samples[count++] = frames[frameIndex].pixels[base + sourceY * width + sourceX];
        }
        stacked[base + y * width + x] = combineSamples(samples.slice(0, count), method, sigmaClipThreshold);
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
  for (const key of ['OBJECT', 'DATE-OBS', 'INSTRUME', 'TELESCOP', 'FILTER', 'FOCALLEN', 'XPIXSZ', 'YPIXSZ']) {
    const value = copyHeaderValue(reference.headers, key);
    if (value !== undefined) cards.push(fitsCard(key, value));
  }
  cards.push(fitsCard('HISTORY', `AstroviaBin stack of ${frames.length} frames (method=${method})`));
  for (let index = 0; index < offsets.length; index++) {
    cards.push(fitsCard('HISTORY', `frame ${index}: dx=${offsets[index].dx} dy=${offsets[index].dy}`));
  }
  cards.push(fitsCard('END'));
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - header.length, ' ')]);

  const data = Buffer.alloc(stacked.length * 4);
  for (let index = 0; index < stacked.length; index++) data.writeFloatBE(stacked[index], index * 4);
  const paddedData = Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - data.length)]);

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat([paddedHeader, paddedData]));
  return { metadata: await readFitsMetadata(outputPath), frameCount: frames.length, offsets };
}
