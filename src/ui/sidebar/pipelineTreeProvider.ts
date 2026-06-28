import * as vscode from 'vscode';
import type { EventBus } from '../../core/events';
import { PipelineStepTreeItem, ExperimentProgressTreeItem } from './treeItems';
import type { PipelineStepStatus } from './treeItems';

interface PipelineStepInfo {
  id: string;
  label: string;
  status: PipelineStepStatus;
  progress?: number;
  currentDetail?: string;
}

interface ExperimentSubItem {
  number: number;
  name: string;
  detail: string;
  status: 'running' | 'completed' | 'failed';
  improved?: boolean;
}

export class PipelineTreeProvider implements vscode.TreeDataProvider<PipelineStepTreeItem | ExperimentProgressTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<PipelineStepTreeItem | ExperimentProgressTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private steps: PipelineStepInfo[] = [];
  private subItems = new Map<string, ExperimentSubItem[]>();

  constructor(private eventBus: EventBus) {
    this.eventBus.on('pipeline:started', () => {
      this.subItems.clear();
      this.refresh();
    });
    this.eventBus.on('pipeline:stepStarted', ({ stepId }) => {
      this.updateStep(stepId, 'running');
    });
    this.eventBus.on('pipeline:stepProgress', ({ stepId, progress, message }) => {
      this.updateStepProgress(stepId, progress, message);
    });
    this.eventBus.on('pipeline:stepCompleted', ({ stepId }) => {
      this.updateStep(stepId, 'completed');
    });
    this.eventBus.on('pipeline:stepFailed', ({ stepId }) => {
      this.updateStep(stepId, 'failed');
    });
    this.eventBus.on('pipeline:paused', () => {
      for (const step of this.steps) {
        if (step.status === 'running') {
          step.status = 'paused';
        }
      }
      this.refresh();
    });
    this.eventBus.on('pipeline:completed', () => this.refresh());
    this.eventBus.on('pipeline:failed', () => this.refresh());
    this.eventBus.on('pipeline:cancelled', () => {
      this.steps = [];
      this.subItems.clear();
      this.refresh();
    });
  }

  setSteps(steps: PipelineStepInfo[]): void {
    this.steps = steps;
    this.subItems.clear();
    this.refresh();
  }

  private updateStep(stepId: string, status: PipelineStepStatus): void {
    const step = this.steps.find(s => s.id === stepId);
    if (step) {
      step.status = status;
      this.refresh();
    }
  }

  private updateStepProgress(stepId: string, progress: number, message?: string): void {
    const step = this.steps.find(s => s.id === stepId);
    if (step) {
      step.progress = progress;
    }

    if (message && message.startsWith('exp:')) {
      // Format: "exp:<number>|<name>|<detail>|<status>"
      const parts = message.substring(4).split('|');
      if (parts.length >= 4) {
        const num = parseInt(parts[0], 10);
        const name = parts[1];
        const detail = parts[2];
        const status = parts[3] as 'running' | 'completed' | 'failed';

        let items = this.subItems.get(stepId);
        if (!items) {
          items = [];
          this.subItems.set(stepId, items);
        }

        const improved = detail.startsWith('✓');

        const existing = items.find(e => e.number === num);
        if (existing) {
          existing.name = name;
          existing.detail = detail;
          existing.status = status;
          existing.improved = improved;
        } else {
          items.push({ number: num, name, detail, status, improved });
        }

        // Show the currently running experiment on the parent step
        if (step && status === 'running') {
          step.currentDetail = `#${num} ${name}`;
        } else if (step) {
          const anyRunning = items.find(e => e.status === 'running');
          step.currentDetail = anyRunning ? `#${anyRunning.number} ${anyRunning.name}` : undefined;
        }
      }
    }

    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: PipelineStepTreeItem | ExperimentProgressTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: PipelineStepTreeItem | ExperimentProgressTreeItem): Promise<(PipelineStepTreeItem | ExperimentProgressTreeItem)[]> {
    if (!element) {
      return this.steps.map(s => {
        const hasChildren = (this.subItems.get(s.id)?.length ?? 0) > 0;
        return new PipelineStepTreeItem(s.label, s.id, s.status, s.progress, hasChildren, s.currentDetail);
      });
    }

    if (element instanceof PipelineStepTreeItem) {
      const items = this.subItems.get(element.stepId) ?? [];
      return items.map(e =>
        new ExperimentProgressTreeItem(e.number, e.name, e.detail, e.status, e.improved),
      );
    }

    return [];
  }
}
