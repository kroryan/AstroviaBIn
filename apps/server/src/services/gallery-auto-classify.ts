import { inArray } from 'drizzle-orm';
import { isSolarSystemTagged } from './solar-system';
import { db, schema } from '../db';
import { storage } from './storage';
import { angularDistanceDegrees } from './wcs';

/**
 * Automatic gallery catalogs:
 *  - planets, Sun, Moon and other Solar System frames go to one "Solar System" catalog;
 *  - every plate-solved image gets the catalog of its field — overlapping solutions or the same
 *    identified target (mosaic panels, a moving asteroid's fields) share it, and a field seen once
 *    gets its own catalog that later images of that field join.
 *
 * Only images that are in no catalog yet are added, so manual organisation is never undone:
 * when some images of a field are already in one of the user's catalogs, the rest join it.
 * Unsolved images stay loose until they are solved.
 */

export const SOLAR_SYSTEM_CATALOG = 'Solar System';
export const AUTO_DESCRIPTION = 'Auto-classified by plate solution';

export interface FieldImage {
  id: number;
  ra: number;
  dec: number;
  /** Largest field dimension, degrees. */
  size: number;
  target: string | null;
  constellation: string | null;
  title?: string | null;
}

/** "29.8' × 29.8'" (or degrees/arcsec) → largest dimension in degrees. */
export function fieldSizeDegrees(fieldOfView: string | null | undefined): number | null {
  if (!fieldOfView) return null;
  const values = [...fieldOfView.matchAll(/([\d.]+)\s*(°|'|′|"|″)?/g)].map(match => {
    const value = Number(match[1]);
    const unit = match[2] ?? "'";
    return unit === '°' ? value : unit === '"' || unit === '″' ? value / 3600 : value / 60;
  }).filter(value => Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : null;
}

function normalizedTarget(target: string | null): string | null {
  const value = target?.trim().replace(/\s+/g, ' ').toLowerCase();
  return value || null;
}

/** Two solutions show the same field when their centres are within half the smaller field. */
export function sameField(a: FieldImage, b: FieldImage): boolean {
  return angularDistanceDegrees(a.ra, a.dec, b.ra, b.dec) <= 0.5 * Math.min(a.size, b.size);
}

/** Groups of image ids linked by overlapping fields or the same identified target. */
export function clusterFields(images: FieldImage[]): number[][] {
  const parent = images.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const join = (a: number, b: number) => { parent[find(a)] = find(b); };
  const byTarget = new Map<string, number>();
  images.forEach((image, index) => {
    const target = normalizedTarget(image.target);
    if (target) {
      const first = byTarget.get(target);
      if (first === undefined) byTarget.set(target, index); else join(index, first);
    }
    for (let other = 0; other < index; other++) if (sameField(image, images[other])) join(index, other);
  });
  const groups = new Map<number, number[]>();
  images.forEach((image, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), image.id]);
  });
  return [...groups.values()];
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** A user-given title without the file extension and site/copy suffixes, or null for generic file names. */
export function descriptiveTitle(title: string | null | undefined, constellation?: string | null): string | null {
  const cleaned = (title ?? '')
    .replace(/\.(png|jpe?g|gif|tiff?|fits?|fts|webp|heic|xisf)$/i, '')
    .replace(/\s+canarias$/i, '')
    .replace(/\s+\d{1,2}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 3 || cleaned.length > 60 || !/[a-zà-ÿ]/i.test(cleaned)) return null;
  // Camera/observatory file names and coordinate dumps are not names.
  if (/^coordenadas|^celestial coordinates|_|\d{5,}/i.test(cleaned)) return null;
  if (constellation && cleaned.toLowerCase() === constellation.toLowerCase()) return null;
  return cleaned;
}

