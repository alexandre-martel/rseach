import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PipelineError } from '../../core/errors';
import {
  IResearchModule,
  ModuleMetadata,
  ModuleCapability,
  ModuleContext,
  StepDefinition,
  StepInput,
  StepOutput,
} from '../types';
import type { Paper, Experiment } from '../../core/types';
import { createRunner, buildCommand, findPython, parseAllMetrics } from './runner';
import type { RunResult } from './runner';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from './checkpoint';
import type { ExperimentCheckpoint, ArgSpec } from './checkpoint';

const outputChannel = vscode.window.createOutputChannel('ResearchLoop - Experiments');

const METADATA: ModuleMetadata = {
  id: 'experiment',
  name: 'Experiment Runner',
  version: '0.1.0',
  description: 'Design and manage experiment configurations based on literature findings.',
  capabilities: [ModuleCapability.EXECUTE, ModuleCapability.GENERATE],
  dependencies: ['literature'],
  configSchema: {
    type: 'object',
    properties: {
      runner: { type: 'string', enum: ['local', 'docker', 'slurm'], default: 'local' },
    },
  },
};

const DESIGN_STEP: StepDefinition = {
  id: 'design',
  name: 'Design Experiments',
  description: 'Use LLM to design experiment configurations from analyzed papers and code.',
  inputs: ['analyzedPapers', 'codeReferences', 'researchQuestion', 'targetMetrics', 'targetHyperparameters'],
  outputs: ['experimentDesigns'],
};

const GENERATE_CODE_STEP: StepDefinition = {
  id: 'generate-code',
  name: 'Generate Code',
  description: 'Generate training/evaluation code if none exists yet. Skipped when code is already available.',
  inputs: ['experimentDesigns', 'codeReferences', 'researchQuestion'],
  outputs: ['generatedCode', 'codeReferences'],
};

const RUN_STEP: StepDefinition = {
  id: 'run',
  name: 'Run Experiments',
  description: 'Execute designed experiments and collect metrics.',
  inputs: ['experimentDesigns', 'researchQuestion', 'generatedCode', 'analyzedPapers'],
  outputs: ['experimentResults', 'experiments'],
};

export class ExperimentModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  getAvailableSteps(): StepDefinition[] {
    return [DESIGN_STEP, GENERATE_CODE_STEP, RUN_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    switch (stepId) {
      case 'design':
        return this.designExperiments(input, context);
      case 'generate-code':
        return this.generateCode(input, context);
      case 'run':
        return this.runExperiments(input, context);
      default:
        throw new PipelineError(`Unknown step "${stepId}" in experiment module`, stepId);
    }
  }

  private async generateCode(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const codeRefs = (input.data.codeReferences as unknown[]) ?? [];
    const designs = (input.data.experimentDesigns as ExperimentDesign[]) ?? [];
    const question = (input.data.researchQuestion as string) ?? '';

    // Check if actual Python files exist on disk — library names in papers don't count
    let hasCodeOnDisk = false;
    try {
      const files = await fs.readdir(context.projectRoot);
      hasCodeOnDisk = files.some(f => f.endsWith('.py'));
    } catch {
      hasCodeOnDisk = false;
    }

    if (hasCodeOnDisk) {
      return {
        data: { generatedCode: null, codeReferences: codeRefs, skipped: true },
        artifacts: [],
        summary: 'Skipped — Python files already exist in project root',
        metrics: { skipped: 1, filesGenerated: 0 },
      };
    }

    const designSummary = designs
      .slice(0, 5)
      .map((d, i) => `${i + 1}. "${d.name ?? 'Experiment'}": ${d.hypothesis ?? ''}\n   Params: ${JSON.stringify(d.hyperparameters ?? {})}`)
      .join('\n');

    const response = await context.llm.complete(
      [
        {
          role: 'user',
          content: `No existing code was found for this research project. Generate the necessary training/evaluation code.

Research question: ${question}

Planned experiments:
${designSummary || '(No specific experiments yet — generate a general-purpose training script)'}

Generate a complete, runnable Python script that:
1. Defines a model/pipeline appropriate for the research question
2. Accepts ALL major model hyperparameters as argparse arguments (at least 5 model params like n_estimators, max_depth, min_samples_split, min_samples_leaf, max_features, criterion — not just operational ones like cv_folds). Each must have a default value, correct type (int/float/str), and choices= for categorical params.
3. Trains/evaluates and prints metrics to stdout in JSON format: {"metric_name": value, ...}
4. Handles common edge cases (missing data, GPU availability, etc.)

Respond in JSON: {
  "files": [{ "path": string, "content": string, "description": string }],
  "entrypoint": string,
  "command_template": string,
  "requirements": string[]
}`,
        },
      ],
      { temperature: 0.3, responseFormat: 'json' },
    );

    let generated = { files: [] as { path: string; content: string; description: string }[], entrypoint: '', command_template: '', requirements: [] as string[] };
    try {
      generated = JSON.parse(response.content);
    } catch {
      // keep defaults
    }

    const codeDir = path.join(context.workspacePath, 'sessions', context.sessionId, 'generated-code');
    await fs.mkdir(codeDir, { recursive: true });
    const writtenPaths: string[] = [];
    for (const file of generated.files) {
      const filePath = path.join(codeDir, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content, 'utf-8');
      writtenPaths.push(filePath);
    }
    if (generated.requirements.length > 0) {
      const reqPath = path.join(codeDir, 'requirements.txt');
      await fs.writeFile(reqPath, generated.requirements.join('\n'), 'utf-8');
      writtenPaths.push(reqPath);
    }

    const codeRefFromGenerated = [{
      paperTitle: '(Generated)',
      repos: [],
      libraries: generated.requirements ?? [],
      language: 'python',
      techniques: [],
    }];

    return {
      data: {
        generatedCode: generated,
        codeReferences: codeRefFromGenerated,
        entrypoint: generated.entrypoint,
        commandTemplate: generated.command_template,
      },
      artifacts: [],
      summary: `Generated ${generated.files.length} file(s) in ${codeDir}: ${generated.files.map((f: { path: string }) => f.path).join(', ') || 'none'}`,
      metrics: { skipped: 0, filesGenerated: generated.files.length },
    };
  }

