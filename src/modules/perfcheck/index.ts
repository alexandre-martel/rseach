import * as os from 'os';
import * as childProcess from 'child_process';
import {
  IResearchModule,
  ModuleMetadata,
  ModuleCapability,
  ModuleContext,
  StepDefinition,
  StepInput,
  StepOutput,
} from '../types';

const METADATA: ModuleMetadata = {
  id: 'perfcheck',
  name: 'Performance Check',
  version: '0.1.0',
  description: 'Quick hardware profiling of the current machine before running experiments.',
  capabilities: [ModuleCapability.ANALYZE],
  dependencies: [],
  configSchema: {},
};

const CHECK_STEP: StepDefinition = {
  id: 'check',
  name: 'Check Machine',
  description: 'Profile CPU, RAM, disk, and GPU availability.',
  inputs: [],
  outputs: ['machineProfile'],
};

export class PerfCheckModule implements IResearchModule {
  readonly metadata: ModuleMetadata = METADATA;

  getAvailableSteps(): StepDefinition[] {
    return [CHECK_STEP];
  }

  async executeStep(
    stepId: string,
    input: StepInput,
    context: ModuleContext,
  ): Promise<StepOutput> {
    if (stepId !== 'check') {
      throw new Error(`Unknown step "${stepId}" in perfcheck module`);
    }
    return this.checkMachine(context);
  }

  private async checkMachine(context: ModuleContext): Promise<StepOutput> {
    const cpus = os.cpus();
    const totalMemGB = +(os.totalmem() / 1073741824).toFixed(1);
    const freeMemGB = +(os.freemem() / 1073741824).toFixed(1);
    const cpuModel = cpus[0]?.model ?? 'unknown';
    const cpuCores = cpus.length;
    const platform = `${os.type()} ${os.release()} (${os.arch()})`;

    let gpuInfo = 'none detected';
    try {
      const out = childProcess.execSync('nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader,nounits', {
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();
      if (out) { gpuInfo = out; }
    } catch {
      try {
        const out = childProcess.execSync('rocm-smi --showid --showmeminfo vram', {
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        if (out) { gpuInfo = `AMD: ${out.substring(0, 200)}`; }
      } catch {
        // no GPU tools available
      }
    }

    let diskFreeGB = -1;
    try {
      if (os.platform() === 'win32') {
        const out = childProcess.execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value', {
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        const match = out.match(/FreeSpace=(\d+)/);
        if (match) { diskFreeGB = +(parseInt(match[1], 10) / 1073741824).toFixed(1); }
      } else {
        const out = childProcess.execSync("df -BG / | tail -1 | awk '{print $4}'", {
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();
        diskFreeGB = +(parseInt(out, 10));
      }
    } catch {
      // ignore
    }

    const profile = {
      platform,
      cpu: cpuModel,
      cpuCores,
      totalMemGB,
      freeMemGB,
      diskFreeGB,
      gpu: gpuInfo,
    };

    const lines = [
      `CPU: ${cpuModel} (${cpuCores} cores)`,
      `RAM: ${freeMemGB}/${totalMemGB} GB free`,
      diskFreeGB >= 0 ? `Disk: ${diskFreeGB} GB free` : 'Disk: unknown',
      `GPU: ${gpuInfo}`,
      `OS: ${platform}`,
    ];

    return {
      data: { machineProfile: profile },
      artifacts: [],
      summary: lines.join(' | '),
      metrics: {
        cpuCores,
        totalMemGB,
        freeMemGB,
        diskFreeGB,
        hasGpu: gpuInfo !== 'none detected' ? 1 : 0,
      },
    };
  }
}
