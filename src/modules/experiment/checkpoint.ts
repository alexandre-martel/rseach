import * as fs from 'fs/promises';
import * as path from 'path';
import type { Experiment } from '../../core/types';

export interface ArgSpec {
  name: string;
  choices?: string[];
  defaultVal?: string;
  type?: string;
}

export interface ExperimentCheckpoint {
  sessionId: string;
  allExperiments: Experiment[];
  allIntermediateMetrics: Record<string, number>[][];
  bestMetricValue: number;
  primaryMetric: string;
  noImproveCount: number;
  knownArgs: string[];
  argSpecs: ArgSpec[];
  reflectionInsights: string;
  entrypoint: string;
  commandTemplate: string | null;
  maxExperiments: number;
  maxNoImprove: number;
  stoppedAt: string;
  stopReason: 'maxNoImprove' | 'maxExperiments' | 'user_stop' | 'error';
}

function checkpointPath(workspacePath: string, sessionId: string): string {
  return path.join(workspacePath, 'sessions', sessionId, 'experiment-checkpoint.json');
}

export async function saveCheckpoint(
  workspacePath: string,
  sessionId: string,
  checkpoint: ExperimentCheckpoint,
): Promise<void> {
  const filePath = checkpointPath(workspacePath, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), 'utf-8');
}

export async function loadCheckpoint(
  workspacePath: string,
  sessionId: string,
): Promise<ExperimentCheckpoint | null> {
  const filePath = checkpointPath(workspacePath, sessionId);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ExperimentCheckpoint;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(
  workspacePath: string,
  sessionId: string,
): Promise<void> {
  const filePath = checkpointPath(workspacePath, sessionId);
  try {
    await fs.unlink(filePath);
  } catch {
    // file doesn't exist — fine
  }
}
