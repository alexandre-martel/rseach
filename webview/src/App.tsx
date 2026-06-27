import React, { useState, useEffect } from 'react';
import { onMessage, postMessage } from './vscode';
import { ResultsDashboard } from './views/ResultsDashboard/ResultsDashboard';

import { Settings } from './views/Settings/Settings';
import { ReportPreview } from './views/ReportPreview/ReportPreview';

interface AppProps {
  panelType: string;
}

export function App({ panelType }: AppProps) {
  useEffect(() => {
    postMessage('ready');
  }, []);

  const renderPanel = () => {
    switch (panelType) {
      case 'dashboard':
        return <ResultsDashboard />;
      case 'settings':
        return <Settings />;
      case 'reportPreview':
        return <ReportPreview />;
      case 'pipelineBuilder':
        return <PipelineBuilderPlaceholder />;
      default:
        return <ResultsDashboard />;
    }
  };

  return (
    <div className="app">
      {renderPanel()}
    </div>
  );
}

function PipelineBuilderPlaceholder() {
  return (
    <div className="placeholder">
      <h2>Pipeline Builder</h2>
      <p>Drag and drop pipeline steps to compose your research loop.</p>
      <p>Coming in Phase 5.</p>
    </div>
  );
}
