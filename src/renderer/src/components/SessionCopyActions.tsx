import { useCallback, useEffect, useRef, useState } from 'react';
import { useAnnounce } from './announce';
import { ContextMenu, type MenuItem } from './TerminalMenu';
import '../styles/helper-ux.css';

/**
 * Copy the last response and the conversation id, from the session's status
 * bar. Main reads the text — Claude Code's transcript or Codex's rollout, the
 * exact conversation file only — and writes the clipboard, awaiting it, so a
 * copy that did not happen is reported as not having happened.
 *
 * Whether a copy is possible is asked when the menu opens. An item that is not
 * available is disabled with its reason printed beneath it, not in a tooltip.
 */
type Availability = Awaited<ReturnType<typeof window.wanigan.ux.copyAvailability>>;

export default function SessionCopyActions({ sessionId }: { sessionId: string }) {
  const { announce } = useAnnounce();
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; available: Availability | null; error: string | null } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  useEffect(() => { setMenu(null); }, [sessionId]);

  const open = () => {
    const rect = button.current?.getBoundingClientRect();
    const x = rect ? rect.left : 0;
    const y = rect ? rect.top : 0;
    setMenu({ x, y, available: null, error: null });
    window.wanigan.ux.copyAvailability(sessionId)
      .then((available) => setMenu((m) => (m ? { ...m, available } : m)))
      .catch((e: unknown) => setMenu((m) => (m ? { ...m, error: e instanceof Error ? e.message : String(e) } : m)));
  };

  const copy = async (what: 'response' | 'id') => {
    try {
      if (what === 'response') {
        const r = await window.wanigan.ux.copyLastResponse(sessionId);
        announce({ tone: 'ok', text: `Copied the last response — ${r.chars.toLocaleString('en-US')} characters, read from ${r.from}.` });
      } else {
        await window.wanigan.ux.copyConversationId(sessionId);
        announce({ tone: 'ok', text: 'Copied the conversation id.' });
      }
    } catch (e) {
      announce({ tone: 'error', text: `Nothing was copied: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const available = menu?.available ?? null;
  const reading = menu !== null && available === null && menu.error === null;
  const last = available?.lastResponse ?? null;
  const items: MenuItem[] = [
    {
      kind: 'item', label: 'Copy last response', disabled: !last?.ok,
      why: reading ? 'Checking for a transcript…' : menu?.error ?? (last && !last.ok ? last.reason : undefined),
      run: () => copy('response'),
    },
    {
      kind: 'item', label: 'Copy conversation ID', disabled: !available?.conversationId,
      why: reading ? undefined : menu?.error ?? 'This session has no conversation id yet.',
      run: () => copy('id'),
    },
  ];

  return (
    <>
      <button ref={button} type="button" className="faint session-status-action ux-status-copy"
              aria-haspopup="menu" aria-expanded={menu !== null} onClick={() => (menu ? close() : open())}>
        copy…
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="Copy from this session" items={items} onClose={close} />}
    </>
  );
}
