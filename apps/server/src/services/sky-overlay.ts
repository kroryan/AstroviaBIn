import type { AstrometryAnnotation } from './astrometry';
import { loadSkyCatalog, starLabels, starPosition, starsNear, tychoName, tychoNear, tychoPosition, type SkyCatalog } from './sky-catalog';
import { angularDistanceDegrees, pixelScaleArcsec, pixelToSky, skyToPixel, type WcsSolution } from './wcs';
import { constellationName } from './iau-constellations';
import type { OnlineCatalog } from './online-catalogs';

/**
 * "Astro-style" annotation layers for a solved image, in the spirit of nova.astrometry.net's
 * annotated view and planetarium overlays: deep-sky outlines, named/catalogued stars,
 * constellation figures and an RA/Dec grid. Every position goes through the image's own WCS
 * (TAN + SIP). Coordinates are image-content pixels: (0, 0) is the top-left corner of the first
 * pixel, so a viewer places a point at x / imageWidth.
 */

export type Point = [number, number];

export interface OverlayObject {
  id: string;
  label: string;
  /** Best-known common name (e.g. "Pleiades"), if any. */
  common: string | null;
  names: string[];
  type: string;
  typeLabel: string;
  x: number;
  y: number;
  /** Semi-axes in pixels (0 for point-like objects) and major-axis angle in degrees, clockwise from +x. */
  rx: number;
  ry: number;
  angle: number;
  mag: number | null;
  ra: number;
  dec: number;
  priority: number;
}

export interface OverlayStar {
  label: string;
  names: string[];
  mag: number | null;
  x: number;
  y: number;
  ra: number;
  dec: number;
  priority: number;
}

export interface SkyOverlay {
  version: 2;
  imageWidth: number;
  imageHeight: number;
  epoch: number;
  field: { ra: number; dec: number; widthDeg: number; heightDeg: number; pixelScale: number; constellation: string | null };
  objects: OverlayObject[];
  stars: OverlayStar[];
  constellations: {
    lines: Array<{ id: string; points: Point[] }>;
    labels: Array<{ id: string; name: string; x: number; y: number }>;
  };
  grid: { raStepDeg: number; decStepDeg: number; lines: Array<{ kind: 'ra' | 'dec'; value: number; label: string; points: Point[] }> };
  /** Present when an online catalogue (Gaia DR3 / SIMBAD) was merged in. */
  online?: { fetchedAt: string; gaia: number; simbad: number };
}

const TYPE_LABELS: Record<string, string> = {
  G: 'Galaxy', GPair: 'Galaxy pair', GTrpl: 'Galaxy triplet', GGroup: 'Galaxy group', PN: 'Planetary nebula',
  HII: 'HII region', EmN: 'Emission nebula', Neb: 'Nebula', RfN: 'Reflection nebula', SNR: 'Supernova remnant',
  OCl: 'Open cluster', GCl: 'Globular cluster', 'Cl+N': 'Cluster with nebula', '*Ass': 'Stellar association', DrkN: 'Dark nebula',
};
const MAX_STARS = 600;
const MAX_OBJECTS = 300;

const toRad = (degrees: number) => degrees * Math.PI / 180;
const toDeg = (radians: number) => radians * 180 / Math.PI;

/** Point reached from (ra, dec) by moving `distance` degrees along position angle `pa` (north through east). */
export function offsetPoint(ra: number, dec: number, pa: number, distance: number): { ra: number; dec: number } {
  const d = toRad(distance);
  const angle = toRad(pa);
  const dec1 = toRad(dec);
  const dec2 = Math.asin(Math.sin(dec1) * Math.cos(d) + Math.cos(dec1) * Math.sin(d) * Math.cos(angle));
  const ra2 = toRad(ra) + Math.atan2(Math.sin(angle) * Math.sin(d) * Math.cos(dec1), Math.cos(d) - Math.sin(dec1) * Math.sin(dec2));
  return { ra: (toDeg(ra2) % 360 + 360) % 360, dec: toDeg(dec2) };
}

/** Content-space pixel (top-left origin) for a sky position, or null behind the tangent plane. */
function project(wcs: WcsSolution, ra: number, dec: number): Point | null {
  const pixel = skyToPixel(wcs, ra, dec);
  return pixel ? [pixel.x - 0.5, pixel.y - 0.5] : null;
}

