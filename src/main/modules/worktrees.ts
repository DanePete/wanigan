import { inspectRecoveryOwner } from '../recovery-inspection';
import type { WaniganModule } from '../module-registry';
import * as worktrees from '../worktrees';
import * as worktreeSetup from '../worktree-setup';
import { liveSessionIds } from '../sessions';
import { assertManagedRoot } from '../roots';
import { forecastCollisions } from '../collisions';
import { migrateWorktrees } from './session-storage';

export const worktreesModule: WaniganModule = {
  id: 'worktrees',
  label: 'Worktrees',
  required: {
    reason: 'Worktrees owns checkout containment, dependency preparation, executable setup consent and workspace lifecycle evidence.',
  },
  migrate: migrateWorktrees,
  recovery: { inspect: d => inspectRecoveryOwner(d, 'worktrees') },
  ipc(handle, context) {
    // Read paths are confined too. Every other handler in this block passes its
    // root through assertManagedRoot; these two took whatever the renderer named
    // and ran git in it, which is the one rule this file states most often —
    // renderer input is untrusted until main has validated it. Reading is a
    // smaller grant than removing a tree, and it is still a grant.
    //
    // No String() on the way in: assertManagedRoot is typed (root: unknown) and
    // answers a non-string with "That repository is not a folder Wanigan can act
    // on", whereas String(Symbol()) throws a TypeError that names nothing and
    // String(undefined) manufactures the path "undefined" for it to refuse.
    //
    // One honest caveat: listWorktrees returns paths straight from `git worktree
    // list --porcelain`, which can name a worktree outside every managed root, so
    // a future UI that lists those and then asks about one gets a refusal from
    // worktrees:status rather than a status.
    handle('worktrees:list', (repoRoot: unknown) =>
      worktrees.listWorktrees(assertManagedRoot(repoRoot, 'That repository')));
    handle('worktrees:status', (p: unknown) =>
      worktrees.worktreeStatus(assertManagedRoot(p, 'That worktree')));
    // removeWorktree already refuses a directory git does not call a worktree,
    // but that leaves every worktree on the machine in range of a channel name.
    // Confining the base first means Wanigan only deletes trees inside the
    // projects and worktrees it has a record of.
    handle('worktrees:remove', (p: string, force: boolean) =>
      worktrees.removeWorktree(assertManagedRoot(p, 'That worktree'), force));
    // Without this a fleet run ends with N worktrees holding the only copy of the
    // work and no way to land any of them from inside the app. Every refusal
    // comes back as { merged: false, detail }; it only throws when there is no
    // worktree at the path at all, so ok:false here is the rare case.
    handle('worktrees:merge', (p: string, opts?: { squash?: boolean; message?: string }) =>
      worktrees.mergeWorktree(assertManagedRoot(p, 'That worktree'), opts));
    // Whether the agents' worktrees would merge — with their base and with each
    // other — asked of git in the object database while the work is in flight.
    // Keyed on a project id; main resolves the repository and every worktree.
    handle('worktrees:forecast', (projectId: string) => forecastCollisions(projectId));
    handle('worktrees:orphans', () => worktrees.reconcileWorktrees(liveSessionIds()));
    handle('worktrees:relink', (p: string) => worktrees.relinkWorktree(assertManagedRoot(p, 'That worktree')));
    handle('worktrees:forSession', (id: string) => worktrees.worktreeForSession(id));
    // What each new worktree of a project is given: how dependency folders
    // arrive, and the setup and teardown commands. Keyed on a project id; main
    // resolves the repository. Saving commands is command text `$SHELL -lc` runs
    // in every worktree Wanigan makes for the project, from sessions and headless
    // runs alike, so the question goes on the save — asked here, where a
    // compromised renderer cannot decline to render it — and never on the run.
    handle('worktrees:setup', (projectId: unknown) => worktrees.worktreeSetupConfig(projectId));
    handle('worktrees:setDepsMode', (projectId: unknown, mode: unknown) => worktreeSetup.setDepsMode(projectId, mode));
    handle('worktrees:saveCommands', (projectId: unknown, input: unknown) =>
      worktreeSetup.saveWorktreeCommandsWithConsent(context.getWindow(), projectId, input));
    handle('worktrees:commandRuns', (projectId: unknown, limit?: unknown) => worktreeSetup.worktreeCommandRuns(projectId, limit));

  },
};
