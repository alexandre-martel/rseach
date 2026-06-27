import React, { useState, useEffect } from 'react';
import { onMessage } from '../../vscode';

interface MetricsData {
  [key: string]: number;
}

interface ExperimentResult {
  name: string;
  metrics: MetricsData;
  status: string;
}

export function ResultsDashboard() {
  const [experiments, setExperiments] = useState<ExperimentResult[]>([]);
  const [selectedMetric, setSelectedMetric] = useState<string>('');

  useEffect(() => {
    onMessage((msg) => {
      if (msg.type === 'metrics:updated') {
        // handle metrics update
      }
    });
  }, []);

  const allMetrics = Array.from(
    new Set(experiments.flatMap(e => Object.keys(e.metrics)))
  );

  return (
    <div>
      <div className="flex-between mb-24">
        <h2>Results Dashboard</h2>
        {allMetrics.length > 0 && (
          <select
            value={selectedMetric}
            onChange={e => setSelectedMetric(e.target.value)}
            style={{ width: 'auto' }}
          >
            <option value="">Select metric</option>
            {allMetrics.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
      </div>

      {experiments.length === 0 ? (
        <div className="placeholder">
          <h3>No experiments yet</h3>
          <p>Run a pipeline or start hyperparameter tuning to see results here.</p>
        </div>
      ) : (
        <>
          <div className="card mb-16">
            <h3 className="mb-8">Experiment Comparison</h3>
            <table>
              <thead>
                <tr>
                  <th>Experiment</th>
                  <th>Status</th>
                  {allMetrics.map(m => <th key={m}>{m}</th>)}
                </tr>
              </thead>
              <tbody>
                {experiments.map((exp, i) => (
                  <tr key={i}>
                    <td>{exp.name}</td>
                    <td>
                      <span className={`badge badge-${exp.status === 'completed' ? 'success' : exp.status === 'running' ? 'running' : 'failed'}`}>
                        {exp.status}
                      </span>
                    </td>
                    {allMetrics.map(m => (
                      <td key={m}>{exp.metrics[m]?.toFixed(4) ?? '-'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-2">
            <div className="card">
              <h3>Summary</h3>
              <p>Total experiments: {experiments.length}</p>
              <p>Completed: {experiments.filter(e => e.status === 'completed').length}</p>
              <p>Failed: {experiments.filter(e => e.status === 'failed').length}</p>
            </div>
            <div className="card">
              <h3>Best Result</h3>
              {selectedMetric && experiments.length > 0 ? (
                <p>
                  {(() => {
                    const best = experiments
                      .filter(e => e.metrics[selectedMetric] !== undefined)
                      .sort((a, b) => b.metrics[selectedMetric] - a.metrics[selectedMetric])[0];
                    return best ? `${best.name}: ${best.metrics[selectedMetric].toFixed(4)}` : 'N/A';
                  })()}
                </p>
              ) : (
                <p>Select a metric above</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
