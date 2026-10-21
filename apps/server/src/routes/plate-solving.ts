import { Hono } from 'hono';
import { plateSolvingPaused, setPlateSolvingPaused } from '../services/plate-solving-pause';
import { storage } from '../services/storage';
import { astrometryService } from '../services/astrometry';
import { configService } from '../services/config';
import { isPlateSolvingEligible } from '../services/solar-system';
import { handleRouteError } from './route-utils';
import { parseCoordinate, type SolveHint } from '../services/astrometry-local';

/** Optional `{ hint: { ra, dec, radius?, scaleLow?, scaleHigh? } }` body; RA/Dec accept degrees or sexagesimal. */
async function solveHint(request: Request): Promise<SolveHint | undefined> {
  if (!request.headers.get('content-type')?.includes('application/json')) return undefined;
  const body = await request.json().catch(() => null) as { hint?: Record<string, unknown> } | null;
  const value = body?.hint;
  if (!value) return undefined;
  const ra = parseCoordinate(value.ra, 'ra');
  const dec = parseCoordinate(value.dec, 'dec');
  if (ra === undefined || dec === undefined || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
    throw new HintError('Enter RA as degrees or hh:mm:ss and Dec as degrees or ±dd:mm:ss');
  }
  const number = (item: unknown) => {
    const parsed = Number(item);
    return item !== undefined && item !== '' && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const scaleLowArcsec = number(value.scaleLow);
  const scaleHighArcsec = number(value.scaleHigh);
  return {
    ra, dec,
    radiusDeg: Math.min(number(value.radius) ?? 3, 30),
    ...(scaleLowArcsec && scaleHighArcsec && scaleHighArcsec > scaleLowArcsec ? { scaleLowArcsec, scaleHighArcsec } : {}),
  };
}

class HintError extends Error {}
import type { WsManager } from '../services/ws-manager';

export default (wsManager?: WsManager) => {
  const app = new Hono();

  // Submit image for plate solving
  app.post('/images/:id/plate-solve', async (c) => {
    try {
      // Local solving requires the feature to be enabled, but no external API key.
      const astrometryConfig = await configService.getAstrometryConfig();
      if (!astrometryConfig.enabled) {
        return c.json({
          message: 'Plate solving is disabled. Enable it in the admin settings.',
        }, 400);
      }

      const imageId = parseInt(c.req.param('id'));
      const image = await storage.getAstroImage(imageId);
      if (!image) {
        return c.json({ message: 'Image not found' }, 404);
      }
      if (!isPlateSolvingEligible(image.tags, Boolean(image.plateSolved))) {
        return c.json({ message: 'Plate solving requires the Deep Sky tag. Add it for stellar fields; Solar System and planet tags are excluded.' }, 400);
      }

      const existingJob = await storage.getLatestPlateSolvingJob(imageId);
      if (existingJob && ['pending', 'processing'].includes(existingJob.status)) {
        return c.json({ status: 'processing', jobId: existingJob.id, submissionId: existingJob.astrometrySubmissionId, message: 'This image is already queued for private local solving.' }, 202);
      }

      let hint: SolveHint | undefined;
      try {
        hint = await solveHint(c.req.raw);
      } catch (error) {
        if (error instanceof HintError) return c.json({ message: error.message }, 400);
        throw error;
      }
      // Use the shared service to complete the full plate solving workflow
      const outcome = await astrometryService.completePlateSolvingWorkflow(image, hint);
      if (outcome.status === 'processing') return c.json(outcome, 202);

      return c.json({
        message: 'Image plate solving completed successfully',
        result: {
          calibration: outcome.result.calibration,
          annotations: outcome.result.annotations,
          machineTags: outcome.result.machineTags,
        },
      });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to complete plate solving');
    }
  });

  // Check plate solving status and update results
  // One query for the images instead of one per job.
  async function visiblePlateSolvingJobs() {
    const [jobs, images] = await Promise.all([storage.getPlateSolvingJobs(), storage.getAstroImages()]);
    const byId = new Map(images.map(image => [image.id, image]));
    return jobs.filter(job => {
      const image = job.imageId === null ? undefined : byId.get(job.imageId);
      return image?.plateSolved || isPlateSolvingEligible(image?.tags);
    });
  }

  // Small status for the sidebar, which polls it: counts and the latest jobs without their (large) results.
  app.get('/jobs/summary', async (c) => {
    try {
      const jobs = await visiblePlateSolvingJobs();
      const time = (value: unknown) => (value ? new Date(value as string | number | Date).getTime() : 0) || 0;
      const recent = [...jobs].sort((a, b) => time(b.submittedAt) - time(a.submittedAt) || b.id - a.id).slice(0, 4)
        .map(job => ({ id: job.id, imageId: job.imageId, status: job.status, submittedAt: job.submittedAt, completedAt: job.completedAt }));
      return c.json({
        paused: await plateSolvingPaused(),
        processing: jobs.filter(job => job.status === 'processing').length,
        pending: jobs.filter(job => job.status === 'pending').length,
        recent,
      });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch plate solving status');
    }
  });

  // Pause / resume the whole queue (the solve in progress is stopped and re-queued, not failed).
  app.post('/pause', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { paused?: unknown };
      if (typeof body.paused !== 'boolean') return c.json({ message: 'paused (true/false) is required' }, 400);
      await setPlateSolvingPaused(body.paused);
      return c.json({ paused: body.paused });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to change the plate solving pause');
    }
  });

  app.get('/jobs', async (c) => {
    try {
      return c.json(await visiblePlateSolvingJobs());
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch plate solving jobs');
    }
  });

  // Bulk submit images for plate solving
  app.post('/bulk', async (c) => {
    try {
      const { imageIds, force } = await c.req.json();

      if (!Array.isArray(imageIds) || imageIds.length === 0) {
        return c.json({ message: 'imageIds array is required' }, 400);
      }

      // Check the local solver feature switch; images never leave this server.
      const astrometryConfig = await configService.getAstrometryConfig();
      if (!astrometryConfig.enabled) {
        return c.json({
          message: 'Plate solving is disabled. Enable it in the admin settings.',
        }, 400);
      }

      const results = [];

      for (const imageId of imageIds) {
        try {
          const image = await storage.getAstroImage(imageId);
          if (!image) {
            results.push({ imageId, success: false, error: 'Image not found' });
            continue;
          }

          // `force` re-solves locally (e.g. to replace imported solutions with a full WCS); the
          // previous solution stays in place until the new one succeeds.
          if (image.plateSolved && force !== true) {
            results.push({ imageId, success: false, error: 'Image already plate solved' });
            continue;
          }
          if (!isPlateSolvingEligible(image.tags, Boolean(image.plateSolved))) {
            results.push({ imageId, success: false, error: 'Plate solving requires the Deep Sky tag; Solar System and planet tags are excluded' });
            continue;
          }

          const latest = await storage.getLatestPlateSolvingJob(imageId);
          if (latest && ['pending', 'processing'].includes(latest.status)) {
            results.push({ imageId, success: false, error: 'Already queued for local solving' });
            continue;
          }

          // Submit for plate solving (just submit, don't wait for completion)
          const { submissionId, jobId } = await astrometryService.submitImageForPlateSolving(image);

          results.push({
            imageId,
            success: true,
            submissionId,
            jobId,
            message: 'Submitted for plate solving',
          });
        } catch (error: unknown) {
          const err = error as Error & { response?: { data?: { message?: string } } };
          results.push({
            imageId,
            success: false,
            error: err.response?.data?.message || err.message,
          });
        }
      }

      return c.json({
        message: 'Bulk plate solving submission completed',
        results,
      });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to submit images for plate solving');
    }
  });

  // Update plate solving job status
  app.post('/update/:jobId', async (c) => {
    try {
      const jobId = parseInt(c.req.param('jobId'));
      const job = await storage.getPlateSolvingJob(jobId);
      if (!job) return c.json({ message: 'Plate-solving job not found' }, 404);
      return c.json({ status: job.status, result: job.result });
    } catch (error) {
      return handleRouteError(c, error, 'Failed to update plate solving status');
    }
  });

  return app;
};
