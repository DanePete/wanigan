import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans-condensed/500.css';
import '@fontsource/ibm-plex-sans-condensed/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/400-italic.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/parts.css';
import './styles/shell.css';
import './styles/controls.css';
import './styles/components.css';
import './styles/palette.css';
import './styles/board.css';
import './styles/drawer.css';
import './styles/session.css';
import './styles/watch.css';
import './styles/needs.css';
import './styles/orb.css';
import './styles/pages.css';
import './styles/git.css';
import './styles/history.css';
import './styles/jev.css';
import './styles/how.css';
import './styles/chat.css';
import './styles/chatter.css';
import './styles/alerts.css';
import './styles/local.css';
import './styles/pairing.css';
import './lib/theme';
import { bridge } from './lib/api';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The frame leaves room for a Mac's window buttons; elsewhere it does not need to (shell.css).
document.documentElement.dataset.platform = bridge().platform;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
