import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

export const FITS_PATH_PREFIX = 'fits://';
export const FITS_DERIVED_PATH_PREFIX = 'fits-derived://';
export const FITS_UPLOAD_PATH_PREFIX = 'fits-upload://';
export const FITS_BLOCK_SIZE = 2880;
export const FITS_CARD_SIZE = 80;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PROCESS_BYTES = 1024 * 1024 * 1024;
const FITS_TILE_SIZE = 256;
const FITS_RANGE_CACHE_MAX = 32;
const fitsRangeJobs = new Map<string, Promise<ProcessingRanges>>();
const fitsTileJobs = new Map<string, Promise<Buffer>>();

export type FitsStretch = 'linear' | 'asinh' | 'log' | 'gamma' | 'mtf' | 'sqrt' | 'square';
export type FitsColorMap = 'original' | 'grey' | 'inverted' | 'heat' | 'cool' | 'rainbow' | 'viridis';

export interface FitsProcessingSettings {
  stretch?: FitsStretch;
  blackPoint?: number;
  whitePoint?: number;
  shadowPercentile?: number;
  highlightPercentile?: number;
  strength?: number;
  gamma?: number;
  /** Target midtone balance for the 'mtf' stretch, in the (0, 1) range. 0.5 is linear. */
  midtones?: number;
  saturation?: number;
  redBalance?: number;
  greenBalance?: number;
  blueBalance?: number;
  backgroundNeutralization?: boolean;
  /** Subtractive Chromatic Noise Reduction strength (0 = off, 1 = full average-neutral correction). */
  scnrAmount?: number;
  /** Luminance unsharp mask strength (0 = off). */
  sharpenAmount?: number;
  /** Unsharp mask blur radius in pixels. */
  sharpenRadius?: number;
  /** Large-scale gradient (light pollution / vignetting) removal strength (0 = off). */
  backgroundExtractionAmount?: number;
  /** Blend of a local blur used for simple noise reduction (0 = off). */
  denoiseAmount?: number;
  /** Noise reduction blur radius in pixels. */
  denoiseRadius?: number;
  /** Cosmetic correction: sigma multiplier over the local median for hot/cold pixel rejection (0 = off). */
  hotPixelThreshold?: number;
  /**
   * Display-only false colour palette applied to the rendered preview. Never baked into a
   * saved FITS derivative, which always keeps its real per-channel pixel data.
   */
  colorMap?: FitsColorMap;
}

export interface FitsMetadata {
  cards: string[];
  headers: Record<string, string | number | boolean>;
  dataOffset: number;
  width: number;
  height: number;
  channels: number;
  bitpix: number;
  bscale: number;
  bzero: number;
  pixelCount: number;
}

export async function readFitsHeader(filePath: string): Promise<Record<string, string | number | boolean>> {
  const source = await stat(filePath);
  return (await readFitsHeaderCards(filePath, source.size)).headers;
}

interface ParsedFitsHeader {
  cards: string[];
  headers: Record<string, string | number | boolean>;
  endOffset: number;
}

/** Read complete FITS blocks until END, without assuming the header fits in a single 1 MiB read. */
async function readFitsHeaderCards(filePath: string, sourceSize: number): Promise<ParsedFitsHeader> {
  const cards: string[] = [];
  const headers: Record<string, string | number | boolean> = {};
  const block = Buffer.alloc(FITS_BLOCK_SIZE);
  const limit = Math.min(sourceSize, MAX_HEADER_BYTES);
  const handle = await open(filePath, 'r');
  try {
    for (let blockOffset = 0; blockOffset + FITS_BLOCK_SIZE <= limit; blockOffset += FITS_BLOCK_SIZE) {
      let bytesRead = 0;
      while (bytesRead < FITS_BLOCK_SIZE) {
        const result = await handle.read(block, bytesRead, FITS_BLOCK_SIZE - bytesRead, blockOffset + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead !== FITS_BLOCK_SIZE) break;

      for (let offset = 0; offset < FITS_BLOCK_SIZE; offset += FITS_CARD_SIZE) {
        const card = block.subarray(offset, offset + FITS_CARD_SIZE).toString('ascii');
        cards.push(card);
        const key = card.slice(0, 8).trim();
        if (key === 'END') return { cards, headers, endOffset: blockOffset + offset + FITS_CARD_SIZE };
        if (key && card[8] === '=') headers[key] = parseFitsValue(card.slice(10).split(/\s\/\s/)[0] || '');
      }
    }
  } finally {
    await handle.close();
  }
  if (sourceSize > MAX_HEADER_BYTES) {
    throw new Error(`Invalid FITS file: header exceeds the ${MAX_HEADER_BYTES / 1024 / 1024} MiB safety limit without END`);
  }
  throw new Error(`Invalid FITS file: missing END header card after scanning ${cards.length * FITS_CARD_SIZE} header bytes (${sourceSize} file bytes)`);
}

export interface FitsPreview {
  buffer: Buffer;
  metadata: FitsMetadata;
  width: number;
  height: number;
}

export type FitsSource = 'source' | 'derived' | 'upload';

function parseFitsValue(raw: string): string | number | boolean {
  const value = raw.trim();
  if (value === 'T') return true;
  if (value === 'F') return false;
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return (end === -1 ? value.slice(1) : value.slice(1, end)).replace(/''/g, "'").trim();
  }
  const numeric = Number(value.replace(/D/gi, 'E'));
  return Number.isFinite(numeric) ? numeric : value;
}

function requiredNumber(headers: Record<string, string | number | boolean>, name: string): number {
  const value = headers[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`FITS header ${name} is required and must be numeric`);
  }
  return value;
}

function bytesPerPixel(bitpix: number): number {
  const bytes = Math.abs(bitpix) / 8;
  if (!Number.isInteger(bytes) || ![8, 16, 32, 64, -32, -64].includes(bitpix)) {
    throw new Error(`Unsupported FITS BITPIX value: ${bitpix}`);
  }
  return bytes;
}

