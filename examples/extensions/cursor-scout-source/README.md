# Cursor changelog for Scout — an example Wanigan extension

The smallest extension that does something: one manifest, one declaration, no
files beside it. It gives Improvement Scout one more public page to read, and
nothing else.

```
cursor-scout-source/
  wanigan-extension.json          the manifest
  README.md                       this file
```

## What it declares

One **Scout source**, `cursor-changelog`: the official Cursor changelog at
`https://cursor.com/changelog`, kind `changelog`, publisher Cursor. The
`publisher` on a source names who publishes the page, not who wrote the
extension — that is the manifest's own `publisher`, Acme here, and the consent
screen shows both.

It declares no MCP server, no skill, no gate, no instructions and no
credential. A Scout source is a public page over https and takes no secret;
the manifest refuses a username or password in the url and has no credential
block for a source to point at.

## What installing it does

It adds a weekly fetch of `cursor.com`.

Scout sources are applied at install, unlike skills, gates and instructions. A
row lands in Scout's source registry with this extension as its owner, enabled,
and from then on it is one of the pages Scout reads on its schedule —
Saturday 09:00 local by default — and cites when it proposes a product change.
Scout proposes; it edits nothing.

The fetch is unattended, which is the whole reason the consent screen shows a
source as a **host** line that says when as well as where:

> Wanigan will fetch cursor.com on Scout's weekly schedule to look for
> changes, for the source “Cursor changelog”.

Two things are still yours to switch on. Scout's weekly research and its
separate unattended-network permission are both off until you turn them on in
AI Improvement Scout; installing this extension adds the destination, it does
not grant the schedule. Until both are on, the source is fetched only when you
press **Research now**. Either way, the Privacy & data panel's egress report
lists `cursor.com` the moment this is installed and stops listing it when it is
uninstalled — a network destination you can see arrive and leave.

## Try it

```
npm run cli -- extension-validate examples/extensions/cursor-scout-source
npm run cli -- extension-preview  examples/extensions/cursor-scout-source
```

`extension-preview` prints the exact consent screen an operator sees at
install, from the same function the app renders. For this extension it is one
host line and one applied artifact row. Read it before you publish anything of
your own, and read the host line twice: it is the sentence someone else will
be asked to agree to every week.

## Things to know before you copy it

- **The id is shared with the built-in sources and with every other
  extension.** `cursor-changelog` is refused, not overwritten, if another
  extension or a hand-added row already holds it; the card names the holder.
  The url is unique across the registry for the same reason.
- **Uninstall removes the row only if it still matches what this manifest
  declared.** Edit the label, the description or the url after install and the
  row is kept and named on the card, because the sentence a person reads to
  decide whether to keep being polled is no longer this extension's sentence.
- **Disabling this extension disables its source.** Re-enabling the extension
  does not re-enable the source; that switch is in AI Improvement Scout, and
  the card says so.
- `requires.wanigan` is `>=0.1.0`. Set it to the oldest Wanigan you have
  actually run your extension against.

See `docs/extensions/AUTHORING.md` for the rules and the reasons behind them.
