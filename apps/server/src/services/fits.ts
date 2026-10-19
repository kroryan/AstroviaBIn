import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const FITS_PATH_PREFIX = 'fits://';
export const FITS_DERIVED_PATH_PREFIX = 'fits-derived://';
export const FITS_UPLOAD_PATH_PREFIX = 'fits-upload://';
export const FITS_BLOCK_SIZE = 2880;
export const FITS_CARD_SIZE = 80;
const MAX_HEADER_BYTES = 1024 * 1024;
const DEFAULT_MAX_PROCESS_BYTES = 1024 * 1024 * 1024;
const FITS_TILE_SIZE = 256;
const FITS_RANGE_CACHE_MAX = 32;
const fitsRangeJobs = new Map<string, Promise<ProcessingRanges>>();
const fitsTileJobs = new Map<string, Promise<Buffer>>();

export type FitsStretch = 'linear' | 'asinh' | 'log' | 'gamma' | 'mtf' | 'sqrt' | 'square';
export type FitsColorMap = 'grey' | 'inverted' | 'heat' | 'cool' | 'rainbow' | 'viridis';

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
  const file = Buffer.alloc(Math.min(source.size, MAX_HEADER_BYTES));
  const handle = await open(filePath, 'r');
  try {
    await handle.read(file, 0, file.length, 0);
  } finally {
    await handle.close();
  }

  const headers: Record<string, string | number | boolean> = {};
  for (let offset = 0; offset + FITS_CARD_SIZE <= file.length; offset += FITS_CARD_SIZE) {
    const card = file.subarray(offset, offset + FITS_CARD_SIZE).toString('ascii');
    const key = card.slice(0, 8).trim();
    if (key === 'END') return headers;
    if (key && card[8] === '=') headers[key] = parseFitsValue(card.slice(10).split(/\s\/\s/)[0] || '');
  }
  throw new Error('Invalid FITS header: missing END card');
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
  const limit = Math.min(source.size, MAX_HEADER_BYTES);
  const file = Buffer.alloc(limit);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(file, 0, limit, 0);
  } finally {
    await handle.close();
  }
  const cards: string[] = [];
  const headers: Record<string, string | number | boolean> = {};
  let endOffset = -1;

  for (let offset = 0; offset + FITS_CARD_SIZE <= limit; offset += FITS_CARD_SIZE) {
    const card = file.subarray(offset, offset + FITS_CARD_SIZE).toString('ascii');
    cards.push(card);
    const key = card.slice(0, 8).trim();
    if (key === 'END') {
      endOffset = offset + FITS_CARD_SIZE;
      break;
    }
    if (key && card[8] === '=') {
      const rawValue = card.slice(10).split(/\s\/\s/)[0] || '';
      headers[key] = parseFitsValue(rawValue);
    }
  }

  if (endOffset === -1) throw new Error('Invalid FITS file: missing END header card');
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

function percentile(values: Float64Array, percentileValue: number): number {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 200_000));
  for (let index = 0; index < values.length; index += step) {
    const value = values[index];
    if (Number.isFinite(value)) sample.push(value);
  }
  if (sample.length === 0) throw new Error('FITS image contains no finite pixel values');
  sample.sort((left, right) => left - right);
  const position = Math.max(0, Math.min(sample.length - 1, Math.round((sample.length - 1) * percentileValue)));
  return sample[position];
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
  const sharedLow = settings.blackPoint ?? percentile(pixels, shadowPercentile);
  const sharedHigh = settings.whitePoint ?? percentile(pixels, highlightPercentile);
  const low = Array.from({ length: metadata.channels }, () => sharedLow);
  const high = Array.from({ length: metadata.channels }, () => sharedHigh);
  if (settings.backgroundNeutralization && metadata.channels === 3) {
    const planeSize = metadata.width * metadata.height;
    for (let channel = 0; channel < metadata.channels; channel++) {
      low[channel] = settings.blackPoint ?? percentile(pixels.subarray(channel * planeSize, (channel + 1) * planeSize), shadowPercentile);
      high[channel] = settings.whitePoint ?? percentile(pixels.subarray(channel * planeSize, (channel + 1) * planeSize), highlightPercentile);
    }
  }
  return { low, high };
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
    const blurred = boxBlur(luminance, width, height, radius);
    for (let index = 0; index < size; index++) {
      const sharpened = clampUnit(luminance[index] + amount * (luminance[index] - blurred[index]));
      const factor = luminance[index] > Number.EPSILON ? sharpened / luminance[index] : 0;
      for (const plane of planes) plane[index] = clampUnit(plane[index] * factor);
    }
  } else {
    const plane = planes[0];
    const blurred = boxBlur(plane, width, height, radius);
    for (let index = 0; index < plane.length; index++) plane[index] = clampUnit(plane[index] + amount * (plane[index] - blurred[index]));
  }
}