function maxProcessBytes(): number {
  const configured = Number(process.env.FITS_MAX_PROCESS_BYTES || DEFAULT_MAX_PROCESS_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PROCESS_BYTES;
}

export async function readFitsMetadata(filePath: string): Promise<FitsMetadata> {
  const source = await stat(filePath);
  const { cards, headers, endOffset } = await readFitsHeaderCards(filePath, source.size);
  if (headers.SIMPLE !== true && headers.XTENSION !== 'IMAGE') {
    throw new Error('Unsupported FITS file: primary HDU is not an image');
  }

  const width = requiredNumber(headers, 'NAXIS1');
  const height = requiredNumber(headers, 'NAXIS2');
  const naxis = requiredNumber(headers, 'NAXIS');
  const channels = naxis >= 3 ? requiredNumber(headers, 'NAXIS3') : 1;
  const bitpix = requiredNumber(headers, 'BITPIX');
  const bscale = typeof headers.BSCALE === 'number' ? headers.BSCALE : 1;
  const bzero = typeof headers.BZERO === 'number' ? headers.BZERO : 0;

  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(channels) || width < 1 || height < 1 || channels < 1) {
    throw new Error('Invalid FITS image dimensions');
  }
  if (channels !== 1 && channels !== 3) {
    throw new Error(`Unsupported FITS channel count: ${channels}. Only mono and RGB FITS are supported.`);
  }

  const pixelCount = width * height * channels;
  if (!Number.isSafeInteger(pixelCount) || !Number.isSafeInteger(pixelCount * bytesPerPixel(bitpix))) {
    throw new Error('FITS image dimensions exceed supported file offsets');
  }
  const dataOffset = Math.ceil(endOffset / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE;
  if (dataOffset + pixelCount * bytesPerPixel(bitpix) > source.size) {
    throw new Error('Invalid FITS file: image data is truncated');
  }

  return { cards, headers, dataOffset, width, height, channels, bitpix, bscale, bzero, pixelCount };
}

function readValue(file: Buffer, offset: number, bitpix: number): number {
  switch (bitpix) {
    case 8: return file.readUInt8(offset);
    case 16: return file.readInt16BE(offset);
    case 32: return file.readInt32BE(offset);
    case 64: return Number(file.readBigInt64BE(offset));
    case -32: return file.readFloatBE(offset);
    case -64: return file.readDoubleBE(offset);
    default: throw new Error(`Unsupported FITS BITPIX value: ${bitpix}`);
  }
}

export function readPixels(file: Buffer, metadata: FitsMetadata): Float64Array {
  if (metadata.pixelCount * bytesPerPixel(metadata.bitpix) > maxProcessBytes()) {
    throw new Error('FITS derivative processing exceeds FITS_MAX_PROCESS_BYTES; previews and zoom remain available.');
  }
  const result = new Float64Array(metadata.pixelCount);
  const bytes = bytesPerPixel(metadata.bitpix);
  for (let index = 0; index < metadata.pixelCount; index++) {
    const value = readValue(file, metadata.dataOffset + index * bytes, metadata.bitpix);
    result[index] = Number.isFinite(value) ? value * metadata.bscale + metadata.bzero : Number.NaN;
  }
  return result;
}

function sortedSample(values: Float64Array): number[] {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 200_000));
  for (let index = 0; index < values.length; index += step) {
    const value = values[index];
    if (Number.isFinite(value)) sample.push(value);
  }
  if (sample.length === 0) throw new Error('FITS image contains no finite pixel values');
  return sample.sort((left, right) => left - right);
}

function atPercentile(sorted: number[], percentileValue: number): number {
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * percentileValue)))];
}

/**
 * Display black point: the shadow-clipping percentile, but never below the sky background minus 2.8σ
 * (σ from the median absolute deviation) — the screen-transfer auto-stretch rule of PixInsight/Siril.
 * Blank borders (0 after registration), dead pixels or a pedestal would otherwise pull the black
 * point far below the sky and wash the background out (with a colour cast when the channels' skies
 * differ). For ordinary frames the percentile already lies at about this level, so nothing changes.
 */
/**
 * Display white point: the highlight percentile, but never closer to the black point than ten times the
 * sky's distance from it, so the sky lands at about 10% before the stretch curve (≈25–30% after the
 * default asinh, like PixInsight's auto-stretch). In mostly empty fields the 99.5th percentile is barely
 * above the sky and would otherwise turn the background bright grey; fields with real signal are
 * unaffected because their percentile is far higher.
 */
export function whitePoint(sorted: number[], highlightPercentile: number, black: number): number {
  const median = atPercentile(sorted, 0.5);
  return Math.max(atPercentile(sorted, highlightPercentile), black + 10 * (median - black));
}

export function blackPoint(sorted: number[], shadowPercentile: number): number {
  const median = atPercentile(sorted, 0.5);
  const deviations = sorted.map(value => Math.abs(value - median)).sort((left, right) => left - right);
  const sigma = 1.4826 * atPercentile(deviations, 0.5);
  return Math.max(atPercentile(sorted, shadowPercentile), median - 2.8 * sigma);
}

function normalized(value: number, low: number, high: number): number {
  return Math.max(0, Math.min(1, (value - low) / Math.max(high - low, Number.EPSILON)));
}

function transfer(value: number, settings: FitsProcessingSettings): number {
  const stretch = settings.stretch || 'asinh';
  // Matches the semantics used by Siril: asinh has a beta >= 1, while the
  // logarithmic curve has its own positive gain. Gamma is independent.
  if (stretch === 'asinh') {
    const beta = Math.max(1, settings.strength ?? 10);
    return Math.asinh(value * beta) / Math.asinh(beta);
  }
  if (stretch === 'log') {
    const gain = Math.max(0.01, settings.strength ?? 10);
    return Math.log1p(value * gain) / Math.log1p(gain);
  }
  if (stretch === 'gamma') return Math.pow(value, 1 / Math.max(0.01, settings.gamma ?? 2.2));
  if (stretch === 'sqrt') return Math.sqrt(value);
  if (stretch === 'square') return value * value;
  if (stretch === 'mtf') {
    // PixInsight/Siril's midtones transfer function: a single "midtones balance"
    // parameter reshapes the curve, with 0.5 as the linear midpoint.
    const midtones = Math.max(0.001, Math.min(0.999, settings.midtones ?? 0.25));
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return ((midtones - 1) * value) / ((2 * midtones - 1) * value - midtones);
  }
  return value;
}

interface ProcessingRanges { low: number[]; high: number[]; }

function processingRanges(pixels: Float64Array, metadata: FitsMetadata, settings: FitsProcessingSettings): ProcessingRanges {
  const shadowPercentile = Math.max(0, Math.min(0.5, settings.shadowPercentile ?? (settings.backgroundNeutralization ? 0.01 : 0.005)));
  const highlightPercentile = Math.max(0.5, Math.min(1, settings.highlightPercentile ?? 0.995));
  const shared = settings.blackPoint === undefined || settings.whitePoint === undefined ? sortedSample(pixels) : [];
  const sharedLow = settings.blackPoint ?? blackPoint(shared, shadowPercentile);
  const sharedHigh = settings.whitePoint ?? whitePoint(shared, highlightPercentile, sharedLow);
  const low = Array.from({ length: metadata.channels }, () => sharedLow);
  const high = Array.from({ length: metadata.channels }, () => sharedHigh);
  if (settings.backgroundNeutralization && metadata.channels === 3) {
    const planeSize = metadata.width * metadata.height;
    const sky: number[] = [];
    for (let channel = 0; channel < metadata.channels; channel++) {
      const plane = sortedSample(pixels.subarray(channel * planeSize, (channel + 1) * planeSize));
      low[channel] = settings.blackPoint ?? blackPoint(plane, shadowPercentile);
      high[channel] = settings.whitePoint ?? whitePoint(plane, highlightPercentile, low[channel]);
      sky[channel] = atPercentile(plane, 0.5);
    }
    return neutralRanges(low, high, sky, settings.blackPoint !== undefined);
  }
  return { low, high };
}

/**
 * Background neutralization: every channel's sky (median) is placed at the same distance above its
 * black point and every channel uses the same range, so the sky becomes neutral while objects keep
 * their real colour ratios. (Stretching each channel to its own black and white points, as before,
 * recoloured the whole image — e.g. an orange or magenta sky.) With fixed black points, they win.
 */
function neutralRanges(low: number[], high: number[], sky: number[], fixedBlack = false): ProcessingRanges {
  const offset = fixedBlack ? 0 : Math.max(0, Math.min(...sky.map((value, channel) => value - low[channel])));
  const black = fixedBlack ? low : sky.map(value => value - offset);
  const range = Math.max(...high.map((value, channel) => value - black[channel]), Number.EPSILON);
  return { low: black, high: black.map(value => value + range) };
}

/**
 * Writes the processed value(s) for one pixel into `output` (sized to metadata.channels).
 * Takes a reused scratch buffer instead of returning a new array: at multi-megapixel native
 * resolutions, allocating a handful of small arrays per pixel (the previous approach) spends
 * most of its time in GC rather than in the actual math.
 */
