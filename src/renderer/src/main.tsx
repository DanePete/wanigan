import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
/* helper sweep · P6 ux */
import CodeRailWindow from './components/CodeRailWindow';
import { codeRailSessionFromQuery } from '@shared/code-rail-window';
import './index.css';
import './styles/compact.css';

// A code rail window is the same renderer, opened by main with the view and the
// session in its query. It renders the rail alone and never mounts the shell.
const railSession = codeRailSessionFromQuery(window.location.search);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {railSession ? <CodeRailWindow sessionId={railSession} /> : <App />}
  </React.StrictMode>
);
