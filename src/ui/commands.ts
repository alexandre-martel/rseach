import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { StorageManager } from '../core/storage';
import type { EventBus } from '../core/events';
import type { Logger } from '../core/logger';
import type { LLMRegistry } from '../llm/registry';
import type { WebviewManager } from './webview/webviewManager';
import type { ResearchExplorerProvider } from './sidebar/researchExplorerProvider';
import type { ResearchSession } from '../core/types';
import type { PipelineDefinition } from '../pipeline/types';
import type { ModuleRegistry as PipelineModuleRegistry } from '../pipeline/types';
import { DEFAULT_RETRY_POLICY } from '../pipeline/types';
import type { PipelineStore } from '../pipeline/engine';
import type { PipelineTreeProvider } from './sidebar/pipelineTreeProvider';
import { PipelineEngine } from '../pipeline/engine';
import type { Paper, Experiment, Report, ReportSection } from '../core/types';
import { loadCheckpoint } from '../modules/experiment/checkpoint';
import type { SkillsManager } from '../skills/manager';
import { PipelineModuleRegistryAdapter } from '../pipeline/bridge';

interface CommandContext {
  storage: StorageManager;
  eventBus: EventBus;
  logger: Logger;
  llmRegistry: LLMRegistry;
  webviewManager: WebviewManager;
  explorerProvider: ResearchExplorerProvider;
  pipelineProvider: PipelineTreeProvider;
  pipelineDefinition: PipelineDefinition;
  pipelineModules: PipelineModuleRegistry;
  pipelineStore: PipelineStore;
  skillsManager: SkillsManager;
}

let activePipelineEngine: PipelineEngine | null = null;
let activeSessionId: string | null = null;
const openExperimentDocs = new Map<string, vscode.TextDocument>();

