/**
 * Worker routes for Claude Code bridge.
 *
 * GET  /api/workers — List connected workers for the authenticated user
 * POST /api/workers/task — Dispatch a coding task to a worker
 *
 * WebSocket upgrade handled separately in index.ts.
 */
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { codeWorkerHub } from '../services/codeworker.service';

export const workersRouter = Router();

// List connected workers
workersRouter.get('/', (req: AuthRequest, res: Response) => {
  const workers = codeWorkerHub.getWorkers(req.userId!);
  res.json({ success: true, data: workers });
});

// Dispatch a task to a worker
workersRouter.post('/task', async (req: AuthRequest, res: Response) => {
  const { prompt, context, workerId } = req.body;
  if (!prompt) {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }

  if (!codeWorkerHub.hasWorkers(req.userId!)) {
    res.status(404).json({ error: 'No connected workers. Run the Angel worker agent on your machine.' });
    return;
  }

  const task = codeWorkerHub.dispatchTask(req.userId!, prompt, context || '', workerId);
  if (!task) {
    res.status(503).json({ error: 'No available workers. All workers are busy.' });
    return;
  }

  res.json({ success: true, data: { taskId: task.taskId, status: task.status, workerId: task.workerId } });
});
