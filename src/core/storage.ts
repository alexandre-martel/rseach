import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ResearchSession } from './types';

export class StorageManager {
  private basePath: string;

  constructor(private context: vscode.ExtensionContext) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.basePath = workspaceFolder
      ? path.join(workspaceFolder, '.researchloop')
      : path.join(context.globalStorageUri.fsPath, 'researchloop');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(path.join(this.basePath, 'sessions'), { recursive: true });
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.basePath, 'sessions', sessionId);
  }

  private sessionFile(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'session.json');
  }

  async listSessions(): Promise<ResearchSession[]> {
    const sessionsDir = path.join(this.basePath, 'sessions');
    try {
      const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
      const sessions: ResearchSession[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            const session = await this.getSession(entry.name);
            sessions.push(session);
          } catch {
            // skip corrupted sessions
          }
        }
      }
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
      return [];
    }
  }

  async getSession(id: string): Promise<ResearchSession> {
    const data = await fs.readFile(this.sessionFile(id), 'utf-8');
    return JSON.parse(data) as ResearchSession;
  }

  async saveSession(session: ResearchSession): Promise<void> {
    const dir = this.sessionDir(session.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true });
    session.updatedAt = Date.now();
    await fs.writeFile(this.sessionFile(session.id), JSON.stringify(session, null, 2), 'utf-8');
  }

  async deleteSession(id: string): Promise<void> {
    await fs.rm(this.sessionDir(id), { recursive: true, force: true });
  }

  async updateSession(id: string, updater: (s: ResearchSession) => ResearchSession): Promise<ResearchSession> {
    const session = await this.getSession(id);
    const updated = updater(session);
    await this.saveSession(updated);
    return updated;
  }

  async saveArtifact(sessionId: string, name: string, data: Buffer): Promise<string> {
    const artifactPath = path.join(this.sessionDir(sessionId), 'artifacts', name);
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, data);
    return artifactPath;
  }

  getArtifactPath(sessionId: string, name: string): string {
    return path.join(this.sessionDir(sessionId), 'artifacts', name);
  }

  async getGlobalState<T>(key: string): Promise<T | undefined> {
    return this.context.globalState.get<T>(key);
  }

  async setGlobalState<T>(key: string, value: T): Promise<void> {
    await this.context.globalState.update(key, value);
  }
}
