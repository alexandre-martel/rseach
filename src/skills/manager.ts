import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Skill, SkillCategory, SkillScope } from './types';

const SKILLS_FILE = 'skills.json';

export class SkillsManager {
  private globalPath: string;
  private workspacePath: string | null;
  private skills: Skill[] = [];

  constructor(globalPath: string, workspacePath: string | null) {
    this.globalPath = path.join(globalPath, SKILLS_FILE);
    this.workspacePath = workspacePath
      ? path.join(workspacePath, '.researchloop', SKILLS_FILE)
      : null;
  }

  async loadAll(): Promise<Skill[]> {
    const [global, workspace] = await Promise.all([
      this.readFile(this.globalPath, 'global'),
      this.workspacePath ? this.readFile(this.workspacePath, 'workspace') : [],
    ]);
    this.skills = [...global, ...workspace];
    return this.skills;
  }

  getAll(): Skill[] {
    return this.skills;
  }

  getForCategory(category: SkillCategory): Skill[] {
    return this.skills.filter(
      s => s.enabled && (s.category === category || s.category === 'general'),
    );
  }

  formatForPrompt(category?: SkillCategory): string {
    const relevant = category
      ? this.getForCategory(category)
      : this.skills.filter(s => s.enabled);
    if (relevant.length === 0) { return ''; }
    const lines = relevant.map(s => `- ${s.instruction}`);
    return `USER INSTRUCTIONS:\n${lines.join('\n')}`;
  }

  async add(
    name: string,
    instruction: string,
    category: SkillCategory,
    scope: SkillScope,
  ): Promise<Skill> {
    const skill: Skill = {
      id: randomUUID(),
      name,
      instruction,
      category,
      enabled: true,
      scope,
      createdAt: new Date().toISOString(),
    };
    this.skills.push(skill);
    await this.persist(scope);
    return skill;
  }

  async update(id: string, changes: Partial<Pick<Skill, 'name' | 'instruction' | 'category' | 'enabled'>>): Promise<Skill | null> {
    const skill = this.skills.find(s => s.id === id);
    if (!skill) { return null; }
    Object.assign(skill, changes);
    await this.persist(skill.scope);
    return skill;
  }

  async toggle(id: string): Promise<Skill | null> {
    const skill = this.skills.find(s => s.id === id);
    if (!skill) { return null; }
    skill.enabled = !skill.enabled;
    await this.persist(skill.scope);
    return skill;
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.skills.findIndex(s => s.id === id);
    if (idx === -1) { return false; }
    const scope = this.skills[idx].scope;
    this.skills.splice(idx, 1);
    await this.persist(scope);
    return true;
  }

  private async persist(scope: SkillScope): Promise<void> {
    const filtered = this.skills.filter(s => s.scope === scope);
    const filePath = scope === 'global' ? this.globalPath : this.workspacePath;
    if (!filePath) { return; }
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
  }

  private async readFile(filePath: string, scope: SkillScope): Promise<Skill[]> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Skill[];
      return parsed.map(s => ({ ...s, scope }));
    } catch {
      return [];
    }
  }
}
