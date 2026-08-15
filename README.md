# ComfyUI Reference Loader

Reference Loader is a ComfyUI V3 custom node for uploading, arranging, editing, and emitting independent image, audio, and video reference lists. It preserves each item's native dimensions, keeps captions aligned with their media outputs, and emits a payload-free manifest for provenance and ordering.

The node is available under `media / reference` as **Reference Loader**. A minimal workflow is included at [`workflows/Reference_Loader.json`](workflows/Reference_Loader.json).

## Features

- Independent Images, Videos, and Audio boards with reorder, enable, caption, and preview controls
- Per-image crop, flip, mask, background, optional `rembg`, and restore-original editing
- Audio/video trim and playback; VIDEO values retain embedded audio
- Optional per-image MPixel limiting and alpha compositing at execution
- Explicit IMAGE/AUDIO/VIDEO list outputs with index-aligned caption lists
- Managed, content-validated storage under `ComfyUI/input/reference_loader`

## Installation

Install through ComfyUI Manager, or extract a release archive into `ComfyUI/custom_nodes`. Restart ComfyUI after installation. Release archives include `dist/index.js`, so Bun and TypeScript are needed only for development.

Pillow, NumPy, torch, and PyAV are supplied by ComfyUI. Automatic background removal is optional; install it in the same Python environment as ComfyUI:

```shell
pip install ".[rembg]"
```

## Outputs

| Output                      | Contract                                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `images` / `image_captions` | Enabled Images order; equal list lengths                                |
| `audios` / `audio_captions` | Enabled standalone and video-derived Audio order; equal list lengths    |
| `videos` / `video_captions` | Enabled Videos order; equal list lengths                                |
| `manifest_json`             | Deterministic metadata without tensors, base64 media, or absolute paths |

Each new video starts with VIDEO enabled and its separate AUDIO output disabled. The VIDEO container's embedded audio remains intact.

See [the Reference Loader guide](docs/REFERENCE_LOADER.md) for editor behavior, limits, storage, and the complete output contract.

## Development

Requirements are Python 3.12, [uv](https://docs.astral.sh/uv/), and Bun 1.3.14 or newer.

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