function processedPixel(pixels: Float64Array, sourceIndex: number, metadata: FitsMetadata, ranges: ProcessingRanges, settings: FitsProcessingSettings, output: Float64Array): void {
  const planeSize = metadata.width * metadata.height;
  for (let channel = 0; channel < metadata.channels; channel++) {
    output[channel] = normalized(pixels[sourceIndex + channel * planeSize], ranges.low[channel], ranges.high[channel]);
  }
  if (metadata.channels !== 3) {
    for (let channel = 0; channel < metadata.channels; channel++) output[channel] = transfer(output[channel], settings);
    return;
  }
  const r = clampUnit(output[0] * Math.max(0, settings.redBalance ?? 1));
  const g0 = clampUnit(output[1] * Math.max(0, settings.greenBalance ?? 1));
  const b = clampUnit(output[2] * Math.max(0, settings.blueBalance ?? 1));
  const scnrAmount = Math.max(0, Math.min(1, settings.scnrAmount ?? 0));
  // Subtractive Chromatic Noise Reduction (average-neutral): pulls green back toward the
  // red/blue average, as Siril's SCNR filter does for OSC/narrowband data.
  const g = scnrAmount > 0 ? Math.max(0, g0 - scnrAmount * Math.max(0, g0 - 0.5 * (r + b))) : g0;
  // Stretch the luminance then apply that factor to RGB, as Siril's colour preserving asinh
  // mode does. This avoids colour shifts in bright stars.
  const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const stretchedLuminance = transfer(luminance, settings);
  const saturation = Math.max(0, Math.min(3, settings.saturation ?? 1));
  const ratio = luminance > Number.EPSILON ? stretchedLuminance / luminance : 0;
  output[0] = clampUnit(stretchedLuminance + (clampUnit(r * ratio) - stretchedLuminance) * saturation);
  output[1] = clampUnit(stretchedLuminance + (clampUnit(g * ratio) - stretchedLuminance) * saturation);
  output[2] = clampUnit(stretchedLuminance + (clampUnit(b * ratio) - stretchedLuminance) * saturation);
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Separable box blur with clamped edges; used as the low-pass stage of the unsharp mask. */
function boxBlur(plane: Float32Array, width: number, height: number, radius: number): Float32Array {
  const size = radius * 2 + 1;
  const horizontal = new Float32Array(plane.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx++) sum += plane[row + Math.max(0, Math.min(width - 1, dx))];
    horizontal[row] = sum / size;
    for (let x = 1; x < width; x++) {
      sum += plane[row + Math.min(width - 1, x + radius)] - plane[row + Math.max(0, x - radius - 1)];
      horizontal[row + x] = sum / size;
    }
  }
  const result = new Float32Array(plane.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy++) sum += horizontal[Math.max(0, Math.min(height - 1, dy)) * width + x];
    result[x] = sum / size;
    for (let y = 1; y < height; y++) {
      sum += horizontal[Math.min(height - 1, y + radius) * width + x] - horizontal[Math.max(0, y - radius - 1) * width + x];
      result[y * width + x] = sum / size;
    }
  }
  return result;
}

/**
 * Gaussian blur of standard deviation `sigma` pixels, approximated by three successive box blurs
 * (Wells 1986; accurate to a few per cent), so cost does not grow with the radius.
 */
function gaussianBlur(plane: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0) return Float32Array.from(plane);
  // Box widths whose three-pass variance matches sigma² (Kovesi's "boxes for Gauss").
  const ideal = Math.sqrt(12 * sigma * sigma / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const lowerCount = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  let result = plane;
  for (let pass = 0; pass < 3; pass++) {
    const size = pass < lowerCount ? lower : upper;
    result = boxBlur(result, width, height, Math.max(0, (size - 1) / 2));
  }
  return result;
}

/**
 * Luminance-only unsharp mask: sharpens perceived detail without introducing
 * colour fringing around stars, mirroring the luminance-preserving stretch above.
 */
function applySharpen(planes: Float32Array[], width: number, height: number, settings: FitsProcessingSettings): void {
  const amount = Math.max(0, Math.min(2, settings.sharpenAmount ?? 0));
  if (amount <= 0) return;
  const radius = Math.max(1, Math.min(4, Math.round(settings.sharpenRadius ?? 1)));
  if (planes.length === 3) {
    const size = width * height;
    const luminance = new Float32Array(size);
    for (let index = 0; index < size; index++) {
      luminance[index] = planes[0][index] * 0.2126 + planes[1][index] * 0.7152 + planes[2][index] * 0.0722;
    }
    const blurred = gaussianBlur(luminance, width, height, radius);
    for (let index = 0; index < size; index++) {
      const sharpened = clampUnit(luminance[index] + amount * (luminance[index] - blurred[index]));
      const factor = luminance[index] > Number.EPSILON ? sharpened / luminance[index] : 0;
      for (const plane of planes) plane[index] = clampUnit(plane[index] * factor);
    }
  } else {
    const plane = planes[0];
    const blurred = gaussianBlur(plane, width, height, radius);
    for (let index = 0; index < plane.length; index++) plane[index] = clampUnit(plane[index] + amount * (plane[index] - blurred[index]));
  }
}

/** Blends each pixel with a Gaussian-smoothed copy (radius = σ in pixels): a simple low-pass noise reduction. */
function applyDenoise(planes: Float32Array[], width: number, height: number, settings: FitsProcessingSettings): void {
  const amount = Math.max(0, Math.min(1, settings.denoiseAmount ?? 0));
  if (amount <= 0) return;
  const radius = Math.max(1, Math.min(4, Math.round(settings.denoiseRadius ?? 1)));
  for (const plane of planes) {
    const blurred = gaussianBlur(plane, width, height, radius);
    for (let index = 0; index < plane.length; index++) plane[index] = clampUnit(plane[index] * (1 - amount) + blurred[index] * amount);
  }
}

/**
 * Cosmetic correction (hot/cold pixel rejection): replaces a pixel with the median of its
 * 8 neighbours whenever it deviates from that median by more than `threshold` times the
 * neighbourhood's robust spread (MAD), the same sigma-clipping idea Siril's cosmetic
 * correction tool uses. Runs on raw per-channel plane data, before stretching.
 */
/**
 * Robust per-plane noise σ from neighbouring-pixel differences (1.4826 · MAD / √2): insensitive to
 * stars, nebulae and gradients, unlike the spread of the pixel values themselves.
 */
function planeNoiseSigma(pixels: Float64Array, base: number, width: number, height: number): number {
  const differences: number[] = [];
  const step = Math.max(1, Math.floor(width * height / 200_000));
  for (let index = 0; index < width * height - 1; index += step) {
    if ((index + 1) % width === 0) continue;
    const difference = pixels[base + index + 1] - pixels[base + index];
    if (Number.isFinite(difference)) differences.push(Math.abs(difference));
  }
  if (!differences.length) return 0;
  differences.sort((a, b) => a - b);
  return 1.4826 * differences[Math.floor(differences.length / 2)] / Math.SQRT2;
}

function removeHotPixels(pixels: Float64Array, metadata: FitsMetadata, threshold: number): Float64Array {
  if (threshold <= 0) return pixels;
  const { width, height, channels } = metadata;
  const planeSize = width * height;
  const result = Float64Array.from(pixels);
  const neighbors = new Array<number>(8);
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * planeSize;
    // The neighbourhood MAD is 0 in flat or quantized areas; the image noise is the floor, so only
    // pixels that stand out from the noise (hot/cold pixels, cosmic-ray hits) are replaced.
    const noiseFloor = Math.max(planeNoiseSigma(pixels, base, width, height), Number.EPSILON);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            neighbors[count++] = pixels[base + ny * width + nx];
          }
        }
        const sorted = neighbors.slice(0, count).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const deviations = sorted.map(value => Math.abs(value - median)).sort((a, b) => a - b);
        const mad = deviations[Math.floor(deviations.length / 2)];
        const scale = Math.max(mad * 1.4826, noiseFloor);
        const index = base + y * width + x;
        if (Math.abs(pixels[index] - median) > threshold * scale) result[index] = median;
      }
    }
  }
  return result;
}

