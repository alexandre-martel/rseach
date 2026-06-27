import { IResearchModule } from './types';

/**
 * Registry that stores and retrieves research modules by their metadata ID.
 */
export class ModuleRegistry {
  private readonly modules = new Map<string, IResearchModule>();

  /**
   * Register a module. Throws if a module with the same ID is already registered.
   */
  register(module: IResearchModule): void {
    const id = module.metadata.id;
    if (this.modules.has(id)) {
      throw new Error(`Module "${id}" is already registered`);
    }
    this.modules.set(id, module);
  }

  /**
   * Unregister a module by ID. Returns true if the module was found and removed.
   */
  unregister(id: string): boolean {
    return this.modules.delete(id);
  }

  /**
   * Retrieve a module by ID, or undefined if not found.
   */
  get(id: string): IResearchModule | undefined {
    return this.modules.get(id);
  }

  /**
   * Retrieve a module by ID. Throws if not found.
   */
  getOrThrow(id: string): IResearchModule {
    const mod = this.modules.get(id);
    if (!mod) {
      throw new Error(`Module "${id}" is not registered`);
    }
    return mod;
  }

  /**
   * Returns all registered modules.
   */
  getAll(): IResearchModule[] {
    return Array.from(this.modules.values());
  }

  /**
   * Returns all registered module IDs.
   */
  getIds(): string[] {
    return Array.from(this.modules.keys());
  }

  /**
   * Check whether a module with the given ID is registered.
   */
  has(id: string): boolean {
    return this.modules.has(id);
  }

  /**
   * Remove all registered modules.
   */
  clear(): void {
    this.modules.clear();
  }
}
