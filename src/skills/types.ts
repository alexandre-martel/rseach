export type SkillCategory = 'literature' | 'experiment' | 'analysis' | 'general';
export type SkillScope = 'global' | 'workspace';

export interface Skill {
  id: string;
  name: string;
  instruction: string;
  category: SkillCategory;
  enabled: boolean;
  scope: SkillScope;
  createdAt: string;
}
