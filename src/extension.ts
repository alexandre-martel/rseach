import * as vscode from 'vscode';
import { EventBus } from './core/events';
import { Logger } from './core/logger';
import { ConfigManager } from './core/config';
import { StorageManager } from './core/storage';
import { LLMRegistry } from './llm/registry';
import { ClaudeProvider } from './llm/providers/claude';
import { OpenAIProvider } from './llm/providers/openai';
import { OllamaProvider } from './llm/providers/ollama';
import { BudgetManager } from './llm/budget';
import { LLMServiceAdapter } from './llm/service';
import { ModuleRegistry } from './modules/registry';
import { LiteratureModule } from './modules/literature/index';
import { CodeModule } from './modules/code/index';
import { ExperimentModule } from './modules/experiment/index';
import { AnalysisModule } from './modules/analysis/index';
import { ReportModule } from './modules/report/index';
import { PerfCheckModule } from './modules/perfcheck/index';

import { PipelineEngine } from './pipeline/engine';
import { PipelineModuleRegistryAdapter } from './pipeline/bridge';
import { FilePipelineStore } from './pipeline/stateStore';
import { DEFAULT_RESEARCH_PIPELINE } from './pipeline/definitions';
import { ResearchExplorerProvider } from './ui/sidebar/researchExplorerProvider';
import { PipelineTreeProvider } from './ui/sidebar/pipelineTreeProvider';

import { StatusBarManager } from './ui/statusBar';
import { WebviewManager } from './ui/webview/webviewManager';
import { registerCommands } from './ui/commands';
import { TelegramService } from './notifications/telegram';
import { SkillsManager } from './skills/manager';

