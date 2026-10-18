import { Hono } from 'hono';
import { storage } from '../services/storage';
import { astrometryService } from '../services/astrometry';
import { configService } from '../services/config';
import { isPlateSolvingEligible } from '../services/solar-system';
import { handleRouteError } from './route-utils';
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
      if (!isPlateSolvingEligible(image.tags)) {
        return c.json({ message: 'Plate solving requires the Deep Sky tag. Add it for stellar fields; Solar System and planet tags are excluded.' }, 400);
      }

      const existingJob = await storage.getLatestPlateSolvingJob(imageId);
      if (existingJob && ['pending', 'processing'].includes(existingJob.status)) {
        return c.json({ status: 'processing', jobId: existingJob.id, submissionId: existingJob.astrometrySubmissionId, message: 'This image is already queued for private local solving.' }, 202);
      }

      // Use the shared service to complete the full plate solving workflow
      const outcome = await astrometryService.completePlateSolvingWorkflow(image);
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
  app.get('/jobs', async (c) => {
    try {
      const jobs = await storage.getPlateSolvingJobs();
      const visibleJobs = [];
      for (const job of jobs) {
        const image = job.imageId === null ? undefined : await storage.getAstroImage(job.imageId);
        if (image?.plateSolved || isPlateSolvingEligible(image?.tags)) visibleJobs.push(job);
      }
      return c.json(visibleJobs);
    } catch (error) {
      return handleRouteError(c, error, 'Failed to fetch plate solving jobs');
    }
  });

  // Bulk submit images for plate solving
  app.post('/bulk', async (c) => {
    try {
      const { imageIds } = await c.req.json();

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

          if (image.plateSolved) {
            results.push({ imageId, success: false, error: 'Image already plate solved' });
            continue;
          }
          if (!isPlateSolvingEligible(image.tags)) {
            results.push({ imageId, success: false, error: 'Plate solving requires the Deep Sky tag; Solar System and planet tags are excluded' });
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
