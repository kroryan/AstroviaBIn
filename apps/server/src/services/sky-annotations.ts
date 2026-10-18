import { and, isNotNull } from 'drizzle-orm';
import { db, schema } from '../db';
import type { AstrometryAnnotation } from './astrometry';
import { angularDistanceDegrees, pixelScaleArcsec, pixelToSky, skyToPixel, type WcsSolution } from './wcs';

interface CatalogEntry {
  name: string;
  type: string | null;
  raDeg: number;
  decDeg: number;
  majorAxis: number | null;
  minorAxis: number | null;
  vMag: number | null;
  bMag: number | null;
  messier: string | null;
  commonNames: string | null;
}

// OpenNGC rows that are duplicates of another entry or do not exist on the sky.
const EXCLUDED_TYPES = new Set(['Dup', 'NonEx']);
const MAX_ANNOTATIONS = 400;
const CACHE_MS = 10 * 60 * 1000;
let cache: { loadedAt: number; entries: CatalogEntry[] } | null = null;

async function catalogEntries(): Promise<CatalogEntry[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_MS) return cache.entries;
  const rows = await db.select({
    name: schema.catalogObjects.name,
    type: schema.catalogObjects.type,
    raDeg: schema.catalogObjects.raDeg,
    decDeg: schema.catalogObjects.decDeg,
    majorAxis: schema.catalogObjects.majorAxis,
    minorAxis: schema.catalogObjects.minorAxis,
    vMag: schema.catalogObjects.vMag,
    bMag: schema.catalogObjects.bMag,
    messier: schema.catalogObjects.messier,
    commonNames: schema.catalogObjects.commonNames,
  }).from(schema.catalogObjects)
    .where(and(isNotNull(schema.catalogObjects.raDeg), isNotNull(schema.catalogObjects.decDeg)))
    .execute();
  const entries = (rows as CatalogEntry[]).filter(row => !EXCLUDED_TYPES.has(row.type || ''));
  cache = { loadedAt: Date.now(), entries };
  return entries;
}

export function clearSkyAnnotationCache(): void {
  cache = null;
}

/** Display names, most recognisable first: Messier number, catalogue name, then common names. */
function namesFor(entry: CatalogEntry): string[] {
  const names = [entry.messier, entry.name, ...(entry.commonNames || '').split(',')]
    .map(name => name?.trim())
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)];
}

function annotationType(entry: CatalogEntry): string {
  if (entry.messier) return 'messier';
  return entry.name.toUpperCase().startsWith('IC') ? 'ic' : 'ngc';
}

/**
 * Projects every OpenNGC object that overlaps the solved field through the full WCS (TAN + SIP).
 * Returned pixel coordinates are in image-content space: (0, 0) is the top-left corner of the
 * first pixel, so a viewer can position overlays as `pixelx / imageWidth` without offsets.
 */
export function annotateField(wcs: WcsSolution, entries: CatalogEntry[]): AstrometryAnnotation[] {
  const width = wcs.imageWidth;
  const height = wcs.imageHeight;
  const center = pixelToSky(wcs, (width + 1) / 2, (height + 1) / 2);
  const corners = [[0.5, 0.5], [width + 0.5, 0.5], [0.5, height + 0.5], [width + 0.5, height + 0.5]];
  const fieldRadius = Math.max(...corners.map(([x, y]) => {
    const corner = pixelToSky(wcs, x, y);
    return angularDistanceDegrees(center.ra, center.dec, corner.ra, corner.dec);
  }));
  const scale = pixelScaleArcsec(wcs);
  const annotations: Array<AstrometryAnnotation & { sortKey: number }> = [];

  for (const entry of entries) {
    const objectRadiusDeg = Math.max(entry.majorAxis || 0, entry.minorAxis || 0) / 120;
    if (angularDistanceDegrees(center.ra, center.dec, entry.raDeg, entry.decDeg) > fieldRadius + objectRadiusDeg) continue;
    const pixel = skyToPixel(wcs, entry.raDeg, entry.decDeg);
    if (!pixel) continue;
    const contentX = pixel.x - 0.5;
    const contentY = pixel.y - 0.5;
    const radius = entry.majorAxis ? entry.majorAxis * 30 / scale : 0;
    // Keep objects whose centre or outline falls on the image.
    const nearestX = Math.min(Math.max(contentX, 0), width);
    const nearestY = Math.min(Math.max(contentY, 0), height);
    const inside = contentX >= 0 && contentX <= width && contentY >= 0 && contentY <= height;
    if (!inside && Math.hypot(contentX - nearestX, contentY - nearestY) > radius) continue;
    annotations.push({
      type: annotationType(entry),
      objectType: entry.type || undefined,
      names: namesFor(entry),
      pixelx: contentX,
      pixely: contentY,
      ra: entry.raDeg,
      dec: entry.decDeg,
      radius,
      vmag: entry.vMag ?? entry.bMag ?? undefined,
      sortKey: (entry.messier ? 1000 : 0) + radius - (entry.vMag ?? entry.bMag ?? 20),
    });
  }
  return annotations
    .sort((left, right) => right.sortKey - left.sortKey)
    .slice(0, MAX_ANNOTATIONS)
    .map(({ sortKey: _sortKey, ...annotation }) => annotation);
}

export async function computeSkyAnnotations(wcs: WcsSolution): Promise<AstrometryAnnotation[]> {
  return annotateField(wcs, await catalogEntries());
}
