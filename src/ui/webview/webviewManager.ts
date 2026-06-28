import * as vscode from 'vscode';
import * as path from 'path';
import type { EventBus } from '../../core/events';
import type { ConfigManager } from '../../core/config';
import type { StorageManager } from '../../core/storage';
import type { LLMRegistry } from '../../llm/registry';
import type { SkillsManager } from '../../skills/manager';
import type { SkillCategory, SkillScope } from '../../skills/types';

export type WebviewPanelType = 'dashboard' | 'pipelineBuilder' | 'reportPreview' | 'settings';

export class WebviewManager {
  private panels = new Map<WebviewPanelType, vscode.WebviewPanel>();
  private config: ConfigManager | null = null;
  private storage: StorageManager | null = null;
  private llmRegistry: LLMRegistry | null = null;
  private skillsManager: SkillsManager | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private eventBus: EventBus,
  ) {}

  setDependencies(config: ConfigManager, llmRegistry: LLMRegistry, storage: StorageManager, skillsManager?: SkillsManager): void {
    this.config = config;
    this.llmRegistry = llmRegistry;
    this.storage = storage;
    this.skillsManager = skillsManager ?? null;
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  show(panelType: WebviewPanelType, title: string): vscode.WebviewPanel {
    const existing = this.panels.get(panelType);
    if (existing) {
      existing.reveal();
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      `researchloop.${panelType}`,
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: panelType === 'pipelineBuilder',
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      },
    );

    panel.webview.html = this.getHtml(panel.webview, panelType);

    panel.webview.onDidReceiveMessage(
      message => this.handleMessage(panelType, message),
      undefined,
      this.context.subscriptions,
    );

    panel.onDidDispose(() => {
      this.panels.delete(panelType);
    });

    this.panels.set(panelType, panel);
    return panel;
  }

  postMessage(panelType: WebviewPanelType, message: unknown): void {
    this.panels.get(panelType)?.webview.postMessage(message);
  }

  broadcastMessage(message: unknown): void {
    for (const panel of this.panels.values()) {
      panel.webview.postMessage(message);
    }
  }

  private handleMessage(panelType: WebviewPanelType, message: { type: string; payload?: unknown }): void {
    switch (message.type) {
      case 'ready':
        break;

      case 'config:get':
        this.sendConfigState(panelType);
        break;

      case 'config:setProvider': {
        const { provider } = message.payload as { provider: string };
        this.handleSetProvider(panelType, provider);
        break;
      }

      case 'config:testConnection': {
        const { provider } = message.payload as { provider: string };
        this.handleTestConnection(panelType, provider);
        break;
      }

      case 'report:get':
        this.handleReportGet(panelType);
        break;

      case 'report:export': {
        const { format } = message.payload as { format: string };
        const fmt = format === 'latex' ? 'LaTeX' : 'Markdown';
        vscode.commands.executeCommand('researchloop.exportReport', fmt);
        break;
      }

      // Sources
      case 'sources:get':
        this.handleSourcesGet(panelType);
        break;
      case 'sources:add':
        this.handleSourcesAdd(panelType, message.payload as { id: string; name: string; url: string });
        break;
      case 'sources:remove':
        this.handleSourcesRemove(panelType, message.payload as { id: string });
        break;

      // Categories
      case 'categories:get':
        this.handleCategoriesGet(panelType);
        break;
      case 'categories:set':
        this.handleCategoriesSet(panelType, message.payload as { categories: string[] });
        break;

      // Skills
      case 'skills:get':
        this.handleSkillsGet(panelType);
        break;
      case 'skills:add':
        this.handleSkillsAdd(panelType, message.payload as { name: string; instruction: string; category: SkillCategory; scope: SkillScope });
        break;
      case 'skills:toggle':
        this.handleSkillsToggle(panelType, message.payload as { id: string });
        break;
      case 'skills:delete':
        this.handleSkillsDelete(panelType, message.payload as { id: string });
        break;

      default:
        break;
    }
  }

  private sendConfigState(panelType: WebviewPanelType): void {
    if (!this.config || !this.llmRegistry) { return; }
    this.postMessage(panelType, {
      type: 'config:updated',
      payload: { activeProvider: this.config.activeProvider },
    });
  }

  private async handleSetProvider(panelType: WebviewPanelType, providerId: string): Promise<void> {
    if (!this.config || !this.llmRegistry) { return; }
    try {
      await this.config.set('llm.activeProvider', providerId);
      this.postMessage(panelType, {
        type: 'config:updated',
        payload: { activeProvider: providerId },
      });
    } catch {
      this.postMessage(panelType, {
        type: 'config:updated',
        payload: { activeProvider: this.config.activeProvider },
      });
    }
  }

  private async handleTestConnection(panelType: WebviewPanelType, providerId: string): Promise<void> {
    if (!this.llmRegistry) { return; }
    const provider = this.llmRegistry.get(providerId);
    if (!provider) {
      this.postMessage(panelType, {
        type: 'config:testResult',
        payload: { provider: providerId, available: false, error: 'Provider not registered' },
      });
      return;
    }
    try {
      const available = await provider.isAvailable();
      this.postMessage(panelType, {
        type: 'config:testResult',
        payload: { provider: providerId, available, error: available ? undefined : 'Not reachable — check API key or connection' },
      });
    } catch (err) {
      this.postMessage(panelType, {
        type: 'config:testResult',
        payload: { provider: providerId, available: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async handleReportGet(panelType: WebviewPanelType): Promise<void> {
    if (!this.storage || !this.activeSessionId) { return; }
    try {
      const session = await this.storage.getSession(this.activeSessionId);
      if (session?.report) {
        this.postMessage(panelType, {
          type: 'report:updated',
          payload: {
            title: session.report.title,
            sections: session.report.sections,
            format: session.report.format,
          },
        });
      }
    } catch {
      // session not found — webview shows placeholder
    }
  }

  // ── Sources ──

  private handleSourcesGet(panelType: WebviewPanelType): void {
    if (!this.config) { return; }
    const all = this.config.literatureSources;
    const builtin = all.filter((s): s is string => typeof s === 'string');
    const custom = all.filter((s): s is { id: string; name: string; url: string } => typeof s === 'object');
    this.postMessage(panelType, { type: 'sources:updated', payload: { builtin, custom } });
  }

  private async handleSourcesAdd(panelType: WebviewPanelType, source: { id: string; name: string; url: string }): Promise<void> {
    if (!this.config) { return; }
    const current = this.config.literatureSources;
    const updated = [...current, source];
    await this.config.set('literature.sources', updated);
    this.handleSourcesGet(panelType);
  }

  private async handleSourcesRemove(panelType: WebviewPanelType, payload: { id: string }): Promise<void> {
    if (!this.config) { return; }
    const current = this.config.literatureSources;
    const updated = current.filter(s => typeof s === 'string' || s.id !== payload.id);
    await this.config.set('literature.sources', updated);
    this.handleSourcesGet(panelType);
  }

  // ── Categories ──

  private handleCategoriesGet(panelType: WebviewPanelType): void {
    if (!this.config) { return; }
    this.postMessage(panelType, {
      type: 'categories:updated',
      payload: { categories: this.config.defaultCategories },
    });
  }

  private async handleCategoriesSet(panelType: WebviewPanelType, payload: { categories: string[] }): Promise<void> {
    if (!this.config) { return; }
    await this.config.set('literature.defaultCategories', payload.categories);
    this.postMessage(panelType, {
      type: 'categories:updated',
      payload: { categories: payload.categories },
    });
  }

  // ── Skills ──

  private async handleSkillsGet(panelType: WebviewPanelType): Promise<void> {
    if (!this.skillsManager) { return; }
    const skills = await this.skillsManager.loadAll();
    this.postMessage(panelType, { type: 'skills:updated', payload: { skills } });
  }

  private async handleSkillsAdd(
    panelType: WebviewPanelType,
    payload: { name: string; instruction: string; category: SkillCategory; scope: SkillScope },
  ): Promise<void> {
    if (!this.skillsManager) { return; }
    await this.skillsManager.add(payload.name, payload.instruction, payload.category, payload.scope);
    this.handleSkillsGet(panelType);
  }

  private async handleSkillsToggle(panelType: WebviewPanelType, payload: { id: string }): Promise<void> {
    if (!this.skillsManager) { return; }
    await this.skillsManager.toggle(payload.id);
    this.handleSkillsGet(panelType);
  }

  private async handleSkillsDelete(panelType: WebviewPanelType, payload: { id: string }): Promise<void> {
    if (!this.skillsManager) { return; }
    await this.skillsManager.delete(payload.id);
    this.handleSkillsGet(panelType);
  }

  private getHtml(webview: vscode.Webview, panelType: WebviewPanelType): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
  <link href="${styleUri}" rel="stylesheet">
  <title>ResearchLoop - ${panelType}</title>
</head>
<body>
  <div id="root" data-panel-type="${panelType}"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
