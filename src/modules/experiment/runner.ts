import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}

export interface RunResult {
  metrics: Record<string, number>;
  logs: string;
  status: 'completed' | 'failed';
  exitCode: number | null;
  duration: number;
}

export interface ExperimentRunner {
  run(opts: RunOptions): Promise<RunResult>;
  installDeps(cwd: string, signal?: AbortSignal): Promise<void>;
}

export class LocalRunner implements ExperimentRunner {
  async run(opts: RunOptions): Promise<RunResult> {
    const start = Date.now();
    const timeout = opts.timeout ?? 300_000;

    return new Promise<RunResult>((resolve) => {
      const pythonPath = opts.command;
      const child = spawn(pythonPath, opts.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        opts.onOutput?.(text);
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        opts.onOutput?.(text);
      });

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => { if (!child.killed) { child.kill('SIGKILL'); } }, 5000);
      }, timeout);

      const onAbort = () => { child.kill('SIGTERM'); };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const duration = Date.now() - start;
        const logs = stdout + (stderr ? '\n--- stderr ---\n' + stderr : '');

        if (code !== 0) {
          resolve({
            metrics: {},
            logs,
            status: 'failed',
            exitCode: code,
            duration,
          });
          return;
        }

        resolve({
          metrics: parseMetrics(stdout),
          logs,
          status: 'completed',
          exitCode: code,
          duration,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({
          metrics: {},
          logs: `Process error: ${err.message}\n${stderr}`,
          status: 'failed',
          exitCode: null,
          duration: Date.now() - start,
        });
      });
    });
  }

  async installDeps(cwd: string, signal?: AbortSignal): Promise<void> {
    const reqPath = path.join(cwd, 'requirements.txt');
    try {
      await fs.access(reqPath);
    } catch {
      return;
    }

    const pip = await findPip(cwd);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['install', '-r', 'requirements.txt'], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });

      const onAbort = () => { child.kill('SIGTERM'); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', onAbort);
        if (code !== 0) {
          reject(new Error(`pip install failed with exit code ${code}`));
        } else {
          resolve();
        }
      });

      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
    });
  }
}

export class DockerRunner implements ExperimentRunner {
  async run(_opts: RunOptions): Promise<RunResult> {
    throw new Error('Docker runner not implemented yet — coming soon');
  }

  async installDeps(_cwd: string, _signal?: AbortSignal): Promise<void> {
    throw new Error('Docker runner not implemented yet — coming soon');
  }
}

export function createRunner(type: 'local' | 'docker' | 'slurm'): ExperimentRunner {
  switch (type) {
    case 'local':
      return new LocalRunner();
    case 'docker':
      return new DockerRunner();
    default:
      throw new Error(`Runner type "${type}" is not supported`);
  }
}

export function parseMetrics(stdout: string): Record<string, number> {
  const lines = stdout.split('\n').reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) { continue; }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const metrics: Record<string, number> = {};
        let hasNumeric = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') {
            metrics[k] = v;
            hasNumeric = true;
          }
        }
        if (hasNumeric) { return metrics; }
      }
    } catch {
      // not valid JSON, keep scanning
    }
  }
  return {};
}

export function parseAllMetrics(stdout: string): Record<string, number>[] {
  const all: Record<string, number>[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) { continue; }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const metrics: Record<string, number> = {};
        let hasNumeric = false;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') {
            metrics[k] = v;
            hasNumeric = true;
          }
        }
        if (hasNumeric) { all.push(metrics); }
      }
    } catch {
      // not valid JSON
    }
  }
  return all;
}

export function buildCommand(
  template: string | undefined,
  entrypoint: string,
  hyperparameters: Record<string, unknown>,
): { command: string; args: string[] } {
  if (template) {
    let cmd = template;
    const consumed = new Set<string>();
    for (const [k, v] of Object.entries(hyperparameters)) {
      const before = cmd;
      cmd = cmd.replace(`{${k}}`, String(v));
      cmd = cmd.replace(`<${k}>`, String(v));
      if (cmd !== before) { consumed.add(k); }
    }

    // If unreplaced placeholders remain (LLM used unknown format), fall back to --key=value
    if (/<\w+>/.test(cmd) || /\{[a-zA-Z_]\w*\}/.test(cmd)) {
      const args = [entrypoint];
      for (const [k, v] of Object.entries(hyperparameters)) {
        args.push(`--${k}=${v}`);
      }
      return { command: 'python', args };
    }

    const parts = cmd.split(/\s+/).filter(Boolean);
    const cleanParts = parts.map(p => p.replace(/^\[|]$/g, '')).filter(p => p && !p.startsWith('...'));

    // Append hyperparameters that weren't consumed by template placeholders
    const extraArgs: string[] = [];
    for (const [k, v] of Object.entries(hyperparameters)) {
      if (!consumed.has(k)) {
        extraArgs.push(`--${k}=${v}`);
      }
    }

    return { command: cleanParts[0], args: [...cleanParts.slice(1), ...extraArgs] };
  }

  const args = [entrypoint];
  for (const [k, v] of Object.entries(hyperparameters)) {
    args.push(`--${k}=${v}`);
  }
  return { command: 'python', args };
}

export async function findPython(cwd: string): Promise<string> {
  const isWin = process.platform === 'win32';
  const venvDirs = ['.venv', 'venv', 'env'];
  const binDir = isWin ? 'Scripts' : 'bin';
  const pythonBin = isWin ? 'python.exe' : 'python';

  for (const dir of venvDirs) {
    const candidate = path.join(cwd, dir, binDir, pythonBin);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not found, try next
    }
  }

  return 'python';
}

async function findPip(cwd: string): Promise<string> {
  const isWin = process.platform === 'win32';
  const venvDirs = ['.venv', 'venv', 'env'];
  const binDir = isWin ? 'Scripts' : 'bin';
  const pipBin = isWin ? 'pip.exe' : 'pip';

  for (const dir of venvDirs) {
    const candidate = path.join(cwd, dir, binDir, pipBin);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not found, try next
    }
  }

  return 'pip';
}
