import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

export class UploadRequestError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'UploadRequestError';
  }
}

export function maxUploadBytes(): number {
  const configured = Number(process.env.SIDEREAL_MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 20 * 1024 ** 3;
}

/** Persist one raw HTTP request body incrementally; never buffer a large photo/FITS in RAM. */
export async function writeUploadBody(
  body: ReadableStream<Uint8Array> | null,
  outputPath: string,
  limitBytes = maxUploadBytes(),
): Promise<{ byteSize: number; sha256: string }> {
  if (!body) throw new UploadRequestError('Upload body is empty');
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${randomUUID()}.uploading`;
  const hash = createHash('sha256');
  let byteSize = 0;
  try {
    await pipeline(
      Readable.fromWeb(body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(chunk: Buffer | Uint8Array, _encoding, callback) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (byteSize + bytes.byteLength > limitBytes) {
            callback(new UploadRequestError(`File exceeds the ${Math.ceil(limitBytes / 1024 ** 3)} GB upload limit`, 413));
            return;
          }
          byteSize += bytes.byteLength;
          hash.update(bytes);
          callback(null, bytes);
        },
      }),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
    if (byteSize === 0) throw new UploadRequestError('Upload body is empty');
    await rename(temporaryPath, outputPath);
    return { byteSize, sha256: hash.digest('hex') };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    await rm(outputPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function sanitizedUploadFilename(value: string | undefined): string {
  const filename = (value || '').normalize('NFC').replace(/\\/g, '/').split('/').pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() || '';
  if (!filename || filename === '.' || filename === '..') throw new UploadRequestError('Choose a valid filename');
  return filename;
}

export function rejectDeclaredOversize(contentLength: string | undefined, limit = maxUploadBytes()): void {
  if (!contentLength) return;
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > limit) {
    throw new UploadRequestError(`File exceeds the ${Math.ceil(limit / 1024 ** 3)} GB upload limit`, 413);
  }
}
