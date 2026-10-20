import { Hono } from 'hono';
import { ZodError } from 'zod';
import {
  checkKnownSpectroscopy, deleteSpectroscopyRun, getKnownSpectroscopy, getSpectroscopyRun, knownRequestSchema,
  listSpectroscopyRuns, spectroscopyFile, spectroscopyRequestSchema, startSpectroscopy,
} from '../services/spectroscopy';

const app = new Hono();

function imageId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function failure(c: any, error: unknown) {
  if (error instanceof ZodError) return c.json({ message: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, 400);
  if (error instanceof Error && /already running|cannot be deleted/.test(error.message)) return c.json({ message: error.message }, 409);
  if (error instanceof Error && /ENOENT/.test(error.message)) return c.json({ message: 'Spectroscopy run or file not found' }, 404);
  console.error('Spectroscopy:', error);
  return c.json({ message: error instanceof Error ? error.message : 'Spectroscopic analysis failed' }, 400);
}

app.get('/:imageId/spectroscopy', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await listSpectroscopyRuns(id)); } catch (error) { return failure(c, error); }
});

app.post('/:imageId/spectroscopy', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    const request = spectroscopyRequestSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await startSpectroscopy(id, request), 202);
  } catch (error) { return failure(c, error); }
});

app.get('/:imageId/spectroscopy/known', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await getKnownSpectroscopy(id)); } catch (error) { return failure(c, error); }
});

app.post('/:imageId/spectroscopy/known', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    const request = knownRequestSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await checkKnownSpectroscopy(id, request));
  } catch (error) { return failure(c, error); }
});

app.get('/:imageId/spectroscopy/:runId', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    c.header('cache-control', 'private, no-store');
    return c.json(await getSpectroscopyRun(id, c.req.param('runId')));
  } catch (error) { return failure(c, error); }
});

app.delete('/:imageId/spectroscopy/:runId', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    await deleteSpectroscopyRun(id, c.req.param('runId'));
    return c.body(null, 204);
  } catch (error) { return failure(c, error); }
});

app.get('/:imageId/spectroscopy/:runId/files/:filename', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    const filename = c.req.param('filename');
    const file = await spectroscopyFile(id, c.req.param('runId'), filename);
    const inline = c.req.query('download') !== '1' && /\.(pdf|json)$/.test(filename);
    return new Response(new Uint8Array(file.body), { headers: {
      'content-type': file.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    } });
  } catch (error) { return failure(c, error); }
});

export default app;
