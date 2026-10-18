import { Hono } from 'hono';
import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import sharp from 'sharp';
import { storage } from '../services/storage';
import { xmpSidecarService } from '../services/xmp-sidecar';
import { configService } from '../services/config';
import { handleRouteError } from './route-utils';
import { SOLAR_SYSTEM_TAGS } from '../services/solar-system';
import { renderTile, tileCacheDirectory, tileInfo } from '../services/tiles';
import { resolveLibraryAssetPath } from '../services/library';
import { readFitsMetadata, resolveFitsFile } from '../services/fits';
import { computeSkyAnnotations } from '../services/sky-annotations';
import { wcsFromStored } from '../services/wcs';

const app = new Hono();
const SOLAR_SYSTEM_TAG_SET = new Set(SOLAR_SYSTEM_TAGS.map(tag => tag.toLocaleLowerCase()));
const FITS_PATH_PREFIXES = ['fits://', 'fits-derived://', 'fits-upload://'];
const isFitsPath = (originalPath: string | null | undefined) => Boolean(originalPath && FITS_PATH_PREFIXES.some(prefix => originalPath.startsWith(prefix)));

async function imageTileSource(image: { id: number; libraryAssetId?: number | null; updatedAt?: Date | string | null }) {
  const asset = await storage.getLibraryAssetForAstroImage(image.id);
  if (!asset) throw new Error('This image has not been migrated to the private Sidereal library');
  const sourcePath = resolveLibraryAssetPath(asset);
  const sourceStat = await stat(sourcePath);
  const updatedAt = image.updatedAt instanceof Date ? image.updatedAt.getTime() : Date.parse(String(image.updatedAt || '')) || 0;
  const cacheKey = `image-${image.id}-${updatedAt}-${sourceStat.size}-${Math.trunc(sourceStat.mtimeMs)}`;
  const metadata = await sharp(sourcePath, { limitInputPixels: false }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read source image dimensions');
  return { sourcePath, cacheKey, width: metadata.width, height: metadata.height };
}

async function nativeImageDimensions(image: { id: number; originalPath?: string | null; libraryAssetId?: number | null; updatedAt?: Date | string | null }) {
  const fitsPath = resolveFitsFile(image.originalPath || null);
  if (fitsPath) {
    const metadata = await readFitsMetadata(fitsPath);
    return { width: metadata.width, height: metadata.height };
  }
  const source = await imageTileSource(image);
  return { width: source.width, height: source.height };
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(tag => typeof tag !== 'string')) throw new Error('tags must be an array of strings');
  const seen = new Set<string>();
  const tags = value.reduce<string[]>((tags, rawTag) => {
    const tag = rawTag.trim();
    const key = tag.toLocaleLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      tags.push(tag);
    }
    return tags;
  }, []);
  const hasSolarSystem = tags.some(tag => SOLAR_SYSTEM_TAG_SET.has(tag.toLocaleLowerCase()));
  const hasDeepSky = tags.some(tag => tag.toLocaleLowerCase() === 'deep sky');
  if (hasSolarSystem) return tags.filter(tag => tag.toLocaleLowerCase() !== 'deep sky');
  if (hasDeepSky) return tags.filter(tag => !SOLAR_SYSTEM_TAG_SET.has(tag.toLocaleLowerCase()));
  return tags;
}

// Get all astrophotography images with optional filters
app.get('/', async (c) => {
  try {
    const objectType = c.req.query('objectType');
    const tags = c.req.queries('tags');
    const plateSolved = c.req.query('plateSolved');
    const constellation = c.req.query('constellation');
    const equipmentId = c.req.query('equipmentId');
    const galleryCatalogId = c.req.query('galleryCatalogId');
    const filters: { objectType?: string; tags?: string[]; plateSolved?: boolean; constellation?: string; equipmentId?: number; galleryCatalogId?: number } = {};

    if (objectType) filters.objectType = objectType;
    if (tags && tags.length > 0) filters.tags = tags;
    if (plateSolved !== undefined) filters.plateSolved = plateSolved === 'true';
    if (constellation) filters.constellation = constellation;
    if (equipmentId) filters.equipmentId = parseInt(equipmentId);
    if (galleryCatalogId) filters.galleryCatalogId = parseInt(galleryCatalogId);

    const images = await storage.getAstroImages(filters);
    return c.json(images);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch images');
  }
});

