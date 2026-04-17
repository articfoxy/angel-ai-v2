/**
 * Claude Code Worker Hub.
 *
 * Manages WebSocket connections from Claude Code worker agents running on
 * developer machines. Workers register with a name, receive coding tasks,
 * execute them via Claude CLI, and stream results back.
 */
import { v4 as uuid } from 'uuid';

export interface CodeTask {
  taskId: string;
  prompt: string;
  context?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  workerId?: string;
  createdAt: Date;
}

interface ConnectedWorker {
  id: string;
  name: string;
  userId: string;
  ws: any;
  connectedAt: Date;
  currentTaskId: string | null;
  projects: string[]; // Available project names on this machine
}

class CodeWorkerHub {
  private workers = new Map<string, ConnectedWorker>();
  private tasks = new Map<string, CodeTask>();
  private taskCallbacks = new Map<string, {
    onChunk: (text: string) => void;
    onComplete: (result: string) => void;
    onError: (error: string) => void;
  }>();

  /** Register a new worker connection. */
  registerWorker(userId: string, name: string, ws: any): string {
    const id = uuid();
    this.workers.set(id, {
      id,
      name,
      userId,
      ws,
      connectedAt: new Date(),
      currentTaskId: null,
      projects: [],
    });
    console.log(`[CodeWorker] Worker registered: ${name} (${id}) for user ${userId}`);
    return id;
  }

  /** Remove a worker on disconnect. */
  removeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      // If worker had an active task, mark it failed
      if (worker.currentTaskId) {
        const task = this.tasks.get(worker.currentTaskId);
        if (task && task.status === 'running') {
          task.status = 'failed';
          task.result = 'Worker disconnected';
          this.taskCallbacks.get(worker.currentTaskId)?.onError('Worker disconnected');
          this.taskCallbacks.delete(worker.currentTaskId);
          this.tasks.delete(worker.currentTaskId);
        }
      }
      this.workers.delete(workerId);
      console.log(`[CodeWorker] Worker removed: ${worker.name} (${workerId})`);
    }
  }

  /** Update the project list for a worker. */
  setWorkerProjects(workerId: string, projects: string[]): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.projects = projects;
      console.log(`[CodeWorker] ${worker.name} projects: ${projects.join(', ')}`);
    }
  }

  /** Get all available projects across all workers for a user. */
  getProjects(userId: string): string[] {
    const projects = new Set<string>();
    for (const w of this.workers.values()) {
      if (w.userId === userId) {
        for (const p of w.projects) projects.add(p);
      }
    }
    return Array.from(projects);
  }

  /** Get all connected workers for a user. */
  getWorkers(userId: string): { id: string; name: string; busy: boolean; projects: string[]; connectedAt: string }[] {
    const result: { id: string; name: string; busy: boolean; projects: string[]; connectedAt: string }[] = [];
    for (const w of this.workers.values()) {
      if (w.userId === userId) {
        result.push({
          id: w.id,
          name: w.name,
          busy: !!w.currentTaskId,
          projects: w.projects,
          connectedAt: w.connectedAt.toISOString(),
        });
      }
    }
    return result;
  }

  /** Dispatch a coding task to a specific worker (or first available). */
  dispatchTask(
    userId: string,
    prompt: string,
    context: string,
    workerId?: string,
    project?: string,
    callbacks?: {
      onChunk: (text: string) => void;
      onComplete: (result: string) => void;
      onError: (error: string) => void;
    },
  ): CodeTask | null {
    // Find target worker
    let worker: ConnectedWorker | undefined;
    if (workerId) {
      worker = this.workers.get(workerId);
      if (!worker || worker.userId !== userId) return null;
    } else {
      // Find first idle worker for this user
      for (const w of this.workers.values()) {
        if (w.userId === userId && !w.currentTaskId) {
          worker = w;
          break;
        }
      }
    }

    if (!worker) return null;

    const task: CodeTask = {
      taskId: uuid(),
      prompt,
      context,
      status: 'pending',
      workerId: worker.id,
      createdAt: new Date(),
    };

    this.tasks.set(task.taskId, task);
    worker.currentTaskId = task.taskId;
    if (callbacks) this.taskCallbacks.set(task.taskId, callbacks);

    // Send task to worker
    try {
      worker.ws.send(JSON.stringify({
        type: 'task',
        taskId: task.taskId,
        prompt,
        context: context || undefined,
        project: project || undefined,
      }));
      task.status = 'running';
      console.log(`[CodeWorker] Task ${task.taskId} dispatched to ${worker.name}`);
    } catch (err) {
      task.status = 'failed';
      task.result = 'Failed to send to worker';
      worker.currentTaskId = null;
      callbacks?.onError('Failed to send to worker');
      return task;
    }

    return task;
  }

  /** Handle a result chunk from a worker. */
  handleChunk(workerId: string, taskId: string, text: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.workerId !== workerId) return;
    this.taskCallbacks.get(taskId)?.onChunk(text);
  }

  /** Handle task completion from a worker. */
  handleComplete(workerId: string, taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.workerId !== workerId) return;
    task.status = 'completed';
    task.result = result;

    const worker = this.workers.get(workerId);
    if (worker) worker.currentTaskId = null;

    this.taskCallbacks.get(taskId)?.onComplete(result);
    this.taskCallbacks.delete(taskId);
    this.tasks.delete(taskId);
    console.log(`[CodeWorker] Task ${taskId} completed (${result.length} chars)`);
  }

  /**
   * Cancel any running task for this user. Sends a cancel message to the worker,
   * which kills the spawned Claude process. Returns the cancelled taskId or null.
   */
  cancelUserTasks(userId: string): string | null {
    for (const w of this.workers.values()) {
      if (w.userId === userId && w.currentTaskId) {
        const taskId = w.currentTaskId;
        try { w.ws.send(JSON.stringify({ type: 'cancel', taskId })); } catch {}
        console.log(`[CodeWorker] Cancel sent for task ${taskId} on ${w.name}`);
        // Mark immediately so the UI clears even if worker is slow to respond
        this.handleError(w.id, taskId, 'Cancelled by user');
        return taskId;
      }
    }
    return null;
  }

  /** Handle task error from a worker. */
  handleError(workerId: string, taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.workerId !== workerId) return;
    task.status = 'failed';
    task.result = error;

    const worker = this.workers.get(workerId);
    if (worker) worker.currentTaskId = null;

    this.taskCallbacks.get(taskId)?.onError(error);
    this.taskCallbacks.delete(taskId);
    this.tasks.delete(taskId);
    console.log(`[CodeWorker] Task ${taskId} failed: ${error.slice(0, 100)}`);
  }

  /** Check if a user has any connected workers. */
  hasWorkers(userId: string): boolean {
    for (const w of this.workers.values()) {
      if (w.userId === userId) return true;
    }
    return false;
  }
}

// Singleton
export const codeWorkerHub = new CodeWorkerHub();
