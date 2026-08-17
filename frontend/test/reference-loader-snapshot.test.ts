import { describe, expect, test } from "bun:test"

import {
  createEmptyPromptDocument,
  deserializePromptDocument,
  serializePromptDocument,
} from "../src/reference-loader/prompt-state.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import {
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
  twoImageMode: true,
  promptByOrder: true,
}

describe("Reference Loader snapshots", () => {
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
    const prompt = createEmptyPromptDocument()
    prompt.view = "raw"
    prompt.sections = [{ title: "scene", parts: [{ type: "text", text: "A scene" }] }]

    const serialized = serializeReferenceLoaderSnapshot({
      loaderState: serializeLoaderState(loader),
      promptState: serializePromptDocument(prompt),
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

  test("rejects malformed state and inconsistent two-image mode before applying it", () => {
    const state = createEmptyLoaderState()
    for (let index = 0; index < 3; index += 1) {
      const item = createMediaItem(
        "image",
        {
          path: `reference_loader/sources/${index}.png`,
          mime: "image/png",
          sha256: String(index).repeat(64),
        },
        `image-${index}`,
      )
      Object.assign(state, loaderReducer(state, { type: "add", item }))
    }
    expect(() =>
      serializeReferenceLoaderSnapshot({
        loaderState: serializeLoaderState(state),
        promptState: serializePromptDocument(createEmptyPromptDocument()),
        settings,
      }),
    ).toThrow("more than two enabled Images")

    expect(() => parseReferenceLoaderSnapshot("not json")).toThrow("valid JSON")
    expect(() =>
      parseReferenceLoaderSnapshot(
        JSON.stringify({ format: REFERENCE_LOADER_SNAPSHOT_FORMAT, version: 99 }),
      ),
    ).toThrow("version must be 1")
    expect(() =>
      serializeReferenceLoaderSnapshot({
        loaderState: serializeLoaderState(createEmptyLoaderState()),
        promptState: serializePromptDocument(createEmptyPromptDocument()),
        settings: { ...settings, maxImagePixels: Number.NaN },
      }),
    ).toThrow("max_image_pixels must be a finite number")
  })

  test("preserves a legacy Prompt snapshot for Raw recovery by the editor", () => {
    const serialized = serializeReferenceLoaderSnapshot({
      loaderState: serializeLoaderState(createEmptyLoaderState()),
      promptState: serializePromptDocument(createEmptyPromptDocument()),
      settings: { ...settings, twoImageMode: false },
    })
    const snapshot = JSON.parse(serialized)
    snapshot.prompt_state = {
      version: 3,
      sections: [{ title: "scene", parts: [{ type: "text", text: "Legacy snapshot" }] }],
    }

    const parsed = parseReferenceLoaderSnapshot(JSON.stringify(snapshot))
    const recovered = deserializePromptDocument(parsed.promptState)
    expect(recovered.recoveredFromVersion).toBe(3)
    expect(recovered.document.view).toBe("raw")
    expect(recovered.document.sections[0]?.parts).toEqual([
      { type: "text", text: "Legacy snapshot" },
    ])
  })
})