// Download the original FITS or locally managed photo rather than a preview.
app.get('/:id/download', async (c) => {
  try {
    const image = await storage.getAstroImage(parseInt(c.req.param('id')));
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://')) {
      return c.redirect(`/api/fits/${image.id}/download`, 302);
    }
    const asset = await storage.getLibraryAssetForAstroImage(image.id);
    if (!asset) return c.json({ message: 'No local original is available for this image' }, 404);
    const name = (image.filename || `${image.id}.image`).replace(/[\r\n"]/g, '_');
    return new Response(Readable.toWeb(createReadStream(resolveLibraryAssetPath(asset))) as ReadableStream,
      {
      headers: {
        'content-type': asset.mimeType || 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to download original image');
  }
});

// Serve the full-resolution local original inline, for zooming without the pixelation a
// downscaled preview/thumbnail would show. FITS images have their own native-resolution route.
app.get('/:id/full', async (c) => {
  try {
    const image = await storage.getAstroImage(parseInt(c.req.param('id')));
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://')) {
      return c.redirect(`/api/fits/${image.id}/preview?preview=full`, 302);
    }
    const asset = await storage.getLibraryAssetForAstroImage(image.id);
    if (!asset) return c.json({ message: 'No private local original is available for this image' }, 404);
    return new Response(Readable.toWeb(createReadStream(resolveLibraryAssetPath(asset))) as ReadableStream, {
      headers: {
        'content-type': asset.mimeType || 'application/octet-stream',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch full-resolution image');
  }
});

// Generate and privately cache a compact gallery thumbnail from the local original.
app.get('/:id/thumbnail', async (c) => {
  try {
    const imageId = Number(c.req.param('id'));
    const image = await storage.getAstroImage(imageId);
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (isFitsPath(image.originalPath)) return c.redirect(`/api/fits/${image.id}/preview`, 302);
    const asset = await storage.getLibraryAssetForAstroImage(image.id);
    if (!asset) return c.json({ message: 'No private local original is available for this image' }, 404);
    const cacheRoot = path.resolve(process.env.THUMBNAIL_CACHE_DIR || (process.env.NODE_ENV === 'production' ? '/app/cache/thumbnails' : './data/thumbnails'));
    const thumbnailPath = path.join(cacheRoot, `image-${asset.sha256}.jpg`);
    try {
      await stat(thumbnailPath);
    } catch {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const tempPath = `${thumbnailPath}.tmp`;
      await sharp(resolveLibraryAssetPath(asset), { limitInputPixels: false })
        .rotate().resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86 }).toFile(tempPath);
      await rename(tempPath, thumbnailPath);
    }
    return new Response(Readable.toWeb(createReadStream(thumbnailPath)) as ReadableStream, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to generate local image thumbnail');
  }
});

// Tile metadata (native dimensions + pyramid depth) for the zoomable viewer.
app.get('/:id/tile-info', async (c) => {
  try {
    const image = await storage.getAstroImage(parseInt(c.req.param('id')));
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (isFitsPath(image.originalPath)) return c.redirect(`/api/fits/${image.id}/tile-info`, 302);
    if (!image.libraryAssetId) return c.json({ message: 'Image has not been migrated to the private Sidereal library' }, 404);
    const source = await imageTileSource(image);
    return c.json(tileInfo(source.width, source.height));
  } catch (error) {
    return handleRouteError(c, error, 'Failed to read tile info');
  }
});

// One 256x256 (edge tiles may be smaller) tile of the zoomable viewer's pyramid.
app.get('/:id/tile', async (c) => {
  try {
    const image = await storage.getAstroImage(parseInt(c.req.param('id')));
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (isFitsPath(image.originalPath)) {
      return c.redirect(`/api/fits/${image.id}/tile?${new URLSearchParams(c.req.query()).toString()}`, 302);
    }
    if (!image.libraryAssetId) return c.json({ message: 'Image has not been migrated to the private Sidereal library' }, 404);
    const level = Number(c.req.query('level'));
    const x = Number(c.req.query('x'));
    const y = Number(c.req.query('y'));
    const source = await imageTileSource(image);
    const tile = await renderTile(source.sourcePath, tileCacheDirectory(), source.cacheKey, source.width, source.height, level, x, y);
    return new Response(new Uint8Array(tile), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to render tile');
  }
});

// Get a specific image
app.get('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(id);
    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }
    return c.json(image);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch image');
  }
});

// Update a specific image
app.patch('/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const updates = await c.req.json();
    const existing = await storage.getAstroImage(id);
    if (!existing) return c.json({ message: 'Image not found' }, 404);
    if (updates.tags !== undefined) {
      updates.tags = normalizeTags(updates.tags);
      const hasSolarSystem = updates.tags.some((tag: string) => SOLAR_SYSTEM_TAG_SET.has(tag.toLocaleLowerCase()));
      const hasDeepSky = updates.tags.some((tag: string) => tag.toLocaleLowerCase() === 'deep sky');
      const currentType = existing.objectType?.toLocaleLowerCase();
      if ((hasSolarSystem && currentType === 'deep sky') || (hasDeepSky && currentType && SOLAR_SYSTEM_TAG_SET.has(currentType))) updates.objectType = null;
    }
    if (updates.captureDate !== undefined) {
      const parsed = updates.captureDate ? new Date(updates.captureDate) : null;
      if (updates.captureDate && Number.isNaN(parsed?.getTime())) return c.json({ message: 'Invalid captureDate' }, 400);
      updates.captureDate = parsed;
      // A manual edit always overrides whatever source the time previously came from.
      updates.captureDateSource = parsed ? 'manual' : null;
    }

    const updatedImage = await storage.updateAstroImage(id, updates);
    if (!updatedImage) {
      return c.json({ message: 'Image not found' }, 404);
    }

    return c.json(updatedImage);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to update image');
  }
});

// Get plate solving job data for an image
app.get('/:id/plate-solving-job', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(imageId);

    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    const job = await storage.getLatestPlateSolvingJob(imageId);
    if (!job) return c.json({ status: 'none' });

    return c.json({
      jobId: job.id,
      submissionId: job.astrometrySubmissionId,
      astrometryJobId: job.astrometryJobId,
      status: job.status,
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
      error: job.status === 'failed' && job.result && typeof job.result === 'object'
        ? (job.result as { error?: string }).error ?? null
        : null,
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch plate solving job data');
  }
});

// Annotations for the latest successful solve. Local solves store the full WCS (TAN + SIP), so the
// overlay is projected live from the OpenNGC catalogue in native image pixels. Older solves imported
// from nova.astrometry.net only kept pixel positions measured on a resized upload; those are scaled
// to native pixels and flagged as legacy until the image is solved again locally.
app.get('/:id/annotations', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(imageId);

    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    const job = await storage.getLatestPlateSolvingJob(imageId, 'success');

    if (!image.plateSolved || !job) {
      return c.json({ message: 'Image has not been plate solved' }, 400);
    }

    if (!job.result) {
      return c.json({ message: 'No successful plate solving data found' }, 400);
    }

    const result = job.result as Record<string, unknown>;
    const calibration = {
      ra: result.ra,
      dec: result.dec,
      pixscale: result.pixscale,
      radius: result.radius,
      orientation: result.orientation,
      parity: result.parity,
    };
    c.header('cache-control', 'private, no-store');

    const wcs = wcsFromStored(result.wcs);
    if (wcs) {
      return c.json({
        annotations: await computeSkyAnnotations(wcs),
        calibration,
        imageDimensions: { width: wcs.imageWidth, height: wcs.imageHeight },
        source: 'wcs',
      });
    }

    const native = await nativeImageDimensions(image).catch(() => null);
    const pixscale = Number(result.pixscale);
    const widthArcsec = Number(result.width_arcsec);
    const heightArcsec = Number(result.height_arcsec);
    const solvedWidth = pixscale > 0 && widthArcsec > 0 ? widthArcsec / pixscale : null;
    const solvedHeight = pixscale > 0 && heightArcsec > 0 ? heightArcsec / pixscale : null;
    const factor = native && solvedWidth ? native.width / solvedWidth : 1;
    const consistent = !native || !solvedWidth || !solvedHeight ||
      Math.abs(native.height / solvedHeight - factor) / factor < 0.02;
    const annotations = consistent
      ? ((result.annotations as Array<Record<string, unknown>>) || []).map(annotation => ({
        ...annotation,
        pixelx: Number(annotation.pixelx) * factor,
        pixely: Number(annotation.pixely) * factor,
        radius: typeof annotation.radius === 'number' ? annotation.radius * factor : annotation.radius,
      }))
      : [];

    return c.json({
      annotations,
      calibration,
      imageDimensions: native || { width: null, height: null },
      source: 'legacy',
      message: consistent
        ? 'Imported solution without a stored WCS; positions were scaled to native pixels. Solve again locally for exact catalogue annotations.'
        : 'Imported solution does not match this image; solve again locally to annotate it.',
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch image annotations');
  }
});

// Gallery catalogs this image belongs to
app.get('/:id/gallery-catalogs', async (c) => {
  try {
    return c.json(await storage.getGalleryCatalogIdsForImage(parseInt(c.req.param('id'))));
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch image catalogs');
  }
});

// Get equipment for a specific image
app.get('/:id/equipment', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(imageId);

    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    const equipment = await storage.getEquipmentForImage(imageId);
    const imageEquipment = await storage.getImageEquipment(imageId);

    // Combine equipment with their relationship data
    const equipmentWithDetails = equipment.map((eq) => {
      const relationship = imageEquipment.find((ie) => ie.equipmentId === eq.id);
      return {
        ...eq,
        settings: relationship?.settings || null,
        notes: relationship?.notes || null,
      };
    });

    return c.json(equipmentWithDetails);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch image equipment');
  }
});

