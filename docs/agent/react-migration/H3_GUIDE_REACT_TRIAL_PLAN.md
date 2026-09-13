# H3 Guide React trial

## Scope

Convert the Media card's Guide placement list and add/apply/cancel form to React.
Keep the existing UI layout, validation, paired-guide behavior, draft ownership,
Apply/Cancel, Undo and serialized state. The incomplete-guide recovery screen,
Timeline pointer interaction and Prompt contenteditable remain native DOM.

## Files and boundaries

- `frontend/src/reference-loader/components/h3-guide-editor.tsx`: render the
  placement list and footer from props; keep only the add-form fields in React
  state. Use stable Guide IDs as keys. Mount one React tree with a footer portal
  because the existing card has two sibling display regions.
- `frontend/src/reference-loader/components/loader.ts`: retain both containers
  across board renders, dispose them when the editing session changes or ends,
  and pass view data and callbacks to React. Keep validation, state mutation,
  paired-side detachment and graph history here. Remove the replaced string
  rendering and DOM-based add-form synchronization. Scope legacy delegated
  click/input/change handling away from the React containers.
- `frontend/build.ts`, `frontend/dev.ts` and frontend tsconfigs: bundle installed
  React with the existing single-entry Bun browser ESM build; align development
  and production JSX/environment configuration and include TSX in type checks.
- Frontend tests: retain existing Guide regression coverage; add focused coverage
  for container/input identity, add-form state across board updates, multiple
  controllers and session cleanup. Verify TSX bundling through the build checks.
- `frontend/src/README.md`, `docs/TESTING.md`: document ownership and browser checks.

The controller expects rendered fields to exist immediately for focus restoration.
Use a synchronous React flush only at this imperative view-update boundary;
ordinary React form state uses normal event updates. Frame edits keep the native
input/change distinction so paired Guides split on commit, not on every keystroke.

## Validation

Run typecheck, frontend tests, formatting/lint and the production build. Check the
development Bun bundling path as well. Browser checks, when available: open Image
and Audio Guide editors, add/remove roles and frames, preserve typing/focus during
an unrelated board update, Apply/Cancel/Undo, reopen, workflow restore, and remove
the node. Report automated validation separately from live ComfyUI verification.