/**
 * Background model as in SExtractor / photutils Background2D: the image is divided into a mesh of
 * boxes, each box's background is its iteratively 3σ-clipped median (stars and compact objects are
 * clipped away), the mesh is median-filtered (3×3) to reject boxes dominated by large objects, and
 * bilinearly interpolated back to full resolution. Exported for tests.
 */
export function backgroundModel(plane: Float64Array, width: number, height: number, boxSize = Math.max(4, Math.round(Math.min(width, height) / 12))): Float64Array {
  // At least 3 boxes per axis, so even small images get a gradient.
  const columns = Math.max(Math.min(3, width), Math.round(width / boxSize));
  const rows = Math.max(Math.min(3, height), Math.round(height / boxSize));
  const mesh = new Float64Array(columns * rows);
  const values: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      values.length = 0;
      const x0 = Math.floor(column * width / columns), x1 = Math.floor((column + 1) * width / columns);
      const y0 = Math.floor(row * height / rows), y1 = Math.floor((row + 1) * height / rows);
      const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 4000)));
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
        const value = plane[y * width + x];
        if (Number.isFinite(value)) values.push(value);
      }
      let kept = values.sort((a, b) => a - b);
      let median = kept.length ? kept[Math.floor(kept.length / 2)] : Number.NaN;
      for (let pass = 0; pass < 5 && kept.length > 10; pass++) {
        const sigma = 1.4826 * [...kept].map(value => Math.abs(value - median)).sort((a, b) => a - b)[Math.floor(kept.length / 2)];
        const next = kept.filter(value => Math.abs(value - median) <= 3 * Math.max(sigma, Number.EPSILON));
        if (next.length === kept.length) break;
        kept = next;
        median = kept[Math.floor(kept.length / 2)];
      }
      mesh[row * columns + column] = median;
    }
  }
  // 3×3 median filter over the mesh.
  const filtered = new Float64Array(mesh.length);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const around: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const r = row + dy, c = column + dx;
        if (r >= 0 && r < rows && c >= 0 && c < columns && Number.isFinite(mesh[r * columns + c])) around.push(mesh[r * columns + c]);
      }
      around.sort((a, b) => a - b);
      filtered[row * columns + column] = around.length ? around[Math.floor(around.length / 2)] : 0;
    }
  }
  // Bilinear interpolation between box centres, extrapolated linearly beyond the outer centres so
  // a gradient continues to the image edges instead of flattening there.
  const model = new Float64Array(width * height);
  const cell = (position: number, count: number): [number, number, number] => {
    if (count === 1) return [0, 0, 0];
    const lower = Math.min(Math.max(Math.floor(position), 0), count - 2);
    return [lower, lower + 1, position - lower];
  };
  for (let y = 0; y < height; y++) {
    const [r0, r1, ty] = cell((y + 0.5) * rows / height - 0.5, rows);
    for (let x = 0; x < width; x++) {
      const [c0, c1, tx] = cell((x + 0.5) * columns / width - 0.5, columns);
      model[y * width + x] = (filtered[r0 * columns + c0] * (1 - tx) + filtered[r0 * columns + c1] * tx) * (1 - ty)
        + (filtered[r1 * columns + c0] * (1 - tx) + filtered[r1 * columns + c1] * tx) * ty;
    }
  }
  return model;
}

/**
 * Removes a smooth large-scale gradient (light pollution, vignetting): subtracts `amount` times the
 * background model's variation about its median, so the overall sky level is kept and stars,
 * galaxies and nebulae (clipped out of the model) keep their flux.
 */
function extractBackground(pixels: Float64Array, metadata: FitsMetadata, amount: number): Float64Array {
  if (amount <= 0) return pixels;
  const { width, height, channels } = metadata;
  const planeSize = width * height;
  const result = Float64Array.from(pixels);
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * planeSize;
    const model = backgroundModel(pixels.subarray(base, base + planeSize), width, height);
    const sorted = Float64Array.from(model).sort();
    const reference = sorted[Math.floor(sorted.length / 2)];
    for (let index = 0; index < planeSize; index++) result[base + index] = pixels[base + index] - amount * (model[index] - reference);
  }
  return result;
}

function heatColor(t: number): [number, number, number] {
  return [clampUnit(3 * t), clampUnit(3 * t - 1), clampUnit(3 * t - 2)];
}

