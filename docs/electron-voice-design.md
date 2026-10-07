# Electron voice design

> **Historical context:** this page was written while the Electron and Tauri apps
> coexisted. Mentions of Tauri helpers, pages, tests and regression results describe
> that migration period; the Tauri shell has since been removed and the shared code
> now lives in `electron/src/shared/`. Existing Tauri installs: see the
> [migration guide](electron-migration.md).

Open Design from the cloning sidebar or command search. Choose a preset or adjust
voice traits, write a script, and synthesize. The existing Tauri category, conflict
resolution and seed helpers build the request; clone references are never forwarded.
A seed stays fixed while adjusting traits, and New seed creates another identity.

Until it can run, Synthesize audio looks unfinished (dashed) rather than greyed out,
and the first reason shows above the composer. Pressing it lists what is missing —
the script, an engine that is still starting or not set up, or one that cannot
design voices (or reuse a saved voice's sample) — each with a button that goes to
the script, the engine notice or the engine settings. While a description is being
read into details, the button waits for a moment instead.

Save as voice profile stores the seed and validated attribute state using the existing
backend profile endpoint. Saved design profiles can be restored from the Design sidebar.
Generation uses the shared lifecycle, cancellation, progress and Vidstack output player.
Local natural-language trait extraction calls the existing deterministic mapper;
manual choices cancel queued or running mappings. Personality and demo starting points,
the collapsed recipe summary, language and production controls, profile editing and persona
export use the same established controls as the Tauri workflow. Native verification and any
remaining release gates are recorded in `electron/PARITY.md`.