  private async designExperiments(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const papers = (input.data.analyzedPapers as Paper[]) ?? [];
    const codeRefs = (input.data.codeReferences as unknown[]) ?? [];
    const question = (input.data.researchQuestion as string) ?? '';
    const targetMetrics = (input.data.targetMetrics as string) ?? '';
    const targetHyperparameters = (input.data.targetHyperparameters as string) ?? '';

    const topPapers = papers
      .slice(0, 5)
      .map((p) => `- "${p.title}": ${p.summary ?? p.abstract ?? ''}`)
      .join('\n');

    const metricsHint = targetMetrics
      ? `\n\nUser-specified metrics to track: ${targetMetrics}`
      : '';
    const hyperparamsHint = targetHyperparameters
      ? `\n\nUser-specified hyperparameters to tune: ${targetHyperparameters}`
      : '';

    const response = await context.llm.complete(
      [
        {
          role: 'user',
          content: `Based on the research question and any available papers, design experiment configurations with CONCRETE hyperparameter values and metrics. You do NOT need an exhaustive literature review — design experiments with whatever information is available.

Research question: ${question}
${metricsHint}${hyperparamsHint}

Available papers (may be partial — that's fine):
${topPapers || '(No papers yet — design exploratory experiments based on the research question alone)'}

Code references found: ${codeRefs.length}

Design 2-3 experiments. Each experiment MUST have concrete hyperparameters with specific values and metrics with expected ranges. For each provide:
- name: very short name (2-4 words max, e.g. "High LR baseline", "Deep + dropout")
- hypothesis: what we're testing
- method: step-by-step method description
- hyperparameters: object with param_name -> value (concrete values, not ranges)
- metrics: list of metric names to measure (e.g. ["accuracy", "f1_score", "brier_score"])
- expectedResults: what we expect to observe
- estimatedDuration: rough time estimate
- suggestedLiterature: keywords for follow-up searches

Respond in JSON: { "experiments": [{ "name": string, "hypothesis": string, "method": string, "hyperparameters": Record<string, number | string>, "metrics": string[], "expectedResults": string, "estimatedDuration": string, "suggestedLiterature": string[] }] }`,
        },
      ],
      { temperature: 0.5, responseFormat: 'json' },
    );

    let designs: unknown[] = [];
    try {
      const parsed = JSON.parse(response.content);
      designs = parsed.experiments ?? [];
    } catch {
      designs = [];
    }

    return {
      data: { experimentDesigns: designs },
      artifacts: [],
      summary: `Designed ${designs.length} experiments with concrete hyperparameters`,
      metrics: { experimentsDesigned: designs.length },
    };
  }

  private async runExperiments(input: StepInput, context: ModuleContext): Promise<StepOutput> {
    const question = (input.data.researchQuestion as string) ?? '';
    const maxNoImprove = (input.data.maxNoImprove as number) ?? 5;
    let maxExperiments = (input.data.maxExperiments as number) ?? 10;
    const resume = (input.data.resume as boolean) ?? false;
    const additionalExperiments = (input.data.additionalExperiments as number) ?? 0;
    let generatedCode = input.data.generatedCode as GeneratedCode | null;
    const entrypoint = (input.data.entrypoint as string) ?? generatedCode?.entrypoint ?? 'train.py';
    const commandTemplate = (input.data.commandTemplate as string) ?? generatedCode?.command_template;
    const runnerType = ((context.config?.runner as string) ?? 'local') as 'local' | 'docker' | 'slurm';

    const runner = createRunner(runnerType);
    const python = await findPython(context.projectRoot);

    // Extract paper insights for experiment design
    const papers = (input.data.analyzedPapers as Paper[]) ?? [];
    let paperInsights = '';
    if (papers.length > 0) {
      const insightParts: string[] = [];
      for (const p of papers.slice(0, 5)) {
        let entry = `• "${p.title}"`;
        if (p.keyFindings?.length) {
          entry += `\n  Findings: ${p.keyFindings.slice(0, 3).join('; ')}`;
        }
        if (p.methods?.length) {
          entry += `\n  Methods: ${p.methods.map(m => `${m.name} (${m.description})`).slice(0, 3).join('; ')}`;
        }
        if (p.hyperparameters?.length) {
          entry += `\n  Recommended hyperparams: ${p.hyperparameters.map(h => `${h.name}=${h.value} (${h.context})`).slice(0, 5).join('; ')}`;
        }
        insightParts.push(entry);
      }
      paperInsights = insightParts.join('\n');
      outputChannel.appendLine(`\n=== PAPER INSIGHTS FOR EXPERIMENT DESIGN ===\n${paperInsights}\n`);
    }

    let allExperiments: Experiment[] = [];
    let allIntermediateMetrics: Record<string, number>[][] = [];
    let bestMetricValue = -Infinity;
    let primaryMetric = '';
    let noImproveCount = 0;
    let reflectionInsights = '';

    // ── Resume from checkpoint ──
    let checkpoint: ExperimentCheckpoint | null = null;
    if (resume) {
      checkpoint = await loadCheckpoint(context.workspacePath, context.sessionId);
      if (checkpoint) {
        allExperiments = checkpoint.allExperiments;
        allIntermediateMetrics = checkpoint.allIntermediateMetrics;
        bestMetricValue = checkpoint.bestMetricValue;
        primaryMetric = checkpoint.primaryMetric;
        noImproveCount = 0; // reset — give it another chance
        if (additionalExperiments > 0) {
          maxExperiments = allExperiments.length + additionalExperiments;
        }
        outputChannel.appendLine(`\n=== RESUMING FROM CHECKPOINT ===`);
        outputChannel.appendLine(`Loaded ${allExperiments.length} previous experiments`);
        outputChannel.appendLine(`Best ${primaryMetric}: ${bestMetricValue}`);
        outputChannel.appendLine(`Budget: ${maxExperiments - allExperiments.length} more experiments`);
        outputChannel.appendLine(`==============================\n`);
      }
    }

    // Helper: write generated code files to projectRoot
    const writeCodeToProject = async (code: GeneratedCode) => {
      for (const file of code.files) {
        const dest = path.join(context.projectRoot, file.path);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, file.content, 'utf-8');
      }
      if (code.requirements?.length) {
        await fs.writeFile(
          path.join(context.projectRoot, 'requirements.txt'),
          code.requirements.join('\n'),
          'utf-8',
        );
      }
    };

