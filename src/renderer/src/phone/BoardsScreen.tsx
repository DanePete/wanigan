// Each project, with how many cards wait in each column, to open its board.
import { COLUMNS } from '@shared/model';
import { ProjectMark } from '../components/ui';
import { Icon } from '../components/icons';
import { useQuery } from '../lib/api';
import { useNav } from './nav';

export function BoardsScreen() {
  const nav = useNav();
  const projects = useQuery('projects.list', {}, ['projects', 'board']);
  return (
    <section aria-labelledby="boards-title">
      <h1 id="boards-title" className="phone-title">Boards</h1>
      {projects.data && !projects.data.length ? <p className="phone-empty">Open a project on your Mac first.</p> : null}
      <ol className="phone-list">
        {(projects.data ?? []).map((p) => (
          <li key={p.id}>
            <button type="button" className="phone-item phone-row" onClick={() => nav.go({ name: 'board', projectId: p.id })}>
              <ProjectMark projectKey={p.key} size="s" />
              <span className="phone-row-main">
                <span className="phone-item-title">{p.name}</span>
                <span className="faint small">{COLUMNS.filter((c) => c !== 'done').map((c) => `${p.counts[c]} ${c}`).join(' · ')}{p.pausedAt ? ' · paused' : ''}</span>
              </span>
              {p.needsYou ? <span className="phone-badge">{p.needsYou}</span> : null}
              <Icon name="chevron" size={16} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
