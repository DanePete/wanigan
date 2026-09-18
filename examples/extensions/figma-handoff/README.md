# Figma handoff — an example Wanigan extension

A complete, valid extension directory. It declares one MCP server, one skill,
one review gate and one project instructions file — four of the five surfaces
an extension can declare; the fifth, a Scout source, has its own example in
`../cursor-scout-source/`. Copy it, change the ids, and make it yours.

```
figma-handoff/
  wanigan-extension.json          the manifest
  skills/figma-handoff/SKILL.md   the skill it declares
  docs/figma.md                   the instructions it declares
  README.md                       this file
```

## What it declares

- **An MCP server**, `figma`, run as `npx -y figma-mcp`, global scope, with a
  Figma personal access token in `FIGMA_TOKEN`. The agent sees its tools as
  `mcp__figma__*`.
- **A credential**, `acme.figma`, which is where that token comes from. The
  value lives in Wanigan's encrypted credential store, not in this directory.
  The credential id starts with the extension id because an extension may only
  name its own.
- **A skill**, `figma-handoff`: read a Figma frame into an implementation brief
  before building anything from it.
- **A gate**, `npm run tokens:check`, so a change that drifts from the design
  tokens fails review.
- **Instructions**, `docs/figma.md`, the project-scoped conventions for working
  from Figma.

Nothing here runs inside Wanigan. The only thing that executes is the MCP
server, out of process, started by your agent's CLI — which is the whole point,
and why you can read this directory and know what installing it does.

## Try it

```
npm run cli -- extension-validate examples/extensions/figma-handoff
npm run cli -- extension-preview  examples/extensions/figma-handoff
```

`extension-preview` prints the exact consent screen an operator sees at
install, from the same function the app renders. Read it before you publish
anything of your own.

## What installing it does today

It installs the `figma` MCP server. The skill, the gate and the instructions
are validated and listed on the extension's card with `applied: false` and a
note saying what each still needs — a gate runs shell commands on the
operator's machine and has to go through Wanigan's existing review-recipe
consent, and skills and instructions are files Wanigan writes through its
reversible, base-hash-guarded projection path. Both routes exist; extensions
are not wired into them yet, and the card says so rather than pretending
otherwise.

## Caveats worth reading before you copy it

`npx -y figma-mcp` downloads and runs a package from the npm registry. Wanigan
shows you that command and pins your approval to the manifest's digest; it does
not audit the package, and the package can change under the same command line
at the next run. `figma-mcp` here stands for whatever Figma MCP server you have
decided to trust — substitute it, and pin a version if you want the command to
mean one thing.

`requires.wanigan` is `>=0.1.0`. Set it to the oldest Wanigan you have actually
run your extension against, not the one you are running today by default.

See `docs/extensions/AUTHORING.md` for the rules and the reasons behind them.