    // Helper: extract --key=value pairs from CLI args
    const extractHyperparams = (exp: Experiment): Record<string, string> => {
      const params: Record<string, string> = {};
      for (const arg of exp.config?.args ?? []) {
        const match = arg.match(/^--([^=]+)=(.+)$/);
        if (match) { params[match[1]] = match[2]; }
      }
      return params;
    };

    // Helper: read entrypoint and extract argparse argument specs (name, choices, default, type)
    const readArgSpecs = async (): Promise<ArgSpec[]> => {
      try {
        const src = await fs.readFile(path.join(context.projectRoot, entrypoint), 'utf-8');
        const specs: ArgSpec[] = [];
        // Match each add_argument call block (may span multiple lines)
        const blocks = src.matchAll(/add_argument\s*\(\s*['"]--([^'"]+)['"]([^)]*)\)/gs);
        for (const block of blocks) {
          const name = block[1];
          const rest = block[2];
          const spec: ArgSpec = { name };
          // Extract choices=[...] or choices=(...)
          const choicesMatch = rest.match(/choices\s*=\s*[\[(]([^\])]+)[\])]/);
          if (choicesMatch) {
            spec.choices = choicesMatch[1].match(/['"]([^'"]+)['"]/g)?.map(s => s.replace(/['"]/g, '')) ?? [];
          }
          // Extract default=...
          const defaultMatch = rest.match(/default\s*=\s*(['"]([^'"]*)['""]|(\S+))/);
          if (defaultMatch) {
            spec.defaultVal = defaultMatch[2] ?? defaultMatch[3];
          }
          // Extract type=...
          const typeMatch = rest.match(/type\s*=\s*(\w+)/);
          if (typeMatch) {
            spec.type = typeMatch[1];
          }
          specs.push(spec);
        }
        return specs;
      } catch { return []; }
    };

    // ── Steps 1-4: Setup (skipped on resume from checkpoint) ──
    let argSpecs: ArgSpec[] = [];
    let knownArgs: string[] = [];
    const operationalArgNames = new Set(['cv_folds', 'folds', 'random_state', 'seed', 'verbose', 'output', 'data_path', 'data_dir', 'save_path', 'log_dir', 'n_jobs']);

    if (checkpoint) {
      argSpecs = checkpoint.argSpecs;
      knownArgs = checkpoint.knownArgs;
      reflectionInsights = checkpoint.reflectionInsights ?? '';
      outputChannel.appendLine(`Restored ${argSpecs.length} arg specs from checkpoint`);
      if (reflectionInsights) {
        outputChannel.appendLine(`Restored reflection insights from last round`);
      }
    } else {

    // ── Step 1: Ensure code exists ──
    if (generatedCode?.files?.length) {
      await writeCodeToProject(generatedCode);
    }

    const entrypointPath = path.join(context.projectRoot, entrypoint);
    let entrypointExists = false;
    try { await fs.access(entrypointPath); entrypointExists = true; } catch { /* */ }

    if (!entrypointExists) {
      context.progress?.(0, 'exp:0|Setup|generating code...|running');
      const genResponse = await context.llm.complete(
        [
          {
            role: 'user',
            content: `No code file "${entrypoint}" exists. Generate training/evaluation code for the research question.

Research question: ${question}

Generate a complete, runnable Python script that:
1. Defines a model/pipeline appropriate for the research question
2. Accepts ALL major model hyperparameters as argparse arguments (at least 5 model params: e.g. n_estimators, max_depth, min_samples_split, min_samples_leaf, max_features, criterion for tree models). Each must have a default, correct type (int/float/str), and choices= for categorical params. Do NOT only add operational params like --cv_folds.
3. Prints INTERMEDIATE progress as JSON lines during training (e.g. per-fold or per-epoch): {"epoch": 1, "train_loss": 0.5, "val_loss": 0.4}
4. Prints FINAL metrics as the LAST JSON line on stdout: {"metric_name": value, ...}
5. Include multiple evaluation metrics (accuracy, f1, precision, recall, etc.) — not just one
6. Uses a built-in or synthetic dataset if no data is available locally
7. Keeps it simple — prefer scikit-learn over complex frameworks

Respond in JSON: {
  "files": [{ "path": string, "content": string }],
  "entrypoint": string,
  "command_template": string,
  "requirements": string[]
}`,
          },
        ],
        { temperature: 0.3, responseFormat: 'json' },
      );

      try {
        const generated = JSON.parse(genResponse.content);
        if (generated.files?.length) {
          generatedCode = generated;
          await writeCodeToProject(generatedCode!);
          context.progress?.(0, `exp:0|Setup|generated ${generated.files.length} file(s)|completed`);
        }
      } catch {
        context.progress?.(0, 'exp:0|Setup|code generation failed|failed');
      }
    }

    // ── Step 2: Install dependencies ──
    context.progress?.(0, 'exp:0|Setup|installing dependencies...|running');
    try {
      await runner.installDeps(context.projectRoot, context.signal);
      context.progress?.(0, 'exp:0|Setup|dependencies installed|completed');
    } catch (err) {
      context.progress?.(0, `exp:0|Setup|pip install failed: ${err instanceof Error ? err.message : err}|failed`);
    }

    // ── Step 3: Validate code (run with no hyperparameters, fix until it works) ──
    const debugLogPath = path.join(context.workspacePath, 'sessions', context.sessionId, 'validation-debug.log');
    await fs.mkdir(path.dirname(debugLogPath), { recursive: true });
    const debugLog = async (msg: string) => {
      const ts = new Date().toISOString();
      await fs.appendFile(debugLogPath, `[${ts}] ${msg}\n`, 'utf-8');
    };

    let validationPassed = false;
    {
      const maxFixAttempts = 3;
      const maxRegenCycles = 3;
      const errorHistory: string[] = [];
      let totalAttempts = 0;

      for (let cycle = 0; cycle < maxRegenCycles && !validationPassed; cycle++) {
        for (let fix = 0; fix < maxFixAttempts && !validationPassed; fix++) {
          totalAttempts++;
          // Validation runs with NO hyperparameters — just check the script starts and outputs JSON
          const { command: valCmd, args: valArgs } = buildCommand(commandTemplate, entrypoint, {});
          const resolvedValCmd = valCmd === 'python' || valCmd === 'python3' ? python : valCmd;

          context.progress?.(0, `exp:0|Validation|attempt ${totalAttempts} (cycle ${cycle + 1})...|running`);
          await debugLog(`=== Validation attempt ${totalAttempts} (cycle ${cycle + 1}, fix ${fix + 1}) ===`);
          await debugLog(`Command: ${resolvedValCmd} ${valArgs.join(' ')}`);
          await debugLog(`CWD: ${context.projectRoot}`);
          outputChannel.appendLine(`\n${'='.repeat(60)}`);
          outputChannel.appendLine(`VALIDATION ATTEMPT ${totalAttempts} (cycle ${cycle + 1}, fix ${fix + 1})`);
          outputChannel.appendLine(`Command: ${resolvedValCmd} ${valArgs.join(' ')}`);
          outputChannel.appendLine(`CWD: ${context.projectRoot}`);
          outputChannel.appendLine('='.repeat(60));

          const valResult = await runner.run({
            command: resolvedValCmd,
            args: valArgs,
            cwd: context.projectRoot,
            env: {},
            timeout: 300_000,
            signal: context.signal,
          });

          await debugLog(`Exit code: ${valResult.exitCode}`);
          await debugLog(`Status: ${valResult.status}`);
          await debugLog(`Metrics: ${JSON.stringify(valResult.metrics)}`);
          await debugLog(`--- FULL OUTPUT ---\n${valResult.logs}\n--- END OUTPUT ---`);
          outputChannel.appendLine(`Exit code: ${valResult.exitCode} | Status: ${valResult.status}`);
          outputChannel.appendLine(`Metrics found: ${JSON.stringify(valResult.metrics)}`);
          outputChannel.appendLine(`--- OUTPUT ---`);
          outputChannel.appendLine(valResult.logs);
          outputChannel.appendLine(`--- END ---`);

          if (valResult.status === 'completed' && Object.keys(valResult.metrics).length > 0) {
            context.progress?.(0, `exp:0|Validation|code works (attempt ${totalAttempts})|completed`);
            await debugLog(`SUCCESS on attempt ${totalAttempts}`);
            outputChannel.appendLine(`>>> SUCCESS on attempt ${totalAttempts}`);
            validationPassed = true;
            break;
          }

          const errorSnippet = valResult.logs.slice(-2000);
          errorHistory.push(`Attempt ${totalAttempts}: ${errorSnippet.slice(0, 500)}`);
          const errorLines = valResult.logs.split('\n').filter(l => l.trim());
          const lastError = errorLines.slice(-3).join(' | ').slice(0, 200);
          context.progress?.(0, `exp:0|Validation|attempt ${totalAttempts} CRASHED: ${lastError}|failed`);
          await debugLog(`CRASHED — last error: ${lastError}`);
          outputChannel.appendLine(`>>> CRASHED: ${lastError}`);
          outputChannel.show(true);

          if (generatedCode?.files?.length) {
            context.progress?.(0, `exp:0|Validation|fixing attempt ${totalAttempts}...|running`);
            const fileSources = generatedCode.files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
            const fixResponse = await context.llm.complete(
              [{ role: 'user', content: `The Python code crashed. This is attempt ${totalAttempts} to fix it.

Command: ${resolvedValCmd} ${valArgs.join(' ')}
Working directory: ${context.projectRoot}

Error output:
${errorSnippet}

${errorHistory.length > 1 ? `Previous errors (do NOT repeat the same mistakes):\n${errorHistory.slice(0, -1).join('\n')}\n` : ''}
Current code:
${fileSources}

Fix ALL issues. The script MUST:
1. Run without errors when called with NO arguments (use argparse defaults)
2. Print INTERMEDIATE progress as JSON lines during training: {"fold": 1, "train_acc": 0.9, "val_acc": 0.85}
3. Print FINAL metrics as the LAST JSON line of stdout: {"accuracy": value, "f1_score": value, "precision": value, ...}
4. Use only standard/pip-installable libraries
5. Handle missing data by generating synthetic data if needed
6. Parse command-line arguments as the correct types (int, float, str) with sensible defaults

Respond in JSON: { "files": [{ "path": string, "content": string }], "explanation": string }` }],
              { temperature: 0.2, responseFormat: 'json' },
            );
            try {
              const fixed = JSON.parse(fixResponse.content);
              if (fixed.files?.length) {
                generatedCode = { ...generatedCode, files: fixed.files };
                await writeCodeToProject(generatedCode);
              }
            } catch { /* */ }
          }
        }

        if (validationPassed) { break; }

        context.progress?.(0, `exp:0|Validation|fixes failed — regenerating from scratch (cycle ${cycle + 2})...|running`);
        const regenResponse = await context.llm.complete(
          [{ role: 'user', content: `Previous code generation failed ${totalAttempts} times. Write a COMPLETELY NEW, SIMPLE, and ROBUST Python script from scratch.

Research question: ${question}

Previous errors encountered (AVOID these):
${errorHistory.slice(-3).join('\n')}

REQUIREMENTS — the script MUST:
1. Be as simple as possible — prefer scikit-learn or basic PyTorch over complex frameworks
2. Accept ALL major MODEL hyperparameters as argparse arguments (at least 5 model params, not just cv_folds — e.g. n_estimators, max_depth, min_samples_split, max_features, criterion). Each must have a default, correct type (int/float/str), and choices= for categorical params.
3. If data is not available locally, generate synthetic data or use a built-in dataset (e.g. sklearn.datasets)
4. Print INTERMEDIATE progress as JSON lines during training (per-fold/per-epoch): {"fold": 1, "train_acc": 0.9, "val_acc": 0.85}
5. Print FINAL metrics as the LAST JSON line: {"accuracy": float, "f1_score": float, "precision": float, "recall": float, ...}
6. Include MULTIPLE evaluation metrics — not just one
7. Handle type casting in argparse (int, float, str) — do NOT assume all args are strings
8. Keep it under 150 lines — simpler code breaks less
9. MUST work when called with NO arguments (all argparse args must have defaults)

Respond in JSON: {
  "files": [{ "path": string, "content": string }],
  "entrypoint": string,
  "command_template": string,
  "requirements": string[]
}` }],
          { temperature: 0.4, responseFormat: 'json' },
        );
        try {
          const regen = JSON.parse(regenResponse.content);
          if (regen.files?.length) {
            generatedCode = regen;
            await writeCodeToProject(generatedCode!);
            try { await runner.installDeps(context.projectRoot, context.signal); } catch { /* */ }
          }
        } catch { /* */ }
      }
    }

    if (!validationPassed) {
      context.progress?.(0, 'exp:0|Validation|all attempts exhausted|failed');
      return {
        data: { experimentResults: [], experimentDesigns: [], experiments: [] },
        artifacts: [],
        summary: 'Validation failed after all fix and regeneration attempts — no experiments were run.',
        metrics: { total: 0, completed: 0, bestValue: -Infinity },
      };
    }

    // ── Step 4: Read the script's CLI arguments ──
    argSpecs = await readArgSpecs();
    knownArgs = argSpecs.map(a => a.name);
    const argDescription = argSpecs.map(a => {
      let desc = `--${a.name}`;
      if (a.type) { desc += ` (${a.type})`; }
      if (a.choices?.length) { desc += ` choices: [${a.choices.join(', ')}]`; }
      if (a.defaultVal !== undefined) { desc += ` default: ${a.defaultVal}`; }
      return desc;
    }).join('\n  ');
    outputChannel.appendLine(`\nKnown script arguments:\n  ${argDescription || '(none found)'}`);

    // Auto-enrich: if script has too few tuneable model hyperparameters, ask LLM to add more
    const tuneableArgCount = argSpecs.filter(a => !operationalArgNames.has(a.name)).length;
    if (tuneableArgCount < 3 && generatedCode?.files?.length) {
      outputChannel.appendLine(`Only ${tuneableArgCount} tuneable hyperparameter(s) — enriching script with model hyperparameters...`);
      context.progress?.(0, 'exp:0|Setup|adding model hyperparameters to script...|running');
      const scriptPath = path.join(context.projectRoot, entrypoint);
      try {
        const originalScript = await fs.readFile(scriptPath, 'utf-8');
        const enrichResp = await context.llm.complete(
          [{ role: 'user', content: `This training script only accepts these arguments: ${argSpecs.map(a => '--' + a.name).join(', ') || '(none)'}.

For hyperparameter tuning, it needs MORE tuneable model hyperparameters as argparse arguments.

Current script:
\`\`\`python
${originalScript}
\`\`\`

Add argparse arguments for ALL major hyperparameters of the model/algorithm in this script:
- For tree models (RandomForest, GradientBoosting, etc.): n_estimators, max_depth, min_samples_split, min_samples_leaf, max_features, criterion
- For neural networks: learning_rate, hidden_size, num_layers, dropout, weight_decay
- For SVM: C, kernel, gamma
- Add 5-8 of the most impactful hyperparameters for whatever model is used.

Each argument MUST have a default value, correct type (int/float/str), and choices= for categorical params.
USE these arguments in the model instantiation (replace hardcoded values).
Keep everything else IDENTICAL — same output format, same metrics, same logic.

Respond in JSON: { "content": "the full modified Python script" }` }],
          { temperature: 0.2, responseFormat: 'json' },
        );
        const enriched = JSON.parse(enrichResp.content);
        if (enriched.content) {
          await fs.writeFile(scriptPath, enriched.content, 'utf-8');
          const { command: vc, args: va } = buildCommand(commandTemplate, entrypoint, {});
          const rc = vc === 'python' || vc === 'python3' ? python : vc;
          const vr = await runner.run({ command: rc, args: va, cwd: context.projectRoot, env: {}, timeout: 300_000, signal: context.signal });
          if (vr.status === 'completed' && Object.keys(vr.metrics).length > 0) {
            argSpecs = await readArgSpecs();
            knownArgs = argSpecs.map(a => a.name);
            outputChannel.appendLine(`Enriched: ${argSpecs.length} args — ${knownArgs.join(', ')}`);
            context.progress?.(0, `exp:0|Setup|${argSpecs.length} hyperparameters available|completed`);
            const mf = generatedCode.files.find(f => f.path === entrypoint);
            if (mf) { mf.content = enriched.content; }
          } else {
            outputChannel.appendLine('Enriched script failed validation — reverting');
            await fs.writeFile(scriptPath, originalScript, 'utf-8');
          }
        }
      } catch (err) {
        outputChannel.appendLine(`Enrichment failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    } // end of if (!checkpoint) — setup steps 1-4

    // Run a single experiment design and return the Experiment object
    const runOne = async (design: ExperimentDesign, index: number): Promise<Experiment> => {
      const num = index + 1;
      const name = design.name ?? `Experiment ${num}`;
      const hyperparams = (design.hyperparameters ?? {}) as Record<string, unknown>;

      context.progress?.(
        Math.round(num / maxExperiments * 100),
        `exp:${num}|${name}|running...|running`,
      );

      const startedAt = Date.now();
      const { command, args } = buildCommand(commandTemplate, entrypoint, hyperparams);
      const resolvedCommand = command === 'python' || command === 'python3' ? python : command;

      outputChannel.appendLine(`\n--- EXPERIMENT #${num} "${name}" ---`);
      outputChannel.appendLine(`Command: ${resolvedCommand} ${args.join(' ')}`);
      outputChannel.appendLine(`Hyperparameters: ${JSON.stringify(hyperparams)}`);

      const result: RunResult = await runner.run({
        command: resolvedCommand,
        args,
        cwd: context.projectRoot,
        env: {},
        timeout: design.timeout ?? 300_000,
        signal: context.signal,
      });

      const completedAt = Date.now();

      // Capture intermediate metrics (all JSON lines, not just the last one)
      const intermediate = parseAllMetrics(result.logs);
      allIntermediateMetrics[index] = intermediate;

      outputChannel.appendLine(`Exit code: ${result.exitCode} | Status: ${result.status}`);
      outputChannel.appendLine(`Final metrics: ${JSON.stringify(result.metrics)}`);
      if (intermediate.length > 1) {
        outputChannel.appendLine(`Intermediate progress (${intermediate.length} checkpoints):`);
        for (const m of intermediate.slice(0, 5)) {
          outputChannel.appendLine(`  ${JSON.stringify(m)}`);
        }
        if (intermediate.length > 5) {
          outputChannel.appendLine(`  ... and ${intermediate.length - 5} more`);
        }
      }

      return {
        id: `exp-${startedAt}-${index}`,
        sessionId: '',
        name,
        description: `${design.hypothesis ?? ''}\n\nMethod: ${design.method ?? ''}\n\nExpected: ${design.expectedResults ?? ''}`,
        status: result.status,
        config: {
          command: resolvedCommand,
          args,
          env: {},
          workingDirectory: context.projectRoot,
        },
        runner: runnerType,
        startedAt,
        completedAt,
        metrics: result.metrics,
        logs: result.logs,
        artifacts: [],
        basedOnPapers: [],
      };
    };

    // Helper: report experiment progress
    const reportProgress = (exp: Experiment) => {
      const num = allExperiments.indexOf(exp) + 1;
      const pct = Math.round(num / maxExperiments * 100);

      if (exp.status === 'failed') {
        const errLines = (exp.logs ?? '').split('\n').filter(l => l.trim());
        const lastErr = errLines.slice(-2).join(' | ').slice(0, 150);
        context.progress?.(pct, `exp:${num}|${exp.name}|CRASHED: ${lastErr}|failed`);
        outputChannel.appendLine(`>>> EXPERIMENT #${num} "${exp.name}" CRASHED <<<`);
        outputChannel.appendLine(exp.logs ?? '(no logs)');
        outputChannel.show(true);
        return false;
      }

      if (primaryMetric) {
        const val = exp.metrics[primaryMetric] ?? -Infinity;
        const isImproved = val > bestMetricValue;
        if (isImproved) { bestMetricValue = val; }
        const marker = isImproved ? '✓' : '✗';
        context.progress?.(pct, `exp:${num}|${exp.name}|${marker} ${primaryMetric}=${val.toFixed(4)}|completed`);
        return isImproved;
      }

      context.progress?.(pct, `exp:${num}|${exp.name}|completed (no metrics)|completed`);
      return false;
    };

    // ── Step 5: Iterative experiment loop — ONE at a time, each informed by previous results ──

    while (noImproveCount < maxNoImprove && allExperiments.length < maxExperiments) {
      const nextNum = allExperiments.length + 1;
      context.progress?.(
        Math.round(allExperiments.length / maxExperiments * 100),
        `exp:${nextNum}|Designing #${nextNum}...|designing...|running`,
      );

      const previousSummary = allExperiments.length === 0
        ? 'No experiments have been run yet. Design the FIRST experiment as a baseline with reasonable default hyperparameters.'
        : allExperiments.map((e, i) => {
            const hp = extractHyperparams(e);
            const hpStr = Object.keys(hp).length > 0 ? JSON.stringify(hp) : 'defaults (no hyperparameters set)';
            // Show ALL metrics, not just the primary one
            const allMetricsStr = Object.keys(e.metrics).length > 0
              ? Object.entries(e.metrics).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`).join(', ')
              : 'no metrics';
            let line = `#${i + 1} "${e.name}" [${e.status}] — metrics: {${allMetricsStr}} — hyperparameters: ${hpStr}`;
            // Include intermediate metrics summary (training dynamics)
            const intermediate = allIntermediateMetrics[i];
            if (intermediate && intermediate.length > 1) {
              const first = intermediate[0];
              const last = intermediate[intermediate.length - 1];
              const progressKeys = Object.keys(first).filter(k => k in last);
              if (progressKeys.length > 0) {
                const dynamics = progressKeys.map(k => {
                  const start = first[k];
                  const end = last[k];
                  const trend = end > start ? '↑' : end < start ? '↓' : '→';
                  return `${k}: ${start.toFixed(3)}${trend}${end.toFixed(3)}`;
                }).join(', ');
                line += ` — training progress (${intermediate.length} steps): ${dynamics}`;
              }
            }
            if (e.status === 'failed') {
              const errLines = (e.logs ?? '').split('\n').filter(l => l.trim());
              const errMsg = errLines.slice(-3).join(' | ').slice(0, 300);
              line += ` — ERROR: ${errMsg}`;
            }
            return line;
          }).join('\n');

      // Build per-arg spec for the prompt with choices/defaults
      const argSpecPrompt = argSpecs.length > 0
        ? argSpecs.map(a => {
            let line = `  --${a.name}`;
            if (a.choices?.length) { line += `: must be one of [${a.choices.map(c => `"${c}"`).join(', ')}]`; }
            else if (a.type) { line += `: ${a.type}`; }
            if (a.defaultVal !== undefined) { line += ` (default: ${a.defaultVal})`; }
            return line;
          }).join('\n')
        : '  (unknown — try common ML hyperparameters)';

      // Build a strategy prompt based on how many experiments have run
      let strategyPrompt: string;
      if (allExperiments.length === 0) {
        strategyPrompt = `This is the FIRST experiment. Use reasonable default values for all hyperparameters to establish a baseline. Do NOT try anything exotic — just run the script with sensible defaults so we have a reference point.`;
      } else if (allExperiments.length === 1) {
        strategyPrompt = `We have 1 baseline result. Now change EXACTLY ONE hyperparameter to understand its effect in isolation. Pick the hyperparameter you think is most likely to impact ${primaryMetric || 'the primary metric'}. Explain your reasoning.`;
      } else {
        // Analyze trends from previous experiments
        const successfulExps = allExperiments.filter(e => e.status === 'completed' && primaryMetric && e.metrics[primaryMetric] !== undefined);
        let trendAnalysis = '';
        if (successfulExps.length >= 2) {
          const sorted = [...successfulExps].sort((a, b) => (b.metrics[primaryMetric] ?? 0) - (a.metrics[primaryMetric] ?? 0));
          const bestExp = sorted[0];
          const worstExp = sorted[sorted.length - 1];
          const bestHp = extractHyperparams(bestExp);
          const worstHp = extractHyperparams(worstExp);
          const diffs: string[] = [];
          for (const key of new Set([...Object.keys(bestHp), ...Object.keys(worstHp)])) {
            if (bestHp[key] !== worstHp[key]) {
              diffs.push(`  ${key}: best=${bestHp[key] ?? 'default'} vs worst=${worstHp[key] ?? 'default'}`);
            }
          }
          if (diffs.length > 0) {
            trendAnalysis = `\nKey differences between best and worst experiments:\n${diffs.join('\n')}\n`;
          }
        }

        const tuneableParamNames = knownArgs.filter(a => !operationalArgNames.has(a));
        strategyPrompt = `We have ${allExperiments.length} experiment(s). Apply SYSTEMATIC hyperparameter search:
${trendAnalysis}
Available tuneable hyperparameters: ${tuneableParamNames.join(', ')}

STRATEGY — DIVERSITY IS CRITICAL:
1. EXPLORE DIFFERENT parameters — do NOT keep changing the same parameter repeatedly.
   If you changed n_estimators in the last experiment, change max_depth or min_samples_split this time.
   Cycle through ALL available hyperparameters before revisiting one you already tried.
2. If a parameter change IMPROVED the metric, note the good value for later combinations. If it HURT, revert it.
3. After each tuneable parameter has been explored individually, combine the best values found so far.
4. Change AT MOST 2 hyperparameters at once — changing everything makes it impossible to know what worked.
5. Do NOT repeat a combination that was already tried.
6. Use DESCRIPTIVE experiment names reflecting WHAT you're changing (e.g. "Deeper Trees" or "Entropy Split" — NOT "More Trees III").

Explain your reasoning: which parameter you chose, WHY you picked this one (not one already tried), and what value you expect to help.`;
      }

      const response = await context.llm.complete(
        [
          {
            role: 'user',
            content: `${context.userSkills ? context.userSkills + '\n\n' : ''}You are an expert ML experiment designer performing systematic hyperparameter optimization.

Research question: ${question}
Primary metric to optimize: ${primaryMetric || '(will be determined by first successful experiment)'} ${primaryMetric ? '(HIGHER is better — maximize it)' : ''}
Best value so far: ${bestMetricValue === -Infinity ? 'none yet' : bestMetricValue.toFixed(6)}
${paperInsights ? `\n--- INSIGHTS FROM RESEARCH PAPERS ---\nUse these findings to guide your hyperparameter choices:\n${paperInsights}\n--- END PAPER INSIGHTS ---\n` : ''}${reflectionInsights ? `\n--- REFLECTION FROM PREVIOUS ROUND ---\n${reflectionInsights}\n--- END REFLECTION ---\n` : ''}
The script "${entrypoint}" accepts these arguments:
${argSpecPrompt}

Previous experiments and results:
${previousSummary}

${strategyPrompt}

CRITICAL RULES:
- "hyperparameters" MUST be a non-empty object with concrete key-value pairs
- Each key MUST be one of: ${knownArgs.join(', ')}
- Values with choices MUST use one of the allowed values listed above
- Numeric values MUST be concrete numbers, NOT ranges or descriptions
- Use insights from research papers above to inform your parameter choices (e.g., if papers recommend specific learning rates or architectures, try those)
${allExperiments.some(e => e.status === 'failed') ? '- Some experiments crashed — read the ERROR messages above and avoid the same mistakes\n' : ''}
Respond in JSON: { "experiments": [{ "name": string (2-4 words), "hypothesis": string, "method": string, "hyperparameters": { ${argSpecs.map(a => a.choices?.length ? `"${a.name}": "${a.choices[0]}"` : `"${a.name}": "<value>"`).join(', ')} }, "metrics": string[], "expectedResults": string, "estimatedDuration": string }] }`,
          },
        ],
        { temperature: 0.4, responseFormat: 'json' },
      );

      let newDesign: ExperimentDesign | null = null;
      try {
        const parsed = JSON.parse(response.content);
        const designs = parsed.experiments ?? [];
        if (designs.length > 0 && designs[0].hyperparameters && Object.keys(designs[0].hyperparameters).length > 0) {
          newDesign = designs[0];
        }
      } catch {
        break;
      }
      if (!newDesign) {
        outputChannel.appendLine(`>>> LLM returned empty hyperparameters for experiment #${nextNum} — stopping.`);
        break;
      }

      const exp = await runOne(newDesign, allExperiments.length);
      allExperiments.push(exp);

      if (!primaryMetric && exp.status === 'completed' && Object.keys(exp.metrics).length > 0) {
        primaryMetric = Object.keys(exp.metrics)[0];
      }

      const improved = reportProgress(exp);

      if (allExperiments.length === 1) {
        noImproveCount = 0;
      } else if (improved) {
        noImproveCount = 0;
      } else {
        noImproveCount++;
      }

      // ── Checkpoint after each experiment ──
      await saveCheckpoint(context.workspacePath, context.sessionId, {
        sessionId: context.sessionId,
        allExperiments,
        allIntermediateMetrics,
        bestMetricValue,
        primaryMetric,
        noImproveCount,
        knownArgs,
        argSpecs,
        reflectionInsights,
        entrypoint,
        commandTemplate: commandTemplate ?? null,
        maxExperiments,
        maxNoImprove,
        stoppedAt: new Date().toISOString(),
        stopReason: noImproveCount >= maxNoImprove ? 'maxNoImprove'
          : allExperiments.length >= maxExperiments ? 'maxExperiments'
          : 'user_stop',
      });

      // ── Reflection step — LLM analyzes results before designing next experiment ──
      if (noImproveCount < maxNoImprove && allExperiments.length < maxExperiments) {
        context.progress?.(
          Math.round(allExperiments.length / maxExperiments * 100),
          `exp:${allExperiments.length}|Reflecting...|analyzing results|running`,
        );

        const completedExps = allExperiments.filter(e => e.status === 'completed' && Object.keys(e.metrics).length > 0);
        if (completedExps.length >= 1) {
          const expTable = completedExps.map((e, i) => {
            const hp = extractHyperparams(e);
            const metricsStr = Object.entries(e.metrics).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`).join(', ');
            return `  #${i + 1} "${e.name}": ${metricsStr} | params: ${JSON.stringify(hp)}`;
          }).join('\n');

          try {
            const reflectionResp = await context.llm.complete(
              [{
                role: 'user',
                content: `${context.userSkills ? context.userSkills + '\n\n' : ''}You are an ML experiment analyst. Analyze the results so far and provide actionable insights for the next experiment.

Research question: ${question}
Primary metric: ${primaryMetric || '(unknown)'} (higher is better)
Best value: ${bestMetricValue === -Infinity ? 'N/A' : bestMetricValue.toFixed(6)}
Experiments without improvement: ${noImproveCount}/${maxNoImprove}

Results so far:
${expTable}

Available hyperparameters: ${knownArgs.filter(a => !operationalArgNames.has(a)).join(', ')}

Provide a SHORT analysis (3-5 sentences):
1. What pattern do you see in the results? Which parameters had the most impact?
2. Are we hitting diminishing returns on any parameter?
3. What specific parameter + value combination should we try next and WHY?
4. Is there an interaction between parameters worth exploring?

Be concrete — name parameters and values. No generic advice.`,
              }],
              { temperature: 0.3 },
            );
            reflectionInsights = reflectionResp.content;
            outputChannel.appendLine(`\n--- REFLECTION after experiment #${allExperiments.length} ---`);
            outputChannel.appendLine(reflectionInsights);
            outputChannel.appendLine('--- END REFLECTION ---\n');
          } catch {
            reflectionInsights = '';
          }
        }

        // Restore the experiment's completed status in the tree view.
        // The reflection progress event above overwrote sub-item #N with
        // "Reflecting... | analyzing results | running". Now that reflection
        // is done, re-emit the experiment's actual result so the tree view
        // shows the green checkmark instead of a perpetual spinner.
        const expNum = allExperiments.indexOf(exp) + 1;
        const expPct = Math.round(expNum / maxExperiments * 100);
        if (exp.status === 'failed') {
          const errLines = (exp.logs ?? '').split('\n').filter(l => l.trim());
          const lastErr = errLines.slice(-2).join(' | ').slice(0, 150);
          context.progress?.(expPct, `exp:${expNum}|${exp.name}|CRASHED: ${lastErr}|failed`);
        } else if (primaryMetric) {
          const val = exp.metrics[primaryMetric] ?? -Infinity;
          const marker = improved ? '✓' : '✗';
          context.progress?.(expPct, `exp:${expNum}|${exp.name}|${marker} ${primaryMetric}=${val.toFixed(4)}|completed`);
        } else {
          context.progress?.(expPct, `exp:${expNum}|${exp.name}|completed (no metrics)|completed`);
        }
      }
    }

    // ── Step 6: Write recap ──
    const recap = {
      sessionId: context.sessionId,
      primaryMetric,
      bestValue: bestMetricValue,
      totalExperiments: allExperiments.length,
      maxExperiments,
      noImproveStreak: noImproveCount,
      experiments: allExperiments.map((exp, i) => {
        const val = exp.metrics[primaryMetric] ?? 0;
        const prevBest = allExperiments.slice(0, i).reduce(
          (best, e) => Math.max(best, e.metrics[primaryMetric] ?? -Infinity), -Infinity,
        );
        return {
          number: i + 1,
          name: exp.name,
          status: exp.status,
          hyperparameters: extractHyperparams(exp),
          explanation: exp.description.split('\n')[0],
          results: exp.metrics,
          kept: i === 0 || val > prevBest,
        };
      }),
      completedAt: new Date().toISOString(),
    };
    const recapDir = path.join(context.workspacePath, 'sessions', context.sessionId);
    await fs.mkdir(recapDir, { recursive: true });
    await fs.writeFile(
      path.join(recapDir, 'experiments-recap.json'),
      JSON.stringify(recap, null, 2),
      'utf-8',
    );

    if (generatedCode?.files?.length) {
      await writeCodeToProject(generatedCode);
    }

    return {
      data: {
        experimentResults: allExperiments,
        experimentDesigns: [],
        experiments: allExperiments,
      },
      artifacts: [],
      summary: `${allExperiments.length}/${maxExperiments} experiments completed (${noImproveCount} consecutive no-improve). Best ${primaryMetric || 'metric'}: ${bestMetricValue === -Infinity ? 'N/A' : bestMetricValue}`,
      metrics: { total: allExperiments.length, completed: allExperiments.filter(e => e.status === 'completed').length, bestValue: bestMetricValue },
    };
  }
}

interface ExperimentDesign {
  name?: string;
  hypothesis?: string;
  method?: string;
  hyperparameters?: Record<string, unknown>;
  metrics?: string[];
  expectedResults?: string;
  estimatedDuration?: string;
  suggestedLiterature?: string[];
  timeout?: number;
}

interface GeneratedCode {
  files: { path: string; content: string }[];
  entrypoint: string;
  command_template: string;
  requirements: string[];
}