/** Blends each pixel with a local blur; a simple, fast stand-in for proper noise reduction. */
function applyDenoise(planes: Float32Array[], width: number, height: number, settings: FitsProcessingSettings): void {
  const amount = Math.max(0, Math.min(1, settings.denoiseAmount ?? 0));
  if (amount <= 0) return;
  const radius = Math.max(1, Math.min(4, Math.round(settings.denoiseRadius ?? 1)));
  for (const plane of planes) {
    const blurred = boxBlur(plane, width, height, radius);
    for (let index = 0; index < plane.length; index++) plane[index] = clampUnit(plane[index] * (1 - amount) + blurred[index] * amount);
  }
}

/**
 * Cosmetic correction (hot/cold pixel rejection): replaces a pixel with the median of its
 * 8 neighbours whenever it deviates from that median by more than `threshold` times the
 * neighbourhood's robust spread (MAD), the same sigma-clipping idea Siril's cosmetic
 * correction tool uses. Runs on raw per-channel plane data, before stretching.
 */
function removeHotPixels(pixels: Float64Array, metadata: FitsMetadata, threshold: number): Float64Array {
  if (threshold <= 0) return pixels;
  const { width, height, channels } = metadata;
  const planeSize = width * height;
  const result = Float64Array.from(pixels);
  const neighbors = new Array<number>(8);
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * planeSize;
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
        const scale = Math.max(mad * 1.4826, Number.EPSILON);
        const index = base + y * width + x;
        if (Math.abs(pixels[index] - median) > threshold * scale) result[index] = median;
      }
    }
  }
  return result;
}

/**
 * Removes a smooth large-scale gradient (light pollution, vignetting) by estimating the
 * background with a wide box blur and subtracting its variation from the raw data, the
 * same low-pass idea behind Siril's background extraction tool.
 */