interface FieldGeometry {
  center: { ra: number; dec: number };
  radius: number;
  width: number;
  height: number;
  scaleDeg: number;
  /** Sky positions of a lattice over the frame, for coordinate ranges. */
  samples: Array<{ ra: number; dec: number }>;
}

function fieldGeometry(wcs: WcsSolution): FieldGeometry {
  const width = wcs.imageWidth;
  const height = wcs.imageHeight;
  const center = pixelToSky(wcs, (width + 1) / 2, (height + 1) / 2);
  const samples: Array<{ ra: number; dec: number }> = [];
  for (let i = 0; i <= 10; i++) {
    for (let j = 0; j <= 10; j++) samples.push(pixelToSky(wcs, 0.5 + width * i / 10, 0.5 + height * j / 10));
  }
  const radius = Math.max(...samples.map(point => angularDistanceDegrees(center.ra, center.dec, point.ra, point.dec)));
  return { center, radius, width, height, scaleDeg: pixelScaleArcsec(wcs) / 3600, samples };
}

function insideFrame(point: Point, width: number, height: number, margin = 0): boolean {
  return point[0] >= -margin && point[0] <= width + margin && point[1] >= -margin && point[1] <= height + margin;
}

function objectOverlay(wcs: WcsSolution, field: FieldGeometry, catalog: SkyCatalog): OverlayObject[] {
  const objects: OverlayObject[] = [];
  for (const entry of catalog.dso) {
    const majorDeg = (entry.maj ?? 0) / 60;
    if (angularDistanceDegrees(field.center.ra, field.center.dec, entry.ra, entry.dec) > field.radius + majorDeg) continue;
    const center = project(wcs, entry.ra, entry.dec);
    if (!center) continue;
    let rx = 0;
    let ry = 0;
    let angle = 0;
    if (majorDeg > 0) {
      const pa = entry.pa ?? 0;
      const minorDeg = (entry.min ?? entry.maj ?? 0) / 60;
      const majorEnd = offsetPoint(entry.ra, entry.dec, pa, majorDeg / 2);
      const minorEnd = offsetPoint(entry.ra, entry.dec, pa + 90, minorDeg / 2);
      const major = project(wcs, majorEnd.ra, majorEnd.dec);
      const minor = project(wcs, minorEnd.ra, minorEnd.dec);
      if (major && minor) {
        rx = Math.hypot(major[0] - center[0], major[1] - center[1]);
        ry = Math.hypot(minor[0] - center[0], minor[1] - center[1]);
        angle = toDeg(Math.atan2(major[1] - center[1], major[0] - center[0]));
      }
    }
    // Keep it when the centre is on the frame or its outline reaches the frame.
    const reach = Math.max(rx, ry);
    const nearestX = Math.min(Math.max(center[0], 0), field.width);
    const nearestY = Math.min(Math.max(center[1], 0), field.height);
    if (!insideFrame(center, field.width, field.height) && Math.hypot(center[0] - nearestX, center[1] - nearestY) > reach) continue;
    const names = [...new Set([entry.messier, entry.name, ...entry.common].filter(Boolean))];
    const sizeScore = Math.log10(1 + reach);
    objects.push({
      id: entry.name,
      label: names[0],
      common: entry.common[0] ?? null,
      names,
      type: entry.type,
      typeLabel: TYPE_LABELS[entry.type] ?? entry.type,
      x: center[0], y: center[1], rx, ry, angle,
      mag: entry.mag,
      ra: entry.ra, dec: entry.dec,
      priority: (entry.messier ? 100 : 40) + (entry.common.length ? 15 : 0) + sizeScore * 8 + (entry.mag === null ? 0 : Math.max(0, 14 - entry.mag)),
    });
  }
  return objects.sort((left, right) => right.priority - left.priority).slice(0, MAX_OBJECTS);
}

