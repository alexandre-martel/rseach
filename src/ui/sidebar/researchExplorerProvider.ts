import * as vscode from 'vscode';
import type { StorageManager } from '../../core/storage';
import type { EventBus } from '../../core/events';
import { SessionTreeItem, CategoryTreeItem, PaperTreeItem, ExperimentTreeItem } from './treeItems';

type ExplorerNode = SessionTreeItem | CategoryTreeItem | PaperTreeItem | ExperimentTreeItem;

export class ResearchExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private storage: StorageManager,
    private eventBus: EventBus,
  ) {
    this.eventBus.on('session:created', () => this.refresh());
    this.eventBus.on('session:updated', () => this.refresh());
    this.eventBus.on('session:deleted', () => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: ExplorerNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!element) {
      const sessions = await this.storage.listSessions();
      return sessions.map(s => new SessionTreeItem(s));
    }

    if (element instanceof SessionTreeItem) {
      const session = element.session;
      return [
        new CategoryTreeItem('Papers', 'papers', session.id, session.papers.length),
        new CategoryTreeItem('Experiments', 'experiments', session.id, session.experiments.length),
        new CategoryTreeItem('Report', 'report', session.id, session.report ? 1 : 0),
      ];
    }

    if (element instanceof CategoryTreeItem) {
      const session = (await this.storage.listSessions()).find(s => s.id === element.sessionId);
      if (!session) { return []; }

      switch (element.category) {
        case 'papers':
          return session.papers.map(p => new PaperTreeItem(p));
        case 'experiments':
          return session.experiments.map(e => new ExperimentTreeItem(e));
        default:
          return [];
      }
    }

    return [];
  }
}
