import * as vscode from 'vscode';
import * as path from 'path';
import type { EventBus } from '../../core/events';
import type { ConfigManager } from '../../core/config';
import type { StorageManager } from '../../core/storage';
import type { LLMRegistry } from '../../llm/registry';

export type WebviewPanelType = 'dashboard' | 'pipelineBuilder' | 'reportPreview' | 'settings';

export class WebviewManager {
  private panels = new Map<WebviewPanelType, vscode.WebviewPanel>();
  private config: ConfigManager | null = null;
  private storage: StorageManager | null = null;
  private llmRegistry: LLMRegistry | null = null;
  private activeSessionId: string | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private eventBus: EventBus,
  ) {}

  setDependencies(config: ConfigManager, llmRegistry: LLMRegistry, storage: StorageManager): void {
    this.config = config;
    this.llmRegistry = llmRegistry;
    this.storage = storage;
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
