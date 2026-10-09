// The phone app: pairing until paired, then a screen and the tab bar.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ToastProvider } from '../components/ui';
import { Icon, type IconName } from '../components/icons';
import { useCoreStatus, useQuery } from '../lib/api';
import type { PhoneLink } from './bridge';
import { NavContext, tabOf, type Nav, type Screen, type Tab } from './nav';
import { Pair } from './Pair';
import { NeedsScreen } from './NeedsScreen';
import { SessionsScreen } from './SessionsScreen';
import { SessionScreen } from './SessionScreen';
import { BoardsScreen } from './BoardsScreen';
import { BoardScreen } from './BoardScreen';
import { CardScreen } from './CardScreen';
import { NewSessionScreen } from './NewSessionScreen';
import { ThisPhone } from './ThisPhone';

const TABS: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'needs', label: 'Needs you', icon: 'needs' },
  { tab: 'sessions', label: 'Sessions', icon: 'terminal' },
  { tab: 'new', label: 'New', icon: 'plus' },
  { tab: 'boards', label: 'Boards', icon: 'board' },
  { tab: 'phone', label: 'This phone', icon: 'phone' },
];

export function PhoneApp({ link }: { link: PhoneLink }) {
  const [paired, setPaired] = useState(link.paired);
  useEffect(() => { link.onUnpaired = () => setPaired(false); }, [link]);
  return (
    <ToastProvider>
      {paired ? <Paired link={link} /> : <Pair link={link} onPaired={() => setPaired(true)} />}
    </ToastProvider>
  );
}

function Paired({ link }: { link: PhoneLink }) {
  const [stack, setStack] = useState<Screen[]>([{ name: 'needs' }]);
  const screen = stack[stack.length - 1]!;
  const go = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const tab = useCallback((t: Tab) => setStack([t === 'new' ? { name: 'new' } : { name: t }]), []);
  const nav = useMemo<Nav>(() => ({ screen, canGoBack: stack.length > 1, go, back, tab }), [screen, stack.length, go, back, tab]);
  const status = useCoreStatus();
  const needs = useQuery('needs.list', {}, ['needs']);
  const count = needs.data?.length ?? 0;
  useEffect(() => { window.scrollTo(0, 0); }, [screen]);

  return (
    <NavContext.Provider value={nav}>
      <div className="phone-app">
        {status !== 'connected' ? (
          <p className="phone-offline" role="status">{status === 'connecting' ? 'Reaching your Mac…' : 'Your Mac is not answering. Is it awake, with Tailscale on?'}</p>
        ) : null}
        <main className="phone-main"><Current screen={screen} link={link} /></main>
        <nav className="phone-tabs" aria-label="Wanigan">
          {TABS.map((t) => (
            <button key={t.tab} type="button" className={`phone-tab${tabOf(screen) === t.tab ? ' on' : ''}`} aria-current={tabOf(screen) === t.tab ? 'page' : undefined} onClick={() => tab(t.tab)}>
              <Icon name={t.icon} size={20} />
              <span>{t.label}</span>
              {t.tab === 'needs' && count ? <span className="phone-badge" aria-label={`${count} waiting`}>{count}</span> : null}
            </button>
          ))}
        </nav>
      </div>
    </NavContext.Provider>
  );
}

function Current({ screen, link }: { screen: Screen; link: PhoneLink }) {
  switch (screen.name) {
    case 'needs': return <NeedsScreen />;
    case 'sessions': return <SessionsScreen />;
    case 'session': return <SessionScreen id={screen.id} />;
    case 'boards': return <BoardsScreen />;
    case 'board': return <BoardScreen projectId={screen.projectId} />;
    case 'card': return <CardScreen id={screen.id} />;
    case 'new': return <NewSessionScreen {...(screen.projectId ? { projectId: screen.projectId } : {})} {...(screen.cardId ? { cardId: screen.cardId } : {})} />;
    case 'phone': return <ThisPhone link={link} />;
  }
}