// Add equipment to an image
app.post('/:id/equipment', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const { equipmentId, settings, notes } = await c.req.json();

    const image = await storage.getAstroImage(imageId);
    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    const equipment = await storage.getEquipment();
    const targetEquipment = equipment.find((eq) => eq.id === equipmentId);
    if (!targetEquipment) {
      return c.json({ message: 'Equipment not found' }, 404);
    }

    const imageEquipment = await storage.addEquipmentToImage(imageId, equipmentId, settings, notes);
    return c.json(imageEquipment);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to add equipment to image');
  }
});

// Remove equipment from an image
app.delete('/:imageId/equipment/:equipmentId', async (c) => {
  try {
    const imageId = parseInt(c.req.param('imageId'));
    const equipmentId = parseInt(c.req.param('equipmentId'));

    const success = await storage.removeEquipmentFromImage(imageId, equipmentId);
    if (!success) {
      return c.json({ message: 'Equipment relationship not found' }, 404);
    }

    return c.json({ message: 'Equipment removed from image' });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to remove equipment from image');
  }
});

// Update equipment settings for an image
app.put('/:imageId/equipment/:equipmentId', async (c) => {
  try {
    const imageId = parseInt(c.req.param('imageId'));
    const equipmentId = parseInt(c.req.param('equipmentId'));
    const { settings, notes } = await c.req.json();

    const imageEquipment = await storage.updateImageEquipment(imageId, equipmentId, { settings, notes });
    if (!imageEquipment) {
      return c.json({ message: 'Equipment relationship not found' }, 404);
    }

    return c.json(imageEquipment);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to update equipment settings');
  }
});