export async function activate(context: vscode.ExtensionContext) {
  const logger = new Logger();
  logger.info('ResearchLoop activating...');

  const config = new ConfigManager();
  const eventBus = new EventBus();
  const storage = new StorageManager(context);

  await storage.initialize();

  // LLM providers
  const llmRegistry = new LLMRegistry();

  const claudeProvider = new ClaudeProvider();
  claudeProvider.configure({
    apiKey: config.claudeApiKey,
    defaultModel: config.claudeModel,
  });
  llmRegistry.register(claudeProvider);

  const openaiProvider = new OpenAIProvider();
  openaiProvider.configure({
    apiKey: config.openaiApiKey,
    defaultModel: config.openaiModel,
  });
  llmRegistry.register(openaiProvider);

  const ollamaProvider = new OllamaProvider();
  ollamaProvider.configure({
    baseUrl: config.ollamaBaseUrl,
    defaultModel: config.ollamaModel,
  });
  llmRegistry.register(ollamaProvider);

  try {
    llmRegistry.setActive(config.activeProvider);
  } catch {
    llmRegistry.setActive('ollama');
  }

  // Budget
  const budgetManager = new BudgetManager(eventBus, {
    maxTokens: config.tokenBudget,
    maxCostUsd: config.costBudget,
  });

  // LLM service adapter (bridges LLMRegistry → ILLMService for modules)
  const llmService = new LLMServiceAdapter(llmRegistry);

  // Research modules
  const moduleRegistry = new ModuleRegistry();
  moduleRegistry.register(new PerfCheckModule());
  moduleRegistry.register(new LiteratureModule());
  moduleRegistry.register(new CodeModule());
  moduleRegistry.register(new ExperimentModule());
  moduleRegistry.register(new AnalysisModule());
  moduleRegistry.register(new ReportModule());

  // Pipeline infrastructure
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const storagePath = workspaceFolder
    ? `${workspaceFolder}/.researchloop`
    : context.globalStorageUri.fsPath;
  const pipelineStore = new FilePipelineStore(storagePath);

  const pipelineModules = new PipelineModuleRegistryAdapter(
    moduleRegistry,
    llmService,
    (moduleId: string) => {
      if (moduleId === 'literature') {
        return {
          sources: config.literatureSources,
          semanticScholarApiKey: config.get<string>('literature.semanticScholarApiKey') ?? '',
        };
      }
      return {};
    },
    storagePath,
    workspaceFolder ?? storagePath,
  );

  // Skills
  const skillsManager = new SkillsManager(
    context.globalStorageUri.fsPath,
    workspaceFolder ?? null,
  );
  await skillsManager.loadAll();

  // UI providers
  const explorerProvider = new ResearchExplorerProvider(storage, eventBus);
  vscode.window.registerTreeDataProvider('researchloop.explorer', explorerProvider);

  const pipelineProvider = new PipelineTreeProvider(eventBus);
  vscode.window.registerTreeDataProvider('researchloop.pipeline', pipelineProvider);

  // Webview manager
  const webviewManager = new WebviewManager(context, eventBus);
  webviewManager.setDependencies(config, llmRegistry, storage, skillsManager);

  // Status bar
  const statusBar = new StatusBarManager(eventBus);
  statusBar.initialize();

  // Commands
  registerCommands(context, {
    storage,
    eventBus,
    logger,
    llmRegistry,
    webviewManager,
    explorerProvider,
    pipelineProvider,
    pipelineDefinition: DEFAULT_RESEARCH_PIPELINE,
    pipelineModules,
    pipelineStore,
    skillsManager,
  });

  // ── Telegram notifications (disabled by default) ──
  let telegramService: TelegramService | null = null;

  const initTelegram = () => {
    if (config.telegramEnabled && config.telegramBotToken && config.telegramChatId) {
      telegramService = new TelegramService(config.telegramBotToken, config.telegramChatId);

      // Pipeline events → Telegram notifications
      eventBus.on('pipeline:started', ({ sessionId }) => {
        telegramService?.sendMessage(`🔬 Pipeline started for session <b>${sessionId}</b>`);
      });

      eventBus.on('pipeline:stepCompleted', ({ stepId }) => {
        const stepDef = DEFAULT_RESEARCH_PIPELINE.steps.find(s => s.id === stepId);
        telegramService?.sendMessage(`✅ <b>${stepDef?.name ?? stepId}</b> completed`);
      });

      eventBus.on('pipeline:stepProgress', ({ message }) => {
        if (message?.includes('exp:') && (message.includes('✓') || message.includes('✗'))) {
          telegramService?.sendMessage(`📊 ${message}`);
        }
      });

      eventBus.on('pipeline:completed', () => {
        telegramService?.sendMessage(
          '🏁 Pipeline completed!\n\nCommands: /status /continue /restart',
        );
      });

      eventBus.on('pipeline:failed', ({ error }) => {
        telegramService?.sendMessage(`❌ Pipeline failed: ${error}`);
      });

      eventBus.on('experiment:checkpointed', ({ experimentCount, bestMetric, bestValue, stopReason }) => {
        telegramService?.sendMessage(
          `📋 Experiments paused (${stopReason})\n` +
          `Ran: ${experimentCount} | Best ${bestMetric}: ${bestValue.toFixed(4)}\n\n` +
          `/continue — resume with more budget\n` +
          `/continue 10 — add 10 experiments\n` +
          `/restart — start fresh`,
        );
      });

      // Telegram commands → VS Code actions
      telegramService.onCommand((cmd, args) => {
        switch (cmd) {
          case 'status':
            telegramService?.sendMessage('📡 ResearchLoop is active. Use /continue or /restart.');
            break;
          case 'pause':
            vscode.commands.executeCommand('researchloop.pausePipeline');
            telegramService?.sendMessage('⏸ Pipeline paused');
            break;
          case 'resume':
            vscode.commands.executeCommand('researchloop.resumePipeline');
            telegramService?.sendMessage('▶️ Pipeline resumed');
            break;
          case 'stop':
            vscode.commands.executeCommand('researchloop.cancelPipeline');
            telegramService?.sendMessage('⏹ Pipeline stopped');
            break;
          case 'continue': {
            const n = parseInt(args, 10) || 5;
            vscode.commands.executeCommand('researchloop.continueExperiments', n);
            telegramService?.sendMessage(`🔄 Continuing with ${n} more experiments...`);
            break;
          }
          case 'restart':
            vscode.commands.executeCommand('researchloop.restartExperiments');
            telegramService?.sendMessage('🔄 Restarting experiments from scratch...');
            break;
          default:
            telegramService?.sendMessage(
              `Unknown command: /${cmd}\n\n` +
              'Available: /status /pause /resume /stop /continue /restart',
            );
        }
      });

      telegramService.start();
      logger.info('Telegram notifications enabled');
    }
  };

  initTelegram();

  // React to config changes
  context.subscriptions.push(
    config.onDidChange((e) => {
      claudeProvider.configure({
        apiKey: config.claudeApiKey,
        defaultModel: config.claudeModel,
      });
      openaiProvider.configure({
        apiKey: config.openaiApiKey,
        defaultModel: config.openaiModel,
      });
      ollamaProvider.configure({
        baseUrl: config.ollamaBaseUrl,
        defaultModel: config.ollamaModel,
      });
      try {
        llmRegistry.setActive(config.activeProvider);
      } catch {
        // keep current provider
      }
      budgetManager.setLimits({
        maxTokens: config.tokenBudget,
        maxCostUsd: config.costBudget,
      });

      // Reinitialize Telegram if settings changed
      if (e.affectsConfiguration('researchloop.notifications.telegram')) {
        telegramService?.stop();
        telegramService = null;
        initTelegram();
      }
    }),
  );

  // Set initial context for menu visibility
  vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');

  // Cleanup
  context.subscriptions.push({
    dispose() {
      telegramService?.stop();
      eventBus.dispose();
      statusBar.dispose();
      logger.dispose();
    },
  });

  logger.info('ResearchLoop activated successfully');
}

export function deactivate() {
  // cleanup handled by subscriptions
}
