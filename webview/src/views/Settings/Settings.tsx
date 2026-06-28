import React, { useState, useEffect } from 'react';
import { onMessage, postMessage } from '../../vscode';

interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  error?: string;
}

interface CustomSource {
  id: string;
  name: string;
  url: string;
}

interface Skill {
  id: string;
  name: string;
  instruction: string;
  category: 'literature' | 'experiment' | 'analysis' | 'general';
  enabled: boolean;
  scope: 'global' | 'workspace';
  createdAt: string;
}

const ARXIV_CATEGORIES = [
  { value: 'cs.LG', label: 'cs.LG — Machine Learning' },
  { value: 'cs.AI', label: 'cs.AI — Artificial Intelligence' },
  { value: 'cs.CV', label: 'cs.CV — Computer Vision' },
  { value: 'cs.CL', label: 'cs.CL — Computation & Language (NLP)' },
  { value: 'cs.RO', label: 'cs.RO — Robotics' },
  { value: 'cs.NE', label: 'cs.NE — Neural & Evolutionary Computing' },
  { value: 'cs.IR', label: 'cs.IR — Information Retrieval' },
  { value: 'cs.DS', label: 'cs.DS — Data Structures' },
  { value: 'cs.CR', label: 'cs.CR — Cryptography & Security' },
  { value: 'stat.ML', label: 'stat.ML — Statistics: Machine Learning' },
  { value: 'stat.ME', label: 'stat.ME — Statistics: Methodology' },
  { value: 'math.OC', label: 'math.OC — Optimization & Control' },
  { value: 'math.ST', label: 'math.ST — Statistics Theory' },
  { value: 'eess.SP', label: 'eess.SP — Signal Processing' },
  { value: 'eess.IV', label: 'eess.IV — Image & Video Processing' },
  { value: 'q-bio.QM', label: 'q-bio.QM — Quantitative Methods' },
  { value: 'physics.data-an', label: 'physics.data-an — Data Analysis' },
];

const SKILL_CATEGORIES = [
  { value: 'general', label: 'General' },
  { value: 'literature', label: 'Literature' },
  { value: 'experiment', label: 'Experiment' },
  { value: 'analysis', label: 'Analysis' },
] as const;

