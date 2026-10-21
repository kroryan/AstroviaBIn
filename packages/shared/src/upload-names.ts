/**
 * Name key used to recognise a file that was already uploaded: case, spaces and punctuation are ignored
 * ("M42 final.FITS" ≈ "m42_final.fits"), and the "-<timestamp>" AstroviaBin adds to stored FITS uploads
 * is removed. Used together with the byte size, never alone.
 */
export function uploadNameKey(name: string): string {
  const base = name.normalize('NFC').replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot).toLowerCase() : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/-\d{12,14}$/, '');
  return `${stem.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}${extension}`;
}
