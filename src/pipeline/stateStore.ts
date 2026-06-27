import * as fs from 'fs/promises';
import * as path from 'path';
import type { PipelineState } from './types';
import type { PipelineStore } from './engine';

/**
 * File-based PipelineStore that persists pipeline state alongside the session
 * data in `.researchloop/sessions/{sessionId}/pipeline.json`.
 */
export class FilePipelineStore implements PipelineStore {
  constructor(private readonly basePath: string) {}

  private filePath(sessionId: string): string {
    return path.join(this.basePath, 'sessions', sessionId, 'pipeline.json');
  }

  async loadState(sessionId: string): Promise<PipelineState | undefined> {
    try {
      const raw = await fs.readFile(this.filePath(sessionId), 'utf-8');
      return JSON.parse(raw) as PipelineState;
    } catch {
      return undefined;
    }
  }

  async saveState(state: PipelineState): Promise<void> {
    const dir = path.dirname(this.filePath(state.sessionId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath(state.sessionId), JSON.stringify(state, null, 2), 'utf-8');
  }
}
