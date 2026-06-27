import * as vscode from 'vscode';
import type { EventBus } from '../core/events';

export class StatusBarManager {
  private statusItem: vscode.StatusBarItem;
  private tokenItem: vscode.StatusBarItem;
  private currentSession: string | null = null;
  private pipelineStatus: string = 'idle';
  private totalTokens = 0;

  constructor(private eventBus: EventBus) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.tokenItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  }

  initialize(): void {
    this.updateStatus();
    this.statusItem.show();

    this.eventBus.on('pipeline:started', ({ sessionId }) => {
      this.currentSession = sessionId;
      this.pipelineStatus = 'running';
      this.updateStatus();
    });

    this.eventBus.on('pipeline:paused', () => {
      this.pipelineStatus = 'paused';
      this.updateStatus();
    });

    this.eventBus.on('pipeline:resumed', () => {
      this.pipelineStatus = 'running';
      this.updateStatus();
    });

    this.eventBus.on('pipeline:completed', () => {
      this.pipelineStatus = 'completed';
      this.updateStatus();
    });

    this.eventBus.on('pipeline:failed', () => {
      this.pipelineStatus = 'failed';
      this.updateStatus();
    });

    this.eventBus.on('pipeline:cancelled', () => {
      this.pipelineStatus = 'idle';
      this.updateStatus();
    });

    this.eventBus.on('llm:requestCompleted', ({ tokens }) => {
      this.totalTokens += tokens;
      this.updateTokens();
    });
  }

  private updateStatus(): void {
    const icon = this.pipelineStatus === 'running' ? '$(loading~spin)' :
                 this.pipelineStatus === 'paused' ? '$(debug-pause)' :
                 this.pipelineStatus === 'completed' ? '$(check)' :
                 this.pipelineStatus === 'failed' ? '$(error)' :
                 '$(beaker)';
    this.statusItem.text = `${icon} ResearchLoop`;
    this.statusItem.tooltip = `Pipeline: ${this.pipelineStatus}${this.currentSession ? `\nSession: ${this.currentSession}` : ''}`;
    this.statusItem.command = 'researchloop.openDashboard';
  }

  private updateTokens(): void {
    if (this.totalTokens > 0) {
      const display = this.totalTokens > 1000
        ? `${(this.totalTokens / 1000).toFixed(1)}k`
        : `${this.totalTokens}`;
      this.tokenItem.text = `$(symbol-number) ${display} tokens`;
      this.tokenItem.tooltip = `Total tokens used: ${this.totalTokens.toLocaleString()}`;
      this.tokenItem.show();
    }
  }

  resetTokens(): void {
    this.totalTokens = 0;
    this.tokenItem.hide();
  }

  dispose(): void {
    this.statusItem.dispose();
    this.tokenItem.dispose();
  }
}
