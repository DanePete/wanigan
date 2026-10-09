// The AI a site runs, as its own core reports it, and what a save runs: the
// Inspector's "AI on this site", and the note shown before anything is saved,
// moved or added (src/shared/live-ai.ts). Read-only: nothing here prompts a
// model, and no key is ever read; the helper lists what core already knows.
import { useState } from 'react';
import { abilityHints, aiClientSentence, keyWords, runnerName, SAVE_CAVEAT, savesSentence, type LiveSiteAiAnswer, type SiteAi } from '@shared/live-ai';
import type { TraceAi, TraceSave } from '@shared/live-trace';
import { Button, Disclosure } from '../ui';

/** Before a save: whose code also runs, what Wanigan cannot see of it, and whether the site's AI Client is connected. */
export function SavesNote({ save, ai }: { save: TraceSave | null; ai?: TraceAi | null }) {
  const said = savesSentence(save);
  const client = aiClientSentence(ai);
  if (!said && !client) return null;
  return (
    <div className="live-saves small" role="note">
      {said ? <p>{said} {SAVE_CAVEAT}</p> : null}
      {client ? <p>{client}</p> : null}
    </div>
  );
}

function summary(ai: SiteAi): string {
  if (ai.platform === 'drupal') return 'no AI API in Drupal core';
  const connected = (ai.connectors ?? []).filter((c) => c.type === 'ai_provider' && c.setUp).length;
  const parts = [
    !ai.coreAi ? 'no AI Client in this WordPress' : ai.supports === false ? 'AI switched off' : `${connected} AI ${connected === 1 ? 'connector' : 'connectors'} set up`,
    ai.abilities ? `${ai.abilities.length} ${ai.abilities.length === 1 ? 'ability' : 'abilities'}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

const ABILITIES_SHOWN = 12;

/** The Inspector's "AI on this site": WordPress core's AI Client, connectors and abilities; on both, what saving runs. */
export function SiteAiSection({ answer, onRefresh }: { answer: LiveSiteAiAnswer | null; onRefresh: () => void }) {
  const [all, setAll] = useState(false);
  if (!answer || answer.state === 'no-helper') return null;
  if (answer.state !== 'ok') {
    const why = answer.state === 'outdated' ? 'The site helper is older than this Wanigan: update it (the gear, then the helper) to see what AI the site runs.'
      : answer.state === 'refused' ? `The site refused to say (it answered ${answer.status}).`
        : answer.state === 'down' ? `The site did not answer (${answer.error}).`
          : 'The site helper’s answer could not be read.';
    return (
      <Disclosure title="AI on this site" summary="not read">
        <p className="small">{why}</p>
        <div className="live-actions"><Button size="s" tone="quiet" icon="refresh" onClick={onRefresh}>Ask again</Button></div>
      </Disclosure>
    );
  }
  const ai = answer.ai;
  const saving = ai.saves.filter((s) => s.runs.length);
  const abilities = ai.abilities ?? [];
  return (
    <Disclosure title="AI on this site" summary={summary(ai)} className="live-site-ai">
      {ai.platform === 'drupal' ? (
        <p className="small">
          Drupal core has no AI API, so Wanigan cannot list this site’s AI: on Drupal it comes from contributed modules, and many of
          them run when content is saved. What each kind of save runs besides core is below.
        </p>
      ) : (
        <>
          <p className="small">
            {!ai.coreAi ? 'This WordPress has no AI Client in core (it came in 7.0).'
              : ai.supports === false ? 'WordPress’s AI Client is here, switched off for this site (wp_supports_ai).'
                : 'WordPress’s AI Client is here: plugins can prompt the providers below through it.'}
          </p>
          {ai.connectors ? (
            ai.connectors.length ? (
              <>
                <h4 className="live-subhead small">Connectors</h4>
                <ul className="live-edit-list">
                  {ai.connectors.map((c) => (
                    <li key={c.id}>
                      <div className="live-edit-what">
                        <span className="small">{c.name}</span>
                        <span className="faint small">{c.type.replace(/_/g, ' ')} · {keyWords(c)}{c.plugin ? ` · ${c.plugin}${c.active === false ? ' (not active)' : ''}` : ''}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : <p className="faint small">No connectors are registered.</p>
          ) : null}
          {ai.abilities ? (
            abilities.length ? (
              <>
                <h4 className="live-subhead small">Abilities</h4>
                <ul className="live-edit-list">
                  {(all ? abilities : abilities.slice(0, ABILITIES_SHOWN)).map((a) => (
                    <li key={a.name}>
                      <div className="live-edit-what">
                        <span className="small">{a.label}</span>
                        <span className="faint small">{abilityHints(a)}</span>
                        <span className="mono small faint">{a.name}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                {abilities.length > ABILITIES_SHOWN ? (
                  <Button size="s" tone="quiet" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${abilities.length}`}</Button>
                ) : null}
              </>
            ) : <p className="faint small">No abilities are registered.</p>
          ) : <p className="faint small">This WordPress has no Abilities API (it came in 6.9).</p>}
        </>
      )}
      <h4 className="live-subhead small">What saving runs besides core</h4>
      {saving.length ? (
        <ul className="live-edit-list">
          {saving.map((s) => (
            <li key={s.id}>
              <div className="live-edit-what">
                <span className="small">{s.label}</span>
                <span className="faint small">{s.runs.map(runnerName).join(', ')}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : <p className="faint small">Only core’s own code, as far as core’s hook lists show.</p>}
      <p className="faint small">{saving.length ? `${SAVE_CAVEAT} ` : ''}Read from {ai.platform === 'drupal' ? 'Drupal' : 'WordPress'} core through the site helper: Wanigan calls no model, and never reads a key.</p>
      <div className="live-actions"><Button size="s" tone="quiet" icon="refresh" onClick={onRefresh}>Read it again</Button></div>
    </Disclosure>
  );
}
