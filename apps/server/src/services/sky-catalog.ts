import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { angularDistanceDegrees } from './wcs';

/**
 * Offline sky data used for annotations, built by tools/scripts/build_sky_catalog.py:
 * HYG + Henry Draper stars, OpenNGC deep-sky objects with sizes and position angles, and
 * d3-celestial constellation figures. Loaded once into memory; stars are sorted by declination
 * so a field query is a binary search plus a small scan.
 */

export interface StarTable {
  epoch: number;
  count: number;
  ra: Float64Array;
  dec: Float64Array;
  mag: Float32Array; // NaN when unknown (HD-only stars)
  pmra: Float32Array; // mas/yr, includes cos(dec)
  pmdec: Float32Array; // mas/yr
  hd: Int32Array; // 0 when none
  hip: Int32Array; // 0 when none
  name: string[];
  bayer: string[];
  flam: string[];
}

export interface DeepSkyObject {
  name: string;
  messier: string;
  common: string[];
  type: string;
  ra: number;
  dec: number;
  maj: number | null; // arcmin
  min: number | null; // arcmin
  pa: number | null; // degrees, north through east
  mag: number | null;
}

export interface Constellation {
  id: string;
  name: string;
  genitive: string;
  label: [number, number];
  lines: Array<Array<[number, number]>>;
}

/** Tycho-2 stars that are not in Hipparcos (columnar, sorted by declination). */
export interface TychoTable {
  epoch: number;
  count: number;
  ra: Float32Array;
  dec: Float32Array;
  mag: Int16Array; // VT (or BT) × 1000
  pmra: Int16Array; // mas/yr, includes cos(dec)
  pmdec: Int16Array;
  tyc1: Uint16Array;
  tyc2: Uint16Array;
  tyc3: Uint8Array;
}

export interface SkyCatalog {
  stars: StarTable;
  tycho?: TychoTable | null;
  dso: DeepSkyObject[];
  constellations: Constellation[];
}

export function skyDataDirectories(): string[] {
  return [
    process.env.ASTROVIABIN_SKY_DATA_DIR,
    '/usr/share/astroviabin/sky',
    path.resolve(process.cwd(), 'data/sky'),
  ].filter((value): value is string => Boolean(value));
}

let cached: SkyCatalog | null | undefined;

function readJson(file: string): unknown {
  const raw = fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));
}

function toStarTable(raw: Record<string, unknown>): StarTable {
  const numbers = (key: string) => raw[key] as Array<number | null>;
  const count = Number(raw.count);
  const mag = new Float32Array(count);
  numbers('mag').forEach((value, index) => { mag[index] = value === null ? Number.NaN : value; });
  return {
    epoch: Number(raw.epoch) || 2000,
    count,
    ra: Float64Array.from(numbers('ra') as number[]),
    dec: Float64Array.from(numbers('dec') as number[]),
    mag,
    pmra: Float32Array.from(numbers('pmra') as number[]),
    pmdec: Float32Array.from(numbers('pmdec') as number[]),
    hd: Int32Array.from(numbers('hd').map(value => value ?? 0)),
    hip: Int32Array.from(numbers('hip').map(value => value ?? 0)),
    name: raw.name as string[],
    bayer: raw.bayer as string[],
    flam: raw.flam as string[],
  };
}

function loadTycho(directory: string): TychoTable | null {
  const meta = path.join(directory, 'tycho.json');
  const data = path.join(directory, 'tycho.bin.gz');
  if (!fs.existsSync(meta) || !fs.existsSync(data)) return null;
  const layout = JSON.parse(fs.readFileSync(meta, 'utf8')) as { count: number; epoch: number; columns: Record<string, { offset: number }> };
  // Copy into a fresh ArrayBuffer so every typed-array view is correctly aligned.
  const bytes = new Uint8Array(zlib.gunzipSync(fs.readFileSync(data))).buffer;
  const n = layout.count;
  const at = (key: string) => layout.columns[key].offset;
  return {
    epoch: layout.epoch,
    count: n,
    ra: new Float32Array(bytes, at('ra'), n),
    dec: new Float32Array(bytes, at('dec'), n),
    mag: new Int16Array(bytes, at('mag'), n),
    pmra: new Int16Array(bytes, at('pmra'), n),
    pmdec: new Int16Array(bytes, at('pmdec'), n),
    tyc1: new Uint16Array(bytes, at('tyc1'), n),
    tyc2: new Uint16Array(bytes, at('tyc2'), n),
    tyc3: new Uint8Array(bytes, at('tyc3'), n),
  };
}

