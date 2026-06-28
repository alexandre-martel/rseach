import * as vscode from 'vscode';
import type { ResearchSession, Paper, Experiment, Trial } from '../../core/types';

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: ResearchSession) {
    super(session.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'session';
    this.description = session.status;
    this.tooltip = `${session.question}\nCreated: ${new Date(session.createdAt).toLocaleDateString()}`;
    this.iconPath = new vscode.ThemeIcon(
      session.status === 'active' ? 'play-circle' :
      session.status === 'completed' ? 'check' : 'archive'
    );
  }
}

export class CategoryTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly category: 'papers' | 'experiments' | 'report',
    public readonly sessionId: string,
    private count: number,
  ) {
    super(label, count > 0 && category !== 'report' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = `category-${category}`;
    this.description = `${count}`;
    this.iconPath = new vscode.ThemeIcon(
      category === 'papers' ? 'book' :
      category === 'experiments' ? 'beaker' :
      'notebook'
    );
    if (category === 'report' && count > 0) {
      this.command = {
        command: 'researchloop.viewReport',
        title: 'View Report',
        arguments: [sessionId],
      };
    }
    if (category === 'experiments' && count > 0) {
      this.command = {
        command: 'researchloop.viewExperiments',
        title: 'View Experiments',
        arguments: [sessionId],
      };
    }
  }
}

export class PaperTreeItem extends vscode.TreeItem {
  constructor(public readonly paper: Paper) {
    super(paper.title, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'paper';
    this.description = `${paper.year} - ${paper.source}`;
    this.tooltip = new vscode.MarkdownString(
      `**${paper.title}**\n\n` +
      `Authors: ${paper.authors.map(a => a.name).join(', ')}\n\n` +
      `${paper.abstract?.substring(0, 200)}...`
    );
    this.iconPath = new vscode.ThemeIcon('file-text');
    if (paper.url) {
      this.command = {
        command: 'vscode.open',
        title: 'Open Paper',
        arguments: [vscode.Uri.parse(paper.url)],
      };
    }
  }
}

export class ExperimentTreeItem extends vscode.TreeItem {
  constructor(public readonly experiment: Experiment) {
    super(experiment.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'experiment';
    this.iconPath = new vscode.ThemeIcon(
      experiment.status === 'running' ? 'loading~spin' :
      experiment.status === 'completed' ? 'check' :
      experiment.status === 'failed' ? 'error' :
      'circle-outline'
    );

    const metricsEntries = Object.entries(experiment.metrics);
    if (metricsEntries.length > 0) {
      const topMetric = metricsEntries[0];
      this.description = `${topMetric[0]}: ${typeof topMetric[1] === 'number' ? topMetric[1].toFixed(4) : topMetric[1]}`;
    } else {
      this.description = experiment.status;
    }

    const params = experiment.config?.args
      ?.filter((a: string) => a.startsWith('--'))
      .map((a: string) => a.replace('--', '').replace('=', ': '))
      .join('\n') ?? '';
    const metrics = metricsEntries
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(4) : v}`)
      .join('\n');

    this.tooltip = new vscode.MarkdownString(
      `**${experiment.name}** (${experiment.status})\n\n` +
      (params ? `**Hyperparameters:**\n${params}\n\n` : '') +
      (metrics ? `**Metrics:**\n${metrics}` : ''),
    );
  }
}

export class TrialTreeItem extends vscode.TreeItem {
  constructor(public readonly trial: Trial, public readonly objectiveMetric?: string) {
    super(`Trial #${trial.number}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'trial';
    const mainMetric = objectiveMetric && trial.metrics[objectiveMetric] !== undefined
      ? `${objectiveMetric}: ${trial.metrics[objectiveMetric].toFixed(4)}`
      : '';
    this.description = mainMetric || trial.status;
    this.iconPath = new vscode.ThemeIcon(
      trial.status === 'running' ? 'loading~spin' :
      trial.status === 'completed' ? 'check' :
      trial.status === 'failed' ? 'error' :
      'circle-outline'
    );
  }
}

export type PipelineStepStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

export class PipelineStepTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly stepId: string,
    public readonly status: PipelineStepStatus,
    public readonly progress?: number,
    hasChildren = false,
    currentDetail?: string,
  ) {
    super(label, hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = `step-${status}`;
    if (currentDetail && status === 'running') {
      this.description = currentDetail;
    } else {
      this.description = progress !== undefined ? `${progress}%` : status;
    }
    this.iconPath = new vscode.ThemeIcon(
      status === 'running' ? 'loading~spin' :
      status === 'completed' ? 'check' :
      status === 'failed' ? 'error' :
      status === 'skipped' ? 'debug-step-over' :
      status === 'paused' ? 'debug-pause' :
      status === 'queued' ? 'clock' :
      'circle-outline'
    );
  }
}

export class ExperimentProgressTreeItem extends vscode.TreeItem {
  constructor(
    public readonly expNumber: number,
    public readonly expName: string,
    public readonly detail: string,
    public readonly expStatus: 'running' | 'completed' | 'failed',
    public readonly improved?: boolean,
  ) {
    super(`#${expNumber} ${expName}`, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'experiment-progress';
    this.description = detail;
    if (expStatus === 'running') {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
    } else if (expStatus === 'failed') {
      this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    } else {
      this.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    }
  }
}
