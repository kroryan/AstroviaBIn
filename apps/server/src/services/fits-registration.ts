import { pixelToSky, skyToPixel, type WcsSolution } from './wcs';

/**
 * Sub-pixel frame registration for stacking. Each frame gets a geometric mapping from reference
 * pixels to its own pixels (0-based):
 *
 *   1. a base mapping — both frames' full WCS (TAN + SIP, so rotation, scale and optical
 *      distortion are all handled) or, without a plate solution, a cross-correlation translation;
 *   2. a smooth polynomial correction fitted to stars matched between the two frames, which absorbs
 *      what the base mapping misses (a frame-to-frame rotation for translation-only bases, or the
 *      residual error of each plate solution).
 *
 * The result is checked against the matched stars: its residual RMS is reported, and frames whose
 * stars do not line up are rejected instead of being blended in misaligned.
 */

export interface Star { x: number; y: number; flux: number }

export interface Registration {
  /** Reference pixel → frame pixel (both 0-based). */
  map: (x: number, y: number) => [number, number];
  /** Frame pixel area covered by one reference pixel (flux conservation when scales differ). */
  areaRatio: (x: number, y: number) => number;
  method: 'wcs+stars' | 'wcs' | 'translation+stars' | 'translation';
  matchedStars: number;
  rmsPx: number | null;
  polynomialOrder: number | null;
}

type Mapping = (x: number, y: number) => [number, number];

function sampledStatistics(plane: Float32Array): { median: number; sigma: number; max: number } {
  const step = Math.max(1, Math.floor(plane.length / 250_000));
  const sample: number[] = [];
  let max = -Infinity;
  for (let index = 0; index < plane.length; index += step) {
    const value = plane[index];
    if (Number.isFinite(value)) sample.push(value);
  }
  for (let index = 0; index < plane.length; index++) if (plane[index] > max) max = plane[index];
  if (!sample.length) return { median: 0, sigma: 0, max: 0 };
  sample.sort((a, b) => a - b);
  const median = sample[Math.floor(sample.length / 2)];
  const deviations = sample.map(value => Math.abs(value - median)).sort((a, b) => a - b);
  return { median, sigma: 1.4826 * deviations[Math.floor(deviations.length / 2)], max };
}

/**
 * Isolated, unsaturated point sources: local maxima ≥ 8σ above the sky, centroided on their
 * background-subtracted light. Single hot pixels/cosmic rays (all light in one pixel) and
 * saturated cores are skipped. Brightest first.
 */
export function detectStars(plane: Float32Array, width: number, height: number, limit = 400, saturation?: number): Star[] {
  const { median, sigma, max } = sampledStatistics(plane);
  if (!(sigma > 0)) return [];
  const threshold = median + 8 * sigma;
  const ceiling = saturation && saturation > 0 ? 0.9 * saturation : median + 0.95 * (max - median);
  const border = 8;
  const found: Star[] = [];
  for (let y = border; y < height - border; y++) {
    const row = y * width;
    for (let x = border; x < width - border; x++) {
      const value = plane[row + x];
      if (!(value > threshold) || value >= ceiling) continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && !(plane[row + dy * width + x + dx] < value)) { peak = false; break; }
        }
      }
      if (!peak) continue;
      // Local background from the ring 6–7 px away.
      const ring: number[] = [];
      for (let dy = -7; dy <= 7; dy++) {
        for (let dx = -7; dx <= 7; dx++) {
          const distance = Math.hypot(dx, dy);
          if (distance >= 6 && distance <= 7.5) {
            const sample = plane[(y + dy) * width + x + dx];
            if (Number.isFinite(sample)) ring.push(sample);
          }
        }
      }
      if (ring.length < 12) continue;
      ring.sort((a, b) => a - b);
      const background = ring[Math.floor(ring.length / 2)];
      const height0 = value - background;
      if (!(height0 > 8 * sigma)) continue;
      let sum = 0, sumX = 0, sumY = 0, neighbours = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const sample = plane[(y + dy) * width + x + dx] - background;
          if (!(sample > 0)) continue;
          sum += sample;
          sumX += sample * dx;
          sumY += sample * dy;
          if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && (dx || dy) && sample > 0.25 * height0) neighbours++;
        }
      }
      // A real (seeing-limited) star spreads into its neighbours; a cosmic ray does not.
      if (neighbours < 3 || !(sum > 0) || height0 / sum > 0.7) continue;
      found.push({ x: x + sumX / sum, y: y + sumY / sum, flux: sum });
    }
  }
  found.sort((a, b) => b.flux - a.flux);
  const kept: Star[] = [];
  for (const star of found) {
    if (kept.length >= limit) break;
    if (kept.some(other => Math.abs(other.x - star.x) < 4 && Math.abs(other.y - star.y) < 4)) continue;
    kept.push(star);
  }
  return kept;
}

