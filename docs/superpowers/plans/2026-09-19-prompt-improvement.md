# Prompt improvement implementation

1. Capture current prompt surfaces in both themes using the isolated renderer
   harness. Extract the textarea host and empty action registry without changing
   behavior; verify and commit that conversion separately.
2. Add the pure request/result contract, optional generation module, bounded
   no-tools Messages request, cancellation, and additive usage ledger. Exercise
   the service against real SQLite with a substituted external transport.
3. Add the shared prompt action and dialog with original/proposed drafts, model
   and cost disclosure, questions, cancellation, and apply guards. Register it
   once and connect the module through typed preload and existing registries.
4. Run the renderer probe for every affected composer, both themes, stale edits,
   disabled controls, errors and late results. Inspect the screenshots and fix
   layout issues. Run the full repository test suite and diff checks, then commit
   the feature independently of the conversion and report any limits honestly.
