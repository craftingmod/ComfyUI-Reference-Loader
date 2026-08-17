# ComfyUI Reference Loader

Reference Loader is a ComfyUI V3 custom node for uploading, arranging, and editing image, audio, and video references. It emits one compact `REFERENCE_LOADER_BUNDLE` containing its structured prompt snapshot alongside media, captions, and a payload-free manifest. **[Reference Loader] Raw Prompt** extracts that snapshot as a compiled `raw_prompt` STRING. **[Reference Loader] Export Prompt for LLM** converts the snapshot and active captions into strict YAML through one connection, while **[Reference Loader] Media Outputs** unpacks the standard media and metadata values. **[Reference Loader] Start/End Frames** projects up to two enabled images into nullable I2V/L2V/FL2V/FL2V_LOOP/T2V frame outputs. **[Reference Loader] MiniMax H3 Wrapper** passes the same bundle to ComfyUI's native MiniMax H3 reference-conditioning implementation without manual list indexing.

The Loader is available under `reference / loader`; **[Reference Loader] Raw Prompt**, **[Reference Loader] Export Prompt for LLM**, **[Reference Loader] Media Outputs**, and **[Reference Loader] Start/End Frames** are under `reference / output`; and **[Reference Loader] MiniMax H3 Wrapper** is under `reference / integration`. A minimal workflow is included at [`workflows/Reference_Loader.json`](workflows/Reference_Loader.json).

## Features

- Independent Images, Videos, and Audio boards with reorder, enable, caption, and preview controls
- Per-image crop, flip, mask, background, optional `rembg`, and restore-original editing
- Audio/video trim and playback; VIDEO values retain embedded audio
- Optional per-image MPixel limiting and alpha compositing at execution
- Structured prompt editor with thumbnail `@` media mentions, stable `#` Subject mentions, and literal raw view
- Browser JSON snapshots for saving and restoring Loader, Prompt, and related node settings
- Stable media mentions compiled to `<Picture N>`, `<Video N>`, and `<Audio N>` tags
- Strict YAML export of active captions and structured prompt sections for LLM inputs
- Compact reference bundle with a dedicated [Reference Loader] Media Outputs node
- Explicit IMAGE/AUDIO/VIDEO lists with index-aligned caption lists after unpacking
- Nullable start/end IMAGE projection for I2V and first-last-frame video workflows
- Optional frontend-only two-image mode that guards the enabled IMAGE output count
- Managed, content-validated storage under `ComfyUI/input/reference_loader`

## Installation

Install through ComfyUI Manager, or extract a release archive into `ComfyUI/custom_nodes`. Restart ComfyUI after installation. Release archives include `dist/index.js`, so Bun and TypeScript are needed only for development.

Pillow, NumPy, torch, and PyAV are supplied by ComfyUI. Automatic background removal is optional; install it in the same Python environment as ComfyUI:

```shell
pip install ".[rembg]"
```

## Outputs

**Reference Loader** emits only `references` as `REFERENCE_LOADER_BUNDLE`. Connect it to **[Reference Loader] Raw Prompt** when the compiled prompt STRING is needed directly; its output is named `raw_prompt`. Connect the same bundle to **[Reference Loader] Export Prompt for LLM**, set the required 4–15 second target duration, and optionally provide an `additional_yaml` top-level mapping. Its `prompt` output is compact strict YAML that starts with `video_duration_seconds`, merges validated additional fields, and then contains active `<Picture N>`, `<Video N>`, and `<Audio N>` caption mappings plus the ordered `generation_directives` mapping. The exporter also provides `references_yaml` and `generation_directives_yaml` STRING outputs for processing either generated top-level mapping independently. It has no generated schema-version field. A derived Audio mapping includes `source_video` when its Video is also enabled. The frontend-only `prompt_schema_preset` is never included. Connect `references` to **[Reference Loader] Media Outputs** when standard ComfyUI media, caption-list, manifest, or the nullable scalar `first_image` value is needed.

Connect it to **[Reference Loader] MiniMax H3 Wrapper** for native MiniMax H3 reference conditioning. The Wrapper retains the native `clip`, `vae`, `audio_vae`, `prompt`, `width`, `height`, `length`, and `ref_image_size` controls and replaces the native `ref_*` Autogrow sockets with `references`. Reference videos are decoded and sampled to the 24 fps IMAGE batch expected by MiniMax H3; no separate sampling node is required.

Connect `references` to **[Reference Loader] Start/End Frames** and choose `I2V`, `L2V`, `FL2V`, `FL2V_LOOP`, or `T2V`. `I2V` emits only the first enabled image as `start_image`; `L2V` emits the last enabled image as `end_image`; `FL2V` emits the first two as start/end; `FL2V_LOOP` emits the first image as both start/end; and `T2V` emits `(None, None)`. Missing frames remain `None`. The optional `enum_string` socket accepts the same abbreviations and overrides the Combo when its trimmed value is non-empty. Image-driven modes reject more than two enabled images so frame roles stay unambiguous; T2V ignores images.

Enable the Loader's advanced `two_image_mode` widget to prevent a third IMAGE output from being enabled. Additional uploaded images remain available but start disabled. The socketless widget is a write-only frontend proxy and does not alter execution or cache fingerprints; Start/End Frames still validates the bundle at execution.

The Media board uses its full content height without accepting extra flex height, so it does not gain a nested scrollbar and the Prompt editor stays immediately adjacent instead of being separated by blank Media space.

| Output                      | Contract                                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `images` / `image_captions` | Enabled Images order; equal list lengths                                |
| `audios` / `audio_captions` | Enabled standalone and video-derived Audio order; equal list lengths    |
| `videos` / `video_captions` | Enabled Videos order; equal list lengths                                |
| `manifest_json`             | Deterministic metadata without tensors, base64 media, or absolute paths |

Each new video starts with VIDEO enabled and its separate AUDIO output disabled. The VIDEO container's embedded audio remains intact.

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
