import type { IResearchModule as PipelineModule, ModuleRegistry as PipelineModuleRegistry, ModuleContext as PipelineContext } from './types';
import type { StepInput, StepOutput } from './types';
import type { IResearchModule } from '../modules/types';
import type { ModuleContext } from '../modules/types';
import type { ILLMService } from '../modules/types';
import type { ModuleRegistry } from '../modules/registry';

/**
 * Adapts a modules/IResearchModule to the pipeline engine's IResearchModule
 * interface by bridging the different ModuleContext shapes.
 */
class ModuleAdapter implements PipelineModule {
  constructor(
    private readonly inner: IResearchModule,
    private readonly llmService: ILLMService,
    private readonly moduleConfig: Record<string, unknown>,
    private readonly workspacePath: string,
    private readonly projectRoot: string,
  ) {}

  async executeStep(
    stepId: string,
    input: StepInput,
    context: PipelineContext,
  ): Promise<StepOutput> {
    const moduleContext: ModuleContext = {
      sessionId: context.sessionId,
      llm: this.llmService,
      config: this.moduleConfig,
      signal: context.abortSignal,
      workspacePath: this.workspacePath,
      projectRoot: this.projectRoot,
      progress: context.progress,
    };
    // Use moduleStepId from config if available, otherwise fall back to pipeline stepId
    const moduleStepId = (input.data.moduleStepId as string) ?? stepId;
    return this.inner.executeStep(moduleStepId, input, moduleContext);
  }
}

/**
 * Adapts the modules/ModuleRegistry to the pipeline engine's ModuleRegistry
 * interface. Each module is wrapped with an adapter that provides the LLM
 * service and config the module expects.
 */
export class PipelineModuleRegistryAdapter implements PipelineModuleRegistry {
  constructor(
    private readonly moduleRegistry: ModuleRegistry,
    private readonly llmService: ILLMService,
    private readonly configProvider: (moduleId: string) => Record<string, unknown>,
    private readonly workspacePath: string = '',
    private readonly projectRoot: string = '',
  ) {}

  get(moduleId: string): PipelineModule | undefined {
    const mod = this.moduleRegistry.get(moduleId);
    if (!mod) { return undefined; }
    const config = this.configProvider(moduleId);
    return new ModuleAdapter(mod, this.llmService, config, this.workspacePath, this.projectRoot);
  }
}
