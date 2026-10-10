// Settings › Skills: every skill your agents can see, by where it lives, with
// the one chosen open beside the list. Reading is free; copying and removing
// happen only when you click, after you have seen what changes.
import { Select } from '../components/Select';
import { useEffect, useMemo, useState } from 'react';
import type { Account, ProjectSummary } from '@shared/model';
import { parseFrontmatter } from '@shared/skills';
import type { Skill, SkillAgent, SkillCopyPlan, SkillGroup, SkillTarget } from '@shared/skills';
import { attempt, bridge, call, useQuery } from '../lib/api';
import { ago, fileManager, plural } from '../lib/format';
import { useHow } from '../lib/how';
import { Badge, Button, Count, Dialog, Disclosure, EmptyState, NotAnswering, ProjectMark, Segmented, useToast } from '../components/ui';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from '../components/How';
import { Icon } from '../components/icons';
import { Markdown } from '../components/Markdown';
import '../styles/library.css';

const AGENT: Record<SkillAgent, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' };
const SOURCE: Record<Skill['source'], string> = { personal: 'Personal', project: 'Project', plugin: 'Plugin', synced: 'Synced from claude.ai' };
type Filter = 'all' | SkillAgent;

export function SkillsView({ projects }: { projects: ProjectSummary[] | undefined }) {
  const listing = useQuery('skills.list', {}, ['skills', 'projects', 'accounts']);
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing.data?.groups ?? [])
      .filter((g) => filter === 'all' || g.agent === filter)
      .map((g) => ({ ...g, skills: g.skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q)) }))
      .filter((g) => g.skills.length);
  }, [listing.data, filter, query]);
  const visible = groups.flatMap((g) => g.skills);
  const total = listing.data?.groups.reduce((n, g) => n + g.skills.length, 0) ?? 0;
  const current = visible.find((s) => s.id === selected) ?? visible[0] ?? null;
  const how = useHow('skills');

  return (
    <section className="view" aria-labelledby="skills-title">
      <header className="topbar">
        <div className="topbar-title">
          <h1 id="skills-title">Skills</h1>
          {listing.data ? <Count n={total} label={plural(total, 'skill')} /> : null}
        </div>
        <div className="topbar-tools">
          <span data-tour="skills-filter">
            <Segmented size="s" label="Agent" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: 'All' }, { value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }, { value: 'gemini', label: 'Gemini CLI' }]} />
          </span>
          <label className="search-field" data-tour="skills-search">
            <Icon name="search" size={14} />
            <span className="visually-hidden">Search skills</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or description"
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }} />
          </label>
          <HowButton onClick={how.show} />
        </div>
      </header>
      {listing.error ? <NotAnswering error={listing.error} onRetry={listing.reload} /> : (
        <div className="library">
          <div className="library-list" data-tour="skills-list">
            {groups.map((g) => (
              <GroupList key={g.id} group={g} projects={projects} current={current?.id ?? null} onPick={setSelected} />
            ))}
            {listing.data && !groups.length ? (
              <EmptyState title={query ? 'No skill matches' : 'No skills yet'} icon="skill">
                {query ? 'Try another word, or show every agent.' : 'Skills appear here as soon as one is in a folder your agents read.'}
              </EmptyState>
            ) : null}
            {listing.data ? <Footnotes listing={listing.data} filter={filter} /> : null}
          </div>
          <div className="library-detail" data-tour="skills-detail">
            {current ? (
              <SkillDetail key={current.id} skill={current} projects={projects ?? []} accounts={accounts.data ?? []} />
            ) : listing.data ? <EmptyState title="Pick a skill" icon="skill">Its SKILL.md opens here.</EmptyState> : null}
          </div>
        </div>
      )}
      {how.open ? <SkillsHow total={listing.data ? total : null} groups={listing.data?.groups.length ?? null} onClose={how.hide} /> : null}
    </section>
  );
}

