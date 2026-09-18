# Figma conventions

The `figma` MCP server is the source for design values. Read node data from it
rather than measuring a screenshot; a number eyeballed off an image is a number
that is wrong by one or two pixels and cannot be traced back to anything.

Colour, spacing, radius and type come from project tokens. If a design uses a
value no token covers, say so and propose the token; do not inline the literal
to avoid the conversation, and do not rename an existing token to fit.

A design is not implemented until its states are. Default, hover, focus,
active, disabled, loading, empty and error each either exist in the frame or
are an open question — list the ones the design does not answer instead of
choosing quietly.

The Figma personal access token reaches the MCP server through its environment.
It does not belong in a transcript, a commit, a `.env` file in the repository,
or a screenshot.
