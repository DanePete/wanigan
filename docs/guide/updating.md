# Updating

How Wanigan checks for a new version, and how to install one without losing your work. Back to the [README](../../README.md).

**Wanigan 2 › Check for Updates…**, or **Settings › Updates**, asks GitHub
whether a newer version is out. Wanigan can also check once a day: the sidebar
asks you once, and nothing is checked until you say yes. A check reads GitHub's
public list of releases. No project, conversation or usage data is included;
GitHub receives normal connection metadata. Someone running a prerelease
(alpha, beta or release candidate) is offered newer prereleases and stable
releases; someone on a stable release is offered only stable releases.

To install a new version, quit Wanigan, open the disk image and drag Wanigan 2
into Applications, replacing the old one. Your projects, boards and history live
in the data folder, not in the app, so they stay. Sessions run in Wanigan's
core, which outlives the window: if any are running when the new version opens,
it asks before restarting the core, because a restart ends them.

This ad-hoc-signed build offers manual downloads; automatic installation is not implemented.

A version without Check for Updates in its Wanigan 2 menu cannot tell you
about new ones: watch the repository's releases on GitHub (Watch › Custom ›
Releases), or download the newest from there once.
