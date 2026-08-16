# Testing

## Automated validation

Run the repository's CI-equivalent checks from the root:

```shell
bun install --frozen-lockfile
uv sync --locked --group dev
bun run fmt:check
bun run lint
bun run typecheck
bun run test:unit
bun run build
bun run release:check
bun run build:custom-node
git diff --check
```

`bun run test:frontend` covers state, serialization, API mapping, DOM lifecycle, custom-widget restoration, image editing, trim playback, and the Bun build boundary. `bun run test:backend` covers the V3 schema and extension, state/manifest contracts, managed media validation, native media loading, and every Reference Loader route. Decoder-specific tests skip only when their optional development runtime is unavailable.

`dist/` is generated; edit `frontend/` and rebuild. The Registry archive must contain the root entrypoint, `backend/`, `dist/`, assets, and metadata while excluding frontend source, tests, caches, local environment files, and local ComfyUI paths.

## Standalone ComfyUI smoke test

Disable any earlier source-pack implementation before testing so node IDs and routes cannot collide.

1. In both Nodes 2.0 and Legacy Canvas, add **Reference Loader** from `reference / loader` and **Reference Loader Raw Outputs** from `reference / output`, connect `references`, and confirm the full board renders without console errors.
2. Upload two differently sized images, a transparent image, audio, a video with sound, and a silent video. Verify previews, waveforms, trim metadata, VIDEO default-on/AUDIO default-off, and disabled Audio controls for the silent video.
3. Reorder each board independently; toggle outputs and enter unique captions. Verify 1-based output badges have no gaps.
4. Exercise image View/Crop/Mask, flip, manual masking, transparent/solid backgrounds, and Restore original. Verify missing `rembg` reports a focused error, then install it and verify preview plus Apply.
5. Preview and trim audio and video. Confirm VIDEO playback includes embedded sound and the optional derived AUDIO uses the same applied range.
6. Queue with Original/Limited image modes and Preserve/Opaque alpha modes. Verify list/caption alignment, independent image resolutions, RGB alpha compositing, and VIDEO container audio.
7. Inspect `manifest_json` from Reference Loader Raw Outputs; it must contain no base64 data or absolute path.
8. Save the workflow, restart ComfyUI, restore it, and verify state/order/captions/edit recipes.
9. Install the Registry ZIP into a separate `custom_nodes` directory and repeat the minimal queue test.
10. With a ComfyUI build containing native MiniMax H3 support, connect `references` to **MiniMax H3 Reference to Video Wrapper**. Verify image-only, video-only, paired video/audio, audio-only video, and standalone audio toggle combinations without inserting list-index or frame-sampling nodes.

Legacy Canvas DOM interaction can feel less fluid than Nodes 2.0; this is a documented UI limitation, not a separate implementation target.
