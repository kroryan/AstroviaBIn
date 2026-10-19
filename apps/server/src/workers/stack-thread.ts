import { parentPort, workerData } from 'node:worker_threads';
import { stackFits } from '../services/fits-stacking';

/** Runs one stack off the server's event loop; see runStackInThread. */
stackFits(workerData.filePaths, workerData.outputPath, workerData.settings).then(
  result => parentPort?.postMessage({ ok: true, result }),
  error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
