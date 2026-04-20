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

// Size limits — the worker runs Claude CLI with --dangerously-skip-permissions,
// so anything we pass flows into a shell-adjacent execution context. Cap strictly.
const MAX_PROMPT_LEN = 8000;
const MAX_CONTEXT_LEN = 16000;
const MAX_PROJECT_LEN = 128;

// List connected workers
workersRouter.get('/', (req: AuthRequest, res: Response) => {
  const workers = codeWorkerHub.getWorkers(req.userId!);
  res.json({ success: true, data: workers });
});

// List all available projects across connected workers
workersRouter.get('/projects', (req: AuthRequest, res: Response) => {
  const projects = codeWorkerHub.getProjects(req.userId!);
  res.json({ success: true, data: projects });
});

// Dispatch a task to a worker. Hardened against abuse: size caps, type checks,
// and control-character stripping to reduce shell-injection surface area.
workersRouter.post('/task', async (req: AuthRequest, res: Response) => {
  const { prompt, context, workerId, project } = req.body || {};

  // Type + presence checks
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt must be a non-empty string' });
  }
  if (context !== undefined && typeof context !== 'string') {
    return res.status(400).json({ error: 'context must be a string' });
  }
  if (workerId !== undefined && (typeof workerId !== 'string' || workerId.length > 64)) {
    return res.status(400).json({ error: 'workerId must be a short string' });
  }
  if (project !== undefined && (typeof project !== 'string' || project.length > MAX_PROJECT_LEN)) {
    return res.status(400).json({ error: 'project name too long' });
  }

  // Size caps
  if (prompt.length > MAX_PROMPT_LEN) {
    return res.status(413).json({ error: `prompt exceeds ${MAX_PROMPT_LEN} chars` });
  }
  const safeContext = (context || '').slice(0, MAX_CONTEXT_LEN);

  // Strip control chars (null byte, ANSI escapes) from all worker-bound strings
  const sanitize = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  const safePrompt = sanitize(prompt);
  const safeCtx = sanitize(safeContext);
  const safeProject = project ? sanitize(project) : undefined;

  if (!codeWorkerHub.hasWorkers(req.userId!)) {
    return res.status(404).json({ error: 'No connected workers. Run the Angel worker agent on your machine.' });
  }

  const task = codeWorkerHub.dispatchTask(req.userId!, safePrompt, safeCtx, workerId, safeProject);
  if (!task) {
    return res.status(503).json({ error: 'No available workers. All workers are busy.' });
  }

  res.json({ success: true, data: { taskId: task.taskId, status: task.status, workerId: task.workerId } });
});