export function registerCommands(context: vscode.ExtensionContext, ctx: CommandContext): void {
  const { storage, eventBus, logger, webviewManager, explorerProvider } = ctx;

  context.subscriptions.push(
    vscode.commands.registerCommand('researchloop.newSession', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Experiment name',
        placeHolder: 'e.g., Cancer, XGBoost Tuning, Robotics Survey',
      });
      if (!name) { return; }

      const question = await vscode.window.showInputBox({
        prompt: 'What is your research question?',
        placeHolder: 'e.g., "What are the best methods for sim-to-real transfer in robotic manipulation?"',
        value: name,
      });
      if (!question) { return; }

      const session: ResearchSession = {
        id: generateId(),
        name,
        question,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        pipelineId: 'default-research-loop',
        papers: [],
        experiments: [],
        report: null,
        tags: [],
        notes: '',
        llmConfig: {
          provider: ctx.llmRegistry.getActiveId() ?? 'ollama',
          model: '',
        },
        tokenUsage: {
          totalPromptTokens: 0,
          totalCompletionTokens: 0,
          totalCost: 0,
          byProvider: {},
          byStep: {},
        },
        schemaVersion: 1,
      };

      await storage.saveSession(session);
      activeSessionId = session.id;
      webviewManager.setActiveSession(session.id);
      eventBus.emit('session:created', session);
      logger.info(`Created session: ${name}`);
      vscode.window.showInformationMessage(`Research session "${name}" created. Click ▶ Start Pipeline in the Pipeline panel to run research.`);
    }),

    vscode.commands.registerCommand('researchloop.deleteSession', async (item: { session?: ResearchSession }) => {
      if (!item?.session) { return; }
      const confirm = await vscode.window.showWarningMessage(
        `Delete session "${item.session.name}"? This cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') { return; }
      await storage.deleteSession(item.session.id);
      if (activeSessionId === item.session.id) {
        activeSessionId = null;
      }
      eventBus.emit('session:deleted', item.session.id);
      logger.info(`Deleted session: ${item.session.name}`);
    }),

    vscode.commands.registerCommand('researchloop.refreshExplorer', () => {
      explorerProvider.refresh();
    }),

    vscode.commands.registerCommand('researchloop.openDashboard', () => {
      webviewManager.show('dashboard', 'Results Dashboard');
    }),

    vscode.commands.registerCommand('researchloop.openPipelineBuilder', () => {
      webviewManager.show('pipelineBuilder', 'Pipeline Builder');
    }),

    vscode.commands.registerCommand('researchloop.openReportPreview', () => {
      webviewManager.show('reportPreview', 'Report Preview');
    }),

    vscode.commands.registerCommand('researchloop.viewExperiments', async (sessionId?: string) => {
      const sid = sessionId ?? activeSessionId;
      if (!sid) {
        vscode.window.showWarningMessage('No session selected.');
        return;
      }
      const session = await storage.getSession(sid);
      if (!session || session.experiments.length === 0) {
        vscode.window.showWarningMessage('No experiments available for this session.');
        return;
      }

      const formatted = formatExperimentsReport(session.experiments);
      const content = JSON.stringify(formatted, null, 2);

      const existing = openExperimentDocs.get(sid);
      if (existing) {
        const editor = vscode.window.visibleTextEditors.find(e => e.document === existing);
        if (editor) {
          const fullRange = new vscode.Range(
            existing.positionAt(0),
            existing.positionAt(existing.getText().length),
          );
          await editor.edit(edit => edit.replace(fullRange, content));
          await vscode.window.showTextDocument(existing, { preview: false });
          return;
        }
        openExperimentDocs.delete(sid);
      }

      const uri = vscode.Uri.parse(`untitled:${session.name} — Experiments.json`);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      await editor.edit(edit => edit.insert(new vscode.Position(0, 0), content));
      openExperimentDocs.set(sid, doc);
    }),

    vscode.commands.registerCommand('researchloop.viewReport', async (sessionId?: string) => {
      const sid = sessionId ?? activeSessionId;
      if (!sid) {
        vscode.window.showWarningMessage('No session selected.');
        return;
      }
      const session = await storage.getSession(sid);
      if (!session?.report) {
        vscode.window.showWarningMessage('No report available for this session.');
        return;
      }
      webviewManager.setActiveSession(sid);
      webviewManager.show('reportPreview', 'Report Preview');
      setTimeout(() => {
        webviewManager.postMessage('reportPreview', {
          type: 'report:updated',
          payload: {
            title: session.report!.title,
            sections: session.report!.sections,
            format: session.report!.format,
          },
        });
      }, 500);
    }),

    vscode.commands.registerCommand('researchloop.openSettings', () => {
      webviewManager.show('settings', 'ResearchLoop Settings');
    }),

    vscode.commands.registerCommand('researchloop.searchPapers', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Search academic papers',
        placeHolder: 'e.g., "transformer attention mechanisms robotics"',
      });
      if (!query) { return; }
      logger.info(`Searching papers: ${query}`);
      vscode.window.showInformationMessage(`Searching for: "${query}"...`);
    }),

    // ── Pipeline control ──────────────────────────────────────────────

    vscode.commands.registerCommand('researchloop.startPipeline', async () => {
      const session = await pickOrGetActiveSession(storage, activeSessionId);
      if (!session) { return; }

      activeSessionId = session.id;
      webviewManager.setActiveSession(session.id);

      const llmAvailable = await ctx.llmRegistry.getActive().isAvailable();
      if (!llmAvailable) {
        vscode.window.showErrorMessage(
          `LLM provider "${ctx.llmRegistry.getActiveId()}" is not reachable. Check your API key and connection in ResearchLoop Settings.`,
        );
        return;
      }

      // Ask user for optional metrics and hyperparameters
      const targetMetrics = await vscode.window.showInputBox({
        prompt: 'What metrics do you want to track? (optional — press Enter to skip)',
        placeHolder: 'e.g., accuracy, f1_score, brier_score, AUC-ROC, log_loss',
      });

      const targetHyperparameters = await vscode.window.showInputBox({
        prompt: 'What hyperparameters do you want to tune? (optional — press Enter to skip)',
        placeHolder: 'e.g., learning_rate: 0.01-0.1, max_depth: 3-10, n_estimators: 50-200',
      });

      // Inject session question into the pipeline's first step config
      const definition = JSON.parse(JSON.stringify(ctx.pipelineDefinition)) as typeof ctx.pipelineDefinition;
      const searchStep = definition.steps.find(s => s.id === 'literature-search');
      if (searchStep) {
        searchStep.config.query = session.question;
        searchStep.config.researchQuestion = session.question;
        const rlConfig = vscode.workspace.getConfiguration('researchloop');
        searchStep.config.categories = rlConfig.get<string[]>('literature.defaultCategories') ?? ['cs.LG', 'cs.RO', 'cs.AI', 'stat.ML'];
        searchStep.config.maxResults = rlConfig.get<number>('literature.maxPapers') ?? 20;
      }
      const analyzeStep = definition.steps.find(s => s.id === 'literature-analyze');
      if (analyzeStep) {
        analyzeStep.config.researchQuestion = session.question;
      }
const codegenStep = definition.steps.find(s => s.id === 'experiment-codegen');
      if (codegenStep) {
        codegenStep.config.researchQuestion = session.question;
      }
      const runStep = definition.steps.find(s => s.id === 'experiment-run');
      if (runStep) {
        runStep.config.researchQuestion = session.question;
        const rlConfig = vscode.workspace.getConfiguration('researchloop');
        runStep.config.maxNoImprove = rlConfig.get<number>('experiment.maxNoImprove') ?? 5;
        runStep.config.maxExperiments = rlConfig.get<number>('experiment.maxExperiments') ?? 10;
        if (targetMetrics) { runStep.config.targetMetrics = targetMetrics; }
        if (targetHyperparameters) { runStep.config.targetHyperparameters = targetHyperparameters; }
      }

      const reportStep = definition.steps.find(s => s.id === 'report');
      if (reportStep) {
        reportStep.config.researchQuestion = session.question;
      }

      // Inject user skills into module prompts
      await ctx.skillsManager.loadAll();
      const skillsText = ctx.skillsManager.formatForPrompt();
      if (ctx.pipelineModules instanceof PipelineModuleRegistryAdapter) {
        ctx.pipelineModules.setUserSkills(skillsText || undefined);
      }

      activePipelineEngine = new PipelineEngine(
        definition,
        ctx.pipelineModules,
        ctx.pipelineStore,
        eventBus,
      );

      // Populate pipeline tree with step definitions so the sidebar shows progress
      ctx.pipelineProvider.setSteps(
        definition.steps.map(s => ({ id: s.id, label: s.name, status: 'pending' as const })),
      );

      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'running');
      logger.info(`Starting pipeline for session: ${session.name}`);

      const totalSteps = definition.steps.length;

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: `Research Pipeline`,
        },
        async (progress) => {
          progress.report({ message: `$(sync~spin) Starting "${session.name}"...` });

          let completedSteps = 0;
          const perStep = 100 / totalSteps;

          const onStepStarted = ({ stepId }: { stepId: string }) => {
            const stepDef = definition.steps.find(s => s.id === stepId);
            progress.report({ message: `$(sync~spin) ${stepDef?.name ?? stepId} (${completedSteps}/${totalSteps})` });
          };
          const onStepDone = () => {
            completedSteps++;
            progress.report({ increment: perStep, message: `${completedSteps}/${totalSteps} steps` });
          };

          eventBus.on('pipeline:stepStarted', onStepStarted);
          eventBus.on('pipeline:stepCompleted', onStepDone);
          eventBus.on('pipeline:stepFailed', onStepDone);

          try {
            await activePipelineEngine!.start(session);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Pipeline failed to start: ${msg}`);
            vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');
            logger.error(`Pipeline start failed: ${msg}`);
            return;
          }

          await new Promise<void>(resolve => {
            const cleanup = () => {
              eventBus.off('pipeline:stepStarted', onStepStarted);
              eventBus.off('pipeline:stepCompleted', onStepDone);
              eventBus.off('pipeline:stepFailed', onStepDone);
              resolve();
            };
            eventBus.once('pipeline:completed', cleanup);
            eventBus.once('pipeline:failed', cleanup);
            eventBus.once('pipeline:cancelled', cleanup);
          });
        },
      );
    }),

    vscode.commands.registerCommand('researchloop.pausePipeline', async () => {
      if (!activePipelineEngine) {
        vscode.window.showWarningMessage('No pipeline is running.');
        return;
      }
      await activePipelineEngine.pause();
      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'paused');
      logger.info('Pipeline paused');
    }),

    vscode.commands.registerCommand('researchloop.resumePipeline', async () => {
      if (!activePipelineEngine) {
        vscode.window.showWarningMessage('No pipeline to resume.');
        return;
      }
      await activePipelineEngine.resume();
      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'running');
      logger.info('Pipeline resumed');
    }),

    vscode.commands.registerCommand('researchloop.cancelPipeline', async () => {
      if (!activePipelineEngine) {
        vscode.window.showWarningMessage('No pipeline is running.');
        return;
      }
      await activePipelineEngine.cancel();
      activePipelineEngine = null;
      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');
      logger.info('Pipeline cancelled');
    }),

    // ── Run Research (right-click on session) ─────────────────────────

    vscode.commands.registerCommand('researchloop.runResearch', async (item: { session?: ResearchSession }) => {
      const session = item?.session ?? await pickOrGetActiveSession(storage, activeSessionId);
      if (!session) { return; }
      activeSessionId = session.id;
      vscode.commands.executeCommand('researchloop.startPipeline');
    }),

    vscode.commands.registerCommand('researchloop.exportReport', async (formatArg?: string) => {
      const format = formatArg ?? await vscode.window.showQuickPick(['Markdown', 'LaTeX'], {
        placeHolder: 'Select export format',
      });
      if (!format) { return; }
      await exportReportToFile(storage, activeSessionId, format.toLowerCase() as 'markdown' | 'latex', logger);
    }),

    // ── Continue / Restart experiments ──────────────────────────────────

    vscode.commands.registerCommand('researchloop.continueExperiments', async (additionalArg?: number) => {
      const session = await pickOrGetActiveSession(storage, activeSessionId);
      if (!session) { return; }

      if (activePipelineEngine) {
        vscode.window.showWarningMessage('A pipeline is already running. Stop it first.');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
      }
      const storagePath = `${workspaceFolder}/.researchloop`;

      const checkpoint = await loadCheckpoint(storagePath, session.id);
      if (!checkpoint) {
        vscode.window.showWarningMessage('No experiment checkpoint found for this session. Run experiments first.');
        return;
      }

      let additional = additionalArg ?? 0;
      if (!additional) {
        const input = await vscode.window.showInputBox({
          prompt: `Resume from ${checkpoint.allExperiments.length} experiments (best ${checkpoint.primaryMetric}: ${checkpoint.bestMetricValue.toFixed(4)}). How many more?`,
          placeHolder: '5',
          value: '5',
        });
        if (!input) { return; }
        additional = parseInt(input, 10) || 5;
      }

      activeSessionId = session.id;

      const rlConfig = vscode.workspace.getConfiguration('researchloop');
      const definition: PipelineDefinition = {
        id: 'continue-experiments',
        name: 'Continue Experiments',
        steps: [{
          id: 'experiment-run',
          name: 'Run Experiments (continued)',
          moduleId: 'experiment',
          dependsOn: [],
          config: {
            moduleStepId: 'run',
            researchQuestion: session.question,
            resume: true,
            additionalExperiments: additional,
            maxNoImprove: rlConfig.get<number>('experiment.maxNoImprove') ?? 5,
            maxExperiments: checkpoint.allExperiments.length + additional,
          },
        }],
        defaultRetryPolicy: DEFAULT_RETRY_POLICY,
      };

      await ctx.skillsManager.loadAll();
      const contSkills = ctx.skillsManager.formatForPrompt();
      if (ctx.pipelineModules instanceof PipelineModuleRegistryAdapter) {
        ctx.pipelineModules.setUserSkills(contSkills || undefined);
      }

      activePipelineEngine = new PipelineEngine(definition, ctx.pipelineModules, ctx.pipelineStore, eventBus);

      ctx.pipelineProvider.setSteps(
        definition.steps.map(s => ({ id: s.id, label: s.name, status: 'pending' as const })),
      );

      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'running');
      logger.info(`Continuing experiments for session: ${session.name} (+${additional})`);

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Continue Experiments' },
        async (progress) => {
          progress.report({ message: `$(sync~spin) Resuming from ${checkpoint!.allExperiments.length} experiments...` });

          const onStepDone = () => {
            progress.report({ message: 'Done' });
          };
          eventBus.on('pipeline:stepCompleted', onStepDone);
          eventBus.on('pipeline:stepFailed', onStepDone);

          try {
            await activePipelineEngine!.start(session);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Continue failed: ${msg}`);
            vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');
            return;
          }

          await new Promise<void>(resolve => {
            const cleanup = () => {
              eventBus.off('pipeline:stepCompleted', onStepDone);
              eventBus.off('pipeline:stepFailed', onStepDone);
              resolve();
            };
            eventBus.once('pipeline:completed', cleanup);
            eventBus.once('pipeline:failed', cleanup);
            eventBus.once('pipeline:cancelled', cleanup);
          });
        },
      );
    }),

    vscode.commands.registerCommand('researchloop.restartExperiments', async () => {
      const session = await pickOrGetActiveSession(storage, activeSessionId);
      if (!session) { return; }

      if (activePipelineEngine) {
        vscode.window.showWarningMessage('A pipeline is already running. Stop it first.');
        return;
      }

      activeSessionId = session.id;
      const rlConfig = vscode.workspace.getConfiguration('researchloop');

      const definition: PipelineDefinition = {
        id: 'restart-experiments',
        name: 'Restart Experiments',
        steps: [{
          id: 'experiment-run',
          name: 'Run Experiments (fresh)',
          moduleId: 'experiment',
          dependsOn: [],
          config: {
            moduleStepId: 'run',
            researchQuestion: session.question,
            resume: false,
            maxNoImprove: rlConfig.get<number>('experiment.maxNoImprove') ?? 5,
            maxExperiments: rlConfig.get<number>('experiment.maxExperiments') ?? 10,
          },
        }],
        defaultRetryPolicy: DEFAULT_RETRY_POLICY,
      };

      await ctx.skillsManager.loadAll();
      const restSkills = ctx.skillsManager.formatForPrompt();
      if (ctx.pipelineModules instanceof PipelineModuleRegistryAdapter) {
        ctx.pipelineModules.setUserSkills(restSkills || undefined);
      }

      activePipelineEngine = new PipelineEngine(definition, ctx.pipelineModules, ctx.pipelineStore, eventBus);

      ctx.pipelineProvider.setSteps(
        definition.steps.map(s => ({ id: s.id, label: s.name, status: 'pending' as const })),
      );

      vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'running');
      logger.info(`Restarting experiments for session: ${session.name}`);

      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Restart Experiments' },
        async (progress) => {
          progress.report({ message: '$(sync~spin) Restarting experiments from scratch...' });

          const onStepDone = () => {
            progress.report({ message: 'Done' });
          };
          eventBus.on('pipeline:stepCompleted', onStepDone);
          eventBus.on('pipeline:stepFailed', onStepDone);

          try {
            await activePipelineEngine!.start(session);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Restart failed: ${msg}`);
            vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');
            return;
          }

          await new Promise<void>(resolve => {
            const cleanup = () => {
              eventBus.off('pipeline:stepCompleted', onStepDone);
              eventBus.off('pipeline:stepFailed', onStepDone);
              resolve();
            };
            eventBus.once('pipeline:completed', cleanup);
            eventBus.once('pipeline:failed', cleanup);
            eventBus.once('pipeline:cancelled', cleanup);
          });
        },
      );
    }),
  );

  // ── Pipeline event listeners (update UI) ──────────────────────────

  eventBus.on('pipeline:completed', async ({ sessionId }) => {
    vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');

    // Sync pipeline outputs back to the session
    if (activePipelineEngine) {
      try {
        const pipelineState = activePipelineEngine.getState();
        const session = await storage.getSession(sessionId);
        if (session) {
          const litSearchOutput = pipelineState.steps['literature-search']?.output;
          const litAnalyzeOutput = pipelineState.steps['literature-analyze']?.output;
          if (litAnalyzeOutput?.data?.analyzedPapers) {
            session.papers = litAnalyzeOutput.data.analyzedPapers as Paper[];
          } else if (litSearchOutput?.data?.papers) {
            session.papers = litSearchOutput.data.papers as Paper[];
          }

          // Sync experiments
          const expRunOutput = pipelineState.steps['experiment-run']?.output;
          if (expRunOutput?.data?.experiments) {
            const experiments = (expRunOutput.data.experiments as Experiment[]).map(exp => ({
              ...exp,
              sessionId: sessionId,
            }));
            session.experiments = experiments;
          }

          const reportOutput = pipelineState.steps['report']?.output;
          if (reportOutput?.data?.report) {
            const raw = reportOutput.data.report as { content?: string; format?: string };
            session.report = parseMarkdownToReport(
              raw.content ?? '',
              sessionId,
              session.question,
            );
          }
          session.updatedAt = Date.now();
          session.status = 'completed';
          await storage.saveSession(session);
        }
      } catch (err) {
        logger.error(`Failed to sync pipeline results: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    activePipelineEngine = null;
    logger.info(`Pipeline completed for session ${sessionId}`);

    // Auto-open the report panel and push data to it
    const completedSession = await storage.getSession(sessionId);
    if (completedSession?.report) {
      webviewManager.show('reportPreview', 'Report Preview');
      setTimeout(() => {
        webviewManager.postMessage('reportPreview', {
          type: 'report:updated',
          payload: {
            title: completedSession.report!.title,
            sections: completedSession.report!.sections,
            format: completedSession.report!.format,
          },
        });
      }, 500);
    }

    vscode.window.showInformationMessage('Research pipeline completed!');
    explorerProvider.refresh();
  });

  eventBus.on('pipeline:failed', ({ sessionId, error }) => {
    vscode.commands.executeCommand('setContext', 'researchloop.pipelineState', 'idle');
    activePipelineEngine = null;
    logger.error(`Pipeline failed for session ${sessionId}: ${error}`);
    vscode.window
      .showErrorMessage(`Research pipeline failed: ${error}`, 'Show Logs')
      .then(action => {
        if (action === 'Show Logs') { logger.show(); }
      });
  });

  eventBus.on('pipeline:stepStarted', ({ stepId }) => {
    const stepDef = ctx.pipelineDefinition.steps.find(s => s.id === stepId);
    logger.info(`Step started: ${stepDef?.name ?? stepId}`);
    vscode.window.setStatusBarMessage(`$(sync~spin) ${stepDef?.name ?? stepId}...`, 60_000);
  });

  eventBus.on('pipeline:stepCompleted', ({ stepId }) => {
    const stepDef = ctx.pipelineDefinition.steps.find(s => s.id === stepId);
    logger.info(`Step completed: ${stepDef?.name ?? stepId}`);
    vscode.window.setStatusBarMessage(`$(check) ${stepDef?.name ?? stepId} done`, 5_000);
  });

  eventBus.on('pipeline:stepFailed', ({ stepId, error }) => {
    logger.error(`Step failed: ${stepId} — ${error}`);
    vscode.window.showWarningMessage(`Pipeline step "${stepId}" failed: ${error}`);
  });
}

async function pickOrGetActiveSession(
  storage: StorageManager,
  activeSessionId: string | null,
): Promise<ResearchSession | undefined> {
  if (activeSessionId) {
    try {
      return await storage.getSession(activeSessionId);
    } catch {
      // session deleted, fall through to picker
    }
  }

  const sessions = await storage.listSessions();
  if (sessions.length === 0) {
    vscode.window.showWarningMessage('No research sessions found. Create one first.');
    return undefined;
  }

  if (sessions.length === 1) {
    return sessions[0];
  }

  const picked = await vscode.window.showQuickPick(
    sessions.map(s => ({
      label: s.name,
      description: s.question,
      detail: `Created ${new Date(s.createdAt).toLocaleDateString()} — ${s.papers.length} papers`,
      session: s,
    })),
    { placeHolder: 'Select a research session' },
  );

  return picked?.session;
}

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

interface FormattedExperiment {
  number: number;
  name: string;
  hyperparameters: Record<string, { value: unknown; delta?: string }>;
  explanation: string;
  results: Record<string, number>;
  kept: boolean;
}

function formatExperimentsReport(experiments: Experiment[]): { experiments: FormattedExperiment[]; bestExperiment: number } {
  if (experiments.length === 0) { return { experiments: [], bestExperiment: 0 }; }

  const metricKeys = Object.keys(experiments[0].metrics);
  const primaryMetric = metricKeys[0] ?? '';

  let bestIdx = 0;
  let bestVal = experiments[0]?.metrics[primaryMetric] ?? 0;
  for (let i = 1; i < experiments.length; i++) {
    const val = experiments[i].metrics[primaryMetric] ?? 0;
    if (val > bestVal) { bestVal = val; bestIdx = i; }
  }

  const formatted: FormattedExperiment[] = experiments.map((exp, i) => {
    const params: Record<string, { value: unknown; delta?: string }> = {};
    const currentParams = parseArgs(exp.config?.args ?? []);
    const prevParams = i > 0 ? parseArgs(experiments[i - 1].config?.args ?? []) : null;

    for (const [key, val] of Object.entries(currentParams)) {
      const numVal = Number(val);
      if (prevParams && key in prevParams) {
        const prevNum = Number(prevParams[key]);
        if (!isNaN(numVal) && !isNaN(prevNum) && prevNum !== 0) {
          const pct = ((numVal - prevNum) / Math.abs(prevNum) * 100).toFixed(1);
          const arrow = numVal > prevNum ? '↑' : numVal < prevNum ? '↓' : '=';
          params[key] = { value: val, delta: `${arrow} ${pct}% vs exp #${i}` };
        } else if (val !== prevParams[key]) {
          params[key] = { value: val, delta: `changed from ${prevParams[key]}` };
        } else {
          params[key] = { value: val };
        }
      } else {
        params[key] = { value: val, delta: i === 0 ? 'baseline' : 'new param' };
      }
    }

    const descLines = (exp.description ?? '').split('\n');
    const explanation = descLines[0] ?? exp.name;

    return {
      number: i + 1,
      name: exp.name,
      hyperparameters: params,
      explanation,
      results: exp.metrics,
      kept: i === bestIdx,
    };
  });

  return { experiments: formatted, bestExperiment: bestIdx + 1 };
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        result[arg.substring(2, eqIdx)] = arg.substring(eqIdx + 1);
      }
    }
  }
  return result;
}

