# Architecture

Reference Loader is a single ComfyUI V3 node pack. The root `__init__.py` is a thin entry shim; `backend/` owns the node, versioned state contract, media loading, manifest generation, and `/reference_loader` routes. `frontend/` owns the custom widget and editors and is bundled into one `dist/index.js` file.

The serialized `loader_state` is the portable source of truth. It stores relative managed paths, source hashes, captions, ordering, enable flags, edit recipes, trim ranges, and display preferences—not media payloads or runtime preview state. Backend execution revalidates managed-path containment, file identity, and output alignment independently of the browser.

Images, videos, and audios are list outputs rather than batches or montages. Their caption lists are produced from the same output plan, while `manifest_json` records stable IDs and derivations without absolute paths or encoded media. VIDEO preserves its container audio; video-derived AUDIO is an explicit, separately enabled projection.

Public contracts are intentionally independent from the source pack: node ID `Alyac_ReferenceLoader`, widget type `REFERENCE_LOADER`, state input `loader_state`, extension name `reference-loader.extension`, API prefix `/reference_loader`, and managed storage `input/reference_loader`.
