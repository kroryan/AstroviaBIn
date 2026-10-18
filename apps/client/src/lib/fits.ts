const FITS_PATH_PREFIXES = ['fits://', 'fits-derived://', 'fits-upload://'];

export function isFitsOriginalPath(originalPath: string | null | undefined): boolean {
  return Boolean(originalPath && FITS_PATH_PREFIXES.some(prefix => originalPath.startsWith(prefix)));
}

/**
 * Fallback URL for viewers without a tile source: FITS gets its native-resolution render,
 * Sidereal-library images get the real original instead of the downscaled gallery preview.
 * Falls back to `fullUrl` for anything without a higher-resolution source available.
 */
export function resolveZoomUrl(image: { id: number; originalPath?: string | null; libraryAssetId?: number | null }): string {
  if (isFitsOriginalPath(image.originalPath)) return `/api/fits/${image.id}/preview?stretch=asinh&preview=full`;
  if (image.libraryAssetId) return `/api/images/${image.id}/full`;
  return '';
}

export type CaptureTimeStatus = 'verified' | 'unverified' | 'edited';

export interface CaptureMoment {
  text: string;
  /**
   * 'verified': the time comes from a real exposure timestamp (FITS DATE-OBS, or EXIF
   * DateTimeOriginal). 'unverified': falls back to file/sync metadata, which can disagree with
   * when the shot was actually taken. 'edited': a person corrected it by hand.
   */
  status: CaptureTimeStatus;
}

/**
 * Formats a capture date+time for display, and classifies how trustworthy the time component is.
 */
export function formatCaptureMoment(
  captureDate: string | Date | null | undefined,
  originalPath: string | null | undefined,
  captureDateSource?: string | null,
): CaptureMoment {
  if (!captureDate) return { text: 'Unknown date', status: 'unverified' };
  const date = new Date(captureDate);
  const text = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const status: CaptureTimeStatus = captureDateSource === 'manual'
    ? 'edited'
    : isFitsOriginalPath(originalPath) || captureDateSource === 'exif'
      ? 'verified'
      : 'unverified';
  return { text, status };
}
