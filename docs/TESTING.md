# Testing

## Automated validation

Run the repository's CI-equivalent checks from the root:

```shell
bun install --frozen-lockfile
uv sync --locked --group dev
bun run fmt:check
bun run lint
bun run typecheck
bun run ci:test
bun run build
bun run release:check
bun run build:custom-node
git diff --check
```

`bun run ci:test` is the canonical combined frontend/backend test command. It
uses the repository-local `.ci-cache/uv` and `.ci-cache/ruff` directories,
disables pytest's disposable cache provider, sets the child-process temp paths
under `.ci-test-tmp/`, gives pytest a unique per-run `--basetemp`, and removes
that run directory after completion. Do not create task-specific cache or temp
directories. `bun run test` and `bun run test:unit` are aliases for
`ci:test`; `bun run test:frontend` and `bun run test:backend` remain focused
commands. Frontend/backend output is streamed in real time and followed by a
stage result. `ci:test` filters only the known harmless Lexical/happy-dom
`updateEditorSync` warning; focused frontend tests leave it visible.
Dots are enabled by default; use `bun run ci:test -- --no-dots` to disable
Bun's dot reporter while keeping all other output live.

The Lexical warning currently seen in the frontend suite is a test-runtime
timing issue: happy-dom dispatches `selectionchange` synchronously from
`Selection#setBaseAndExtent()` while Lexical is committing a read-only editor
state. It is not a command dispatched from this project's `editor.read()` path.
`PromptRichEditor` skips DOM-selection reconciliation for its model-only flush,
while normal editing selection behavior remains unchanged.

`bun run test:frontend` covers state, serialization, API mapping, DOM lifecycle, custom-widget restoration, image editing, trim playback, and the Bun build boundary. `bun run test:backend` covers the V3 schema and extension, state/manifest contracts, managed media validation, native media loading, and every Reference Loader route. Decoder-specific tests skip only when their optional development runtime is unavailable.

`dist/` is generated; edit `frontend/` and rebuild. The Registry archive must contain the root entrypoint, `backend/`, `dist/`, assets, and metadata while excluding frontend source, tests, caches, local environment files, and local ComfyUI paths.

## Standalone ComfyUI smoke test

The ordinary Media toolbar, channel shells, cards, captions, output
controls, ordering, upload/drop surface, and single-image panel use React. The
H3 Guide/Timeline workspace also uses React for the fixed shell, Timeline/List,
Guide markers, Inspector, recovery, draft footer, keyboard/pointer interaction,
and Guide drag/drop. Confirm a normal update keeps the same React surface and
does not replace focused captions, previews, player hosts, or Guide inputs.

Restore states with enabled/disabled H3 data, Start/End, Guide entries,
incomplete Guides, and disabled Guide media IDs. Confirm they remain on the same
React root and preserve timeline data. Type an unsubmitted Guide frame value,
change Position, then cause an unrelated board update; confirm the field value,
active field, selection, and existing Guide fields remain intact. Test Image
Start/End, standalone Audio frames, paired Guide input versus commit,
Apply/Cancel/Undo, workflow restore, and closing/reopening the Inspector. Two
Loader nodes must have independent forms; removing a node must clean up its
React root. Native MiniMax H3 generation/checkpoint behavior is a separate
runtime acceptance test.

Disable any earlier source-pack implementation before testing so node IDs and routes cannot collide.

