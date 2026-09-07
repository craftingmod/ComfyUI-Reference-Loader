# ComfyUI Reference Loader

Reference Loader is a ComfyUI V3 custom node for uploading, arranging, and editing image, audio, and video references. It emits one compact `REFERENCE_LOADER_BUNDLE` containing its structured prompt snapshot alongside media, captions, and a payload-free manifest. Its optional H3 Timeline Guides editor lives inside Media: it reuses existing cards, previews, waveform/playback, and editing controls to assign media to native MiniMax H3 Start/End/Guide frame positions without changing the ordinary reference lists or prompt tags. **Load Reference Image** reuses the same managed upload, bounded preview, and non-destructive image editor for a single Load Image-style input. **[Reference Loader] Raw Prompt** extracts the bundle's compiled `raw_prompt` STRING. **[Reference Loader] Reference Prompt Cache** reuses a workflow-persisted LLM prompt while the bundle fingerprint is unchanged. **Prompt Live Cache** provides the same lazy cached-prompt pattern for any caller-supplied string identity. **[Reference Loader] Export Prompt for LLM** converts the snapshot and active captions into strict YAML through one connection, while **[Reference Loader] Media Outputs** unpacks the standard media and metadata values. **[Reference Loader] Start/End Frames** projects up to two enabled images into nullable I2V/L2V/FL2V/FL2V_LOOP/T2V frame outputs. **[Reference Loader] MiniMax H3 Wrapper** passes the same bundle to ComfyUI's native MiniMax H3 reference-conditioning implementation without manual list indexing.

**Reference Loader** and **Load Reference Image** are available under `reference / loader`; **[Reference Loader] Reference Prompt Cache** is under `reference / prompt`; **Prompt Live Cache** is under `reference / util`; **[Reference Loader] Raw Prompt**, **[Reference Loader] Export Prompt for LLM**, **[Reference Loader] Media Outputs**, and **[Reference Loader] Start/End Frames** are under `reference / output`; and **[Reference Loader] MiniMax H3 Wrapper** is under `reference / integration`. A minimal workflow is included at [`workflows/Reference_Loader.json`](workflows/Reference_Loader.json).

## Features

- Independent Images, Videos, and Audio boards with reorder, enable, caption, and preview controls; per-video **VA** and derived **A** toggles are independent
- Per-image crop, flip, mask, background, optional `rembg`, and restore-original editing
- Audio/video trim and playback; VIDEO values retain embedded audio by default and can be muted at execution with **VA**
- Optional per-image MPixel limiting and alpha compositing at execution
- Load Image-style single-image picker with RGB IMAGE, inverse-alpha MASK, and inline Edit
- Structured prompt editor with thumbnail `@` media mentions, independent `#` Subject/Shot definitions, and a literal-tag raw view
- Subject and Shot source data stays tag-based; compiled output assigns `<Subject N>` and `[Shot N]` indexes only at queue/export time
- Browser JSON snapshots for saving and restoring Loader, Prompt, and related node settings
- Stable media mentions compiled to `<Picture N>`, `<Video N>`, and `<Audio N>` tags
- Strict YAML export of active captions and structured prompt sections for LLM inputs
- Compact reference bundle with a dedicated [Reference Loader] Media Outputs node
- Explicit IMAGE/AUDIO/VIDEO lists with index-aligned caption lists after unpacking
- Nullable start/end IMAGE projection for I2V and first-last-frame video workflows
- Optional frontend-only two-image mode that guards the enabled IMAGE output count
- Optional H3 Timeline Guides editor inside Media for Start, End, up to 32 visual/audio guide rows, and an independent Shot lane at 24 fps; guide-only media stays out of ordinary reference outputs
- Managed, content-validated storage under `ComfyUI/input/reference_loader`

## Installation

Install through ComfyUI Manager, or extract a release archive into `ComfyUI/custom_nodes`. Restart ComfyUI after installation. Release archives include `dist/index.js`, so Bun and TypeScript are needed only for development.

Pillow, NumPy, torch, and PyAV are supplied by ComfyUI. Automatic background removal is optional; install it in the same Python environment as ComfyUI:

```shell
pip install ".[rembg]"
```

## Outputs

