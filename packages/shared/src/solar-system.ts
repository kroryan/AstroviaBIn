export const SOLAR_SYSTEM_TAGS = [
  'solar system', 'sun', 'moon', 'mercury', 'venus', 'earth', 'mars',
  'jupiter', 'saturn', 'uranus', 'neptune', 'pluto',
];
const SOLAR_SYSTEM_TAG_SET = new Set(SOLAR_SYSTEM_TAGS);
const PLANETARY_TAGS = new Set(SOLAR_SYSTEM_TAGS.filter(tag => tag !== 'solar system'));
const SMALL_BODY_TAGS = new Set(['comet', 'comets', 'asteroid', 'asteroids']);

function hasSmallBodyTag(tags: string[] | null | undefined): boolean {
  return Boolean(tags?.some(tag => SMALL_BODY_TAGS.has(tag.trim().toLowerCase())));
}

/** Comets and asteroids can be tagged Deep Sky to plate-solve their stellar field. */
export function isSolarSystemTagged(tags: string[] | null | undefined): boolean {
  if (!tags?.length) return false;
  const normalized = tags.map(tag => tag.trim().toLowerCase());
  if (normalized.some(tag => PLANETARY_TAGS.has(tag))) return true;
  return normalized.includes('solar system') && !normalized.some(tag => SMALL_BODY_TAGS.has(tag));
}

export function isDeepSkyTagged(tags: string[] | null | undefined): boolean {
  return Boolean(tags?.some(tag => tag.trim().toLowerCase() === 'deep sky'));
}

/** A comet/asteroid tagged Deep Sky remains eligible; planetary frames are not. */
export function isPlateSolvingEligible(tags: string[] | null | undefined, alreadySolved = false): boolean {
  return (isDeepSkyTagged(tags) || alreadySolved) && !isSolarSystemTagged(tags);
}

/**
 * The gallery's Not Solved filter also includes ordinary and untagged images,
 * but hides Solar System/planet/comet/asteroid frames unless they are explicitly
 * Deep Sky. Planetary frames remain ineligible for plate solving even then.
 */
export function shouldShowInNotSolvedFilter(tags: string[] | null | undefined): boolean {
  if (isDeepSkyTagged(tags)) return isPlateSolvingEligible(tags);
  return !isSolarSystemTagged(tags) && !hasSmallBodyTag(tags);
}

// Spanish and English names in titles/file names ("Saturno1 canarias.png", "sol2", "Moon").
const BODY_NAMES: Array<[RegExp, string]> = [
  [/^(sol|sun|solar)$/, 'Sun'], [/^(luna|moon|lunar)$/, 'Moon'], [/^(mercurio|mercury)$/, 'Mercury'],
  [/^venus$/, 'Venus'], [/^(marte|mars)$/, 'Mars'], [/^(j[uú]piter)$/, 'Jupiter'], [/^(saturno|saturn)$/, 'Saturn'],
  [/^(urano|uranus)$/, 'Uranus'], [/^(neptuno|neptune)$/, 'Neptune'], [/^(plut[oó]n?|pluto)$/, 'Pluto'],
];

/** The Sun, Moon or planet a title or file name names, if any. */
export function solarSystemBodyIn(text: string | null | undefined): string | null {
  for (const word of (text ?? '').toLowerCase().split(/[^a-záéíóúñü]+/)) {
    const match = BODY_NAMES.find(([pattern]) => pattern.test(word));
    if (match) return match[1];
  }
  return null;
}

/**
 * Tags for a newly added image: "Deep Sky" (so it can be plate-solved), or the named planet/Sun/
 * Moon instead when the title or file name says so.
 */
export function defaultImageTags(...names: Array<string | null | undefined>): string[] {
  for (const name of names) {
    const body = solarSystemBodyIn(name);
    if (body) return [body];
  }
  return ['Deep Sky'];
}

/** Tags after an edit: a newly added planet/Sun/Moon tag removes "Deep Sky" (comets/asteroids keep it). */
export function withoutDeepSkyForPlanets(tags: string[], previousTags: string[] | null | undefined): string[] {
  if (!isSolarSystemTagged(tags) || isSolarSystemTagged(previousTags)) return tags;
  return tags.filter(tag => tag.trim().toLowerCase() !== 'deep sky');
}
