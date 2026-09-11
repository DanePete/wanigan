import { useCallback, useEffect, useState } from 'react';
import { checklistFrom, countedAgents, installFor, preflightComplete, type Preflight } from '@shared/preflight';
import { defaultSelection, discoveryDetail, rankDiscovered, type DiscoveryResult } from '@shared/discovery';
import { EmptyState, Icon, SectionHead } from './bits';

/**
 * The first thing a new operator is asked to do, and the last thing they see of
 * onboarding.
 *
 * Three items, each stating what Wanigan observed rather than what it assumes.
 * It renders nothing once every item is satisfied and nothing while the read is
 * still in flight, so it can be mounted unconditionally: an operator who has
 * finished setting up never learns this component exists.
 *
 * The one rule worth keeping when editing this file: a red mark here is a claim
 * about somebody's machine. `shared/preflight.ts` decides what may be claimed,
 * and this renders that decision without adding to it.
 */
export default function SetupChecklist({ onAddProject, onNewSession }: {
  onAddProject: () => void;
  onNewSession: () => void;
}) {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [found, setFound] = useState<DiscoveryResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);

  const read = useCallback(async () => {
    setChecking(true);
    try {
      setPreflight(await window.wanigan.preflight.read());
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void read(); }, [read]);

  const scan = useCallback(async () => {
    setScanning(true); setScanError(null); setImportNote(null); setQuery('');
    try {
      const result = await window.wanigan.preflight.discover();
      setFound(result);
      setPicked(new Set(defaultSelection(result.projects, Date.now())));
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, []);

  const importPicked = useCallback(async () => {
    if (!picked.size) return;
    setImporting(true); setScanError(null); setImportNote(null);
    try {
      const projects = await window.wanigan.preflight.importProjects([...picked]);
      // Cancellation returns the unchanged project list. Preserve every choice
      // that was not actually registered, so cancelling never loses the scan.
      const registered = new Set(projects.map(project => project.path));
      const added = [...picked].filter(path => registered.has(path)).length;
      setFound(previous => previous && ({ ...previous, projects: previous.projects.map(project => ({ ...project, known: project.known || registered.has(project.path) })) }));
      setPicked(previous => new Set([...previous].filter(path => !registered.has(path))));
      setImportNote(added ? `${added} ${added === 1 ? 'project added' : 'projects added'}.` : 'No projects added. Your choices are still here.');
      await read();
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [picked, read]);

  // A failed read is not an empty machine. Say so with the posture that exists
  // for it rather than rendering a checklist of things that were never checked.
  if (error) {
    return <EmptyState posture="could-not-read" title="Wanigan could not check this machine."
      cue={error} action={<button className="btn" type="button" onClick={() => void read()}>Try again</button>} />;
  }
  if (!preflight) return null;

  const items = checklistFrom(preflight);
  if (preflightComplete(items)) return null;

  const agentReady = items[0].done;
  const projectReady = items[1].done;
  const next = items.find(item => !item.done)?.id;
  const visibleProjects = rankDiscovered(found?.projects ?? []).filter(project => `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()));

  // Only the agents the checklist actually counts: a key-backed profile is not
  // something to install, and offering "install GLM" for a missing claude
  // binary would name the wrong thing. Keyed by command so the two harnesses
  // that share one install line print it once.
  const installs = new Map<string, { label: string; command: string; alternative: string | null; url: string }>();
  for (const agent of countedAgents(preflight.agents)) {
    const hint = installFor(agent);
    if (!agent.found && hint && !installs.has(hint.command)) {
      installs.set(hint.command, { label: agent.label, ...hint });
    }
  }

  const copy = (command: string) => {
    void navigator.clipboard.writeText(command)
      .then(() => setCopied(command))
      .catch(() => setCopied(null));
  };

  const action = (id: string) => {
    if (id === 'agent' && agentReady) return null;
    if (id === 'agent') {
      return <button className="btn btn-sm" type="button" onClick={() => void read()} disabled={checking}>
        {checking ? 'Checking…' : 'Re-check'}
      </button>;
    }
    if (id === 'project') {
      return found
        ? <button className="btn btn-sm" type="button" onClick={onAddProject}>Choose a folder</button>
        : <button className="btn btn-sm btn-primary" type="button" onClick={() => void scan()} disabled={scanning}>
            {scanning ? 'Looking…' : 'Find my projects'}
          </button>;
    }
    // No `title`: the precondition is already in this row's detail line, where
    // a keyboard and a touch screen can both reach it.
    return <button className="btn btn-sm" type="button" onClick={onNewSession} disabled={!agentReady || !projectReady}>
      Start a session
    </button>;
  };

  return (
    <section className="mission-setup" aria-labelledby="mission-setup-title">
      <SectionHead label="Getting started" right={<span>{items.filter(item => item.done).length} of 3 ready</span>} />
      <h2 className="mission-setup-title" id="mission-setup-title">Let’s get your first session going.</h2>
      <p className="mission-setup-cue">An agent, a project, and somewhere to start. Here’s what Wanigan found.</p>
      <ol className="mission-setup-list">
        {items.map((item) => (
          <li className={`mission-setup-item ${item.done ? 'is-done' : 'is-todo'}${item.id === next ? ' is-next' : ''}`} key={item.id} aria-current={item.id === next ? 'step' : undefined}>
            <span className="mission-setup-mark glyph" aria-hidden="true">{item.done ? '✓' : '○'}</span>
            <div className="mission-setup-body">
              <strong>{item.title}<span className="sr-only">{item.done ? ' — done' : ' — still to do'}</span></strong>
              <span className="mission-setup-detail">{item.detail}</span>
              {item.id === 'agent' && !item.done && installs.size > 0 && (
                <div className="mission-setup-installs">
                  {[...installs.values()].map((hint) => (
                    <div className="mission-setup-install" key={hint.command}>
                      <span className="mission-setup-install-for">{hint.label}</span>
                      <div className="mission-setup-install-row">
                        <code>{hint.command}</code>
                        <button className="btn btn-sm" type="button"
                          aria-label={`Copy the command to install ${hint.label}`} onClick={() => copy(hint.command)}>
                          {copied === hint.command ? 'Copied' : 'Copy'}
                        </button>
                        <button className="btn btn-sm" type="button"
                          aria-label={`Open the ${hint.label} install guide`}
                          onClick={() => void window.wanigan.shell.openExternal(hint.url)}>
                          Guide<Icon name="external" />
                        </button>
                      </div>
                      {hint.alternative && (
                        <div className="mission-setup-install-row">
                          <code>{hint.alternative}</code>
                          <button className="btn btn-sm" type="button"
                            aria-label={`Copy the Homebrew command to install ${hint.label}`}
                            onClick={() => copy(hint.alternative!)}>
                            {copied === hint.alternative ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  <p className="mission-setup-note">
                    Run one in a terminal, then Re-check. The first line is the vendor's own installer and
                    needs no Node; the second is Homebrew if you already use it. Wanigan runs neither — these
                    CLIs often live inside an editor extension rather than on your PATH, which is why it looks
                    in both places before saying it cannot find one.
                  </p>
                </div>
              )}

              {item.id === 'project' && !found && <button className="mission-setup-folder" type="button" onClick={onAddProject}>Choose a folder instead</button>}
              {item.id === 'project' && (scanError || found) && (
                <div className="mission-setup-found">
                  {scanError && <p className="mission-setup-bad" role="alert">{scanError}</p>}
                  {importNote && <p className="mission-setup-note" role="status">{importNote}</p>}
                  {found && found.projects.length === 0 && (
                    <p className="mission-setup-note">
                      Nothing found in your Claude or Codex history yet. Choose a folder instead.
                    </p>
                  )}
                  {found && found.projects.length > 0 && (
                    <>
                      <p className="mission-setup-note">
                        {`Found ${found.projects.length} from ${found.scanned} past conversations`}
                        {found.truncated ? ' — the scan hit its limit, so there may be more.' : '.'}
                        {' Ticked ones are git repositories you worked in recently.'}
                      </p>
                      <div className="mission-setup-search">
                        <input className="field" type="search" aria-label="Search discovered projects" placeholder="Find a project or folder" value={query} onChange={event => setQuery(event.target.value)} />
                        <span role="status">{visibleProjects.length} shown · {picked.size} selected</span>
                      </div>
                      {visibleProjects.length === 0 && <p className="mission-setup-note">No matching projects. <button className="btn btn-sm" type="button" onClick={() => setQuery('')}>Clear search</button></p>}
                      <ul className="mission-setup-candidates">
                        {visibleProjects.map((candidate) => (
                          <li key={candidate.path}>
                            <label className={candidate.known ? 'is-known' : undefined}>
                              <input type="checkbox" checked={picked.has(candidate.path)} disabled={candidate.known || importing}
                                onChange={(e) => setPicked((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(candidate.path); else next.delete(candidate.path);
                                  return next;
                                })} />
                              <span className="mission-setup-candidate-name">
                                <strong>{candidate.name}</strong>{candidate.remote === null && <em>Not a git repository</em>}
                                <span className="mission-setup-candidate-path">{candidate.path}</span>
                              </span>
                              <span className="mission-setup-candidate-meta">
                                {candidate.known ? 'already added' : discoveryDetail(candidate, Date.now())}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <div className="mission-setup-candidate-actions">
                        <button className="btn btn-sm btn-primary" type="button" disabled={!picked.size || importing}
                          onClick={() => void importPicked()}>
                          {importing ? 'Adding…' : `Add ${picked.size} ${picked.size === 1 ? 'project' : 'projects'}`}
                        </button>
                        <button className="btn btn-sm" type="button" onClick={() => setPicked(new Set())} disabled={!picked.size || importing}>
                          Clear
                        </button>
                        <span className="mission-setup-note">Wanigan asks you to confirm before adding any.</span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
            {action(item.id)}
          </li>
        ))}
      </ol>
    </section>
  );
}