function compact(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Whether a title names the target itself (its designation, "M 42", "Messier 42"). */
export function titleReferencesTarget(title: string, target: string, messier?: string | null): boolean {
  const name = compact(title);
  const designations = [compact(target)];
  const number = messier?.match(/\d+/)?.[0];
  if (number) designations.push(`m${number}`, `messier${number}`);
  return designations.some(designation => designation.length >= 2 && name.includes(designation));
}

/**
 * Catalog name for a field: the identified target ("M 42 (NGC 1976)") when an image title names
 * it or no title is descriptive; otherwise the user's own title ("Tau Canis Majoris"), since the
 * identified target can be an incidental object in the field; else the field position.
 */
export async function clusterName(members: FieldImage[]): Promise<string> {
  const target = mostCommon(members.map(member => member.target?.trim()).filter((value): value is string => Boolean(value)));
  let messier: string | null = null;
  if (target) {
    const rows = await db.select({ name: schema.catalogObjects.name, messier: schema.catalogObjects.messier })
      .from(schema.catalogObjects).where(inArray(schema.catalogObjects.name, [target])).execute() as Array<{ name: string; messier: string | null }>;
    messier = rows[0]?.messier?.trim() || null;
  }
  const titles = members.map(member => descriptiveTitle(member.title, member.constellation)).filter((value): value is string => Boolean(value));
  const targetName = target ? (messier ? `${messier} (${target})` : target) : null;
  if (targetName && (!titles.length || members.some(member => member.title && titleReferencesTarget(member.title, target!, messier)))) {
    return targetName;
  }
  if (titles.length) {
    const counts = new Map<string, number>();
    for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
  }
  const ra = members.reduce((sum, member) => sum + member.ra, 0) / members.length;
  const dec = members.reduce((sum, member) => sum + member.dec, 0) / members.length;
  const hours = Math.floor(ra / 15);
  const minutes = Math.floor((ra / 15 - hours) * 60);
  const constellation = mostCommon(members.map(member => member.constellation).filter((value): value is string => Boolean(value)));
  return `${constellation ? `${constellation} field` : 'Field'} ${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')} ${dec >= 0 ? '+' : '−'}${Math.abs(Math.round(dec))}°`;
}

/**
 * A catalog with this name: the user's own catalog of that name is reused; an automatic one only
 * when it holds images of the same field (`members`), otherwise a numbered name is used so two
 * different fields that happen to share a title are never mixed.
 */
async function catalogNamed(name: string, description: string, members: number[] = [], catalogsOf?: Map<number, number[]>): Promise<{ id: number; created: boolean; name: string }> {
  for (let suffix = 1; suffix < 100; suffix++) {
    const candidate = suffix === 1 ? name : `${name} (${suffix})`;
    const existing = await storage.getGalleryCatalogByName(candidate);
    if (!existing) return { id: (await storage.createGalleryCatalog({ name: candidate, description })).id, created: true, name: candidate };
    const automatic = existing.description === AUTO_DESCRIPTION;
    if (!automatic || !catalogsOf || members.some(id => catalogsOf.get(id)?.includes(existing.id))) {
      return { id: existing.id, created: false, name: candidate };
    }
  }
  throw new Error(`Too many catalogs named ${name}`);
}

/**
 * Classifies the whole gallery, or only the group of `imageId` (after it is solved or tagged).
 * Returns how many images were added and which catalogs were created.
 */
export async function classifyGallery(options: { imageId?: number } = {}): Promise<{ added: number; created: string[]; renamed: string[] }> {
  const images = await storage.getAstroImages();
  const memberships = await db.select({ catalogId: schema.galleryCatalogImages.catalogId, imageId: schema.galleryCatalogImages.imageId })
    .from(schema.galleryCatalogImages).execute() as Array<{ catalogId: number; imageId: number }>;
  const catalogsOf = new Map<number, number[]>();
  for (const { catalogId, imageId } of memberships) catalogsOf.set(imageId, [...(catalogsOf.get(imageId) ?? []), catalogId]);
  const loose = (id: number) => !catalogsOf.has(id);
  let added = 0;
  const created: string[] = [];
  const renamed: string[] = [];

  const solar = images.filter(image => isSolarSystemTagged(image.tags) && loose(image.id)
    && (options.imageId === undefined || image.id === options.imageId)).map(image => image.id);
  if (solar.length) {
    const catalog = await catalogNamed(SOLAR_SYSTEM_CATALOG, 'Planets, Sun and Moon — auto-classified');
    if (catalog.created) created.push(SOLAR_SYSTEM_CATALOG);
    added += await storage.addImagesToGalleryCatalog(catalog.id, solar);
  }

  const fields: FieldImage[] = images.flatMap(image => {
    const ra = Number(image.ra), dec = Number(image.dec);
    const size = fieldSizeDegrees(image.fieldOfView);
    if (!image.plateSolved || isSolarSystemTagged(image.tags) || !image.ra || !image.dec || !Number.isFinite(ra) || !Number.isFinite(dec) || !size) return [];
    return [{ id: image.id, ra, dec, size, target: image.targetName ?? null, constellation: image.constellation ?? null, title: image.title }];
  });
  const byId = new Map(fields.map(field => [field.id, field]));
  for (const group of clusterFields(fields)) {
    if (options.imageId !== undefined && !group.includes(options.imageId)) continue;
    // Join the catalog that already holds most of this field's images (the user's naming wins).
    const existing = mostCommon(group.flatMap(id => catalogsOf.get(id) ?? []));
    // After a single solve, only that image joins an existing catalog: companions left loose
    // there were taken out by hand. A new catalog starts with every loose image of the field.
    const toAdd = options.imageId !== undefined && existing !== undefined
      ? (loose(options.imageId) ? [options.imageId] : [])
      : group.filter(loose);
    if (!toAdd.length) continue;
    let catalogId = existing;
    if (catalogId === undefined) {
      const catalog = await catalogNamed(await clusterName(group.map(id => byId.get(id)!)), AUTO_DESCRIPTION, group, catalogsOf);
      if (catalog.created) created.push(catalog.name);
      catalogId = catalog.id;
    }
    added += await storage.addImagesToGalleryCatalog(catalogId, toAdd);
    for (const id of toAdd) catalogsOf.set(id, [catalogId]);
  }
  // Automatic catalogs still carrying a generated position name get a better name once one exists
  // (a descriptive title or an identified target). A name the user typed is never changed.
  if (options.imageId === undefined) {
    for (const catalog of await storage.getGalleryCatalogs()) {
      if (catalog.description !== AUTO_DESCRIPTION || !GENERATED_FIELD_NAME.test(catalog.name)) continue;
      const members = catalog.imageIds.map(id => byId.get(id)).filter((member): member is FieldImage => Boolean(member));
      if (!members.length) continue;
      const name = await clusterName(members);
      if (name !== catalog.name && !GENERATED_FIELD_NAME.test(name) && !await storage.getGalleryCatalogByName(name)) {
        await storage.updateGalleryCatalog(catalog.id, { name });
        renamed.push(`${catalog.name} → ${name}`);
      }
    }
  }
  return { added, created, renamed };
}

const GENERATED_FIELD_NAME = /^(?:[A-Za-z ]+ )?field \d{2}h\d{2} [+−]\d+°$/;
