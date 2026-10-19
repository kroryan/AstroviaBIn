import { constellationName } from './iau-constellations';

/**
 * Determine the IAU constellation containing a J2000 position, using the official boundaries
 * (Roman 1987 table; see iau-constellations.ts).
 * @param ra Right Ascension in degrees
 * @param dec Declination in degrees
 * @returns Constellation name
 */
export function getConstellationFromCoordinates(ra: number, dec: number): string | null {
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  return constellationName(ra, dec);
}

/**
 * Get constellation abbreviation from full name
 * @param constellationName Full constellation name
 * @returns 3-letter abbreviation
 */
export function getConstellationAbbreviation(constellationName: string): string {
  const abbreviations: Record<string, string> = {
    "Andromeda": "And",
    "Antlia": "Ant",
    "Apus": "Aps",
    "Aquarius": "Aqr",
    "Aquila": "Aql",
    "Ara": "Ara",
    "Aries": "Ari",
    "Auriga": "Aur",
    "Bootes": "Boo",
    "Caelum": "Cae",
    "Camelopardalis": "Cam",
    "Cancer": "Cnc",
    "Canes Venatici": "CVn",
    "Canis Major": "CMa",
    "Canis Minor": "CMi",
    "Capricornus": "Cap",
    "Carina": "Car",
    "Cassiopeia": "Cas",
    "Centaurus": "Cen",
    "Cepheus": "Cep",
    "Cetus": "Cet",
    "Chamaeleon": "Cha",
    "Circinus": "Cir",
    "Columba": "Col",
    "Coma Berenices": "Com",
    "Corona Australis": "CrA",
    "Corona Borealis": "CrB",
    "Corvus": "Crv",
    "Crater": "Crt",
    "Crux": "Cru",
    "Cygnus": "Cyg",
    "Delphinus": "Del",
    "Dorado": "Dor",
    "Draco": "Dra",
    "Equuleus": "Equ",
    "Eridanus": "Eri",
    "Fornax": "For",
    "Gemini": "Gem",
    "Grus": "Gru",
    "Hercules": "Her",
    "Horologium": "Hor",
    "Hydra": "Hya",
    "Hydrus": "Hyi",
    "Indus": "Ind",
    "Lacerta": "Lac",
    "Leo": "Leo",
    "Leo Minor": "LMi",
    "Lepus": "Lep",
    "Libra": "Lib",
    "Lupus": "Lup",
    "Lynx": "Lyn",
    "Lyra": "Lyr",
    "Mensa": "Men",
    "Microscopium": "Mic",
    "Monoceros": "Mon",
    "Musca": "Mus",
    "Norma": "Nor",
    "Octans": "Oct",
    "Ophiuchus": "Oph",
    "Orion": "Ori",
    "Pavo": "Pav",
    "Pegasus": "Peg",
    "Perseus": "Per",
    "Phoenix": "Phe",
    "Pictor": "Pic",
    "Pisces": "Psc",
    "Piscis Austrinus": "PsA",
    "Puppis": "Pup",
    "Pyxis": "Pyx",
    "Reticulum": "Ret",
    "Sagitta": "Sge",
    "Sagittarius": "Sgr",
    "Scorpius": "Sco",
    "Sculptor": "Scl",
    "Scutum": "Sct",
    "Serpens": "Ser",
    "Sextans": "Sex",
    "Taurus": "Tau",
    "Telescopium": "Tel",
    "Triangulum": "Tri",
    "Triangulum Australe": "TrA",
    "Tucana": "Tuc",
    "Ursa Major": "UMa",
    "Ursa Minor": "UMi",
    "Vela": "Vel",
    "Virgo": "Vir",
    "Volans": "Vol",
    "Vulpecula": "Vul",
  };

  return abbreviations[constellationName] || constellationName.substring(0, 3).toUpperCase();
}

/**
 * Get constellation information including name, abbreviation, and coordinates
 * @param ra Right Ascension in degrees
 * @param dec Declination in degrees
 * @returns Constellation info object
 */
export function getConstellationInfo(ra: number, dec: number) {
  const constellationName = getConstellationFromCoordinates(ra, dec);
  if (!constellationName) {
    return null;
  }

  return {
    name: constellationName,
    abbreviation: getConstellationAbbreviation(constellationName),
    ra,
    dec,
  };
} 