import { Hono } from 'hono';
import { ZodError } from 'zod';
import {
  analysisFile, analysisRequestSchema, getHotpantsReport, listAnalysisInputs,
  listHotpantsReports, saveAnalysisInput, startHotpantsAnalysis, helperRequestSchema, runAnalysisHelper,
  deleteHotpantsReport, candidateCheckSchema, checkHotpantsCandidate, startVerification,
} from '../services/hotpants';
import { rejectDeclaredOversize, UploadRequestError } from '../services/upload-stream';

const app = new Hono();

function imageId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function failure(c: any, error: unknown) {
  if (error instanceof ZodError) return c.json({ message: error.issues.map(issue => issue.message).join('; ') }, 400);
  if (error instanceof UploadRequestError) return c.json({ message: error.message }, error.status);
  if (error instanceof Error && error.message.startsWith('An analysis is already running')) return c.json({ message: error.message }, 409);
  if (error instanceof Error && error.message === 'A running analysis cannot be deleted') return c.json({ message: error.message }, 409);
  if (error instanceof Error && error.message === 'A candidate check is already running for this analysis') return c.json({ message: error.message }, 409);
  if (error instanceof Error && error.message === 'Verification is already being generated for this analysis') return c.json({ message: error.message }, 409);
  if (error instanceof Error && /ENOENT/.test(error.message)) return c.json({ message: 'Analysis file not found' }, 404);
  console.error('HOTPANTS analysis:', error);
  return c.json({ message: error instanceof Error ? error.message : 'HOTPANTS analysis failed' }, 400);
}

app.get('/:imageId/analyses', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await listHotpantsReports(id)); } catch (error) { return failure(c, error); }
});

app.post('/:imageId/analyses', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    const request = analysisRequestSchema.parse(await c.req.json());
    return c.json(await startHotpantsAnalysis(id, request), 202);
  } catch (error) { return failure(c, error); }
});

app.get('/:imageId/analyses/:runId', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await getHotpantsReport(id, c.req.param('runId'))); } catch (error) { return failure(c, error); }
});

app.delete('/:imageId/analyses/:runId', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    await deleteHotpantsReport(id, c.req.param('runId'));
    return c.body(null, 204);
  } catch (error) { return failure(c, error); }
});

app.post('/:imageId/analyses/:runId/candidates/:candidateIndex/check', async c => {
  const id = imageId(c.req.param('imageId'));
  const candidateIndex = Number(c.req.param('candidateIndex'));
  if (!id || !Number.isSafeInteger(candidateIndex) || candidateIndex < 0) return c.json({ message: 'Invalid candidate' }, 400);
  try {
    const { followupImageId } = candidateCheckSchema.parse(await c.req.json());
    return c.json(await checkHotpantsCandidate(id, c.req.param('runId'), candidateIndex, followupImageId), 201);
  } catch (error) { return failure(c, error); }
});

app.post('/:imageId/analyses/:runId/verification', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await startVerification(id, c.req.param('runId')), 202); } catch (error) { return failure(c, error); }
});

app.post('/:imageId/analyses/:runId/utilities', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    const request = helperRequestSchema.parse(await c.req.json());
    return c.json(await runAnalysisHelper(id, c.req.param('runId'), request), 201);
  } catch (error) { return failure(c, error); }
});

app.get('/:imageId/analyses/:runId/files/:filename', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return await analysisFile(id, c.req.param('runId'), c.req.param('filename'), c.req.query('preview') === '1'); }
  catch (error) { return failure(c, error); }
});

app.get('/:imageId/analysis-inputs', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try { return c.json(await listAnalysisInputs(id)); } catch (error) { return failure(c, error); }
});

app.post('/:imageId/analysis-inputs', async c => {
  const id = imageId(c.req.param('imageId'));
  if (!id) return c.json({ message: 'Invalid image id' }, 400);
  try {
    rejectDeclaredOversize(c.req.header('content-length'), 120 * 1024 * 1024);
    const filename = await saveAnalysisInput(id, c.req.query('filename'), c.req.raw.body);
    return c.json({ filename }, 201);
  } catch (error) { return failure(c, error); }
});

export default app;
