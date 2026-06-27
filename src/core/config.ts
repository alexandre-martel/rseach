import * as vscode from 'vscode';

export class ConfigManager {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('researchloop');
  }

  get<T>(key: string): T | undefined {
    return this.config.get<T>(key);
  }

  getRequired<T>(key: string): T {
    const value = this.config.get<T>(key);
    if (value === undefined) {
      throw new Error(`Missing required config: researchloop.${key}`);
    }
    return value;
  }

  async set(key: string, value: unknown, global = false): Promise<void> {
    await this.config.update(key, value, global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  }

  get activeProvider(): string {
    return this.config.get<string>('llm.activeProvider') ?? 'ollama';
  }

  get claudeApiKey(): string {
    return this.config.get<string>('llm.claude.apiKey') ?? '';
  }

  get claudeModel(): string {
    return this.config.get<string>('llm.claude.model') ?? 'claude-sonnet-4-20250514';
  }

  get openaiApiKey(): string {
    return this.config.get<string>('llm.openai.apiKey') ?? '';
  }

  get openaiModel(): string {
    return this.config.get<string>('llm.openai.model') ?? 'o3-mini';
  }

  get ollamaBaseUrl(): string {
    return this.config.get<string>('llm.ollama.baseUrl') ?? 'http://localhost:11434';
  }

  get ollamaModel(): string {
    return this.config.get<string>('llm.ollama.model') ?? 'llama3.1';
  }

  get tokenBudget(): number {
    return this.config.get<number>('llm.tokenBudget') ?? 0;
  }

  get costBudget(): number {
    return this.config.get<number>('llm.costBudget') ?? 0;
  }

  get enabledModules(): string[] {
    return this.config.get<string[]>('modules.enabled') ?? ['literature', 'code', 'experiment', 'analysis', 'report'];
  }

  get defaultRunner(): string {
    return this.config.get<string>('experiment.defaultRunner') ?? 'local';
  }

  get literatureSources(): string[] {
    return this.config.get<string[]>('literature.sources') ?? ['arxiv', 'semanticScholar'];
  }

  get maxPapers(): number {
    return this.config.get<number>('literature.maxPapers') ?? 20;
  }

  get defaultCategories(): string[] {
    return this.config.get<string[]>('literature.defaultCategories') ?? ['cs.LG', 'cs.RO', 'cs.AI', 'stat.ML'];
  }

  get reportFormat(): 'markdown' | 'latex' {
    return this.config.get<'markdown' | 'latex'>('report.defaultFormat') ?? 'markdown';
  }

  get experimentMaxNoImprove(): number {
    return this.config.get<number>('experiment.maxNoImprove') ?? 3;
  }

  get experimentMaxExperiments(): number {
    return this.config.get<number>('experiment.maxExperiments') ?? 10;
  }

  onDidChange(handler: (e: vscode.ConfigurationChangeEvent) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('researchloop')) {
        handler(e);
      }
    });
  }
}