/** Least squares via normal equations with partial pivoting (small systems only). */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-12) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = a[row][column] / a[column][column];
      for (let k = column; k <= n; k++) a[row][k] -= factor * a[column][k];
    }
  }
  return a.map((row, index) => row[n] / a[index][index]);
}

interface Polynomial { order: number; cx: number; cy: number; scale: number; ax: number[]; ay: number[] }

function terms(order: number, u: number, v: number): number[] {
  const result: number[] = [];
  for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) result.push(u ** i * v ** j);
  return result;
}

function fitPolynomial(points: Array<[number, number]>, residuals: Array<[number, number]>, order: number, width: number, height: number): Polynomial | null {
  const cx = width / 2, cy = height / 2, scale = Math.max(width, height) / 2;
  const size = terms(order, 0, 0).length;
  const normal = Array.from({ length: size }, () => new Array(size).fill(0));
  const bx = new Array(size).fill(0), by = new Array(size).fill(0);
  points.forEach(([x, y], index) => {
    const t = terms(order, (x - cx) / scale, (y - cy) / scale);
    for (let i = 0; i < size; i++) {
      bx[i] += t[i] * residuals[index][0];
      by[i] += t[i] * residuals[index][1];
      for (let j = 0; j < size; j++) normal[i][j] += t[i] * t[j];
    }
  });
  const ax = solve(normal, bx);
  const ay = solve(normal, by);
  return ax && ay ? { order, cx, cy, scale, ax, ay } : null;
}

function evaluatePolynomial(poly: Polynomial, x: number, y: number): [number, number] {
  const t = terms(poly.order, (x - poly.cx) / poly.scale, (y - poly.cy) / poly.scale);
  let dx = 0, dy = 0;
  for (let i = 0; i < t.length; i++) { dx += poly.ax[i] * t[i]; dy += poly.ay[i] * t[i]; }
  return [dx, dy];
}

