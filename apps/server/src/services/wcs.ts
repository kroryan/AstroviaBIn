/**
 * FITS WCS (TAN gnomonic projection with optional SIP distortion), as written by
 * Astrometry.net's solve-field. Pixel coordinates follow the FITS convention:
 * the centre of the first pixel is (1, 1), x runs along image columns and y along
 * stored rows (row 1 is the first row Sidereal renders at the top of the viewer).
 */

export interface SipPolynomial {
  order: number;
  /** Coefficients keyed by `${p}_${q}` for the u^p v^q term. */
  terms: Record<string, number>;
}

export interface WcsSolution {
  crval1: number;
  crval2: number;
  crpix1: number;
  crpix2: number;
  cd11: number;
  cd12: number;
  cd21: number;
  cd22: number;
  /** Image size the solution describes, in pixels. */
  imageWidth: number;
  imageHeight: number;
  sip?: { a: SipPolynomial; b: SipPolynomial; ap?: SipPolynomial; bp?: SipPolynomial };
}

type Headers = Record<string, string | number | boolean>;

function numberHeader(headers: Headers, key: string): number | undefined {
  const value = headers[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (radiansValue: number) => radiansValue * 180 / Math.PI;

function readSip(headers: Headers, prefix: 'A' | 'B' | 'AP' | 'BP'): SipPolynomial | undefined {
  const order = numberHeader(headers, `${prefix}_ORDER`);
  if (order === undefined || order < 1) return undefined;
  const terms: Record<string, number> = {};
  for (let p = 0; p <= order; p++) {
    for (let q = 0; q <= order - p; q++) {
      const value = numberHeader(headers, `${prefix}_${p}_${q}`);
      if (value !== undefined && value !== 0) terms[`${p}_${q}`] = value;
    }
  }
  return { order, terms };
}

export function parseWcsHeaders(headers: Headers, imageWidth: number, imageHeight: number): WcsSolution {
  const crval1 = numberHeader(headers, 'CRVAL1');
  const crval2 = numberHeader(headers, 'CRVAL2');
  const crpix1 = numberHeader(headers, 'CRPIX1');
  const crpix2 = numberHeader(headers, 'CRPIX2');
  const cdelt1 = numberHeader(headers, 'CDELT1');
  const cdelt2 = numberHeader(headers, 'CDELT2');
  const cd11 = numberHeader(headers, 'CD1_1') ?? (cdelt1 === undefined ? undefined : cdelt1 * (numberHeader(headers, 'PC1_1') ?? 1));
  const cd12 = numberHeader(headers, 'CD1_2') ?? (cdelt1 === undefined ? undefined : cdelt1 * (numberHeader(headers, 'PC1_2') ?? 0));
  const cd21 = numberHeader(headers, 'CD2_1') ?? (cdelt2 === undefined ? undefined : cdelt2 * (numberHeader(headers, 'PC2_1') ?? 0));
  const cd22 = numberHeader(headers, 'CD2_2') ?? (cdelt2 === undefined ? undefined : cdelt2 * (numberHeader(headers, 'PC2_2') ?? 1));
  if ([crval1, crval2, crpix1, crpix2, cd11, cd12, cd21, cd22].some(value => value === undefined)) {
    throw new Error('Local solver returned an incomplete WCS calibration');
  }
  if (Math.abs((cd11! * cd22!) - (cd12! * cd21!)) < Number.EPSILON) {
    throw new Error('Local solver returned a singular WCS calibration');
  }
  const ctype1 = String(headers.CTYPE1 || 'RA---TAN');
  if (!/TAN/.test(ctype1)) throw new Error(`Unsupported WCS projection ${ctype1}`);
  const a = readSip(headers, 'A');
  const b = readSip(headers, 'B');
  return {
    crval1: crval1!, crval2: crval2!, crpix1: crpix1!, crpix2: crpix2!,
    cd11: cd11!, cd12: cd12!, cd21: cd21!, cd22: cd22!,
    imageWidth, imageHeight,
    ...(a && b && /SIP/.test(ctype1) ? { sip: { a, b, ap: readSip(headers, 'AP'), bp: readSip(headers, 'BP') } } : {}),
  };
}

/** Accepts a WCS persisted in a plate-solving result; returns undefined for anything malformed. */
export function wcsFromStored(value: unknown): WcsSolution | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const wcs = value as WcsSolution;
  const required = [wcs.crval1, wcs.crval2, wcs.crpix1, wcs.crpix2, wcs.cd11, wcs.cd12, wcs.cd21, wcs.cd22, wcs.imageWidth, wcs.imageHeight];
  if (!required.every(item => typeof item === 'number' && Number.isFinite(item))) return undefined;
  return wcs;
}

function evaluate(poly: SipPolynomial | undefined, u: number, v: number): number {
  if (!poly) return 0;
  let sum = 0;
  for (const [key, coefficient] of Object.entries(poly.terms)) {
    const [p, q] = key.split('_').map(Number);
    sum += coefficient * u ** p * v ** q;
  }
  return sum;
}

/** FITS pixel (1-based) → sky (degrees). */
export function pixelToSky(wcs: WcsSolution, x: number, y: number): { ra: number; dec: number } {
  const u = x - wcs.crpix1;
  const v = y - wcs.crpix2;
  const U = u + evaluate(wcs.sip?.a, u, v);
  const V = v + evaluate(wcs.sip?.b, u, v);
  const xi = radians(wcs.cd11 * U + wcs.cd12 * V);
  const eta = radians(wcs.cd21 * U + wcs.cd22 * V);
  const ra0 = radians(wcs.crval1);
  const dec0 = radians(wcs.crval2);
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  const ra = (degrees(ra0 + Math.atan2(xi, denominator)) + 360) % 360;
  const dec = degrees(Math.atan2(Math.sin(dec0) + eta * Math.cos(dec0), Math.hypot(denominator, xi)));
  return { ra, dec };
}

/** Sky (degrees) → FITS pixel (1-based), or null for points on the far hemisphere. */
export function skyToPixel(wcs: WcsSolution, ra: number, dec: number): { x: number; y: number } | null {
  const ra0 = radians(wcs.crval1);
  const dec0 = radians(wcs.crval2);
  const targetRa = radians(ra);
  const targetDec = radians(dec);
  const deltaRa = targetRa - ra0;
  const cosineDistance = Math.sin(dec0) * Math.sin(targetDec) + Math.cos(dec0) * Math.cos(targetDec) * Math.cos(deltaRa);
  if (cosineDistance <= 1e-6) return null;
  const xi = degrees(Math.cos(targetDec) * Math.sin(deltaRa) / cosineDistance);
  const eta = degrees((Math.cos(dec0) * Math.sin(targetDec) - Math.sin(dec0) * Math.cos(targetDec) * Math.cos(deltaRa)) / cosineDistance);
  const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  const U = (wcs.cd22 * xi - wcs.cd12 * eta) / det;
  const V = (-wcs.cd21 * xi + wcs.cd11 * eta) / det;
  if (!wcs.sip) return { x: U + wcs.crpix1, y: V + wcs.crpix2 };

  // Start from the inverse polynomial when present, then iterate the forward SIP model so the
  // result round-trips exactly through pixelToSky (to well below a thousandth of a pixel).
  let u = U + evaluate(wcs.sip.ap, U, V);
  let v = V + evaluate(wcs.sip.bp, U, V);
  for (let iteration = 0; iteration < 50; iteration++) {
    const nextU = U - evaluate(wcs.sip.a, u, v);
    const nextV = V - evaluate(wcs.sip.b, u, v);
    const change = Math.abs(nextU - u) + Math.abs(nextV - v);
    u = nextU;
    v = nextV;
    if (change < 1e-9) break;
  }
  return { x: u + wcs.crpix1, y: v + wcs.crpix2 };
}

/** Local pixel scale in arcsec/pixel from the linear CD matrix. */
export function pixelScaleArcsec(wcs: WcsSolution): number {
  return Math.sqrt(Math.abs(wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21)) * 3600;
}

export function angularDistanceDegrees(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = radians(dec1);
  const b = radians(dec2);
  const deltaRa = radians(ra2 - ra1);
  const value = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(deltaRa);
  return degrees(Math.acos(Math.min(1, Math.max(-1, value))));
}
