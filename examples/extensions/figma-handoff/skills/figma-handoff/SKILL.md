---
name: figma-handoff
description: Read a Figma frame into an implementation brief before any UI is built from it.
---

# Figma handoff

Read a design out of Figma and write down what it actually specifies, before
any component is built from it. The failure this prevents is a component built
from a screenshot: spacing eyeballed to the nearest multiple of four, a colour
sampled from a JPEG instead of named from the token it came from, and a state
nobody noticed because it was on a frame further down the page.

## Trigger

Use this when a task starts from a Figma link or frame name and ends in UI
code. Do not use it for a copy change, a bug fix in an existing component, or
any task where no design is being read.

## Inputs

- A Figma file URL or `file key` plus a node id, from the person who asked.
- The `figma` MCP server, installed by this extension. If its tools are not
  listed as `mcp__figma__*`, stop and say so rather than guessing at the
  design.
- The project's token source: the file `docs/figma.md` names, or the token
  definitions the repository already keeps.

## Steps

1. Fetch the node with the `figma` MCP server. Do not rely on an image of the
   frame for any number you are going to type into code.
2. List every variant and state present on the frame — default, hover, focus,
   active, disabled, loading, empty, error. Name the ones the design does not
   cover; those are decisions being handed to you, and they are cheaper to ask
   about now.
3. Map each colour, spacing, radius and type value to an existing project
   token. Where no token matches, write the raw value down and flag it as a
   proposed new token. Do not invent a token name and do not inline a literal
   to avoid the conversation.
4. Record the responsive behaviour the frame shows and the behaviour it does
   not: which widths exist as frames, and what happens between them.
5. Write the brief — tokens, states, responsive rules, open questions — and put
   the open questions first.

## Verification

- Every value in the brief traces to a node in the Figma response or to a named
  project token. If you cannot say which, it does not go in the brief.
- Run the project's token check (`npm run tokens:check` in a repository that
  has it) before proposing a new token, so you are not adding one that exists.
- The open-questions list is answered, or explicitly deferred by the person who
  asked, before implementation starts.

## Boundaries

- Do not write component code from this skill. It produces the brief; building
  from it is a separate task with its own review.
- Do not edit the Figma file. This is a read.
- Do not paste the Figma personal access token into a transcript, a commit, or
  a file. It reaches the MCP server through the environment and has no reason
  to appear anywhere else.
- If the frame and the repository disagree about an existing component, report
  the disagreement. Do not silently pick one.
