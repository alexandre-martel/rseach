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
  const telegramListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  const cleanupTelegramListeners = () => {
    for (const { event, handler } of telegramListeners) {
      eventBus.off(event as keyof import('./core/events').EventMap, handler as never);
    }
    telegramListeners.length = 0;
  };

  const onTelegram = <K extends keyof import('./core/events').EventMap>(
    event: K,
    handler: (payload: import('./core/events').EventMap[K]) => void,
  ) => {
    eventBus.on(event, handler);
    telegramListeners.push({ event, handler: handler as (...args: unknown[]) => void });
  };

  const initTelegram = () => {
    if (config.telegramEnabled && config.telegramBotToken && config.telegramChatId) {
      const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'unknown';
      const tag = `[${workspaceName}]`;

      telegramService = new TelegramService(
        config.telegramBotToken,
        config.telegramChatId,
        (msg) => logger.warn(msg),
      );

      const notifiedExps = new Set<string>();

      // Pipeline events → Telegram notifications
      onTelegram('pipeline:started', () => {
        notifiedExps.clear();
        telegramService?.sendMessage(`${tag} 🔬 Pipeline started`);
      });

      onTelegram('pipeline:stepCompleted', ({ stepId }) => {
        const stepDef = DEFAULT_RESEARCH_PIPELINE.steps.find(s => s.id === stepId);
        telegramService?.sendMessage(`${tag} ✅ <b>${stepDef?.name ?? stepId}</b> completed`);
      });

      onTelegram('pipeline:stepProgress', ({ message }) => {
        if (!message?.startsWith('exp:')) { return; }
        const parts = message.substring(4).split('|');
        if (parts.length < 4) { return; }
        const [num, name, detail, status] = parts;
        if (status !== 'completed' && status !== 'failed') { return; }

        const key = `${num}|${status}`;
        if (notifiedExps.has(key)) { return; }
        notifiedExps.add(key);

        if (status === 'failed') {
          telegramService?.sendMessage(`${tag} 💥 #${num} <b>${name}</b> — ${detail}`);
        } else {
          telegramService?.sendMessage(`${tag} 📊 #${num} <b>${name}</b> — ${detail}`);
        }
      });

      onTelegram('pipeline:completed', () => {
        telegramService?.sendMessage(
          `${tag} 🏁 <b>Pipeline completed!</b>\n\n` +
          '/status — check connection\n' +
          '/continue — run more experiments\n' +
          '/continue 10 — run 10 more\n' +
          '/restart — start fresh\n' +
          '/new — start a new session',
        );
      });

      onTelegram('pipeline:failed', ({ error }) => {
        telegramService?.sendMessage(`${tag} ❌ Pipeline failed: ${error}`);
      });

      onTelegram('experiment:checkpointed', ({ experimentCount, bestMetric, bestValue, stopReason }) => {
        telegramService?.sendMessage(
          `${tag} 📋 <b>Experiments paused</b> (${stopReason})\n` +
          `Ran: ${experimentCount} | Best ${bestMetric}: ${bestValue.toFixed(4)}\n\n` +
          '/continue — resume with more budget\n' +
          '/continue 10 — add 10 experiments\n' +
          '/restart — start fresh',
        );
      });

      // Telegram commands → VS Code actions
      telegramService.onCommand((cmd, args) => {
        switch (cmd) {
          case 'start':
          case 'status':
            telegramService?.sendMessage(
              `${tag} 📡 ResearchLoop is active.\n\n` +
              '/continue — resume experiments\n' +
              '/restart — start experiments fresh\n' +
              '/new — start a new research session\n' +
              '/pause — pause pipeline\n' +
              '/resume — resume pipeline\n' +
              '/stop — cancel pipeline',
            );
            break;
          case 'pause':
            vscode.commands.executeCommand('researchloop.pausePipeline');
            telegramService?.sendMessage(`${tag} ⏸ Pipeline paused`);
            break;
          case 'resume':
            vscode.commands.executeCommand('researchloop.resumePipeline');
            telegramService?.sendMessage(`${tag} ▶️ Pipeline resumed`);
            break;
          case 'stop':
            vscode.commands.executeCommand('researchloop.cancelPipeline');
            telegramService?.sendMessage(`${tag} ⏹ Pipeline stopped`);
            break;
          case 'continue': {
            const n = parseInt(args, 10) || 5;
            vscode.commands.executeCommand('researchloop.continueExperiments', n);
            telegramService?.sendMessage(`${tag} 🔄 Continuing with ${n} more experiments...`);
            break;
          }
          case 'restart':
            vscode.commands.executeCommand('researchloop.restartExperiments');
            telegramService?.sendMessage(`${tag} 🔄 Restarting experiments from scratch...`);
            break;
          case 'new':
            if (args.trim()) {
              vscode.commands.executeCommand('researchloop.newSessionAuto', args.trim());
              telegramService?.sendMessage(`${tag} 🆕 Starting new session: <b>${args.trim()}</b>`);
            } else {
              telegramService?.sendMessage(
                `${tag} Usage: /new <research question>\n\n` +
                'Example:\n/new Best methods for random forest hyperparameter tuning',
              );
            }
            break;
          default:
            telegramService?.sendMessage(
              `Unknown command: /${cmd}\n\n` +
              'Available: /status /pause /resume /stop /continue /restart /new',
            );
        }
      });

      telegramService.start();
      logger.info('Telegram notifications enabled');

      telegramService.sendMessage(`${tag} 🔗 ResearchLoop connected.`);
    } else if (config.telegramEnabled) {
      logger.warn('Telegram enabled but botToken or chatId is missing — notifications disabled');
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
        cleanupTelegramListeners();
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
