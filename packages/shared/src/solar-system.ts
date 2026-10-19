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