const SECTION_TYPE_MAP: Record<string, ReportSection['type']> = {
  'abstract': 'abstract',
  'introduction': 'introduction',
  'literature review': 'related_work',
  'related work': 'related_work',
  'methodology': 'methods',
  'methods': 'methods',
  'results': 'results',
  'experiments': 'experiments',
  'discussion': 'discussion',
  'conclusion': 'conclusion',
  'conclusions': 'conclusion',
  'future work': 'custom',
  'next steps': 'custom',
  'references': 'custom',
};

function parseMarkdownToReport(content: string, sessionId: string, title: string): Report {
  const sections: ReportSection[] = [];
  const lines = content.split('\n');
  let current: { title: string; lines: string[] } | null = null;
  let order = 0;

  const flush = () => {
    if (!current) { return; }
    const key = current.title.toLowerCase().replace(/^\d+\.\s*/, '');
    sections.push({
      id: `section-${order}`,
      type: SECTION_TYPE_MAP[key] ?? 'custom',
      title: current.title,
      content: current.lines.join('\n').trim(),
      order: order++,
      autoGenerated: true,
    });
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,2}\s+(.+)/);
    if (heading) {
      flush();
      current = { title: heading[1].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    sections.push({
      id: 'section-0',
      type: 'custom',
      title: 'Research Report',
      content: content.trim(),
      order: 0,
      autoGenerated: true,
    });
  }

  return {
    id: `report-${Date.now()}`,
    sessionId,
    title: title || 'Research Report',
    sections,
    references: [],
    figures: [],
    format: 'markdown',
    generatedAt: Date.now(),
  };
}