**Load Reference Image** presents the same essential surface as ComfyUI's Load Image: an image chooser with an adjacent **Edit** action and one preview that consumes the remaining widget height without coupling node width to node height. It emits one RGB `image` and one `mask`; it deliberately has no prompt/description widget or output. The preview enlarges or reduces its image with contain scaling, preserving aspect ratio against both available dimensions. In Preserve mode the mask is the inverted alpha channel, matching ComfyUI's Load Image convention; an image without alpha emits a zero mask. Opaque mode composites transparency onto `alpha_background` and emits a zero mask. `limit_image_pixels` downsizes only execution output above the selected MPixel ceiling, while socketless `preview_pixels` controls only the bounded card/editor thumbnail and does not affect execution outputs or the execution fingerprint/cache. Animated image files currently use their first frame. The full **Reference Loader** continues to support captions/descriptions on its media cards and editors.

Image uploads use the image formats registered by the installed ComfyUI/Pillow runtime rather than a fixed extension list. The decoded content determines the canonical format, so a valid JPEG incorrectly named with a `.png` suffix is accepted and stored with a `.jpg` suffix. EXIF orientation is applied when readable; malformed EXIF metadata falls back to the stored pixel orientation instead of rejecting an otherwise decodable image.

**Reference Loader** emits only `references` as `REFERENCE_LOADER_BUNDLE`. Connect it to **[Reference Loader] Raw Prompt** when the compiled prompt STRING is needed directly; its output is named `raw_prompt`. Connect the same bundle to **[Reference Loader] Export Prompt for LLM**, set the required 4–15 second target duration, optionally select a MiniMax H3 `style`, and optionally provide an `additional_yaml` top-level mapping. Its `prompt` output is compact strict YAML that starts with `video_duration_seconds`, optionally contains a selected top-level `style` mapping, merges validated additional fields, and then contains active `<Picture N>`, `<Video N>`, and `<Audio N>` caption mappings plus the ordered `generation_directives` mapping. The default `none` style emits no `style` mapping and leaves style selection to the prompt/request. The exporter also provides `references_yaml` and `generation_directives_yaml` STRING outputs for processing either generated top-level mapping independently. It has no generated schema-version field. A derived Audio mapping includes `source_video` when its Video is also enabled. The frontend-only `prompt_schema_preset` is never included. Connect `references` to **[Reference Loader] Media Outputs** when standard ComfyUI media, caption-list, manifest, or the nullable scalar `first_image` value is needed.

Connect it to **[Reference Loader] MiniMax H3 Wrapper** for native MiniMax H3 reference conditioning. The Wrapper retains the native `clip`, `vae`, `audio_vae`, `prompt`, `width`, `height`, `length`, and `ref_image_size` controls and replaces the native `ref_*` Autogrow sockets with `references`. Reference videos are decoded and sampled to the 24 fps IMAGE batch expected by MiniMax H3; no separate sampling node is required.

Expand **H3 Timeline Guides** inside Media to enable the optional timeline. Image and standalone Audio cards expose independent **G** Guide toggles plus **G-pencil** editors beside the normal **I/A** output controls; Video cards intentionally expose no Guide controls. Start and End accept existing Images, while each guide row accepts an Image, a standalone Audio, or both, plus a non-negative output frame index. Prompt Shots appear in a separate **Shot** lane and keep their own tag/frame draft; they never enter H3 conditioning. The editor opens as an overlay inside the selected Media grid. Disabled ordinary references remain selectable, and Guide-only media is loaded into the bundle's separate `guide_media` mapping without changing reference ordinals, captions, or Prompt tags. The native Wrapper passes Start at frame 0, ordinary rows at their saved positions, and End as `-1` so ComfyUI resolves it against the actual output length. Rows are ordered by frame and stable guide ID; overlapping visual or audio ranges are rejected instead of being overwritten. Timeline state is saved inside `loader_state`, while panel collapse state is UI-only. The product limit is 32 intermediate guides; it is not a MiniMax H3 model limit.

Timeline execution requires a ComfyUI build exposing native `MiniMaxH3AddGuide`. Timeline OFF, or an enabled timeline with no selected positions, keeps the ordinary native R2V delegation path. This repository has contract, routing, and fake-native tests for the feature; model-quality and full conditioning compatibility still require a real H3 checkpoint/runtime smoke test.

