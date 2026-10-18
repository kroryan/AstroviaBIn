export const SOLAR_SYSTEM_TAGS = [
  'Solar System', 'Sun', 'Moon', 'Mercury', 'Venus', 'Earth', 'Mars',
  'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
] as const;

const SOLAR_SYSTEM_TAG_SET = new Set(SOLAR_SYSTEM_TAGS.map(tag => tag.toLowerCase()));
const DEEP_SKY_TAG = 'deep sky';

/** Solar-system frames cannot be solved by Astrometry.net's stellar-field solver. */
export function isSolarSystemTagged(tags: string[] | null | undefined): boolean {
  return Boolean(tags?.some(tag => SOLAR_SYSTEM_TAG_SET.has(tag.trim().toLowerCase())));
}

export function isDeepSkyTagged(tags: string[] | null | undefined): boolean {
  return Boolean(tags?.some(tag => tag.trim().toLowerCase() === DEEP_SKY_TAG));
}

/**
 * Deep Sky frames are eligible for Astrometry.net, and so is any frame that already has a stellar
 * plate solution (e.g. imported before tagging existed) so it can be re-solved for a full WCS.
 * Solar System frames never are.
 */
export function isPlateSolvingEligible(tags: string[] | null | undefined, alreadySolved = false): boolean {
  return (isDeepSkyTagged(tags) || alreadySolved) && !isSolarSystemTagged(tags);
}
