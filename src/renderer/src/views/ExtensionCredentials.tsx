import { useState } from 'react';
import type { ExtensionInfo } from '@shared/types';
import { Hint, Mark, Note } from '../components/bits';

/*
 * Values for the credentials an installed extension declares.
 *
 * The value goes straight to the main process, which checks that this installed,
 * approved extension declares that id and that no provider pack owns it, then
 * stores it in the OS keychain. It is never read back here: what returns is only
 * whether each credential is present. A field is a password field and is cleared
 * the moment it is saved.
 */

function fieldId(extensionId: string, credentialId: string): string {
  return `cred-${`${extensionId}-${credentialId}`.replace(/[^A-Za-z0-9_-]+/g, '-')}`;
}

export default function ExtensionCredentials({ extension, onChanged }: {
  extension: ExtensionInfo;
  onChanged: (list: ExtensionInfo[]) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!extension.credentials.length) return null;

  async function run(credentialId: string, work: () => Promise<ExtensionInfo[]>) {
    setBusy(credentialId);
    setError(null);
    try {
      const list = await work();
      setDrafts((d) => ({ ...d, [credentialId]: '' }));
      setEditing((e) => ({ ...e, [credentialId]: false }));
      onChanged(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ex-form">
      {extension.credentials.map((c) => {
        const id = fieldId(extension.id, c.id);
        const value = drafts[c.id] ?? '';
        const open = !c.present || editing[c.id];
        return (
          <div className="ex-field" key={c.id}>
            <label className="label" htmlFor={id}>{c.label}</label>
            {open ? (
              <div className="ex-actions">
                <input
                  id={id}
                  type="password"
                  className="field mono"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  placeholder={c.present ? 'Paste a new value to replace the saved one' : 'Paste the value'}
                  disabled={busy !== null}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && value.trim()) {
                      e.preventDefault();
                      void run(c.id, () => window.wanigan.extensions.setCredential(extension.id, c.id, value));
                    }
                  }}
                />
                <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null || !value.trim()}
                        onClick={() => void run(c.id, () => window.wanigan.extensions.setCredential(extension.id, c.id, value))}>
                  {busy === c.id ? 'Saving…' : 'Save'}
                </button>
                {c.present && (
                  <button type="button" className="btn btn-sm" disabled={busy !== null}
                          onClick={() => setEditing((e) => ({ ...e, [c.id]: false }))}>Cancel</button>
                )}
              </div>
            ) : (
              <div className="ex-actions">
                <Mark glyph="✓" word="Saved in the keychain" tone="ok" />
                <button type="button" className="btn btn-sm" disabled={busy !== null}
                        onClick={() => setEditing((e) => ({ ...e, [c.id]: true }))}>Replace</button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null}
                        onClick={() => void run(c.id, () => window.wanigan.extensions.clearCredential(extension.id, c.id))}>
                  {busy === c.id ? 'Removing…' : 'Remove'}
                </button>
              </div>
            )}
            <Hint>
              {c.help ? `${c.help} ` : ''}Kept in the OS keychain and handed only to this extension&rsquo;s server when a
              session starts. Wanigan never shows it again.
            </Hint>
          </div>
        );
      })}
      {error && <Note tone="error" onDismiss={() => setError(null)}>{error}</Note>}
    </div>
  );
}
