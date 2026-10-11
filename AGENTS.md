# Wanigan 2: agent guide

Every rule in [CONTRIBUTING.md](CONTRIBUTING.md) applies to agents working here: read it
before changing anything. This one comes first:

## Never expose a real site

The owner's real sites (clients' and his own: every Drupal, WordPress or other
site he runs, locally or live, other than Wanigan and its demo) never leave
this Mac through anything you write or publish. That covers git (files, test
fixtures, code comments, commit messages, branch names), pull requests and
issues, release notes, websites, published artifacts and documents, posts,
screenshots and recordings: no screenshots or video of them, no site, theme,
module or component names, no paths, hostnames, IDs, content or page text.

- Test against a real site locally when asked to; keep what you capture in
  scratch space, and delete it when done.
- Fixtures and examples are made up (acme, northwind, example.test).
  Screenshots that leave the Mac show Wanigan's own demo, or there are none.
- Before any push, release, deploy or post: grep the diff and the text for
  real names, and open every image in it.
- If something slips out, stop and say so plainly. Remove it from the branch
  and its history, and tell the owner what is still reachable (GitHub keeps
  old commits by SHA until the repository is deleted or Support purges them).

## Wanigan Build Board

Track material app, Rust rebuild, editor, and website work in the private
[Wanigan Build Board](https://github.com/users/DanePete/projects/5). Before
starting, find or create the card and set its Kind, Workstream, Status, and
responsible person when known. Record observed progress, blockers, and verified
commit or pull request links at meaningful milestones. Keep Ready, Working,
Review, and Done aligned with the actual work and acceptance state.

After applicable checks and review, commit only accepted owned paths, push the
appropriate branch, and update the Project. In the coordinated Rust port, the
integration owner handles shared-file checks, commits, and pushes after a lane
is accepted; a ready handoff is not Done. Follow that checkout's `PORT-WORK.md`
claim and check barrier. Preserve unrelated work and the privacy check above.

The website's hourly Cloudflare Cron refreshes `wanigan.ai/board` from GitHub.
Only cards and people individually approved in the website's
`content/board-approved.ts` may appear publicly. Project updates never approve
new public prose or identities. Keep credentials, raw private issue text, and
private repository links out of public site data.