function GroupList({ group, projects, current, onPick }: {
  group: SkillGroup; projects: ProjectSummary[] | undefined; current: string | null; onPick: (id: string) => void;
}) {
  const project = group.projectId ? projects?.find((p) => p.id === group.projectId) : undefined;
  return (
    <section className="lib-group" aria-label={`${group.title}${group.account ? `, ${group.account}` : ''}, ${AGENT[group.agent]}`}>
      <header className="lib-group-head">
        <p className="lib-group-title">
          {project ? <ProjectMark projectKey={project.key} size="s" /> : null}
          <span className="lib-group-name">{group.title}{group.account ? <span className="faint"> · {group.account}</span> : null}</span>
          <Badge>{AGENT[group.agent]}</Badge>
        </p>
        <p className="lib-where mono" data-tip={group.where}>{group.where}</p>
        {group.note ? <p className="lib-group-note">{group.note}</p> : null}
      </header>
      <ul className="lib-rows">
        {group.skills.map((s) => (
          <li key={s.id}>
            <button type="button" className={`lib-row${s.id === current ? ' active' : ''}`} aria-current={s.id === current ? 'true' : undefined} onClick={() => onPick(s.id)}>
              <span className="lib-row-name">
                {s.name}
                {s.enabled === false ? <Badge>off</Badge> : null}
                {s.linkedTo ? <Badge>linked</Badge> : null}
              </span>
              <span className="lib-row-desc">{s.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Footnotes({ listing, filter }: { listing: { empty: { agent: SkillAgent; where: string }[]; notes: string[] }; filter: Filter }) {
  const empty = listing.empty.filter((e) => filter === 'all' || e.agent === filter);
  return (
    <div className="lib-foot">
      {empty.length ? (
        <p><span className="faint">Also looked in, and found none:</span> {empty.map((e, i) => <span key={e.where + e.agent} className="mono">{i ? ', ' : ''}{e.where}</span>)}</p>
      ) : null}
      {listing.notes.map((n) => <p key={n} className="faint">{n}</p>)}
    </div>
  );
}

function SkillDetail({ skill, projects, accounts }: { skill: Skill; projects: ProjectSummary[]; accounts: Account[] }) {
  const toast = useToast();
  const read = useQuery('skills.read', { id: skill.id }, ['skills']);
  const [copying, setCopying] = useState<'project' | 'personal' | null>(null);
  const [removing, setRemoving] = useState(false);
  const parsed = useMemo(() => (read.data ? parseFrontmatter(read.data.text) : null), [read.data]);
  const extra = parsed ? Object.entries(parsed.data).filter(([k]) => k !== 'name' && k !== 'description') : [];

  return (
    <article className="lib-detail" aria-labelledby={`skill-${skill.id}`}>
      <header className="lib-detail-head">
        <p className="lib-kicker">{AGENT[skill.agent]} · {SOURCE[skill.source]}{skill.plugin ? ` · ${skill.plugin}` : ''}</p>
        <h2 id={`skill-${skill.id}`}>{skill.name}</h2>
        <p className="lib-desc">{skill.description}</p>
        <dl className="lib-facts">
          <div><dt>Seen by</dt><dd>{seenBy(skill, projects, accounts)}</dd></div>
          {skill.invoke ? <div><dt>Call it</dt><dd className="mono">{skill.invoke}</dd></div> : null}
          {skill.enabled === false ? <div><dt>Plugin</dt><dd>Switched off in this account’s settings, so its skills are not loaded.</dd></div> : null}
          <div>
            <dt>Folder</dt>
            <dd>
              <span className="mono lib-path">{skill.displayDir}</span>
              {skill.linkedTo ? <span className="faint small"> → <span className="mono">{skill.linkedTo}</span></span> : null}
              {' '}<button type="button" className="linkish small" onClick={() => void bridge().openPath(`${skill.dir}/SKILL.md`)}>Show in {fileManager(bridge().platform)}</button>
            </dd>
          </div>
          <div><dt>Size</dt><dd>{plural(skill.files, 'file')} · {size(skill.bytes)}{skill.modified ? ` · changed ${ago(skill.modified)}` : ''}</dd></div>
        </dl>
        <div className="lib-actions" data-tour="skills-copy">
          <Button size="s" icon="copy" onClick={() => setCopying('project')} disabled={!projects.length}>Copy to a project…</Button>
          <Button size="s" tone="quiet" onClick={() => setCopying('personal')}>Copy to my skills…</Button>
          {skill.removable ? <Button size="s" tone="quiet" onClick={() => setRemoving(true)}>Remove…</Button> : null}
        </div>
      </header>
      <div className="lib-detail-body">
        {read.error ? <p className="error-text" role="alert">{read.error.message}</p> : null}
        {extra.length ? (
          <Disclosure title="Frontmatter" summary={plural(extra.length, 'more field')} className="lib-frontmatter">
            <dl>{extra.map(([k, v]) => <div key={k}><dt className="mono">{k}</dt><dd>{Array.isArray(v) ? v.join(', ') : v}</dd></div>)}</dl>
          </Disclosure>
        ) : null}
        {parsed ? <Markdown source={parsed.body} /> : read.loading ? <p className="faint">Reading SKILL.md…</p> : null}
        {read.data?.truncated ? <p className="faint small">Only the first 512 KB is shown.</p> : null}
      </div>
      {copying ? (
        <CopyDialog skill={skill} mode={copying} projects={projects} accounts={accounts} onClose={() => setCopying(null)}
          onDone={(plan) => { setCopying(null); toast(`Copied ${skill.name} to ${plan.displayDest}.`); }} />
      ) : null}
      {removing ? (
        <Dialog title={`Remove ${skill.name}?`} onClose={() => setRemoving(false)}
          footer={<>
            <Button tone="quiet" onClick={() => setRemoving(false)}>Cancel</Button>
            <Button tone="danger" onClick={() => attempt(() => call('skills.remove', { id: skill.id }), (m) => toast(m, 'error')).then((r) => {
              setRemoving(false);
              if (r) toast(r.keptAt ? `Removed. The folder is in Wanigan’s trash: ${r.keptAt}` : `Removed ${r.removed}.`);
            })}>Remove</Button>
          </>}>
          <p>
            {skill.linkedTo ? 'Removes the link ' : `Moves ${plural(skill.files, 'file')} in `}
            <span className="mono">{skill.displayDir}</span>
            {skill.linkedTo ? '. The folder it points to stays where it is.' : ' to Wanigan’s trash, where you can take it back.'}
          </p>
          <p className="faint">{readers(skill)} {/[\\/]\.agents[\\/]skills[\\/]/.test(skill.dir) ? 'stop' : 'stops'} seeing it in sessions that start after this.</p>
        </Dialog>
      ) : null}
    </article>
  );
}

interface Destination { key: string; label: string; group: string; to: SkillTarget }

/** Who reads a skill's folder: the Agent Skills folder is Codex's and Gemini CLI's both. */
function readers(skill: Skill): string {
  return /[\\/]\.agents[\\/]skills[\\/]/.test(skill.dir) ? 'Codex and Gemini CLI' : AGENT[skill.agent];
}

const PROJECT_FOLDER: Record<SkillAgent, string> = { claude: '.claude', codex: '.agents', gemini: '.gemini' };

function destinations(mode: 'project' | 'personal', skill: Skill, projects: ProjectSummary[], accounts: Account[]): Destination[] {
  if (mode === 'project') {
    return projects.flatMap((p) => (['claude', 'codex', 'gemini'] as const).map((agent) => ({
      key: `${p.id}:${agent}`, group: p.name,
      label: `${p.name} — ${agent === 'codex' ? 'Codex and Gemini CLI' : AGENT[agent]} (${PROJECT_FOLDER[agent]}/skills)`,
      to: { agent, projectId: p.id },
    }))).filter((d) => !(skill.source === 'project' && skill.projectIds !== 'all' && skill.projectIds.includes(d.to.projectId as string) && d.to.agent === skill.agent));
  }
  const claude = accounts.filter((a) => a.provider === 'claude').map((a) => ({
    key: `claude:${a.id}`, group: 'Claude Code', label: `Claude Code — ${a.label} (${a.displayDir}/skills)`, to: { agent: 'claude' as const, accountId: a.id },
  }));
  // Not where it already is: a personal skill copied onto itself is refused.
  const own = (d: Destination): boolean => skill.source === 'personal' && d.to.agent === skill.agent
    && (skill.accountIds === 'all' || skill.accountIds.includes(d.to.accountId as string));
  return [
    ...claude,
    { key: 'codex', group: 'Codex', label: 'Codex — every account, and Gemini CLI (~/.agents/skills)', to: { agent: 'codex' as const, accountId: null } },
    { key: 'gemini', group: 'Gemini CLI', label: 'Gemini CLI (~/.gemini/skills)', to: { agent: 'gemini' as const, accountId: null } },
  ].filter((d) => !own(d));
}

function CopyDialog({ skill, mode, projects, accounts, onClose, onDone }: {
  skill: Skill; mode: 'project' | 'personal'; projects: ProjectSummary[]; accounts: Account[]; onClose: () => void; onDone: (plan: SkillCopyPlan) => void;
}) {
  const options = destinations(mode, skill, projects, accounts);
  const [choice, setChoice] = useState(() => (options.find((o) => o.to.agent === skill.agent) ?? options[0])?.key ?? '');
  const [plan, setPlan] = useState<SkillCopyPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const dest = options.find((o) => o.key === choice);

  useEffect(() => {
    let live = true;
    setPlan(null);
    setError(null);
    setReplace(false);
    if (!dest) return;
    void call('skills.copy', { id: skill.id, to: dest.to, preview: true }).then(
      (r) => { if (live) setPlan(r.plan); },
      (e: Error) => { if (live) setError(e.message); },
    );
    return () => { live = false; };
  }, [skill.id, dest?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = async (): Promise<void> => {
    if (!plan || !dest) return;
    setBusy(true);
    const r = await attempt(() => call('skills.copy', { id: skill.id, to: dest.to, planId: plan.planId, overwrite: replace }), setError);
    setBusy(false);
    if (r?.done) onDone(r.plan);
  };

  return (
    <Dialog title={mode === 'project' ? `Copy ${skill.name} to a project` : `Copy ${skill.name} to your skills`} onClose={onClose} width={600}
      footer={<>
        <Button tone="quiet" onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={() => apply()} disabled={!plan || busy || (!!plan.replaces && !replace)}>
          {plan ? `Copy ${plural(plan.files.length, 'file')}` : 'Copy'}
        </Button>
      </>}>
      <div className="field">
        <label htmlFor="copy-dest">Copy to</label>
        <Select id="copy-dest" value={choice} onChange={setChoice}
          options={[...new Set(options.map((o) => o.group))].flatMap((g) => options.filter((o) => o.group === g).map((o) => ({ value: o.key, label: o.label, group: g })))} />
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {plan ? (
        <div className="plan">
          <p className="plan-dest">Creates <span className="mono">{plan.displayDest}</span></p>
          <ul className="plan-files">
            {plan.files.map((f) => <li key={f.path}><span className="mono">{f.path}</span><span className="faint">{size(f.bytes)}</span></li>)}
          </ul>
          {plan.skipped.length ? (
            <p className="faint small">Not copied: {plan.skipped.map((s) => `${s.path} (${s.why})`).join(', ')}.</p>
          ) : null}
          {plan.replaces ? (
            <div className="plan-warn" role="note">
              <p>
                There is already a <span className="mono">{plan.name}</span> there
                {plan.replaces.linkedTo ? <> (a link to <span className="mono">{plan.replaces.linkedTo}</span>)</> : ` (${plural(plan.replaces.files, 'file')})`}.
                Copying replaces it; what is there now goes to Wanigan’s trash.
              </p>
              <label className="check-row"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace it</label>
            </div>
          ) : null}
          {plan.inProject ? <p className="faint small">This writes into the project folder, so git will see the new files. Nothing is committed.</p> : null}
        </div>
      ) : !error ? <p className="faint">Working out what would be written…</p> : null}
    </Dialog>
  );
}

function seenBy(skill: Skill, projects: ProjectSummary[], accounts: Account[]): string {
  // Gemini CLI has one sign-in, and reads a project's skills only in a folder it trusts.
  const who = skill.agent === 'gemini' ? 'Gemini CLI'
    : skill.accountIds === 'all'
      ? `${AGENT[skill.agent]}, any account`
      : `${AGENT[skill.agent]} as ${skill.accountIds.map((id) => accounts.find((a) => a.id === id)?.label ?? 'an account').join(', ')}`;
  const where = skill.projectIds === 'all'
    ? 'in every project'
    : `in ${skill.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? 'a project').join(', ')}${skill.agent === 'gemini' ? ' once Gemini trusts the folder' : ''}`;
  return `${who}, ${where}${skill.enabled === false ? ' (once the plugin is switched on)' : ''}`;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** How Skills works, as a picture: every sentence is a rule the core's skills reader and copier enforce. */
function SkillsHow({ total, groups, onClose }: { total: number | null; groups: number | null; onClose: () => void }) {
  return (
    <HowDialog place="skills" title="How skills work" onClose={onClose}
      intro={<><strong>Every skill your agents can see, read from their own folders.</strong> Reading is free; nothing is copied or removed until you click, after you have seen what changes.</>}
      side={(
        <>
          <HowNote title="Where they live" tone="quiet">
            <ul>
              <li><strong>Personal:</strong> in an account’s own folder, for every project.</li>
              <li><strong>Project:</strong> in the repository, for that project: <code>.claude/skills</code>, <code>.agents/skills</code>, <code>.gemini/skills</code>.</li>
              <li><strong>Plugin</strong> and <strong>synced from claude.ai:</strong> read as they are; switched-off plugins say so.</li>
              <li>Codex and Gemini CLI both read <code>.agents/skills</code>.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Finding them" actor="wanigan">
        <HowBox actor="wanigan" title="Read from every folder" num={howNum(groups, 'folder with skills', 'folders with skills')}>
          Each account’s folder, each open project, and the shared Agent Skills folder. Folders with none are listed at the foot.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Pick one" num={howNum(total, 'skill', 'skills')}>
          Its SKILL.md opens beside the list, with who sees it, how to call it and where its folder is.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="Copying and removing" actor="you">
        <HowBox actor="you" title="Copy to a project, or to your skills">
          The plan comes first: every file it would write, and where. What is already there is replaced only if you tick Replace it, and goes to Wanigan’s trash.
        </HowBox>
        <HowArrow />
        <HowBox actor="board" title="In a project, git sees it">
          A copy into a project folder is a change for git to see. Nothing is committed.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Remove">
          A skill’s folder goes to Wanigan’s trash, where you can take it back; a link is removed and what it points to stays. Sessions that start after stop seeing it.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