For an LLM-refined prompt path, connect the LLM STRING to **[Reference Loader] Reference Prompt Cache** as `live_prompt`, and connect the same `references` bundle. When `cached_ref_hash` matches the bundle's fingerprint, the node returns `cached_prompt` without evaluating `live_prompt`, so the LLM branch is skipped by ComfyUI's lazy execution. Optionally connect a canonical string of LLM-side settings to `invalidate_key`; a changed value invalidates the prompt cache. For example, use KJ Nodes' **Something To String** and/or string-combine nodes to include a seed, branch name, model, temperature, or other prompt-generation settings. `cached_prompt` remains editable for manual refinement, while `cached_ref_hash` and `cached_invalidate_key` are kept read-only. A stale reference hash or invalidate key, or enabled `force_refresh`, evaluates `live_prompt` and captures the new prompt, reference hash, and invalidate-key fingerprint into the workflow widgets. Leave `force_refresh` off for normal use; enable it when another LLM-side setting is not included in `invalidate_key`.

For a source-independent prompt cache, add **Prompt Live Cache** from `reference / util`. Connect a required complete cache identity to `invalidate_key`, the generated STRING to `live_prompt`, and use its editable `cached_prompt` widget as the persisted fallback. Unlike **[Reference Loader] Reference Prompt Cache**, this node does not automatically include a Reference Loader fingerprint; include every relevant source and generation setting in `invalidate_key` yourself.

Connect `references` to **[Reference Loader] Start/End Frames** and choose `I2V`, `L2V`, `FL2V`, `FL2V_LOOP`, or `T2V`. `I2V` emits only the first enabled image as `start_image`; `L2V` emits the last enabled image as `end_image`; `FL2V` emits the first two as start/end; `FL2V_LOOP` emits the first image as both start/end; and `T2V` emits `(None, None)`. Missing frames remain `None`. The optional `enum_string` socket accepts the same abbreviations and overrides the Combo when its trimmed value is non-empty. Image-driven modes reject more than two enabled images so frame roles stay unambiguous; T2V ignores images.

Enable the Loader's advanced `two_image_mode` widget to prevent a third IMAGE output from being enabled. Additional uploaded images remain available but start disabled. The socketless widget is a write-only frontend proxy and does not alter execution or cache fingerprints; Start/End Frames still validates the bundle at execution.

The Media board uses its full content height without accepting extra flex height, so it does not gain a nested scrollbar and the Prompt editor stays immediately adjacent instead of being separated by blank Media space.

| Output                      | Contract                                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `images` / `image_captions` | Enabled Images order; equal list lengths                                |
| `audios` / `audio_captions` | Enabled standalone and video-derived Audio order; equal list lengths    |
| `videos` / `video_captions` | Enabled Videos order; equal list lengths                                |
| `manifest_json`             | Deterministic metadata without tensors, base64 media, or absolute paths |

Each new video starts with VIDEO and embedded VIDEO audio (**VA**) enabled, while its separate AUDIO output is disabled. **VA** and **A** are independent: disabling **VA** creates a VIDEO value without embedded audio, while **A** controls the separately decoded soundtrack.

See [the Reference Loader guide](docs/REFERENCE_LOADER.md) for editor behavior, limits, storage, and the complete output contract.

## Development

Requirements are Python 3.12, [uv](https://docs.astral.sh/uv/), and Bun 1.4.0 or newer.

```shell
bun install --frozen-lockfile
uv sync --locked --group dev
bun run fmt:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
```

Configure a local ComfyUI path in `.env.local`, then use `bun run setup:local` and `bun run deploy:dev`. Python changes require a ComfyUI restart; `bun run dev` watches frontend changes.

Build the Registry-style package with `bun run build:custom-node`. See [testing](docs/TESTING.md) for the full validation and smoke-test checklist.

## License

MIT

## Acknowledgements

The structured raw-prompt and thumbnail mention interaction was informed by [ComfyUI-MiniMaxH3-Easy](https://github.com/nkxx188/ComfyUI-MiniMaxH3-Easy), which is also MIT licensed.