async function exportReportToFile(
  storage: StorageManager,
  sessionId: string | null,
  format: 'markdown' | 'latex',
  logger: Logger,
): Promise<void> {
  if (!sessionId) {
    vscode.window.showWarningMessage('No session selected.');
    return;
  }
  const session = await storage.getSession(sessionId);
  if (!session?.report) {
    vscode.window.showWarningMessage('No report available for this session.');
    return;
  }

  const report = session.report;
  let content: string;
  let ext: string;

  if (format === 'latex') {
    content = convertReportToLatex(report);
    ext = 'tex';
  } else {
    content = reportToMarkdown(report);
    ext = 'md';
  }

  const defaultName = `${session.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-report.${ext}`;
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
    filters: format === 'latex'
      ? { 'LaTeX': ['tex'] }
      : { 'Markdown': ['md'] },
    title: `Export Report as ${format === 'latex' ? 'LaTeX' : 'Markdown'}`,
  });
  if (!uri) { return; }

  await fs.writeFile(uri.fsPath, content, 'utf-8');
  logger.info(`Report exported to ${uri.fsPath}`);
  vscode.window.showInformationMessage(`Report exported to ${uri.fsPath}`);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
}

function reportToMarkdown(report: Report): string {
  const lines: string[] = [`# ${report.title}`, ''];
  for (const section of report.sections.sort((a, b) => a.order - b.order)) {
    lines.push(`## ${section.title}`, '', section.content, '');
  }
  return lines.join('\n');
}

