## frontend/src

## Context

`ComfyUI` + native DOM, with React ordinary Media and a Media card Guide editor trial

## Purpose

Contains the frontend extension that runs inside the ComfyUI browser UI. Use
the ComfyUI `app` and `api` modules from `../../scripts/app.js` and
`../../scripts/api.js` together with native browser DOM APIs here to register
extensions, settings, commands, widgets, and other UI behavior.

## Prompt editor responsibilities

- `reference-loader/prompt-state.ts` owns the document format, parsing and compilation.
- `reference-loader/components/prompt-editor.ts` owns the live document, input events,
  autocomplete state, Shot drafts and ComfyUI graph transactions. Editable DOM is
  synchronized here before serialization and document changes.
- `reference-loader/components/prompt-dom.ts` provides contenteditable text/chip
  conversion, caret handling and shared tag visuals. It does not depend on ComfyUI.
- `reference-loader/components/prompt-cards.ts` builds detached Section and
  Subject/Shot cards from supplied state. It does not change that state, install
  event handlers or retain a controller reference.

Keep document changes in the controller and document operations in `prompt-state.ts`;
card builders should only describe the view. Preserve the distinction between the
committed document and the Shot draft when displaying definitions.

## React ordinary Media surface

`reference-loader/components/loader-react.tsx` renders the GUIDE-free references
surface and the single-image Loader. It subscribes to the Controller's stable
view snapshot with `useSyncExternalStore` and sends narrow commands back through
the Controller. The React tree does not own a second `LoaderState` or duplicate
history, serialization, upload, preview, or ComfyUI transaction logic.

When a timeline is enabled or contains Start/End, Guide, or disabled-media data,
the Controller selects the preserved legacy Loader surface so restore cannot
silently lose Guide state. Legacy delegated handlers are scoped to that legacy
root; the React subtree owns its own Media events. Direct drops on the outer
widget remain supported for the legacy fallback.

## React Guide editor trial

`reference-loader/components/h3-guide-editor.tsx` renders the Media card Guide
placement list and footer. The add-form fields are local React state; the Loader
controller still owns Guide drafts, validation, Apply/Cancel and Undo. A portal
keeps the footer in the existing sibling card body without changing the CSS layout.

The controller retains both React containers across board renders and unmounts
the tree when the edit session ends, is replaced, or the node is destroyed. The
preserved legacy delegated handlers are scoped to the legacy container. Native
frame `change` commits remain distinct from per-keystroke input so paired
connections split only on commit. A synchronous flush at the controller/view
boundary preserves existing immediate focus restoration; React form handlers use
normal state updates.

The incomplete-Guide recovery screen, Timeline interaction and Prompt editing stay
native DOM. No React store owns a second copy of the saved Loader state.

The Bun bundler includes React in the single browser ESM entry. Source and test
tsconfigs include TSX with the automatic JSX runtime. `bun run build` selects the
production React build; `bun run dev` selects development React with watch/rebuild
and source maps. The watch command does not provide React Fast Refresh.