function coolColor(t: number): [number, number, number] {
  return [t, 1 - t, 1];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

function rainbowColor(t: number): [number, number, number] {
  return hsvToRgb((1 - t) * (2 / 3), 1, 1);
}

// Approximate anchor colours sampled from the viridis colormap, linearly interpolated.
const VIRIDIS_ANCHORS: [number, number, number][] = [
  [68, 1, 84], [71, 44, 122], [59, 81, 139], [44, 113, 142], [33, 144, 141],
  [39, 173, 129], [92, 200, 99], [170, 220, 50], [253, 231, 37],
];

function viridisColor(t: number): [number, number, number] {
  const position = clampUnit(t) * (VIRIDIS_ANCHORS.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(VIRIDIS_ANCHORS.length - 1, lower + 1);
  const fraction = position - lower;
  const [lr, lg, lb] = VIRIDIS_ANCHORS[lower];
  const [ur, ug, ub] = VIRIDIS_ANCHORS[upper];
  return [
    (lr + (ur - lr) * fraction) / 255,
    (lg + (ug - lg) * fraction) / 255,
    (lb + (ub - lb) * fraction) / 255,
  ];
}

/**
 * Maps the processed planes through a display colour palette for the preview only. Saved
 * FITS derivatives never go through this: they always keep their real per-channel data.
 */
function applyColorMap(planes: Float32Array[], colorMap: FitsColorMap): Float32Array[] {
  // 'original' shows the image as it is: natural colour for RGB, grey for mono.
  if (colorMap === 'original') return planes;
  let mono = planes[0];
  if (planes.length === 3) {
    // 'grey' and the false-colour palettes map the luminance (Rec. 709 weights).
    if (colorMap === 'inverted') return planes.map(plane => plane.map(value => 1 - value)) as Float32Array[];
    mono = new Float32Array(planes[0].length);
    for (let index = 0; index < mono.length; index++) mono[index] = planes[0][index] * 0.2126 + planes[1][index] * 0.7152 + planes[2][index] * 0.0722;
  }
  if (colorMap === 'grey') return [mono];
  if (colorMap === 'inverted') return [mono.map(value => 1 - value)];
  const lut = colorMap === 'heat' ? heatColor : colorMap === 'cool' ? coolColor : colorMap === 'rainbow' ? rainbowColor : viridisColor;
  const r = new Float32Array(mono.length);
  const g = new Float32Array(mono.length);
  const b = new Float32Array(mono.length);
  for (let index = 0; index < mono.length; index++) {
    const [rr, gg, bb] = lut(mono[index]);
    r[index] = rr; g[index] = gg; b[index] = bb;
  }
  return [r, g, b];
}

/** Raw-data clean-up shared by the preview and the saved derivative: cosmetic correction, then background removal. */
function preparePixels(rawPixels: Float64Array, metadata: FitsMetadata, settings: FitsProcessingSettings): Float64Array {
  const cleaned = removeHotPixels(rawPixels, metadata, settings.hotPixelThreshold ?? 0);
  return extractBackground(cleaned, metadata, settings.backgroundExtractionAmount ?? 0);
}

function previewDimensions(width: number, height: number, maximum = 2048): { width: number; height: number } {
  const scale = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Reads a downscaled copy of the image by averaging each block of source pixels (area resampling),
 * so the preview keeps faint stars and has the noise of a binned image instead of the aliasing of
 * point sampling. NaN/blank pixels are left out of each block's mean.
 */
async function readPreviewPixels(filePath: string, metadata: FitsMetadata, width: number, height: number): Promise<Float64Array> {
  const bytes = bytesPerPixel(metadata.bitpix);
  const sourcePlaneSize = metadata.width * metadata.height;
  const previewPlaneSize = width * height;
  const pixels = new Float64Array(previewPlaneSize * metadata.channels);
  const rowBytes = metadata.width * bytes;
  const maxRows = Math.ceil(metadata.height / height) + 1;
  const block = Buffer.allocUnsafe(rowBytes * maxRows);
  const sums = new Float64Array(width);
  const counts = new Uint32Array(width);
  const columnOf = new Uint32Array(metadata.width);
  for (let x = 0; x < metadata.width; x++) columnOf[x] = Math.min(width - 1, Math.floor(x * width / metadata.width));
  const handle = await open(filePath, 'r');
  try {
    for (let channel = 0; channel < metadata.channels; channel++) {
      for (let y = 0; y < height; y++) {
        sums.fill(0);
        counts.fill(0);
        const firstRow = Math.floor(y * metadata.height / height);
        const lastRow = Math.max(firstRow, Math.min(metadata.height - 1, Math.floor((y + 1) * metadata.height / height) - 1));
        // The block's rows are contiguous in the file: one read per preview row.
        const rowCount = lastRow - firstRow + 1;
        await readExactly(handle, block, rowBytes * rowCount, metadata.dataOffset + (channel * sourcePlaneSize + firstRow * metadata.width) * bytes);
        for (let line = 0; line < rowCount; line++) {
          const start = line * rowBytes;
          for (let sourceX = 0; sourceX < metadata.width; sourceX++) {
            const value = readValue(block, start + sourceX * bytes, metadata.bitpix) * metadata.bscale + metadata.bzero;
            if (!Number.isFinite(value)) continue;
            sums[columnOf[sourceX]] += value;
            counts[columnOf[sourceX]]++;
          }
        }
        const target = channel * previewPlaneSize + y * width;
        for (let x = 0; x < width; x++) pixels[target + x] = counts[x] ? sums[x] / counts[x] : Number.NaN;
      }
    }
  } finally {
    await handle.close();
  }
  return pixels;
}

// The downscaled raw data does not depend on the processing settings: keep the last few in memory
// so moving a slider only re-runs the processing, not the read of every row of a large FITS.
const previewPixelCache = new Map<string, Promise<Float64Array>>();
async function cachedPreviewPixels(filePath: string, metadata: FitsMetadata, width: number, height: number): Promise<Float64Array> {
  const { mtimeMs, size } = await stat(filePath);
  const key = `${filePath}|${mtimeMs}|${size}|${width}x${height}`;
  let pending = previewPixelCache.get(key);
  if (!pending) {
    pending = readPreviewPixels(filePath, metadata, width, height);
    previewPixelCache.set(key, pending);
    pending.catch(() => previewPixelCache.delete(key));
    while (previewPixelCache.size > 4) previewPixelCache.delete(previewPixelCache.keys().next().value!);
  }
  // preparePixels() copies before modifying, so the cached array is never altered.
  return pending;
}

export async function renderFitsPreview(filePath: string, settings: FitsProcessingSettings = {}, maximumDimension = 2048): Promise<FitsPreview> {
  const metadata = await readFitsMetadata(filePath);
  const dimensions = previewDimensions(metadata.width, metadata.height, Math.min(maximumDimension, 4096));
  const previewMetadata = { ...metadata, width: dimensions.width, height: dimensions.height,
    pixelCount: dimensions.width * dimensions.height * metadata.channels };
  const [rawPixels, ranges] = await Promise.all([
    cachedPreviewPixels(filePath, metadata, dimensions.width, dimensions.height),
    cachedFileProcessingRanges(filePath, metadata, settings),
  ]);
  const pixels = preparePixels(rawPixels, previewMetadata, settings);
  const sourceChannels = metadata.channels === 3 ? 3 : 1;
  const planes = Array.from({ length: sourceChannels }, () => new Float32Array(dimensions.width * dimensions.height));
  const scratch = new Float64Array(sourceChannels);

  for (let y = 0; y < dimensions.height; y++) {
    for (let x = 0; x < dimensions.width; x++) {
      const sourceIndex = y * dimensions.width + x;
      processedPixel(pixels, sourceIndex, previewMetadata, ranges, settings, scratch);
      const outputIndex = y * dimensions.width + x;
      for (let channel = 0; channel < sourceChannels; channel++) planes[channel][outputIndex] = scratch[channel];
    }
  }
  applyDenoise(planes, dimensions.width, dimensions.height, settings);
  applySharpen(planes, dimensions.width, dimensions.height, settings);
  const colorMapped = applyColorMap(planes, settings.colorMap ?? 'original');
  const outputChannels: 1 | 3 = colorMapped.length === 3 ? 3 : 1;

  const raw = Buffer.alloc(dimensions.width * dimensions.height * outputChannels);
  for (let index = 0; index < dimensions.width * dimensions.height; index++) {
    for (let channel = 0; channel < outputChannels; channel++) raw[index * outputChannels + channel] = Math.round(255 * colorMapped[channel][index]);
  }

  // sharp/libvips needs an explicit greyscale colourspace, or it upsamples a
  // single-channel raw buffer into a 3-channel sRGB PNG regardless of `channels`.
  let pipeline = sharp(raw, { raw: { width: dimensions.width, height: dimensions.height, channels: outputChannels } });
  if (outputChannels === 1) pipeline = pipeline.toColourspace('b-w');
  // Max zlib compression (level 9) on a multi-megapixel, noisy astro image can take tens of
  // seconds; drop to the fastest level once there's enough resolution for that cost to matter —
  // this is a view-only render, not the saved derivative, so a larger file is the right trade.
  const compressionLevel = dimensions.width * dimensions.height > 4_000_000 ? 1 : 9;
  const buffer = await pipeline.png({ compressionLevel }).toBuffer();
  return { buffer, metadata, ...dimensions };
}

const COMMENTARY_KEYWORDS = new Set(['HISTORY', 'COMMENT', '']);

export function fitsCard(key: string, value?: string): string {
  // Commentary keywords carry free text after column 8 and must not have the "= " value indicator;
  // CFITSIO-based readers (solve-field among them) reject such files.
  // Logical and numeric values use the FITS "fixed format" (right-justified to column 30), which
  // the standard requires for SIMPLE, BITPIX, NAXISn and friends; strings start at column 11.
  const content = value === undefined ? key
    : COMMENTARY_KEYWORDS.has(key) ? `${key.padEnd(8, ' ')}${value}`
      : value.startsWith("'") ? `${key.padEnd(8, ' ')}= ${value}`
        : `${key.padEnd(8, ' ')}= ${value.padStart(20, ' ')}`;
  return content.padEnd(FITS_CARD_SIZE, ' ').slice(0, FITS_CARD_SIZE);
}

export function copyHeaderValue(headers: Record<string, string | number | boolean>, key: string): string | undefined {
  const value = headers[key];
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export async function createProcessedFits(filePath: string, outputPath: string, settings: FitsProcessingSettings = {}): Promise<FitsMetadata> {
  const [metadata, file] = await Promise.all([readFitsMetadata(filePath), readFile(filePath)]);
  const pixels = preparePixels(readPixels(file, metadata), metadata, settings);
  const ranges = processingRanges(pixels, metadata, settings);
  const cards = [
    fitsCard('SIMPLE', 'T'),
    fitsCard('BITPIX', '-32'),
    fitsCard('NAXIS', String(metadata.channels === 1 ? 2 : 3)),
    fitsCard('NAXIS1', String(metadata.width)),
    fitsCard('NAXIS2', String(metadata.height)),
  ];
  if (metadata.channels === 3) cards.push(fitsCard('NAXIS3', '3'));
  for (const key of ['OBJECT', 'DATE-OBS', 'EXPTIME', 'INSTRUME', 'TELESCOP', 'FILTER', 'FOCALLEN', 'XPIXSZ', 'YPIXSZ']) {
    const value = copyHeaderValue(metadata.headers, key);
    if (value !== undefined) cards.push(fitsCard(key, value));
  }
  // The geometry is unchanged, so the source's celestial WCS (with distortion terms) still applies.
  for (const rawCard of metadata.cards) {
    const key = rawCard.slice(0, 8).trim();
    if (/^(CTYPE|CRPIX|CRVAL|CUNIT|CDELT|CROTA|CD\d|PC\d|WCSAXES|RADESYS|EQUINOX|LONPOLE|LATPOLE|PV\d|A_|B_|AP_|BP_)/.test(key)) cards.push(rawCard);
  }
  cards.push(fitsCard('BUNIT', "'normalized'"));
  cards.push(fitsCard('COMMENT', 'Display-stretched (non-linear) data scaled 0-1: not for photometry.'));
  cards.push(fitsCard('HISTORY', 'AstroviaBin non-destructive derivative'));
  // Every setting, so the processing can be reproduced exactly.
  const recorded = Object.entries(settings).filter(([key, value]) => key !== 'colorMap' && value !== undefined && value !== null);
  for (let index = 0; index < recorded.length; index += 3) {
    cards.push(fitsCard('HISTORY', recorded.slice(index, index + 3).map(([key, value]) => `${key}=${value}`).join(' ').slice(0, 70)));
  }
  cards.push(fitsCard('END'));
  const header = Buffer.from(cards.join(''), 'ascii');
  const paddedHeader = Buffer.concat([header, Buffer.alloc(Math.ceil(header.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - header.length, ' ')]);
  const data = Buffer.alloc(pixels.length * 4);
  const planeSize = metadata.width * metadata.height;
  const planes = Array.from({ length: metadata.channels }, () => new Float32Array(planeSize));
  const scratch = new Float64Array(metadata.channels);
  for (let index = 0; index < planeSize; index++) {
    processedPixel(pixels, index, metadata, ranges, settings, scratch);
    for (let channel = 0; channel < metadata.channels; channel++) planes[channel][index] = scratch[channel];
  }
  applyDenoise(planes, metadata.width, metadata.height, settings);
  applySharpen(planes, metadata.width, metadata.height, settings);
  for (let channel = 0; channel < metadata.channels; channel++) {
    for (let index = 0; index < planeSize; index++) data.writeFloatBE(planes[channel][index], (channel * planeSize + index) * 4);
  }
  const paddedData = Buffer.concat([data, Buffer.alloc(Math.ceil(data.length / FITS_BLOCK_SIZE) * FITS_BLOCK_SIZE - data.length)]);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.concat([paddedHeader, paddedData]));
  return readFitsMetadata(outputPath);
}

export function fitsPathFor(relativePath: string, source: FitsSource = 'source'): string {
  const prefix = source === 'derived'
    ? FITS_DERIVED_PATH_PREFIX
    : source === 'upload'
      ? FITS_UPLOAD_PATH_PREFIX
      : FITS_PATH_PREFIX;
  return `${prefix}${encodeURIComponent(relativePath)}`;
}

export function fitsRelativePath(originalPath: string | null): string | null {
  const source = fitsSource(originalPath);
  if (!source || !originalPath) return null;
  const prefix = source === 'derived'
    ? FITS_DERIVED_PATH_PREFIX
    : source === 'upload'
      ? FITS_UPLOAD_PATH_PREFIX
      : FITS_PATH_PREFIX;
  try { return decodeURIComponent(originalPath.slice(prefix.length)); } catch { return null; }
}

export function fitsSource(originalPath: string | null): FitsSource | null {
  if (originalPath?.startsWith(FITS_DERIVED_PATH_PREFIX)) return 'derived';
  if (originalPath?.startsWith(FITS_UPLOAD_PATH_PREFIX)) return 'upload';
  if (originalPath?.startsWith(FITS_PATH_PREFIX)) return 'source';
  return null;
}

export function fitsLibraryDirectory(): string {
  return path.resolve(process.env.FITS_LIBRARY_DIR || path.join(process.cwd(), 'data', 'fits'));
}

export function fitsCacheDirectory(): string {
  return path.resolve(process.env.FITS_CACHE_DIR || path.join(process.cwd(), 'data', 'fits-cache'));
}

export function fitsDerivedDirectory(): string {
  return path.resolve(process.env.FITS_DERIVATIVES_DIR || path.join(process.cwd(), 'data', 'fits-derived'));
}

export function fitsUploadDirectory(): string {
  return path.resolve(process.env.FITS_UPLOAD_DIR || path.join(process.cwd(), 'data', 'fits-upload'));
}

export function resolveFitsFile(originalPath: string | null): string | null {
  const relativePath = fitsRelativePath(originalPath);
  if (!relativePath) return null;
  const source = fitsSource(originalPath);
  const root = source === 'derived' ? fitsDerivedDirectory() : source === 'upload' ? fitsUploadDirectory() : fitsLibraryDirectory();
  const resolved = path.resolve(root, relativePath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

/**
 * Part of every rendered-image cache key: bump it when the rendering changes so previews and tiles
 * cached on disk by an older version are not served again (they are simply left unused).
 * 3: background-relative black and white points and colour-preserving background neutralization.
 */
const FITS_RENDER_VERSION = 3;

/** A 1-D spectrum stored as a 1 x N image (uploads of SDSS/tabular spectra, see spectroscopy.py to-image). */
export function isSpectrumFits(metadata: FitsMetadata): boolean {
  return metadata.headers.ASTVSPEC === true || (metadata.height === 1 && metadata.width > 16);
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!);
}

/** The gallery picture of a 1-D spectrum: flux against wavelength, drawn as SVG and rendered to PNG. */
export async function renderSpectrumPreview(filePath: string, metadata: FitsMetadata, maximumDimension = 2048): Promise<Buffer> {
  const width = Math.max(400, Math.min(1600, maximumDimension));
  const height = Math.round(width * 0.56);
  const flux = readPixels(await readFile(filePath), metadata).slice(0, metadata.width);
  const count = flux.length;
  const waveMin = Number(metadata.headers.WAVEMIN);
  const waveMax = Number(metadata.headers.WAVEMAX);
  const hasWave = Number.isFinite(waveMin) && Number.isFinite(waveMax) && waveMax > waveMin;
  const logGrid = metadata.headers.SPECGRID === 'log';
  const waveAt = (index: number) => !hasWave ? index
    : logGrid ? waveMin * Math.pow(waveMax / waveMin, index / Math.max(count - 1, 1)) : waveMin + (waveMax - waveMin) * index / Math.max(count - 1, 1);
  // One median per screen column keeps the shape without aliasing the noise.
  const left = 70, right = 20, top = 48, bottom = 56;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const columns: Array<{ x: number; value: number }> = [];
  for (let column = 0; column < plotWidth; column++) {
    const start = Math.floor(column * count / plotWidth), end = Math.max(start + 1, Math.floor((column + 1) * count / plotWidth));
    const values = Array.from(flux.subarray(start, end)).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length) columns.push({ x: column, value: values[values.length >> 1] });
  }
  const sorted = columns.map(point => point.value).sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.005)] ?? 0;
  const high = sorted[Math.floor(sorted.length * 0.995)] ?? 1;
  const span = high - low || 1;
  const yMin = low - 0.08 * span, yMax = high + 0.12 * span;
  const yAt = (value: number) => top + plotHeight * (1 - (value - yMin) / (yMax - yMin));
  const path = columns.map((point, index) => `${index ? 'L' : 'M'}${(left + point.x).toFixed(1)},${yAt(Math.min(Math.max(point.value, yMin), yMax)).toFixed(1)}`).join('');
  const ticks: string[] = [];
  if (hasWave) {
    const step = (waveMax - waveMin) / 10 > 500 ? 1000 : 500;
    for (let wave = Math.ceil(waveMin / step) * step; wave <= waveMax; wave += step) {
      const fraction = logGrid ? Math.log(wave / waveMin) / Math.log(waveMax / waveMin) : (wave - waveMin) / (waveMax - waveMin);
      const x = left + fraction * plotWidth;
      ticks.push(`<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${top + plotHeight}" stroke="#1e293b" stroke-width="1"/>` +
        `<text x="${x.toFixed(1)}" y="${top + plotHeight + 20}" fill="#94a3b8" font-size="15" text-anchor="middle">${wave / 10}</text>`);
    }
  }
  const title = escapeXml(String(metadata.headers.OBJECT || 'Spectrum'));
  const subtitle = escapeXml([metadata.headers.SPCLASS, metadata.headers.SPSUBCL].filter(Boolean).join(' ') || `${count} points`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#05030c"/>
<rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="#0b0a18" stroke="#334155"/>
${ticks.join('\n')}
<path d="${path}" fill="none" stroke="#22d3ee" stroke-width="1.6" stroke-linejoin="round"/>
<text x="${left}" y="30" fill="#e2e8f0" font-size="20" font-family="sans-serif" font-weight="bold">${title}</text>
<text x="${width - right}" y="30" fill="#a78bfa" font-size="16" font-family="sans-serif" text-anchor="end">${subtitle}</text>
<text x="${left + plotWidth / 2}" y="${height - 12}" fill="#94a3b8" font-size="15" font-family="sans-serif" text-anchor="middle">${hasWave ? 'Wavelength (nm, air)' : 'Sample'}</text>
<text x="20" y="${top + plotHeight / 2}" fill="#94a3b8" font-size="15" font-family="sans-serif" text-anchor="middle" transform="rotate(-90 20 ${top + plotHeight / 2})">Flux</text>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function cachedFitsPreview(filePath: string, settings: FitsProcessingSettings = {}, maximumDimension = 2048): Promise<Buffer> {
  const source = await stat(filePath);
  const key = createHash('sha256').update(JSON.stringify({ render: FITS_RENDER_VERSION, filePath, size: source.size, mtimeMs: source.mtimeMs, settings, maximumDimension })).digest('hex');
  const cachePath = path.join(fitsCacheDirectory(), `${key}.png`);
  try {
    const cached = await readFile(cachePath);
    // A power cut can leave an empty or truncated cache file: only a complete PNG is a hit.
    if (cached.length > 8 && cached.subarray(0, 8).equals(PNG_SIGNATURE)) return cached;
    await rm(cachePath, { force: true });
  } catch { /* generate it below */ }
  const metadata = await readFitsMetadata(filePath);
  const buffer = isSpectrumFits(metadata)
    ? await renderSpectrumPreview(filePath, metadata, maximumDimension)
    : (await renderFitsPreview(filePath, settings, maximumDimension)).buffer;
  await mkdir(path.dirname(cachePath), { recursive: true });
  // Written to a temporary file and renamed, so a reader never sees a half-written preview.
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, buffer);
    await rename(temporaryPath, cachePath);
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return buffer;
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, length: number, position: number): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error('FITS pixel data is truncated');
    offset += bytesRead;
  }
}

async function sampleFileValues(
  handle: Awaited<ReturnType<typeof open>>,
  metadata: FitsMetadata,
  channel?: number,
): Promise<number[]> {
  const bytes = bytesPerPixel(metadata.bitpix);
  const valueCount = metadata.width * metadata.height;
  const channels = channel === undefined ? Array.from({ length: metadata.channels }, (_, index) => index) : [channel];
  const targetSamplesPerChannel = Math.max(1, Math.floor(200_000 / channels.length));
  const valuesPerWindow = Math.max(1, Math.floor((256 * 1024) / bytes));
  // Spread small, bounded reads over the whole plane. For very large FITS files this
  // samples at most 16 MiB per channel instead of scanning many gigabytes per first tile.
  const windowCount = Math.min(64, Math.ceil(valueCount / valuesPerWindow));
  const samplesPerWindow = Math.max(1, Math.floor(targetSamplesPerChannel / windowCount));
  const step = Math.max(1, Math.floor(valuesPerWindow / samplesPerWindow));
  const values: number[] = [];

  for (const channelIndex of channels) {
    const planeOffset = channelIndex * metadata.width * metadata.height;
    for (let window = 0; window < windowCount; window++) {
      const start = windowCount === 1
        ? 0
        : Math.floor(window * (valueCount - valuesPerWindow) / (windowCount - 1));
      const count = Math.min(valuesPerWindow, valueCount - start);
      const buffer = Buffer.allocUnsafe(count * bytes);
      await readExactly(handle, buffer, buffer.length, metadata.dataOffset + (planeOffset + start) * bytes);
      for (let index = 0; index < count; index++) {
        if (index % step !== 0) continue;
        const raw = readValue(buffer, index * bytes, metadata.bitpix);
        const value = raw * metadata.bscale + metadata.bzero;
        if (Number.isFinite(value)) values.push(value);
      }
    }
  }

  if (values.length === 0) throw new Error('FITS image contains no finite pixel values');
  return values.sort((left, right) => left - right);
}

async function cachedFileProcessingRanges(filePath: string, metadata: FitsMetadata, settings: FitsProcessingSettings): Promise<ProcessingRanges> {
  const source = await stat(filePath);
  const key = createHash('sha256').update(JSON.stringify({
    render: FITS_RENDER_VERSION,
    filePath,
    size: source.size,
    mtimeMs: source.mtimeMs,
    blackPoint: settings.blackPoint,
    whitePoint: settings.whitePoint,
    shadowPercentile: settings.shadowPercentile,
    highlightPercentile: settings.highlightPercentile,
    backgroundNeutralization: settings.backgroundNeutralization,
  })).digest('hex');
  const cached = fitsRangeJobs.get(key);
  if (cached) return cached;

  const work = (async () => {
    const handle = await open(filePath, 'r');
    try {
      const shadowPercentile = Math.max(0, Math.min(0.5, settings.shadowPercentile ?? (settings.backgroundNeutralization ? 0.01 : 0.005)));
      const highlightPercentile = Math.max(0.5, Math.min(1, settings.highlightPercentile ?? 0.995));
      if (settings.backgroundNeutralization && metadata.channels === 3) {
        const low: number[] = [];
        const high: number[] = [];
        const sky: number[] = [];
        for (let channel = 0; channel < metadata.channels; channel++) {
          const plane = await sampleFileValues(handle, metadata, channel);
          low.push(settings.blackPoint ?? blackPoint(plane, shadowPercentile));
          high.push(settings.whitePoint ?? whitePoint(plane, highlightPercentile, low[channel]));
          sky.push(atPercentile(plane, 0.5));
        }
        return neutralRanges(low, high, sky, settings.blackPoint !== undefined);
      }
      const all = await sampleFileValues(handle, metadata);
      const low = settings.blackPoint ?? blackPoint(all, shadowPercentile);
      const high = settings.whitePoint ?? whitePoint(all, highlightPercentile, low);
      return {
        low: Array.from({ length: metadata.channels }, () => low),
        high: Array.from({ length: metadata.channels }, () => high),
      };
    } finally {
      await handle.close();
    }
  })();

  fitsRangeJobs.set(key, work);
  try {
    const result = await work;
    while (fitsRangeJobs.size > FITS_RANGE_CACHE_MAX) {
      const oldest = fitsRangeJobs.keys().next().value;
      if (!oldest || oldest === key) break;
      fitsRangeJobs.delete(oldest);
    }
    return result;
  } catch (error) {
    fitsRangeJobs.delete(key);
    throw error;
  }
}

/** Render only the requested native-resolution FITS tile. No full-size PNG or pyramid is built. */
export async function renderFitsTile(filePath: string, settings: FitsProcessingSettings, level: number, x: number, y: number): Promise<Buffer> {
  const metadata = await readFitsMetadata(filePath);
  const maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(metadata.width, metadata.height))));
  if (!Number.isInteger(level) || level < 0 || level > maxLevel) throw new Error('Invalid tile level');
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) throw new Error('Invalid tile coordinates');

  const scale = 2 ** (maxLevel - level);
  const levelWidth = Math.max(1, Math.ceil(metadata.width / scale));
  const levelHeight = Math.max(1, Math.ceil(metadata.height / scale));
  const left = x * FITS_TILE_SIZE;
  const top = y * FITS_TILE_SIZE;
  if (left >= levelWidth || top >= levelHeight) throw new Error('Tile out of bounds');
  const width = Math.min(FITS_TILE_SIZE, levelWidth - left);
  const height = Math.min(FITS_TILE_SIZE, levelHeight - top);

  const source = await stat(filePath);
  const tileKey = createHash('sha256').update(JSON.stringify({
    render: FITS_RENDER_VERSION, filePath, size: source.size, mtimeMs: source.mtimeMs, settings, level, x, y,
  })).digest('hex');
  const cacheDirectory = path.join(fitsCacheDirectory(), 'tiles');
  const cachePath = path.join(cacheDirectory, `${tileKey}.jpg`);
  try {
    const cached = await readFile(cachePath);
    if (cached.length > 0) {
      await sharp(cached).metadata();
      return cached;
    }
    await rm(cachePath, { force: true });
  } catch { /* cache miss or a partial cache file */ }
  const pending = fitsTileJobs.get(cachePath);
  if (pending) return pending;

  const work = (async () => {
    const ranges = await cachedFileProcessingRanges(filePath, metadata, settings);
    const planeSize = metadata.width * metadata.height;
    const bytes = bytesPerPixel(metadata.bitpix);
    const tilePlaneSize = width * height;
    const pixels = new Float64Array(tilePlaneSize * metadata.channels);
    const handle = await open(filePath, 'r');
    try {
      for (let channel = 0; channel < metadata.channels; channel++) {
        const channelOffset = channel * planeSize;
        for (let tileY = 0; tileY < height; tileY++) {
          const sourceY = Math.min(metadata.height - 1, Math.floor((top + tileY) * metadata.height / levelHeight));
          const firstX = Math.floor(left * metadata.width / levelWidth);
          const lastX = Math.floor((left + width - 1) * metadata.width / levelWidth);
          const rowValues = lastX - firstX + 1;
          const row = Buffer.allocUnsafe(rowValues * bytes);
          await readExactly(handle, row, row.length, metadata.dataOffset + (channelOffset + sourceY * metadata.width + firstX) * bytes);
          for (let tileX = 0; tileX < width; tileX++) {
            const sourceX = Math.min(metadata.width - 1, Math.floor((left + tileX) * metadata.width / levelWidth));
            const raw = readValue(row, (sourceX - firstX) * bytes, metadata.bitpix);
            const value = raw * metadata.bscale + metadata.bzero;
            pixels[channel * tilePlaneSize + tileY * width + tileX] = Number.isFinite(value) ? value : Number.NaN;
          }
        }
      }
    } finally {
      await handle.close();
    }

    const tileMetadata = { ...metadata, width, height, pixelCount: tilePlaneSize * metadata.channels };
    const planes = Array.from({ length: metadata.channels }, () => new Float32Array(tilePlaneSize));
    const scratch = new Float64Array(metadata.channels);
    for (let index = 0; index < tilePlaneSize; index++) {
      processedPixel(pixels, index, tileMetadata, ranges, settings, scratch);
      for (let channel = 0; channel < metadata.channels; channel++) planes[channel][index] = scratch[channel];
    }
    const mapped = applyColorMap(planes, settings.colorMap ?? 'original');
    const outputChannels = mapped.length === 3 ? 3 : 1;
    const raw = Buffer.alloc(tilePlaneSize * outputChannels);
    for (let index = 0; index < tilePlaneSize; index++) {
      for (let channel = 0; channel < outputChannels; channel++) raw[index * outputChannels + channel] = Math.round(255 * mapped[channel][index]);
    }
    let pipeline = sharp(raw, { raw: { width, height, channels: outputChannels as 1 | 3 } });
    if (outputChannels === 1) pipeline = pipeline.toColourspace('b-w');
    const buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();

    await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, buffer, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, cachePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return buffer;
  })();

  fitsTileJobs.set(cachePath, work);
  try {
    return await work;
  } finally {
    fitsTileJobs.delete(cachePath);
  }
}