function convertReportToLatex(report: Report): string {
  const escape = (s: string) => s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[&%$#_{}~^]/g, m => `\\${m}`);

  const lines: string[] = [
    '\\documentclass{article}',
    '\\usepackage[utf8]{inputenc}',
    '\\usepackage{hyperref}',
    '\\usepackage{booktabs}',
    '',
    `\\title{${escape(report.title)}}`,
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
  ];

  for (const section of report.sections.sort((a, b) => a.order - b.order)) {
    lines.push(`\\section{${escape(section.title)}}`, '');
    const content = section.content
      .replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
      .replace(/\*(.+?)\*/g, '\\textit{$1}')
      .replace(/`(.+?)`/g, '\\texttt{$1}')
      .replace(/^- (.+)$/gm, '\\item $1')
      .replace(/^(\d+)\. (.+)$/gm, '\\item $2');

    if (content.includes('\\item')) {
      const itemLines = content.split('\n');
      let inList = false;
      for (const line of itemLines) {
        if (line.trim().startsWith('\\item') && !inList) {
          lines.push('\\begin{itemize}');
          inList = true;
        } else if (!line.trim().startsWith('\\item') && inList) {
          lines.push('\\end{itemize}');
          inList = false;
        }
        lines.push(line);
      }
      if (inList) { lines.push('\\end{itemize}'); }
    } else {
      lines.push(content);
    }
    lines.push('');
  }

  lines.push('\\end{document}', '');
  return lines.join('\n');
}