// --- Image Acquisition Routes ---

// Get acquisition entries for an image
app.get('/:id/acquisitions', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const acquisitions = await storage.getImageAcquisitions(imageId);
    return c.json(acquisitions);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch acquisition entries');
  }
});

// Add acquisition entry to an image
app.post('/:id/acquisitions', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const { filterId, filterName, frameCount, exposureTime, gain, offset, binning, sensorTemp, date, notes } = await c.req.json();

    if (!frameCount || !exposureTime) {
      return c.json({ message: 'frameCount and exposureTime are required' }, 400);
    }

    const acquisition = await storage.createImageAcquisition({
      imageId,
      filterId: filterId || null,
      filterName: filterName || null,
      frameCount,
      exposureTime,
      gain: gain ?? null,
      offset: offset ?? null,
      binning: binning || null,
      sensorTemp: sensorTemp ?? null,
      date: date ? new Date(date) : null,
      notes: notes || null,
    });
    return c.json(acquisition);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to create acquisition entry');
  }
});

// Update an acquisition entry
app.put('/:imageId/acquisitions/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const { filterId, filterName, frameCount, exposureTime, gain, offset, binning, sensorTemp, date, notes } = await c.req.json();

    const acquisition = await storage.updateImageAcquisition(id, {
      filterId, filterName, frameCount, exposureTime,
      gain, offset, binning, sensorTemp,
      date: date ? new Date(date) : null,
      notes,
    });

    if (!acquisition) {
      return c.json({ message: 'Acquisition entry not found' }, 404);
    }
    return c.json(acquisition);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to update acquisition entry');
  }
});

// Delete an acquisition entry
app.delete('/:imageId/acquisitions/:id', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const success = await storage.deleteImageAcquisition(id);
    if (!success) {
      return c.json({ message: 'Acquisition entry not found' }, 404);
    }
    return c.json({ message: 'Acquisition entry deleted' });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to delete acquisition entry');
  }
});

// Get XMP sidecar for an image
app.get('/:id/sidecar', async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(id);

    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    const sidecarConfig = await configService.getSidecarConfig();
    const sidecarPath = await xmpSidecarService.resolveSidecarPath(image, sidecarConfig);

    if (!sidecarPath) {
      return c.json({ message: 'No XMP sidecar found for this image' }, 404);
    }

    const content = await readFile(sidecarPath, 'utf8');
    const isDownload = c.req.query('download') === 'true';

    const headers: Record<string, string> = { 'Content-Type': 'application/xml' };
    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="${image.filename}.xmp"`;
    }

    return new Response(content, { headers });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch sidecar');
  }
});

export default app;