function starOverlay(wcs: WcsSolution, field: FieldGeometry, catalog: SkyCatalog, epoch: number): OverlayStar[] {
  const table = catalog.stars;
  const stars: OverlayStar[] = [];
  // Spatial hash (in pixels) to merge the same star coming from HYG/HD and Tycho-2.
  // HD-only entries carry no proper motion, so allow a few arcseconds when matching them to Tycho-2.
  const matchRadius = Math.max(1.5, 6 / 3600 / field.scaleDeg);
  const cell = matchRadius * 2;
  const grid = new Map<string, OverlayStar[]>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const nearby = (x: number, y: number): OverlayStar | undefined => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const star of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (Math.hypot(star.x - x, star.y - y) <= matchRadius) return star;
      }
    }
    return undefined;
  };
  const add = (star: OverlayStar) => {
    stars.push(star);
    const key = cellKey(star.x, star.y);
    grid.set(key, [...(grid.get(key) ?? []), star]);
  };

  for (const index of starsNear(table, field.center.ra, field.center.dec, field.radius + 0.05)) {
    const position = starPosition(table, index, epoch);
    const point = project(wcs, position.ra, position.dec);
    if (!point || !insideFrame(point, field.width, field.height)) continue;
    const names = starLabels(table, index);
    if (names.length === 0) continue;
    const mag = Number.isNaN(table.mag[index]) ? null : table.mag[index];
    add({
      label: table.name[index] && table.bayer[index] ? `${table.name[index]} (${table.bayer[index]})` : names[0],
      names,
      mag: mag === null ? null : Math.round(mag * 100) / 100,
      x: point[0], y: point[1], ra: position.ra, dec: position.dec,
      // Named bright stars outrank catalogue objects: Alcyone matters more than the M 45 marker on top of it.
      priority: starPriority(mag, table.name[index] ? 110 : table.bayer[index] ? 80 : table.flam[index] ? 45 : 0),
    });
  }

  const tycho = catalog.tycho;
  if (tycho) {
    for (const index of tychoNear(tycho, field.center.ra, field.center.dec, field.radius + 0.05)) {
      const position = tychoPosition(tycho, index, epoch);
      const point = project(wcs, position.ra, position.dec);
      if (!point || !insideFrame(point, field.width, field.height)) continue;
      const mag = Math.round(tycho.mag[index] / 10) / 100;
      const name = tychoName(tycho, index);
      const existing = nearby(point[0], point[1]);
      if (existing) {
        // Same star already known by HD: borrow the Tycho magnitude and identifier.
        if (existing.mag === null) {
          // HD-only entry: Tycho-2 has the magnitude and a proper-motion-corrected position.
          existing.mag = mag;
          existing.x = point[0];
          existing.y = point[1];
          existing.ra = position.ra;
          existing.dec = position.dec;
          existing.priority = starPriority(mag, 0);
        }
        if (!existing.names.includes(name)) existing.names.push(name);
        continue;
      }
      add({ label: name, names: [name], mag, x: point[0], y: point[1], ra: position.ra, dec: position.dec, priority: starPriority(mag, -10) });
    }
  }
  return stars.sort((left, right) => right.priority - left.priority).slice(0, MAX_STARS);
}

/** Brighter stars and named stars first; unknown magnitudes rank like mag 11. */
function starPriority(mag: number | null, bonus: number): number {
  return bonus + Math.max(0, 16 - (mag ?? 11)) * 4;
}

