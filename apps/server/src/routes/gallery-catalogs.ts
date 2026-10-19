import { Hono } from 'hono';
import { z, ZodError } from 'zod';
import { storage } from '../services/storage';
import { classifyGallery } from '../services/gallery-auto-classify';
import { handleRouteError } from './route-utils';

const app = new Hono();

const catalogSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name must be 80 characters or fewer'),
  description: z.string().trim().max(1000).nullable().optional(),
});
const imageIdsSchema = z.object({ imageIds: z.array(z.number().int().positive()).min(1).max(1000) });

function id(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function validationError(c: any, error: unknown) {
  if (error instanceof ZodError) return c.json({ message: error.issues.map(issue => issue.message).join('; ') }, 400);
  return null;
}

app.get('/', async (c) => {
  try {
    return c.json(await storage.getGalleryCatalogs());
  } catch (error) {
    return handleRouteError(c, error, 'Failed to list gallery catalogs');
  }
});

app.post('/', async (c) => {
  try {
    const data = catalogSchema.parse(await c.req.json());
    if (await storage.getGalleryCatalogByName(data.name)) return c.json({ message: 'A catalog with that name already exists' }, 409);
    return c.json(await storage.createGalleryCatalog(data), 201);
  } catch (error) {
    return validationError(c, error) ?? handleRouteError(c, error, 'Failed to create gallery catalog');
  }
});

// Files every unclassified image: Solar System frames together, plate-solved images by field.
app.post('/auto-classify', async (c) => {
  try {
    return c.json(await classifyGallery());
  } catch (error) {
    return handleRouteError(c, error, 'Failed to auto-classify the gallery');
  }
});

app.patch('/:id', async (c) => {
  try {
    const catalogId = id(c.req.param('id'));
    if (!catalogId || !await storage.getGalleryCatalog(catalogId)) return c.json({ message: 'Catalog not found' }, 404);
    const data = catalogSchema.partial().parse(await c.req.json());
    if (data.name) {
      const clash = await storage.getGalleryCatalogByName(data.name);
      if (clash && clash.id !== catalogId) return c.json({ message: 'A catalog with that name already exists' }, 409);
    }
    return c.json(await storage.updateGalleryCatalog(catalogId, data));
  } catch (error) {
    return validationError(c, error) ?? handleRouteError(c, error, 'Failed to update gallery catalog');
  }
});

app.delete('/:id', async (c) => {
  try {
    const catalogId = id(c.req.param('id'));
    if (!catalogId || !await storage.getGalleryCatalog(catalogId)) return c.json({ message: 'Catalog not found' }, 404);
    await storage.deleteGalleryCatalog(catalogId);
    return c.body(null, 204);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to delete gallery catalog');
  }
});

app.post('/:id/images', async (c) => {
  try {
    const catalogId = id(c.req.param('id'));
    if (!catalogId || !await storage.getGalleryCatalog(catalogId)) return c.json({ message: 'Catalog not found' }, 404);
    const { imageIds } = imageIdsSchema.parse(await c.req.json());
    return c.json({ added: await storage.addImagesToGalleryCatalog(catalogId, imageIds) });
  } catch (error) {
    return validationError(c, error) ?? handleRouteError(c, error, 'Failed to add images to the catalog');
  }
});

app.delete('/:id/images/:imageId', async (c) => {
  try {
    const catalogId = id(c.req.param('id'));
    const imageId = id(c.req.param('imageId'));
    if (!catalogId || !imageId) return c.json({ message: 'Invalid catalog or image' }, 400);
    await storage.removeImageFromGalleryCatalog(catalogId, imageId);
    return c.body(null, 204);
  } catch (error) {
    return handleRouteError(c, error, 'Failed to remove the image from the catalog');
  }
});

export default app;
