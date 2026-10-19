import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { storage } from '../services/storage';
import { libraryStorageDirectory, resolveLibraryAssetPath } from '../services/library';
import { rejectDeclaredOversize, sanitizedUploadFilename, UploadRequestError, writeUploadBody } from '../services/upload-stream';
import { handleRouteError } from './route-utils';

const app = new Hono();
const UPLOADABLE_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.bmp', '.avif', '.heic', '.heif']);
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff',
  '.tiff': 'image/tiff', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif',
};

app.post('/upload', async (c) => {
  let outputPath: string | undefined;
  try {
    rejectDeclaredOversize(c.req.header('content-length'));
    const filename = sanitizedUploadFilename(c.req.query('filename') || c.req.header('x-file-name'));
    const extension = path.extname(filename).toLowerCase();
    if (!UPLOADABLE_IMAGE_EXTENSIONS.has(extension)) {
      return c.json({ message: 'Upload a JPEG, PNG, TIFF, WebP, GIF, BMP, AVIF, or HEIC image' }, 415);
    }

    const id = randomUUID();
    const relativePath = `originals/${id}${extension}`;
    outputPath = path.join(libraryStorageDirectory(), relativePath);
    const { byteSize, sha256 } = await writeUploadBody(c.req.raw.body, outputPath);
    const imageMetadata = await sharp(outputPath, { limitInputPixels: false }).metadata();
    if (!imageMetadata.width || !imageMetadata.height || !imageMetadata.format) {
      throw new UploadRequestError('The uploaded file is not a supported image');
    }

    const asset = await storage.createLibraryAsset({
      legacyAssetId: null,
      // Stored identifier from before the AstroviaBin rename; kept so existing records stay valid.
      legacyRelativePath: `sidereal-upload/${id}`,
      relativePath,
      filename,
      mimeType: IMAGE_MIME_TYPES[extension] || `image/${imageMetadata.format}`,
      byteSize,
      sha256,
      metadata: { source: 'AstroviaBin upload', width: imageMetadata.width, height: imageMetadata.height, format: imageMetadata.format },
    });

    let imageId: number | undefined;
    try {
      const image = await storage.createAstroImage({
        immichId: null,
        libraryAssetId: asset.id,
        title: path.basename(filename, extension),
        filename,
        originalPath: `sidereal-library://${asset.id}`,
        thumbnailUrl: null,
        fullUrl: null,
        plateSolved: false,
        tags: [],
      });
      imageId = image.id;
      await storage.updateAstroImage(image.id, {
        thumbnailUrl: `/api/images/${image.id}/thumbnail`,
        fullUrl: `/api/images/${image.id}/full`,
      });
      return c.json({ asset, image: await storage.getAstroImage(image.id) }, 201);
    } catch (error) {
      if (imageId !== undefined) await storage.deleteAstroImage(imageId).catch(() => {});
      await storage.deleteLibraryAsset(asset.id).catch(() => {});
      throw error;
    }
  } catch (error) {
    if (outputPath) await rm(outputPath, { force: true }).catch(() => {});
    if (error instanceof UploadRequestError) return c.json({ message: error.message }, error.status);
    return handleRouteError(c, error, 'Failed to upload image to the private AstroviaBin library');
  }
});

app.get('/migration-status', async (c) => {
  try {
    const [assets, images] = await Promise.all([storage.getLibraryAssets(), storage.getAstroImages()]);
    return c.json({
      localAssetCount: assets.length,
      localBytes: assets.reduce((sum, asset) => sum + asset.byteSize, 0),
      astroImagesWithLocalOriginal: images.filter(image => image.libraryAssetId != null).length,
      astroImagesWithoutLocalOriginal: images.filter(image => image.libraryAssetId == null && !image.originalPath?.startsWith('fits://') && !image.originalPath?.startsWith('fits-derived://') && !image.originalPath?.startsWith('fits-upload://')).length,
      fitsCount: images.filter(image => image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://')).length,
      storageDirectory: libraryStorageDirectory(),
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to read local library status');
  }
});

app.get('/assets', async (c) => {
  try {
    const page = Math.max(1, Number(c.req.query('page')) || 1);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
    const assets = await storage.getLibraryAssets();
    const start = (page - 1) * limit;
    return c.json({ total: assets.length, page, limit, items: assets.slice(start, start + limit) });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to list local library assets');
  }
});

app.get('/assets/:id/original', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ message: 'Invalid library asset ID' }, 400);
    const asset = await storage.getLibraryAsset(id);
    if (!asset) return c.json({ message: 'Library asset not found' }, 404);
    return new Response(Readable.toWeb(createReadStream(resolveLibraryAssetPath(asset))) as ReadableStream, {
      headers: {
        'content-type': asset.mimeType || 'application/octet-stream',
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to serve local library original');
  }
});

app.get('/assets/:id/thumbnail', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ message: 'Invalid library asset ID' }, 400);
    const asset = await storage.getLibraryAsset(id);
    if (!asset) return c.json({ message: 'Library asset not found' }, 404);
    const cacheRoot = path.join(libraryStorageDirectory(), 'thumbnails');
    const thumbnailPath = path.join(cacheRoot, `${asset.sha256}.jpg`);
    try {
      await stat(thumbnailPath);
    } catch {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const temporaryPath = `${thumbnailPath}.tmp`;
      await sharp(resolveLibraryAssetPath(asset), { limitInputPixels: false })
        .rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 }).toFile(temporaryPath);
      await rename(temporaryPath, thumbnailPath);
    }
    return new Response(Readable.toWeb(createReadStream(thumbnailPath)) as ReadableStream, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to render local library thumbnail');
  }
});

export default app;