function unitVector(ra: number, dec: number): [number, number, number] {
  const a = toRad(ra);
  const d = toRad(dec);
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** Points along the great circle between two sky positions, every `stepDeg` at most. */
function greatCircle(from: Point, to: Point, stepDeg: number): Point[] {
  const a = unitVector(from[0], from[1]);
  const b = unitVector(to[0], to[1]);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const steps = Math.max(1, Math.ceil(toDeg(omega) / stepDeg));
  const points: Point[] = [];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const wa = omega < 1e-9 ? 1 - t : Math.sin((1 - t) * omega) / Math.sin(omega);
    const wb = omega < 1e-9 ? t : Math.sin(t * omega) / Math.sin(omega);
    const v = [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
    points.push([(toDeg(Math.atan2(v[1], v[0])) + 360) % 360, toDeg(Math.asin(Math.max(-1, Math.min(1, v[2]))))]);
  }
  return points;
}

/** Projects a sky polyline, splitting it where it leaves the usable part of the tangent plane. */
function projectPolyline(wcs: WcsSolution, field: FieldGeometry, sky: Point[]): Point[][] {
  const limit = Math.max(field.width, field.height) * 4;
  const pieces: Point[][] = [];
  let current: Point[] = [];
  for (const [ra, dec] of sky) {
    const usable = angularDistanceDegrees(field.center.ra, field.center.dec, ra, dec) < Math.min(80, field.radius * 6 + 5);
    const point = usable ? project(wcs, ra, dec) : null;
    if (point && Math.abs(point[0] - field.width / 2) < limit && Math.abs(point[1] - field.height / 2) < limit) {
      current.push([Math.round(point[0] * 10) / 10, Math.round(point[1] * 10) / 10]);
    } else if (current.length) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length) pieces.push(current);
  return pieces.filter(piece => piece.length > 1 && piece.some(point => insideFrame(point, field.width, field.height, field.width * 0.05)) || crossesFrame(piece, field));
}

function crossesFrame(piece: Point[], field: FieldGeometry): boolean {
  if (piece.length < 2) return false;
  const xs = piece.map(point => point[0]);
  const ys = piece.map(point => point[1]);
  return Math.min(...xs) < field.width && Math.max(...xs) > 0 && Math.min(...ys) < field.height && Math.max(...ys) > 0;
}

function constellationOverlay(wcs: WcsSolution, field: FieldGeometry, catalog: SkyCatalog): SkyOverlay['constellations'] {
  const step = Math.max(0.05, Math.min(1, field.radius / 20));
  const lines: SkyOverlay['constellations']['lines'] = [];
  const labels: SkyOverlay['constellations']['labels'] = [];
  for (const constellation of catalog.constellations) {
    for (const segment of constellation.lines) {
      // Skip figures far from the field quickly.
      if (!segment.some(([ra, dec]) => angularDistanceDegrees(field.center.ra, field.center.dec, ra, dec) < field.radius + 40)) continue;
      const sky: Point[] = [];
      for (let index = 0; index < segment.length - 1; index++) {
        const arc = greatCircle(segment[index], segment[index + 1], step);
        sky.push(...(index === 0 ? arc : arc.slice(1)));
      }
      for (const points of projectPolyline(wcs, field, sky)) lines.push({ id: constellation.id, points });
    }
    const label = project(wcs, constellation.label[0], constellation.label[1]);
    if (label && insideFrame(label, field.width, field.height) &&
        angularDistanceDegrees(field.center.ra, field.center.dec, constellation.label[0], constellation.label[1]) <= field.radius) {
      labels.push({ id: constellation.id, name: constellation.name, x: label[0], y: label[1] });
    }
  }
  return { lines, labels };
}

const DEC_STEPS = [1 / 60, 2 / 60, 5 / 60, 10 / 60, 15 / 60, 0.5, 1, 2, 5, 10, 15, 30];
// RA steps in degrees, i.e. 4s, 8s, 20s, 40s, 1m, 2m, 5m, 10m, 20m, 30m, 1h, 2h.
const RA_STEPS = [1 / 60, 2 / 60, 5 / 60, 10 / 60, 0.25, 0.5, 1.25, 2.5, 5, 7.5, 15, 30];

function niceStep(span: number, steps: number[], target = 5): number {
  return steps.find(step => span / step <= target) ?? steps[steps.length - 1];
}

function formatRa(degrees: number, step: number): string {
  const totalSeconds = Math.round(((degrees % 360) + 360) % 360 / 15 * 3600);
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor(totalSeconds % 3600 / 60);
  const s = totalSeconds % 60;
  return step < 0.25 ? `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s` : `${h}h${String(m).padStart(2, '0')}m`;
}

function formatDec(degrees: number, step: number): string {
  const sign = degrees < 0 ? '−' : '+';
  const totalArcsec = Math.round(Math.abs(degrees) * 3600);
  const d = Math.floor(totalArcsec / 3600);
  const m = Math.floor(totalArcsec % 3600 / 60);
  return step >= 1 ? `${sign}${d}°` : `${sign}${d}°${String(m).padStart(2, '0')}′`;
}

function gridOverlay(wcs: WcsSolution, field: FieldGeometry): SkyOverlay['grid'] {
  const decs = field.samples.map(point => point.dec);
  let decMin = Math.min(...decs);
  let decMax = Math.max(...decs);
  const northPole = project(wcs, 0, 90);
  const southPole = project(wcs, 0, -90);
  const poleInside = (northPole && insideFrame(northPole, field.width, field.height)) || (southPole && insideFrame(southPole, field.width, field.height));
  if (northPole && insideFrame(northPole, field.width, field.height)) decMax = 90;
  if (southPole && insideFrame(southPole, field.width, field.height)) decMin = -90;
  // RA span measured around the field centre so the 0h/24h seam does not matter.
  const offsets = field.samples.map(point => ((point.ra - field.center.ra + 540) % 360) - 180);
  const raSpan = poleInside ? 360 : Math.max(...offsets) - Math.min(...offsets);
  const decStep = niceStep(decMax - decMin, DEC_STEPS);
  const raStep = niceStep(raSpan, RA_STEPS);
  const lines: SkyOverlay['grid']['lines'] = [];
  const samplesPerLine = 64;

  const raFrom = poleInside ? 0 : field.center.ra + Math.min(...offsets);
  const raTo = poleInside ? 360 : field.center.ra + Math.max(...offsets);
  for (let dec = Math.ceil(decMin / decStep) * decStep; dec <= decMax + 1e-9; dec += decStep) {
    if (Math.abs(dec) >= 90) continue;
    const sky: Point[] = [];
    for (let i = 0; i <= samplesPerLine; i++) sky.push([raFrom + (raTo - raFrom) * i / samplesPerLine, dec]);
    for (const points of projectPolyline(wcs, field, sky)) lines.push({ kind: 'dec', value: dec, label: formatDec(dec, decStep), points });
  }
  const lowDec = Math.max(-89.999, decMin);
  const highDec = Math.min(89.999, decMax);
  for (let ra = Math.ceil(raFrom / raStep) * raStep; ra <= raTo + 1e-9; ra += raStep) {
    const sky: Point[] = [];
    for (let i = 0; i <= samplesPerLine; i++) sky.push([ra, lowDec + (highDec - lowDec) * i / samplesPerLine]);
    for (const points of projectPolyline(wcs, field, sky)) lines.push({ kind: 'ra', value: ((ra % 360) + 360) % 360, label: formatRa(ra, raStep), points });
  }
  return { raStepDeg: raStep, decStepDeg: decStep, lines };
}

/** Builds every annotation layer for a solved image. Returns null without the offline sky bundle. */
export function computeSkyOverlay(wcs: WcsSolution, options: { epoch?: number; catalog?: SkyCatalog | null } = {}): SkyOverlay | null {
  const catalog = options.catalog === undefined ? loadSkyCatalog() : options.catalog;
  if (!catalog) return null;
  const field = fieldGeometry(wcs);
  const epoch = options.epoch ?? new Date().getUTCFullYear() + new Date().getUTCMonth() / 12;
  return {
    version: 2,
    imageWidth: field.width,
    imageHeight: field.height,
    epoch,
    field: {
      ra: field.center.ra, dec: field.center.dec,
      widthDeg: field.width * field.scaleDeg, heightDeg: field.height * field.scaleDeg,
      pixelScale: pixelScaleArcsec(wcs), constellation: constellationName(field.center.ra, field.center.dec),
    },
    objects: objectOverlay(wcs, field, catalog),
    stars: starOverlay(wcs, field, catalog, epoch),
    constellations: constellationOverlay(wcs, field, catalog),
    grid: gridOverlay(wcs, field),
  };
}

/** The flat annotation list kept for XMP sidecars and older clients. */
export function overlayToAnnotations(overlay: SkyOverlay): AstrometryAnnotation[] {
  return [
    ...overlay.objects.map(object => ({
      type: object.names[0].startsWith('M ') ? 'messier' : object.id.startsWith('IC') ? 'ic' : 'ngc',
      objectType: object.type, names: object.names, pixelx: object.x, pixely: object.y,
      radius: object.rx, ra: object.ra, dec: object.dec, vmag: object.mag ?? undefined,
    })),
    ...overlay.stars.map(star => ({
      type: 'star', names: star.names, pixelx: star.x, pixely: star.y, ra: star.ra, dec: star.dec, vmag: star.mag ?? undefined,
    })),
  ];
}

/**
 * Adds an online catalogue (Gaia DR3 stars, SIMBAD objects) to an overlay. Stars already known
 * offline only gain their Gaia identifier; objects near an OpenNGC entry only add their name.
 */
export function mergeOnlineCatalog(overlay: SkyOverlay, wcs: WcsSolution, online: OnlineCatalog, epoch: number): SkyOverlay {
  const width = overlay.imageWidth;
  const height = overlay.imageHeight;
  const scaleDeg = overlay.field.pixelScale / 3600;
  const starRadius = Math.max(1.5, 1.5 / 3600 / scaleDeg);
  const cell = starRadius * 2;
  const grid = new Map<string, OverlayStar[]>();
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  const index = (star: OverlayStar) => { const key = keyOf(star.x, star.y); grid.set(key, [...(grid.get(key) ?? []), star]); };
  overlay.stars.forEach(index);
  const nearby = (x: number, y: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const star of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(star.x - x, star.y - y) <= starRadius) return star;
    }
    return undefined;
  };
  const stars = overlay.stars.map(star => ({ ...star, names: [...star.names] }));
  const years = epoch - 2016;
  for (const gaia of online.gaia) {
    const dec = gaia.dec + gaia.pmdec * years / 3.6e6;
    const ra = gaia.ra + gaia.pmra * years / 3.6e6 / Math.max(1e-6, Math.cos(gaia.dec * Math.PI / 180));
    const point = project(wcs, ra, dec);
    if (!point || !insideFrame(point, width, height)) continue;
    const name = `Gaia DR3 ${gaia.id}`;
    const existing = nearby(point[0], point[1]);
    if (existing) {
      if (!existing.names.includes(name)) existing.names.push(name);
      continue;
    }
    const star: OverlayStar = {
      label: name, names: [name], mag: gaia.mag === null ? null : Math.round(gaia.mag * 100) / 100,
      x: point[0], y: point[1], ra, dec, priority: starPriority(gaia.mag, -20),
    };
    stars.push(star);
    index(star);
  }

  const objects = overlay.objects.map(object => ({ ...object, names: [...object.names] }));
  const objectRadius = Math.max(4, 20 / 3600 / scaleDeg);
  for (const entry of online.simbad) {
    const point = project(wcs, entry.ra, entry.dec);
    if (!point || !insideFrame(point, width, height)) continue;
    // Same object only when close to the catalogue centre (≤ 60"): clusters and HII regions inside a
    // large galaxy's outline are separate objects.
    const match = objects.find(object => Math.hypot(object.x - point[0], object.y - point[1]) <= Math.max(objectRadius, Math.min(object.ry, 60 / 3600 / scaleDeg)));
    if (match) {
      match.names = [entry.name, ...match.names.filter(name => name !== entry.name)];
      match.label = entry.name;
      match.type = entry.type;
      match.typeLabel = SIMBAD_TYPES[entry.type] ?? entry.type;
      if (entry.mag !== null) match.mag = entry.mag;
      match.priority = 1000 + (entry.mag === null ? 0 : Math.max(0, 18 - entry.mag));
      continue;
    }
    objects.push({
      id: entry.name, label: entry.name, common: null, names: [entry.name], type: entry.type, typeLabel: SIMBAD_TYPES[entry.type] ?? entry.type,
      x: point[0], y: point[1], rx: 0, ry: 0, angle: 0, mag: entry.mag, ra: entry.ra, dec: entry.dec,
      priority: 1000 + (entry.mag === null ? 0 : Math.max(0, 18 - entry.mag)),
    });
  }
  return {
    ...overlay,
    stars: stars.sort((left, right) => right.priority - left.priority).slice(0, 2000),
    objects: objects.sort((left, right) => right.priority - left.priority).slice(0, 600),
    online: { fetchedAt: online.fetchedAt, gaia: online.gaia.length, simbad: online.simbad.length },
  };
}

const SIMBAD_TYPES: Record<string, string> = {
  G: 'Galaxy', GiG: 'Galaxy in group', GiC: 'Galaxy in cluster', BiC: 'Brightest galaxy in cluster', SBG: 'Starburst galaxy',
  AGN: 'Active galaxy', Sy1: 'Seyfert 1', Sy2: 'Seyfert 2', QSO: 'Quasar', BLL: 'BL Lac', LSB: 'Low surface brightness galaxy',
  ClG: 'Galaxy cluster', GrG: 'Galaxy group', PN: 'Planetary nebula', HII: 'HII region', RNe: 'Reflection nebula', DNe: 'Dark nebula',
  SNR: 'Supernova remnant', OpC: 'Open cluster', GlC: 'Globular cluster', 'Cl*': 'Star cluster', EmG: 'Emission-line galaxy',
};
