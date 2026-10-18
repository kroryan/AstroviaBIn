import { Hono } from 'hono';
import { readFile } from 'fs/promises';
import { storage } from '../services/storage';
import { xmpSidecarService } from '../services/xmp-sidecar';
import { configService } from '../services/config';
import { handleRouteError } from './route-utils';
import { SOLAR_SYSTEM_TAGS } from '../services/solar-system';

const app = new Hono();
const SOLAR_SYSTEM_TAG_SET = new Set(SOLAR_SYSTEM_TAGS.map(tag => tag.toLocaleLowerCase()));

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

// Helper to update Immich asset metadata
async function updateImmichAssetMetadata(immichId: string, metadata: { latitude?: number; longitude?: number }) {
  try {
    const config = await configService.getImmichConfig();
    if (!config.host || !config.apiKey) {
      console.warn('Immich config missing, skipping metadata sync');
      return;
    }

    await fetch(`${config.host}/api/assets`, {
      method: 'PUT',
      headers: { 'X-API-Key': config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [immichId],
        latitude: metadata.latitude,
        longitude: metadata.longitude,
      }),
    });
    console.log(`Synced metadata to Immich for asset ${immichId}`);
  } catch (error: unknown) {
    const err = error as Error;
    console.error(`Failed to sync metadata to Immich for asset ${immichId}:`, err.message);
  }
}

// Get all astrophotography images with optional filters
app.get('/', async (c) => {
  try {
    const objectType = c.req.query('objectType');
    const tags = c.req.queries('tags');
    const plateSolved = c.req.query('plateSolved');
    const constellation = c.req.query('constellation');
    const equipmentId = c.req.query('equipmentId');
    const filters: { objectType?: string; tags?: string[]; plateSolved?: boolean; constellation?: string; equipmentId?: number } = {};

    if (objectType) filters.objectType = objectType;
    if (tags && tags.length > 0) filters.tags = tags;
    if (plateSolved !== undefined) filters.plateSolved = plateSolved === 'true';
    if (constellation) filters.constellation = constellation;
    if (equipmentId) filters.equipmentId = parseInt(equipmentId);

    const images = await storage.getAstroImages(filters);
    return c.json(images);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch images');
  }
});

// Download the original FITS or Immich asset rather than a preview.
app.get('/:id/download', async (c) => {
  try {
    const image = await storage.getAstroImage(parseInt(c.req.param('id')));
    if (!image) return c.json({ message: 'Image not found' }, 404);
    if (image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://')) {
      return c.redirect(`/api/fits/${image.id}/download`, 302);
    }
    if (!image.immichId) return c.json({ message: 'No downloadable original is available for this image' }, 404);
    const config = await configService.getImmichConfig();
    if (!config.host || !config.apiKey) return c.json({ message: 'Immich configuration missing' }, 503);
    const response = await fetch(`${config.host.replace(/\/+$/, '')}/api/assets/${encodeURIComponent(image.immichId)}/original`, {
      headers: { 'X-API-Key': config.apiKey },
    });
    if (!response.ok || !response.body) return c.json({ message: `Immich returned ${response.status}` }, response.status as 400);
    const name = (image.filename || `${image.id}.image`).replace(/[\r\n"]/g, '_');
    return new Response(response.body, {
      headers: {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to download original image');
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

    // Sync to Immich if coordinates were updated
    if (updatedImage.immichId && (updates.latitude !== undefined || updates.longitude !== undefined)) {
      await updateImmichAssetMetadata(updatedImage.immichId, {
        latitude: updatedImage.latitude || undefined,
        longitude: updatedImage.longitude || undefined,
      });
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

    // Find the successful plate solving job for this image directly
    const job = await storage.getLatestPlateSolvingJob(imageId, 'success');

    if (!image.plateSolved || !job) {
      return c.json({ message: 'Image has not been successfully plate solved' }, 400);
    }

    return c.json({
      jobId: job.id,
      submissionId: job.astrometrySubmissionId,
      astrometryJobId: job.astrometryJobId,
      status: job.status,
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch plate solving job data');
  }
});

// Get image annotations from stored plate solving data
app.get('/:id/annotations', async (c) => {
  try {
    const imageId = parseInt(c.req.param('id'));
    const image = await storage.getAstroImage(imageId);

    if (!image) {
      return c.json({ message: 'Image not found' }, 404);
    }

    // Find the successful plate solving job for this image directly
    const job = await storage.getLatestPlateSolvingJob(imageId, 'success');

    if (!image.plateSolved || !job) {
      return c.json({ message: 'Image has not been plate solved' }, 400);
    }

    if (!job.result) {
      return c.json({ message: 'No successful plate solving data found' }, 400);
    }

    const result = job.result as Record<string, unknown>;
    const annotations = (result.annotations as unknown[]) || [];
    const calibration = {
      ra: result.ra,
      dec: result.dec,
      pixscale: result.pixscale,
      radius: result.radius,
      orientation: result.orientation,
    };

    return c.json({
      annotations: annotations,
      calibration: calibration,
      imageDimensions: {
        width: result.width || null,
        height: result.height || null,
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to fetch image annotations');
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
