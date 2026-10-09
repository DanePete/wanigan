// What is running, in every project, newest first.
import { LIVE_STATES } from '@shared/model';
import { Button, ProjectMark, StateMark } from '../components/ui';
import { Icon } from '../components/icons';
import { useQuery } from '../lib/api';
import { PROVIDER_LABEL, duration } from '../lib/format';
import { localModelLabel } from '@shared/local-models';
import { useNav } from './nav';

export function SessionsScreen() {
  const nav = useNav();
  const sessions = useQuery('sessions.list', { live: true }, ['sessions']);
  const projects = useQuery('projects.list', {}, ['projects']);
  const key = new Map((projects.data ?? []).map((p) => [p.id, p.key]));
  const live = (sessions.data ?? []).filter((s) => LIVE_STATES.has(s.state)).sort((a, b) => b.startedAt - a.startedAt);
  return (
    <section aria-labelledby="sessions-title">
      <h1 id="sessions-title" className="phone-title">Sessions</h1>
      {sessions.data && !live.length ? (
        <div className="phone-empty">
          <p>Nothing is running.</p>
          <Button tone="primary" icon="plus" onClick={() => nav.tab('new')}>Start a session</Button>
        </div>
      ) : null}
      <ol className="phone-list">
        {live.map((s) => (
          <li key={s.id}>
            <button type="button" className="phone-item phone-row" onClick={() => nav.go({ name: 'session', id: s.id })}>
              <ProjectMark projectKey={key.get(s.projectId) ?? '?'} size="s" />
              <span className="phone-row-main">
                <span className="phone-item-title">{s.title}</span>
                <span className="faint small">
                  {PROVIDER_LABEL[s.provider]}{s.model ? ` · ${localModelLabel(s.model) ?? s.model}` : ''} · {duration(s.startedAt)}
                </span>
              </span>
              <StateMark state={s.state} />
              <Icon name="chevron" size={16} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
