import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const rootElement = document.getElementById('root');
if (rootElement) {
  const panelType = rootElement.getAttribute('data-panel-type') ?? 'dashboard';
  const root = createRoot(rootElement);
  root.render(<App panelType={panelType} />);
}
