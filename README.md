# ComfyUI Reference Loader

Reference Loader is a ComfyUI V3 custom node for uploading, arranging, and editing image, audio, and video references. It emits one compact `REFERENCE_LOADER_BUNDLE`; the companion **Reference Loader Raw Outputs** node unpacks aligned media and caption lists plus a payload-free manifest. **MiniMax H3 Reference to Video Wrapper** passes the same bundle to ComfyUI's native MiniMax H3 reference-conditioning implementation without manual list indexing.

The Loader is available under `reference / loader`, **Reference Loader Raw Outputs** is under `reference / output`, and **MiniMax H3 Reference to Video Wrapper** is under `reference / integration`. A minimal workflow is included at [`workflows/Reference_Loader.json`](workflows/Reference_Loader.json).

## Features

- Independent Images, Videos, and Audio boards with reorder, enable, caption, and preview controls
- Per-image crop, flip, mask, background, optional `rembg`, and restore-original editing
- Audio/video trim and playback; VIDEO values retain embedded audio
- Optional per-image MPixel limiting and alpha compositing at execution
- One compact Loader output with a dedicated Reference Loader Raw Outputs node
- Explicit IMAGE/AUDIO/VIDEO lists with index-aligned caption lists after unpacking
- Managed, content-validated storage under `ComfyUI/input/reference_loader`

## Installation

Install through ComfyUI Manager, or extract a release archive into `ComfyUI/custom_nodes`. Restart ComfyUI after installation. Release archives include `dist/index.js`, so Bun and TypeScript are needed only for development.

Pillow, NumPy, torch, and PyAV are supplied by ComfyUI. Automatic background removal is optional; install it in the same Python environment as ComfyUI:

```shell
pip install ".[rembg]"
```

## Outputs

**Reference Loader** emits a single `references` output of type `REFERENCE_LOADER_BUNDLE`. Connect it to **Reference Loader Raw Outputs** when standard ComfyUI values are needed.

Connect it to **MiniMax H3 Reference to Video Wrapper** for native MiniMax H3 reference conditioning. The Wrapper retains the native `clip`, `vae`, `audio_vae`, `prompt`, `width`, `height`, `length`, and `ref_image_size` controls and replaces the native `ref_*` Autogrow sockets with `references`. Reference videos are decoded and sampled to the 24 fps IMAGE batch expected by MiniMax H3; no separate sampling node is required.

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