export function Settings() {
  const [activeProvider, setActiveProvider] = useState('ollama');
  const [providers, setProviders] = useState<ProviderStatus[]>([
    { id: 'ollama', name: 'Ollama (Local)', available: false },
    { id: 'claude', name: 'Anthropic Claude', available: false },
    { id: 'openai', name: 'OpenAI', available: false },
  ]);
  const [testing, setTesting] = useState<string | null>(null);

  // Sources
  const [builtinSources, setBuiltinSources] = useState<string[]>(['arxiv', 'semanticScholar', 'webSearch']);
  const [customSources, setCustomSources] = useState<CustomSource[]>([]);
  const [showAddSource, setShowAddSource] = useState(false);
  const [newSourceName, setNewSourceName] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');

  // Categories
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['cs.LG', 'cs.RO', 'cs.AI', 'stat.ML']);

  // Skills
  const [skills, setSkills] = useState<Skill[]>([]);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillInstruction, setNewSkillInstruction] = useState('');
  const [newSkillCategory, setNewSkillCategory] = useState<Skill['category']>('general');
  const [newSkillScope, setNewSkillScope] = useState<Skill['scope']>('workspace');

  useEffect(() => {
    onMessage((msg) => {
      if (msg.type === 'config:updated') {
        const payload = msg.payload as { activeProvider: string };
        setActiveProvider(payload.activeProvider);
      }
      if (msg.type === 'config:testResult') {
        const payload = msg.payload as { provider: string; available: boolean; error?: string };
        setProviders(prev => prev.map(p =>
          p.id === payload.provider ? { ...p, available: payload.available, error: payload.error } : p
        ));
        setTesting(null);
      }
      if (msg.type === 'sources:updated') {
        const payload = msg.payload as { builtin: string[]; custom: CustomSource[] };
        setBuiltinSources(payload.builtin);
        setCustomSources(payload.custom);
      }
      if (msg.type === 'categories:updated') {
        const payload = msg.payload as { categories: string[] };
        setSelectedCategories(payload.categories);
      }
      if (msg.type === 'skills:updated') {
        const payload = msg.payload as { skills: Skill[] };
        setSkills(payload.skills);
      }
    });
    postMessage('config:get');
    postMessage('sources:get');
    postMessage('categories:get');
    postMessage('skills:get');
  }, []);

  const testConnection = (providerId: string) => {
    setTesting(providerId);
    postMessage('config:testConnection', { provider: providerId });
  };

  const addCustomSource = () => {
    if (!newSourceName.trim() || !newSourceUrl.trim()) { return; }
    postMessage('sources:add', {
      id: newSourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: newSourceName.trim(),
      url: newSourceUrl.trim(),
    });
    setNewSourceName('');
    setNewSourceUrl('');
    setShowAddSource(false);
  };

  const removeCustomSource = (id: string) => {
    postMessage('sources:remove', { id });
  };

  const toggleCategory = (cat: string) => {
    const next = selectedCategories.includes(cat)
      ? selectedCategories.filter(c => c !== cat)
      : [...selectedCategories, cat];
    setSelectedCategories(next);
    postMessage('categories:set', { categories: next });
  };

  const addSkill = () => {
    if (!newSkillName.trim() || !newSkillInstruction.trim()) { return; }
    postMessage('skills:add', {
      name: newSkillName.trim(),
      instruction: newSkillInstruction.trim(),
      category: newSkillCategory,
      scope: newSkillScope,
    });
    setNewSkillName('');
    setNewSkillInstruction('');
    setNewSkillCategory('general');
    setShowAddSkill(false);
  };

  const toggleSkill = (id: string) => {
    postMessage('skills:toggle', { id });
  };

  const deleteSkill = (id: string) => {
    postMessage('skills:delete', { id });
  };

  return (
    <div>
      <h2 className="mb-24">ResearchLoop Settings</h2>

      {/* LLM Provider */}
      <div className="card mb-16">
        <h3 className="mb-16">LLM Provider</h3>
        {providers.map(provider => (
          <div key={provider.id} className="card mb-8" style={{
            borderColor: activeProvider === provider.id ? 'var(--vscode-focusBorder)' : undefined,
          }}>
            <div className="flex-between">
              <div>
                <strong>{provider.name}</strong>
                {provider.available && (
                  <span className="badge badge-success" style={{ marginLeft: 8 }}>Connected</span>
                )}
                {provider.error && (
                  <span className="badge badge-failed" style={{ marginLeft: 8 }}>{provider.error}</span>
                )}
              </div>
              <div className="flex">
                <button
                  className="secondary"
                  onClick={() => testConnection(provider.id)}
                  disabled={testing === provider.id}
                >
                  {testing === provider.id ? 'Testing...' : 'Test'}
                </button>
                {activeProvider !== provider.id && (
                  <button onClick={() => {
                    setActiveProvider(provider.id);
                    postMessage('config:setProvider', { provider: provider.id });
                  }}>
                    Activate
                  </button>
                )}
              </div>
            </div>
            {provider.id === 'ollama' && (
              <p style={{ marginTop: 8, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                Free, local. Install from ollama.com and run: <code>ollama serve</code>
              </p>
            )}
          </div>
        ))}
        <p style={{ marginTop: 12, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
          API keys are configured in VS Code Settings (Ctrl+,) under "ResearchLoop".
        </p>
      </div>

      {/* Sources */}
      <div className="card mb-16">
        <div className="flex-between mb-16">
          <h3>Sources</h3>
          <button onClick={() => setShowAddSource(!showAddSource)}>
            {showAddSource ? 'Cancel' : '+ Add Source'}
          </button>
        </div>

        {/* Built-in sources */}
        {builtinSources.map(s => (
          <div key={s} className="card mb-8">
            <div className="flex-between">
              <div>
                <strong>{s === 'arxiv' ? 'arXiv' : s === 'semanticScholar' ? 'Semantic Scholar' : 'Web Search (DuckDuckGo)'}</strong>
                <span className="badge badge-success" style={{ marginLeft: 8 }}>Built-in</span>
              </div>
            </div>
          </div>
        ))}

        {/* Custom sources */}
        {customSources.map(s => (
          <div key={s.id} className="card mb-8">
            <div className="flex-between">
              <div>
                <strong>{s.name}</strong>
                <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                  {s.url}
                </span>
              </div>
              <button className="secondary" onClick={() => removeCustomSource(s.id)}>Remove</button>
            </div>
          </div>
        ))}

        {/* Add source form */}
        {showAddSource && (
          <div className="card mb-8" style={{ borderColor: 'var(--vscode-focusBorder)' }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Name</label>
              <input
                value={newSourceName}
                onChange={e => setNewSourceName(e.target.value)}
                placeholder="e.g., IEEE Xplore"
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>URL</label>
              <input
                value={newSourceUrl}
                onChange={e => setNewSourceUrl(e.target.value)}
                placeholder="e.g., https://ieeexplore.ieee.org"
              />
            </div>
            <p style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 8 }}>
              Custom sources search the web scoped to this domain (site:domain query).
            </p>
            <button onClick={addCustomSource} disabled={!newSourceName.trim() || !newSourceUrl.trim()}>
              Add
            </button>
          </div>
        )}
      </div>

      {/* Categories */}
      <div className="card mb-16">
        <h3 className="mb-16">Article Categories</h3>
        <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>
          Select arXiv categories to filter paper searches.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {ARXIV_CATEGORIES.map(cat => {
            const isSelected = selectedCategories.includes(cat.value);
            return (
              <button
                key={cat.value}
                onClick={() => toggleCategory(cat.value)}
                style={{
                  padding: '4px 10px',
                  fontSize: 12,
                  borderRadius: 12,
                  border: '1px solid',
                  borderColor: isSelected ? 'var(--vscode-focusBorder)' : 'var(--vscode-widget-border)',
                  background: isSelected ? 'var(--vscode-button-background)' : 'transparent',
                  color: isSelected ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                  cursor: 'pointer',
                  opacity: isSelected ? 1 : 0.7,
                }}
              >
                {cat.value}
              </button>
            );
          })}
        </div>
        {selectedCategories.length > 0 && (
          <p style={{ marginTop: 8, fontSize: 11, color: 'var(--vscode-descriptionForeground)' }}>
            Selected: {selectedCategories.join(', ')}
          </p>
        )}
      </div>

      {/* Skills */}
      <div className="card mb-16">
        <div className="flex-between mb-16">
          <h3>Skills</h3>
          <button onClick={() => setShowAddSkill(!showAddSkill)}>
            {showAddSkill ? 'Cancel' : '+ Add Skill'}
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>
          Persistent instructions injected into LLM prompts at each session.
        </p>

        {/* Add skill form */}
        {showAddSkill && (
          <div className="card mb-8" style={{ borderColor: 'var(--vscode-focusBorder)' }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Name</label>
              <input
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
                placeholder="e.g., Always compare with RF baseline"
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Instruction</label>
              <textarea
                value={newSkillInstruction}
                onChange={e => setNewSkillInstruction(e.target.value)}
                placeholder="e.g., Always include a Random Forest baseline in experiment comparisons."
                rows={3}
              />
            </div>
            <div className="flex" style={{ marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Category</label>
                <select value={newSkillCategory} onChange={e => setNewSkillCategory(e.target.value as Skill['category'])}>
                  {SKILL_CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>Scope</label>
                <select value={newSkillScope} onChange={e => setNewSkillScope(e.target.value as Skill['scope'])}>
                  <option value="workspace">This project</option>
                  <option value="global">All projects</option>
                </select>
              </div>
            </div>
            <button onClick={addSkill} disabled={!newSkillName.trim() || !newSkillInstruction.trim()}>
              Add Skill
            </button>
          </div>
        )}

        {/* Skill list */}
        {skills.length === 0 && !showAddSkill && (
          <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', fontStyle: 'italic' }}>
            No skills configured yet. Add one to customize LLM behavior across sessions.
          </p>
        )}

        {skills.map(skill => (
          <div key={skill.id} className="card mb-8" style={{
            opacity: skill.enabled ? 1 : 0.5,
          }}>
            <div className="flex-between">
              <div style={{ flex: 1 }}>
                <div className="flex" style={{ alignItems: 'center' }}>
                  <strong>{skill.name}</strong>
                  <span className={`badge ${skill.category === 'general' ? 'badge-running' : 'badge-pending'}`}
                    style={{ marginLeft: 8 }}>
                    {skill.category}
                  </span>
                  <span className="badge" style={{
                    marginLeft: 4,
                    background: skill.scope === 'global' ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-descriptionForeground)',
                    color: 'white',
                    padding: '1px 6px',
                    borderRadius: 8,
                    fontSize: 10,
                  }}>
                    {skill.scope === 'global' ? 'Global' : 'Project'}
                  </span>
                </div>
                <p style={{ marginTop: 4, fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
                  {skill.instruction}
                </p>
              </div>
              <div className="flex">
                <button className="secondary" onClick={() => toggleSkill(skill.id)}>
                  {skill.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="secondary" onClick={() => deleteSkill(skill.id)}
                  style={{ color: 'var(--vscode-testing-iconFailed)' }}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