/** Nearest-neighbour lookup on a coarse spatial hash. */
function starIndex(stars: Star[], cell = 16) {
  const buckets = new Map<string, number[]>();
  stars.forEach((star, index) => {
    const key = `${Math.floor(star.x / cell)},${Math.floor(star.y / cell)}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(index);
  });
  return (x: number, y: number, radius: number): number => {
    let best = -1, bestDistance = radius;
    const span = Math.ceil(radius / cell);
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let i = gx - span; i <= gx + span; i++) {
      for (let j = gy - span; j <= gy + span; j++) {
        for (const index of buckets.get(`${i},${j}`) ?? []) {
          const distance = Math.hypot(stars[index].x - x, stars[index].y - y);
          if (distance < bestDistance) { bestDistance = distance; best = index; }
        }
      }
    }
    return best;
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/**
 * Fits the star-based correction on top of `base`. Returns null when the stars cannot confirm a
 * mapping (too few matches).
 */
function refineWithStars(base: Mapping, referenceStars: Star[], frameStars: Star[], width: number, height: number, initialRadius: number) {
  if (referenceStars.length < 6 || frameStars.length < 6) return null;
  const nearest = starIndex(frameStars);
  let correction: Polynomial | null = null;
  let radius = initialRadius;
  let result: { poly: Polynomial; matched: number; rms: number } | null = null;
  for (let iteration = 0; iteration < 5; iteration++) {
    const points: Array<[number, number]> = [];
    const residuals: Array<[number, number]> = [];
    for (const star of referenceStars) {
      const [bx, by] = base(star.x, star.y);
      const [cx, cy] = correction ? evaluatePolynomial(correction, star.x, star.y) : [0, 0];
      const match = nearest(bx + cx, by + cy, radius);
      if (match < 0) continue;
      points.push([star.x, star.y]);
      residuals.push([frameStars[match].x - bx, frameStars[match].y - by]);
    }
    if (points.length < 6) return result;
    const order = points.length >= 80 ? 3 : points.length >= 30 ? 2 : 1;
    // Sigma-clipped fit: mismatches and blended stars must not bend the mapping.
    let use = points.map(() => true);
    let poly: Polynomial | null = null;
    let errors: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      poly = fitPolynomial(points.filter((_, i) => use[i]), residuals.filter((_, i) => use[i]), use.filter(Boolean).length >= 3 * terms(order, 0, 0).length ? order : 1, width, height);
      if (!poly) return result;
      errors = points.map(([x, y], i) => {
        const [dx, dy] = evaluatePolynomial(poly!, x, y);
        return Math.hypot(residuals[i][0] - dx, residuals[i][1] - dy);
      });
      const limit = Math.max(0.3, 3 * 1.4826 * median(errors.filter((_, i) => use[i])));
      const next = errors.map(error => error <= limit);
      if (next.filter(Boolean).length < 6 || next.every((value, i) => value === use[i])) break;
      use = next;
    }
    const kept = errors.filter((_, i) => use[i]);
    correction = poly;
    result = { poly: poly!, matched: kept.length, rms: Math.sqrt(kept.reduce((sum, value) => sum + value * value, 0) / kept.length) };
    radius = Math.max(1.5, Math.min(radius, 4 * result.rms + 1));
  }
  return result;
}

/** Bilinear interpolation of a mapping evaluated on a coarse grid (the mappings are smooth). */
function gridded(mapping: Mapping, width: number, height: number, step = 16): { map: Mapping; areaRatio: (x: number, y: number) => number } {
  const columns = Math.ceil((width - 1) / step) + 1;
  const rows = Math.ceil((height - 1) / step) + 1;
  const gx = new Float64Array(columns * rows);
  const gy = new Float64Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const [x, y] = mapping(Math.min(column * step, width - 1), Math.min(row * step, height - 1));
      gx[row * columns + column] = x;
      gy[row * columns + column] = y;
    }
  }
  const interpolate = (grid: Float64Array, x: number, y: number) => {
    const fx = Math.min(Math.max(x / step, 0), columns - 1.000001);
    const fy = Math.min(Math.max(y / step, 0), rows - 1.000001);
    const c = Math.floor(fx), r = Math.floor(fy);
    const tx = fx - c, ty = fy - r;
    const i = r * columns + c;
    return (grid[i] * (1 - tx) + grid[i + 1] * tx) * (1 - ty) + (grid[i + columns] * (1 - tx) + grid[i + columns + 1] * tx) * ty;
  };
  const map: Mapping = (x, y) => [interpolate(gx, x, y), interpolate(gy, x, y)];
  return {
    map,
    areaRatio: (x, y) => {
      // Central differences, kept inside the grid so the last row/column has a real derivative.
      const px = Math.min(Math.max(x, 1), width - 2), py = Math.min(Math.max(y, 1), height - 2);
      const [x1, y1] = map(px + 1, py), [x0, y0] = map(px - 1, py);
      const [x3, y3] = map(px, py + 1), [x2, y2] = map(px, py - 1);
      return Math.abs((x1 - x0) * (y3 - y2) - (x3 - x2) * (y1 - y0)) / 4;
    },
  };
}

export function wcsMapping(reference: WcsSolution, frame: WcsSolution): Mapping {
  return (x, y) => {
    const sky = pixelToSky(reference, x + 1, y + 1);
    const pixel = skyToPixel(frame, sky.ra, sky.dec);
    return pixel ? [pixel.x - 1, pixel.y - 1] : [Number.NaN, Number.NaN];
  };
}

/**
 * Registers one frame onto the reference. `translation` is the cross-correlation fallback used
 * when either frame lacks a plate solution. Throws when stars show the frame cannot be aligned.
 */
export function registerFrame(options: {
  width: number; height: number;
  referenceStars: Star[]; frameStars: Star[];
  referenceWcs: WcsSolution | null; frameWcs: WcsSolution | null;
  translation: () => { dx: number; dy: number };
}): Registration {
  const { width, height, referenceStars, frameStars, referenceWcs, frameWcs } = options;
  const useWcs = Boolean(referenceWcs && frameWcs);
  let base: Mapping;
  if (useWcs) {
    base = wcsMapping(referenceWcs!, frameWcs!);
  } else {
    const { dx, dy } = options.translation();
    base = (x, y) => [x + dx, y + dy];
  }
  const refined = refineWithStars(base, referenceStars, frameStars, width, height, useWcs ? 8 : 6);
  const enoughStars = Math.min(referenceStars.length, frameStars.length) >= 15;
  if (refined && refined.matched >= Math.max(6, Math.min(25, 0.15 * Math.min(referenceStars.length, frameStars.length))) && refined.rms <= 1.0) {
    const poly = refined.poly;
    const mapping: Mapping = (x, y) => {
      const [bx, by] = base(x, y);
      const [cx, cy] = evaluatePolynomial(poly, x, y);
      return [bx + cx, by + cy];
    };
    const grid = gridded(mapping, width, height);
    return { ...grid, method: useWcs ? 'wcs+stars' : 'translation+stars', matchedStars: refined.matched,
      rmsPx: Math.round(refined.rms * 1000) / 1000, polynomialOrder: poly.order };
  }
  if (enoughStars) {
    // Plenty of stars but they do not line up: blending this frame would blur the stack.
    throw new Error(refined
      ? `stars do not line up (${refined.matched} matched, residual ${refined.rms.toFixed(2)} px)`
      : 'its stars could not be matched to the reference frame');
  }
  // Too few stars to check (e.g. planetary or very sparse frames): trust the base mapping.
  const grid = gridded(base, width, height);
  return { ...grid, method: useWcs ? 'wcs' : 'translation', matchedStars: refined?.matched ?? 0, rmsPx: null, polynomialOrder: null };
}

/** Catmull-Rom bicubic sample at a 0-based position; NaN outside the frame or next to NaN data. */
export function bicubic(plane: Float64Array, offset: number, width: number, height: number, x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix < 1 || iy < 1 || ix > width - 3 || iy > height - 3) {
    // Last-pixel border: bilinear, or nearest at the very edge.
    if (x < -0.5 || y < -0.5 || x > width - 0.5 || y > height - 0.5) return Number.NaN;
    const cx = Math.min(Math.max(Math.round(x), 0), width - 1), cy = Math.min(Math.max(Math.round(y), 0), height - 1);
    return plane[offset + cy * width + cx];
  }
  const tx = x - ix, ty = y - iy;
  const weights = (t: number) => {
    const t2 = t * t, t3 = t2 * t;
    return [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2];
  };
  const wx = weights(tx), wy = weights(ty);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    const row = offset + (iy - 1 + j) * width + ix - 1;
    const line = plane[row] * wx[0] + plane[row + 1] * wx[1] + plane[row + 2] * wx[2] + plane[row + 3] * wx[3];
    sum += line * wy[j];
  }
  return sum;
}