function extractBackground(pixels: Float64Array, metadata: FitsMetadata, amount: number): Float64Array {
  if (amount <= 0) return pixels;
  const { width, height, channels } = metadata;
  const planeSize = width * height;
  const radius = Math.max(8, Math.round(Math.min(width, height) / 8));
  const result = Float64Array.from(pixels);
  for (let channel = 0; channel < channels; channel++) {
    const base = channel * planeSize;
    const plane = new Float32Array(planeSize);
    for (let index = 0; index < planeSize; index++) plane[index] = pixels[base + index];
    const blurred = boxBlur(plane, width, height, radius);
    let referenceSum = 0;
    for (let index = 0; index < planeSize; index++) referenceSum += blurred[index];
    const reference = referenceSum / planeSize;
    for (let index = 0; index < planeSize; index++) result[base + index] = pixels[base + index] - amount * (blurred[index] - reference);
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
  if (planes.length === 3) {
    if (colorMap !== 'inverted') return planes;
    return planes.map(plane => plane.map(value => 1 - value)) as Float32Array[];
  }
  const mono = planes[0];
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

async function readPreviewPixels(filePath: string, metadata: FitsMetadata, width: number, height: number): Promise<Float64Array> {
  const bytes = bytesPerPixel(metadata.bitpix);
  const sourcePlaneSize = metadata.width * metadata.height;
  const previewPlaneSize = width * height;
  const pixels = new Float64Array(previewPlaneSize * metadata.channels);
  const firstX = 0;
  const lastX = Math.min(metadata.width - 1, Math.floor((width - 1) * metadata.width / width));
  const row = Buffer.allocUnsafe((lastX - firstX + 1) * bytes);
  const handle = await open(filePath, 'r');
  try {
    for (let channel = 0; channel < metadata.channels; channel++) {
      for (let y = 0; y < height; y++) {
        const sourceY = Math.min(metadata.height - 1, Math.floor(y * metadata.height / height));
        const offset = metadata.dataOffset + (channel * sourcePlaneSize + sourceY * metadata.width + firstX) * bytes;
        await readExactly(handle, row, row.length, offset);
        for (let x = 0; x < width; x++) {
          const sourceX = Math.min(metadata.width - 1, Math.floor(x * metadata.width / width));
          const raw = readValue(row, (sourceX - firstX) * bytes, metadata.bitpix);
          const value = raw * metadata.bscale + metadata.bzero;
          pixels[channel * previewPlaneSize + y * width + x] = Number.isFinite(value) ? value : Number.NaN;
        }
      }
    }
  } finally {
    await handle.close();
  }
  return pixels;
}

export async function renderFitsPreview(filePath: string, settings: FitsProcessingSettings = {}, maximumDimension = 2048): Promise<FitsPreview> {
  const metadata = await readFitsMetadata(filePath);
  const dimensions = previewDimensions(metadata.width, metadata.height, Math.min(maximumDimension, 4096));
  const previewMetadata = { ...metadata, width: dimensions.width, height: dimensions.height,
    pixelCount: dimensions.width * dimensions.height * metadata.channels };
  const [rawPixels, ranges] = await Promise.all([
    readPreviewPixels(filePath, metadata, dimensions.width, dimensions.height),
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
  const colorMapped = applyColorMap(planes, settings.colorMap ?? 'grey');
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

export function fitsCard(key: string, value?: string): string {
  const content = value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`;
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
  cards.push(fitsCard('HISTORY', 'AstroviaBin non-destructive derivative'));
  cards.push(fitsCard('HISTORY', `stretch=${settings.stretch || 'asinh'} background=${Boolean(settings.backgroundNeutralization)}`));
  if ((settings.scnrAmount ?? 0) > 0) cards.push(fitsCard('HISTORY', `scnrAmount=${settings.scnrAmount}`));
  if ((settings.sharpenAmount ?? 0) > 0) cards.push(fitsCard('HISTORY', `sharpenAmount=${settings.sharpenAmount} sharpenRadius=${settings.sharpenRadius ?? 1}`));
  if ((settings.denoiseAmount ?? 0) > 0) cards.push(fitsCard('HISTORY', `denoiseAmount=${settings.denoiseAmount} denoiseRadius=${settings.denoiseRadius ?? 1}`));
  if ((settings.backgroundExtractionAmount ?? 0) > 0) cards.push(fitsCard('HISTORY', `backgroundExtractionAmount=${settings.backgroundExtractionAmount}`));
  if ((settings.hotPixelThreshold ?? 0) > 0) cards.push(fitsCard('HISTORY', `hotPixelThreshold=${settings.hotPixelThreshold}`));
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

export async function cachedFitsPreview(filePath: string, settings: FitsProcessingSettings = {}, maximumDimension = 2048): Promise<Buffer> {
  const source = await stat(filePath);
  const key = createHash('sha256').update(JSON.stringify({ filePath, size: source.size, mtimeMs: source.mtimeMs, settings, maximumDimension })).digest('hex');
  const cachePath = path.join(fitsCacheDirectory(), `${key}.png`);
  try { return await readFile(cachePath); } catch { /* generate it below */ }
  const preview = await renderFitsPreview(filePath, settings, maximumDimension);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, preview.buffer);
  return preview.buffer;
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, buffer: Buffer, length: number, position: number): Promise<void> {
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) throw new Error('FITS pixel data is truncated');
    offset += bytesRead;
  }
}

async function sampleFilePercentile(
  handle: Awaited<ReturnType<typeof open>>,
  metadata: FitsMetadata,
  percentileValue: number,
  channel?: number,
): Promise<number> {
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
  values.sort((left, right) => left - right);
  const position = Math.max(0, Math.min(values.length - 1, Math.round((values.length - 1) * percentileValue)));
  return values[position];
}

async function cachedFileProcessingRanges(filePath: string, metadata: FitsMetadata, settings: FitsProcessingSettings): Promise<ProcessingRanges> {
  const source = await stat(filePath);
  const key = createHash('sha256').update(JSON.stringify({
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
        for (let channel = 0; channel < metadata.channels; channel++) {
          low.push(settings.blackPoint ?? await sampleFilePercentile(handle, metadata, shadowPercentile, channel));
          high.push(settings.whitePoint ?? await sampleFilePercentile(handle, metadata, highlightPercentile, channel));
        }
        return { low, high };
      }
      const low = settings.blackPoint ?? await sampleFilePercentile(handle, metadata, shadowPercentile);
      const high = settings.whitePoint ?? await sampleFilePercentile(handle, metadata, highlightPercentile);
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
    filePath, size: source.size, mtimeMs: source.mtimeMs, settings, level, x, y,
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
    const mapped = applyColorMap(planes, settings.colorMap ?? 'grey');
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
