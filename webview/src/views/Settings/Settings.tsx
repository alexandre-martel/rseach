import React, { useState, useEffect } from 'react';
import { onMessage, postMessage } from '../../vscode';

interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  error?: string;
}

export function Settings() {
  const [activeProvider, setActiveProvider] = useState('ollama');
  const [providers, setProviders] = useState<ProviderStatus[]>([
    { id: 'ollama', name: 'Ollama (Local)', available: false },
    { id: 'claude', name: 'Anthropic Claude', available: false },
    { id: 'openai', name: 'OpenAI', available: false },
  ]);
  const [testing, setTesting] = useState<string | null>(null);

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
    });
    postMessage('config:get');
  }, []);

  const testConnection = (providerId: string) => {
    setTesting(providerId);
    postMessage('config:testConnection', { provider: providerId });
  };

  return (
    <div>
      <h2 className="mb-24">ResearchLoop Settings</h2>

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

      <div className="card mb-16">
        <h3 className="mb-8">Modules</h3>
        <p style={{ color: 'var(--vscode-descriptionForeground)' }}>
          Enable/disable modules in VS Code Settings: <code>researchloop.modules.enabled</code>
        </p>
      </div>

      <div className="card">
        <h3 className="mb-8">Sub-Extensions</h3>
        <p className="mb-8" style={{ color: 'var(--vscode-descriptionForeground)' }}>
          Install additional capabilities:
        </p>
        <table>
          <thead>
            <tr><th>Extension</th><th>Features</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>researchloop-robotics</td>
              <td>MuJoCo, PyBullet, Isaac Sim, Gazebo</td>
              <td><span className="badge badge-pending">Not installed</span></td>
            </tr>
            <tr>
              <td>researchloop-cloud</td>
              <td>AWS SageMaker, GCP Vertex AI, Azure ML</td>
              <td><span className="badge badge-pending">Not installed</span></td>
            </tr>
            <tr>
              <td>researchloop-mlops</td>
              <td>W&B, MLflow, TensorBoard, DVC</td>
              <td><span className="badge badge-pending">Not installed</span></td>
            </tr>
            <tr>
              <td>researchloop-hpc</td>
              <td>SLURM, PBS, Kubernetes jobs</td>
              <td><span className="badge badge-pending">Not installed</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
