## frontend/src

## Context

`ComfyUI` + `DOM (browser native)` Context

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