1. In both Nodes 2.0 and Legacy Canvas, add **Reference Loader** and **Load Reference Image** from `reference / loader`, then add **[Reference Loader] Raw Prompt**, **[Reference Loader] Export Prompt for LLM**, **[Reference Loader] Media Outputs**, and **[Reference Loader] Start/End Frames** from `reference / output`. Connect `references` to all four output nodes and confirm the full board, Prompt editor, and compact single-image widget render without console errors.
2. Upload two differently sized images, a transparent image, audio, a video with sound, and a silent video. Verify previews, waveforms, trim metadata, VIDEO/**VA** default-on/AUDIO default-off, independent **VA**/**A** toggles, and disabled **VA**/**A** controls for the silent video.
3. Reorder each Media board independently; toggle outputs and enter unique captions. Verify 1-based output badges have no gaps. In Prompt, add Subject and Shot cards, verify tags are stored as `#name`, show the `S1`/`SH1` headers and green Shot tags, rename a definition, and confirm all exact references update without changing unresolved or escaped tags. Move sections and Subject cards with the header/button controls and `Alt+Up` / `Alt+Down`; confirm Raw/source text keeps tags while compiled output assigns stable Subject indexes and frame-sorted Shot indexes. Change a Shot frame in Subjects & Shots and verify it is serialized immediately without Apply; move a Shot by the Timeline Shot lane and verify that the Timeline edit still uses Apply/Cancel. Type `@` or `#` in a Prompt category and confirm autocomplete is laid out between that category's title and text body; type `/` in Add section and confirm the alias list is laid out immediately before Add section. Confirm image/video thumbnails appear, select mentions, and verify chips retain their media identity while their displayed ordinals follow reorder and enable changes. Confirm Subject/Shot definitions survive Prompt Clear and remain independent of Media Guides. Confirm MiniMax H3 Base and Freeform keep unregistered `#` text literal.
4. Exercise image View/Crop/Mask, flip, manual masking, transparent/solid backgrounds, and Restore original. Verify missing `rembg` reports a focused error, then install it and verify preview plus Apply.
5. Preview and trim audio and video. Confirm VIDEO-board preview/editor playback follows **VA** (audible when on, muted when off), Audio-board playback remains audible, and the optional derived AUDIO uses the same applied range.
6. Queue with Original/Limited image modes and Preserve/Opaque alpha modes. Verify list/caption alignment, independent image resolutions, RGB alpha compositing, and the actual VIDEO stream's embedded audio for both **VA** on and off.
7. Queue Start/End Frames with `I2V`, `L2V`, `FL2V`, `FL2V_LOOP`, and `T2V`. Verify the modes populate only start, only end, the first two, the first Image in both outputs, and neither output respectively, with missing Images producing `None`. Connect a STRING primitive to `enum_string` and confirm a non-blank value overrides the Combo while a blank value falls back to it. Enable a third Image and confirm image-driven modes reject the ambiguous frame selection while T2V still returns `(None, None)`.
8. Add enough Media cards to increase the board height, then resize Reference Loader vertically in both canvases. Verify the complete Media board remains visible without a nested Media scrollbar and Prompt stays directly adjacent with no expandable blank Media space.
9. Inspect `manifest_json` from [Reference Loader] Media Outputs; it must contain no base64 data or absolute path. Confirm `first_image` matches the first enabled item in `images` and becomes `None` when no Image is enabled.
10. Use Prompt **Copy source** and **Copy compiled** separately: the first must retain `#tags`, while the second includes generated Subject/Shot indexes and resolved media. Queue Raw Prompt and verify `raw_prompt` is the compiled model prompt. Toggle Raw and Structured and confirm the authoring text, definitions, Shot frames, and unresolved tags survive without index re-parsing. Try loading an earlier Prompt state and confirm it is recovered as Raw with a migration notice, then switches to v6 Structured without losing its text, definitions, or media mentions. Newer or malformed states remain rejected. Set Export Prompt for LLM `seconds`, add a nested mapping/list through `additional_yaml`, and queue it. Verify the compact strict `prompt` YAML starts with `video_duration_seconds`, contains the validated additional fields, active tag-to-caption mappings, an ordered `generation_directives` mapping, resolved media and Subject/Shot tags, and `source_video` only for enabled video-derived Audio paired with an enabled Video. Verify `references_yaml` and `generation_directives_yaml` are independently valid YAML documents and parse to the same mappings as their sections in `prompt`. Confirm the outputs contain no generated `schema_version`, top-level `prompt`, `prompt_schema_preset`, media payload, or absolute path. Confirm invalid YAML, duplicate/reserved keys, aliases, and out-of-range Shot frames are rejected. Save the workflow, restart ComfyUI, restore it, and verify state/order/captions/edit recipes/prompt parts, Subjects, Shots, and their frames.
11. Open the **Snapshot** dropdown and use **Save**, change Loader, Prompt, preset, image-output, caption, and horizontal/vertical card settings, then use **Load** on the downloaded JSON and confirm the complete saved state returns only after confirmation. Confirm cancellation and invalid files leave the current state unchanged. Verify Media **Clear** preserves Prompt and is undoable, while Prompt **Clear** immediately removes only Prompt sections and preserves Media and the selected Prompt view.
12. Install the Registry ZIP into a separate `custom_nodes` directory and repeat the minimal queue test.
13. With a ComfyUI build containing native MiniMax H3 support, connect `references` to **[Reference Loader] MiniMax H3 Wrapper**. Verify image-only, video-only, paired video/audio, audio-only video, and standalone audio toggle combinations without inserting list-index or frame-sampling nodes. Set Reference Loader's general socketless `Frames` and `FPS` inputs and confirm they are persisted in `loader_state`, carried in the bundle, and shown read-only beside the H3 Timeline summary. Open the top-level **H3 Timeline Guides** widget between Media and Subjects & Shots, enable it, and use the Image/standalone Audio G toggle and G-pencil actions from Media to assign Start/End and guide frames. Add a Shot, verify its matching G-pencil uses the same visual treatment, opens the Timeline at the Shot frame, and selects the Guide at that frame when one exists; verify the button does not add a Shot-to-Guide field to Prompt serialization. Confirm the ruler, list, Inspector, drag/drop, and Shot lane use the configured output scale while the serialized Guide frame remains native 24 fps, and changing output settings changes the execution fingerprint. Confirm Video cards and video-derived Audio expose no Guide controls and are rejected by the backend contract. Confirm Guide-only media does not change ordinary list lengths, captions, Prompt tags, or Picture/Video/Audio ordinals; save/reload and Snapshot/Undo preserve IDs and frames; same-kind overlaps fail without overwriting; same-frame visual plus audio is allowed; and Options Override refreshes Guide Images without changing ordinary Video/VA/A outputs. Confirm Timeline OFF remains usable when native `MiniMaxH3AddGuide` is unavailable, while enabled non-empty Timeline reports a focused native-feature error.
14. In **Load Reference Image**, confirm **Edit** sits beside the filename chooser and the preview consumes all remaining space below that row. Resize width and height independently in both directions and confirm neither dimension forces the other to grow. Verify both small and large images are contain-scaled against width and height with aspect ratio preserved. Choose an RGB image and then replace it with a transparent image. Open Edit and confirm no Description field is shown, then exercise crop/flip/mask/background/Restore original and confirm workflow reload retains the result. Confirm the node has no Prompt Advanced input or Description output. Change `preview_pixels` and verify the proxy URL/resolution changes without changing the execution fingerprint. Queue Preserve and Opaque modes with Original and Limited output sizes; verify RGB IMAGE, inverse-alpha or zero MASK, and the MPixel ceiling. Drop multiple files and non-image files to confirm only one image is accepted. Verify edited thumbnails continue to respect the configured preview ceiling. Separately verify the full **Reference Loader** still shows and persists captions in cards and Edit.

Legacy Canvas DOM interaction can feel less fluid than Nodes 2.0; this is a documented UI limitation, not a separate implementation target.
