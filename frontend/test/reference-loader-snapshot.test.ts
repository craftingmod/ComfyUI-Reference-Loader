import { describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import {
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  serializePromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import {
  captureReferenceLoaderSnapshotSettings,
  parseReferenceLoaderSnapshot,
  REFERENCE_LOADER_SNAPSHOT_FORMAT,
  REFERENCE_LOADER_SNAPSHOT_VERSION,
  serializeReferenceLoaderSnapshot,
  type ReferenceLoaderSnapshotSettings,
} from "../src/reference-loader/snapshot.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

const settings: ReferenceLoaderSnapshotSettings = {
  limitImagePixels: true,
  maxImagePixels: 3.75,
  compositeAlpha: true,
  alphaBackground: "#123456",
  promptSchemaPreset: "minimax_h3_t2v",
  showCaptions: false,
  horizontalCards: false,
}

describe("Reference Loader snapshots", () => {
  test("falls back to the default alpha background when a legacy widget is blank", () => {
    const node: ComfyNode = {
      widgets: [
        { name: "alpha_background", value: "" },
        { name: "max_image_pixels", value: "invalid" },
      ],
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }

    expect(
      captureReferenceLoaderSnapshotSettings(
        node,
        { showCaptions: true, horizontalCards: false },
        "generic",
      ).alphaBackground,
    ).toBe("#000000")
    expect(
      captureReferenceLoaderSnapshotSettings(
        node,
        { showCaptions: true, horizontalCards: false },
        "generic",
      ).maxImagePixels,
    ).toBe(2)
  })

  test("round-trips Loader, Prompt, original-source, and node settings", () => {
    const originalSource = {
      path: "reference_loader/sources/original.png",
      mime: "image/png",
      sha256: "a".repeat(64),
    }
    const image = createMediaItem("image", originalSource, "image-1")
    if (image.kind !== "image") throw new Error("Expected an image item.")
    image.source = {
      path: "reference_loader/edits/edited.png",
      mime: "image/png",
      sha256: "b".repeat(64),
      revision: 2,
    }
    image.edit = { flipX: true, revision: 2 }
    const loader = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const prompt = createEmptyPromptDocumentV6()
    prompt.view = "raw"
    prompt.sections = [
      {
        id: createPromptDefinitionId(),
        title: "scene",
        parts: [{ type: "text", text: "A scene" }],
      },
    ]

    const serialized = serializeReferenceLoaderSnapshot({
      loaderState: serializeLoaderState(loader),
      promptState: serializePromptDocumentV6(prompt),
      settings,
    })
    const file = JSON.parse(serialized) as Record<string, unknown>
    expect(file.format).toBe(REFERENCE_LOADER_SNAPSHOT_FORMAT)
    expect(file.version).toBe(REFERENCE_LOADER_SNAPSHOT_VERSION)
    const parsed = parseReferenceLoaderSnapshot(serialized)
    const restoredLoader = JSON.parse(parsed.loaderState)

    expect(restoredLoader.items["image-1"].originalSource).toEqual(originalSource)
    expect(restoredLoader.items["image-1"].source.path).toBe("reference_loader/edits/edited.png")
    expect(JSON.parse(parsed.promptState)).toEqual(prompt)
    expect(parsed.settings).toEqual(settings)
  })

  test("preserves the embedded video audio toggle", () => {
    const video = createMediaItem(
      "video",
      {
        path: "reference_loader/sources/clip.mp4",
        mime: "video/mp4",
        sha256: "c".repeat(64),
      },
      "video-1",
    )
    if (video.kind !== "video") throw new Error("Expected a video item.")
    video.videoAudioEnabled = false
    const loader = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const parsed = parseReferenceLoaderSnapshot(
      serializeReferenceLoaderSnapshot({
        loaderState: serializeLoaderState(loader),
        promptState: serializePromptDocumentV6(createEmptyPromptDocumentV6()),
        settings,
      }),
    )

    expect(JSON.parse(parsed.loaderState).items["video-1"].videoAudioEnabled).toBe(false)
  })

  test("defaults a snapshot without card orientation to vertical", () => {
    const snapshot = JSON.parse(
      serializeReferenceLoaderSnapshot({
        loaderState: serializeLoaderState(createEmptyLoaderState()),
        promptState: serializePromptDocumentV6(createEmptyPromptDocumentV6()),
        settings,
      }),
    ) as Record<string, unknown>
    delete (snapshot.node_settings as Record<string, unknown>).horizontal_cards

    expect(parseReferenceLoaderSnapshot(JSON.stringify(snapshot)).settings.horizontalCards).toBe(false)
  })

  test("rejects malformed state before applying it", () => {
    expect(() => parseReferenceLoaderSnapshot("not json")).toThrow("valid JSON")
    expect(() =>
      parseReferenceLoaderSnapshot(
        JSON.stringify({ format: REFERENCE_LOADER_SNAPSHOT_FORMAT, version: 99 }),
      ),
    ).toThrow("version must be 2")
    expect(() =>
      serializeReferenceLoaderSnapshot({
        loaderState: serializeLoaderState(createEmptyLoaderState()),
        promptState: serializePromptDocumentV6(createEmptyPromptDocumentV6()),
        settings: { ...settings, maxImagePixels: Number.NaN },
      }),
    ).toThrow("max_image_pixels must be a finite number")
  })

  test("rejects a legacy Prompt snapshot instead of recovering it", () => {
    const serialized = serializeReferenceLoaderSnapshot({
      loaderState: serializeLoaderState(createEmptyLoaderState()),
      promptState: serializePromptDocumentV6(createEmptyPromptDocumentV6()),
      settings,
    })
    const snapshot = JSON.parse(serialized)
    snapshot.prompt_state = {
      version: 3,
      sections: [{ title: "scene", parts: [{ type: "text", text: "Legacy snapshot" }] }],
    }

    expect(() => parseReferenceLoaderSnapshot(JSON.stringify(snapshot))).toThrow(
      "Prompt state is invalid",
    )
  })
})
