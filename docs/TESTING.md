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

1. In both Nodes 2.0 and Legacy Canvas, add **Reference Loader** from `reference / loader`, then add **Reference Loader Raw Outputs** and **Reference Loader Start/End Frames** from `reference / output`. Connect `references` to both output nodes and confirm the full board and Prompt editor render without console errors.
2. Upload two differently sized images, a transparent image, audio, a video with sound, and a silent video. Verify previews, waveforms, trim metadata, VIDEO default-on/AUDIO default-off, and disabled Audio controls for the silent video.
3. Reorder each board independently; toggle outputs and enter unique captions. Verify 1-based output badges have no gaps. Type `@` in Prompt, confirm image/video thumbnails appear, select mentions, and verify chips retain their media identity while their displayed ordinals follow reorder and enable changes.
4. Exercise image View/Crop/Mask, flip, manual masking, transparent/solid backgrounds, and Restore original. Verify missing `rembg` reports a focused error, then install it and verify preview plus Apply.
5. Preview and trim audio and video. Confirm VIDEO playback includes embedded sound and the optional derived AUDIO uses the same applied range.
6. Queue with Original/Limited image modes and Preserve/Opaque alpha modes. Verify list/caption alignment, independent image resolutions, RGB alpha compositing, and VIDEO container audio.
7. Enable advanced `two_image_mode` with no more than two enabled Images. Verify a third IMAGE activation is blocked and further uploaded Images are retained disabled. With three Images already enabled, verify the mode refuses activation without changing their state. Disable the mode and verify normal IMAGE toggles resume.
8. Queue Start/End Frames with `I2V`, `L2V`, `FL2V`, and `T2V`. Verify the modes populate only start, only end, both, and neither output respectively, with missing Images producing `None`. Connect a STRING primitive to `enum_string` and confirm a non-blank value overrides the Combo while a blank value falls back to it. Then bypass or disable the frontend mode, enable a third Image, and confirm image-driven modes reject the ambiguous frame selection while T2V still returns `(None, None)`.
9. Add enough Media cards to increase the board height, then resize Reference Loader vertically in both canvases. Verify the complete Media board remains visible without a nested Media scrollbar and Prompt stays directly adjacent with no expandable blank Media space.
10. Inspect `manifest_json` from Reference Loader Raw Outputs; it must contain no base64 data or absolute path.
11. Create a `#` dialogue block, inspect the literal tags in Raw, pass the `prompt` output through a STRING/LLM path, and verify the resulting text retains the media and `<d>` tags. Save the workflow, restart ComfyUI, restore it, and verify state/order/captions/edit recipes/prompt parts.
12. Install the Registry ZIP into a separate `custom_nodes` directory and repeat the minimal queue test.
13. With a ComfyUI build containing native MiniMax H3 support, connect `references` to **MiniMax H3 Reference to Video Wrapper**. Verify image-only, video-only, paired video/audio, audio-only video, and standalone audio toggle combinations without inserting list-index or frame-sampling nodes.

Legacy Canvas DOM interaction can feel less fluid than Nodes 2.0; this is a documented UI limitation, not a separate implementation target.