/** Loads the bundle on first use; returns null when it is not installed (annotations fall back to OpenNGC from the DB). */
export function loadSkyCatalog(): SkyCatalog | null {
  if (cached !== undefined) return cached;
  for (const directory of skyDataDirectories()) {
    const starsFile = path.join(directory, 'stars.json.gz');
    if (!fs.existsSync(starsFile)) continue;
    try {
      cached = {
        stars: toStarTable(readJson(starsFile) as Record<string, unknown>),
        tycho: loadTycho(directory),
        dso: readJson(path.join(directory, 'dso.json.gz')) as DeepSkyObject[],
        constellations: readJson(path.join(directory, 'constellations.json')) as Constellation[],
      };
      console.log(`Sky annotation data loaded from ${directory}: ${cached.stars.count} named/HD stars, ${cached.tycho?.count ?? 0} Tycho-2 stars, ${cached.dso.length} deep-sky objects`);
      return cached;
    } catch (error) {
      console.error(`Could not load sky annotation data from ${directory}:`, error);
    }
  }
  console.warn('Sky annotation data not found; star and constellation annotations are unavailable.');
  cached = null;
  return cached;
}

/** For tests. */
export function setSkyCatalog(catalog: SkyCatalog | null): void {
  cached = catalog;
}

function lowerBound(values: Float64Array | Float32Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1; else high = middle;
  }
  return low;
}

/** Indices of stars within `radiusDeg` of a position (catalogue epoch positions). */
export function starsNear(table: StarTable, ra: number, dec: number, radiusDeg: number): number[] {
  const first = lowerBound(table.dec, dec - radiusDeg);
  const last = lowerBound(table.dec, dec + radiusDeg + 1e-9);
  const result: number[] = [];
  for (let index = first; index < last; index++) {
    if (angularDistanceDegrees(ra, dec, table.ra[index], table.dec[index]) <= radiusDeg) result.push(index);
  }
  return result;
}

/** Position of a star at `epoch` (decimal year) after applying its proper motion. */
export function starPosition(table: StarTable, index: number, epoch: number): { ra: number; dec: number } {
  const years = epoch - table.epoch;
  const dec = table.dec[index] + table.pmdec[index] * years / 3.6e6;
  const cosDec = Math.max(1e-6, Math.cos(table.dec[index] * Math.PI / 180));
  const ra = table.ra[index] + table.pmra[index] * years / 3.6e6 / cosDec;
  return { ra: (ra % 360 + 360) % 360, dec };
}

/** Display label: proper name, then Bayer, Flamsteed, HD, HIP. */
export function starLabels(table: StarTable, index: number): string[] {
  const labels = [table.name[index], table.bayer[index], table.flam[index],
    table.hd[index] ? `HD ${table.hd[index]}` : '', table.hip[index] ? `HIP ${table.hip[index]}` : ''];
  return labels.filter(Boolean);
}

/** Indices of Tycho-2 stars within `radiusDeg` of a position. */
export function tychoNear(table: TychoTable, ra: number, dec: number, radiusDeg: number): number[] {
  const first = lowerBound(table.dec, dec - radiusDeg);
  const last = lowerBound(table.dec, dec + radiusDeg + 1e-9);
  const result: number[] = [];
  for (let index = first; index < last; index++) {
    if (angularDistanceDegrees(ra, dec, table.ra[index], table.dec[index]) <= radiusDeg) result.push(index);
  }
  return result;
}

export function tychoPosition(table: TychoTable, index: number, epoch: number): { ra: number; dec: number } {
  const years = epoch - table.epoch;
  const dec = table.dec[index] + table.pmdec[index] * years / 3.6e6;
  const cosDec = Math.max(1e-6, Math.cos(table.dec[index] * Math.PI / 180));
  const ra = table.ra[index] + table.pmra[index] * years / 3.6e6 / cosDec;
  return { ra: (ra % 360 + 360) % 360, dec };
}

export function tychoName(table: TychoTable, index: number): string {
  return `TYC ${table.tyc1[index]}-${table.tyc2[index]}-${table.tyc3[index]}`;
}