/**
 * Makes an uploaded FITS readable when its image is not in the primary HDU (an IMAGE extension or
 * a tile-compressed RICE/GZIP image, as Slooh "_cal.fit" or fpack files): the image is rewritten
 * as a standard single-HDU FITS with the observation keywords merged, and the untouched original
 * is kept next to it as "<name>.orig". Returns whether the file was rewritten.
 */
export async function normalizeUploadedFits(filePath: string): Promise<boolean> {
  let readError: unknown = null;
  try {
    const metadata = await readFitsMetadata(filePath);
    if (metadata.width > 0 && metadata.height > 0) return false;
  } catch (error) {
    readError = error; // not a primary-HDU image: try to normalize
  }
  const original = `${filePath}.orig`;
  const converted = `${filePath}.${randomUUID()}.tmp`;
  await rename(filePath, original);
  try {
    const script = process.env.FITS_NORMALIZE_SCRIPT || path.resolve(process.cwd(), 'tools/scripts/fits_normalize.py');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.env.ASTROVIABIN_ANALYSIS_PYTHON || '/opt/astroviabin-python/bin/python', [script, original, converted], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
      child.on('error', reject);
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        let message = '';
        try { message = JSON.parse(stdout).error; } catch { /* no specific reason */ }
        reject(message ? new Error(`Invalid FITS file: ${message}`) : null);
      });
    });
    await rename(converted, filePath);
    await readFitsMetadata(filePath);
    console.log(`Normalized FITS ${path.basename(filePath)}: ${output.trim()}`);
    return true;
  } catch (error) {
    await rm(converted, { force: true }).catch(() => undefined);
    await rename(original, filePath).catch(() => undefined);
    // A specific reason from the converter, else the original read error (e.g. a broken header).
    if (error instanceof Error && error.message.startsWith('Invalid FITS file:')) throw error;
    throw readError ?? error;
  }
}
