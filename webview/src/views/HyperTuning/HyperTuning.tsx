import React, { useState, useEffect } from 'react';
import { onMessage, postMessage } from '../../vscode';

interface ParamDef {
  name: string;
  type: 'float' | 'int' | 'choice' | 'bool';
  min?: number;
  max?: number;
  scale?: 'linear' | 'log';
  values?: (string | number | boolean)[];
}

interface Trial {
  number: number;
  params: Record<string, string | number | boolean>;
  metrics: Record<string, number>;
  status: string;
  duration?: number;
}

interface TuningState {
  params: ParamDef[];
  trials: Trial[];
  strategy: string;
  objective: { metric: string; direction: string };
  status: string;
  bestTrialNumber?: number;
}

export function HyperTuning() {
  const [state, setState] = useState<TuningState>({
    params: [],
    trials: [],
    strategy: 'llm-guided',
    objective: { metric: 'val_accuracy', direction: 'maximize' },
    status: 'configuring',
  });
  const [promptInput, setPromptInput] = useState('');
  const [sortBy, setSortBy] = useState('number');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    onMessage((msg) => {
      if (msg.type === 'quickTune:init') {
        const payload = msg.payload as { description: string };
        setPromptInput(payload.description);
      }
      if (msg.type === 'hypertuning:stateUpdated') {
        setState(msg.payload as TuningState);
      }
    });
  }, []);

  const sortedTrials = [...state.trials].sort((a, b) => {
    if (sortBy === 'number') {
      return sortDir === 'asc' ? a.number - b.number : b.number - a.number;
    }
    const aVal = a.metrics[sortBy] ?? 0;
    const bVal = b.metrics[sortBy] ?? 0;
    return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
  });

  const bestTrial = state.trials
    .filter(t => t.status === 'completed' && t.metrics[state.objective.metric] !== undefined)
    .sort((a, b) => {
      const aVal = a.metrics[state.objective.metric];
      const bVal = b.metrics[state.objective.metric];
      return state.objective.direction === 'maximize' ? bVal - aVal : aVal - bVal;
    })[0];

  const allMetricKeys = Array.from(new Set(state.trials.flatMap(t => Object.keys(t.metrics))));
  const allParamKeys = Array.from(new Set(state.trials.flatMap(t => Object.keys(t.params))));

  const handleSort = (key: string) => {
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(key);
      setSortDir('desc');
    }
  };

  return (
    <div>
      <h2 className="mb-16">HyperParameter Tuning</h2>

      {/* Prompt-driven config */}
      {state.status === 'configuring' && (
        <div className="card mb-16">
          <h3 className="mb-8">Describe your tuning needs</h3>
          <textarea
            rows={4}
            value={promptInput}
            onChange={e => setPromptInput(e.target.value)}
            placeholder='e.g., "Tune learning rate (1e-5 to 1e-2, log scale), batch size (16/32/64), and dropout (0-0.5). Maximize val_accuracy. Budget: 30 trials, max 4h. My command: python train.py --lr {learning_rate} --bs {batch_size}"'
          />
          <div className="flex mt-8">
            <button onClick={() => postMessage('hypertuning:generateConfig', { prompt: promptInput })}>
              Generate Config with AI
            </button>
            <button className="secondary" onClick={() => setState(s => ({ ...s, status: 'manual' }))}>
              Manual Config
            </button>
          </div>
        </div>
      )}

      {/* Parameter space display */}
      {state.params.length > 0 && (
        <div className="card mb-16">
          <h3 className="mb-8">Parameter Space</h3>
          <table>
            <thead>
              <tr>
                <th>Parameter</th>
                <th>Type</th>
                <th>Range / Values</th>
                <th>Scale</th>
              </tr>
            </thead>
            <tbody>
              {state.params.map(p => (
                <tr key={p.name}>
                  <td><strong>{p.name}</strong></td>
                  <td>{p.type}</td>
                  <td>
                    {p.type === 'choice'
                      ? p.values?.join(', ')
                      : p.type === 'bool'
                        ? 'true / false'
                        : `${p.min} - ${p.max}`}
                  </td>
                  <td>{p.scale ?? 'linear'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex mt-8">
            <span>Strategy: <strong>{state.strategy}</strong></span>
            <span>Objective: <strong>{state.objective.direction} {state.objective.metric}</strong></span>
          </div>
          {state.status === 'configuring' && (
            <div className="mt-8">
              <button onClick={() => postMessage('hypertuning:start')}>
                Start Tuning
              </button>
            </div>
          )}
        </div>
      )}

      {/* Best result */}
      {bestTrial && (
        <div className="card mb-16" style={{ borderColor: 'var(--vscode-testing-iconPassed, #388a34)' }}>
          <h3 className="mb-8">Best Configuration (Trial #{bestTrial.number})</h3>
          <div className="grid grid-2">
            <div>
              <h4>Parameters</h4>
              {Object.entries(bestTrial.params).map(([k, v]) => (
                <div key={k}><code>{k}</code>: <strong>{String(v)}</strong></div>
              ))}
            </div>
            <div>
              <h4>Metrics</h4>
              {Object.entries(bestTrial.metrics).map(([k, v]) => (
                <div key={k}>
                  <code>{k}</code>: <strong>{v.toFixed(4)}</strong>
                  {k === state.objective.metric && ' *'}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Trial history table */}
      {state.trials.length > 0 && (
        <div className="card">
          <div className="flex-between mb-8">
            <h3>Trial History ({state.trials.length} trials)</h3>
            <div className="flex">
              <span className="badge badge-success">
                {state.trials.filter(t => t.status === 'completed').length} completed
              </span>
              <span className="badge badge-failed">
                {state.trials.filter(t => t.status === 'failed').length} failed
              </span>
              {state.trials.some(t => t.status === 'running') && (
                <span className="badge badge-running">
                  {state.trials.filter(t => t.status === 'running').length} running
                </span>
              )}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th onClick={() => handleSort('number')} style={{ cursor: 'pointer' }}>
                  # {sortBy === 'number' && (sortDir === 'asc' ? '▲' : '▼')}
                </th>
                <th>Status</th>
                {allParamKeys.map(k => <th key={k}>{k}</th>)}
                {allMetricKeys.map(k => (
                  <th key={k} onClick={() => handleSort(k)} style={{ cursor: 'pointer' }}>
                    {k} {k === state.objective.metric && '*'}
                    {sortBy === k && (sortDir === 'asc' ? '▲' : '▼')}
                  </th>
                ))}
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {sortedTrials.map(trial => (
                <tr key={trial.number} style={trial.number === bestTrial?.number ? { fontWeight: 'bold' } : undefined}>
                  <td>{trial.number}</td>
                  <td>
                    <span className={`badge badge-${trial.status === 'completed' ? 'success' : trial.status === 'running' ? 'running' : trial.status === 'failed' ? 'failed' : 'pending'}`}>
                      {trial.status}
                    </span>
                  </td>
                  {allParamKeys.map(k => (
                    <td key={k}>{trial.params[k] !== undefined ? String(trial.params[k]) : '-'}</td>
                  ))}
                  {allMetricKeys.map(k => (
                    <td key={k}>{trial.metrics[k]?.toFixed(4) ?? '-'}</td>
                  ))}
                  <td>{trial.duration ? `${(trial.duration / 1000).toFixed(1)}s` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
