import { describe, expect, test } from "bun:test"

import {
  executionFingerprintSource,
  projectLoaderExecution,
} from "../src/reference-loader/execution.ts"
import {
  LocalHistory,
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
} from "../src/reference-loader/history.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import {
  deserializeLoaderState,
  serializeLoaderState,
} from "../src/reference-loader/serialization.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  MAX_H3_GUIDES,
  type MediaSource,
} from "../src/reference-loader/types.ts"
import { validateLoaderState } from "../src/reference-loader/validation.ts"

const source = (name: string, mime: string): MediaSource => ({
  path: `reference_loader/sources/${name}`,
  mime,
  sha256: "a".repeat(64),
  size: 128,
})

describe("Reference Loader state", () => {
  test("adds each media kind to the correct independent order", () => {
    let state = createEmptyLoaderState()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("image", source("i.webp", "image/webp"), "i"),
    })
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("audio", source("a.wav", "audio/wav"), "a"),
    })
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("video", source("v.mp4", "video/mp4"), "v"),
    })

    expect(state.imageOrder).toEqual(["i"])
    expect(state.videoOrder).toEqual(["v"])
    expect(state.audioOrder).toEqual(["a", "v"])

    const withoutVideo = loaderReducer(state, { type: "remove", id: "v" })
    expect(withoutVideo.videoOrder).toEqual([])
    expect(withoutVideo.audioOrder).toEqual(["a"])
  })

  test("reorders, moves, toggles and removes without mutating previous state", () => {
    const first = createMediaItem("image", source("a.png", "image/png"), "a")
    const second = createMediaItem("image", source("b.png", "image/png"), "b")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: first })
    state = loaderReducer(state, { type: "add", item: second })
    const previous = state
    state = loaderReducer(state, { type: "move", channel: "image", id: "a", delta: 1 })
    state = loaderReducer(state, { type: "toggle", channel: "image", id: "a" })
    state = loaderReducer(state, { type: "remove", id: "b" })

    expect(previous.imageOrder).toEqual(["a", "b"])
    expect(state.imageOrder).toEqual(["a"])
    expect(state.items.a?.kind === "image" && state.items.a.imageEnabled).toBe(false)
    expect(state.items.b).toBeUndefined()
  })

  test("replaces media without changing its reference identity or order", () => {
    const original = createMediaItem("image", source("original.png", "image/png"), "image")
    original.caption = "keep this caption"
    if (original.kind !== "image") throw new Error("Expected an image test item.")
    original.imageEnabled = false
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: original })
    const replacement = createMediaItem("image", source("replacement.png", "image/png"), "image")

    state = loaderReducer(state, { type: "replace-media", id: "image", item: replacement })

    expect(state.imageOrder).toEqual(["image"])
    expect(state.items.image).toMatchObject({
      ...replacement,
      caption: "keep this caption",
      imageEnabled: false,
    })
    expect(loaderReducer(state, { type: "replace-media", id: "missing", item: replacement })).toBe(
      state,
    )
  })

  test("clears every media channel while preserving UI preferences", () => {
    const image = createMediaItem("image", source("a.png", "image/png"), "a")
    const video = createMediaItem("video", source("v.mp4", "video/mp4"), "v")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, { type: "add", item: video })
    state = loaderReducer(state, { type: "set-ui", values: { gridColumns: 5 } })

    const cleared = loaderReducer(state, { type: "clear" })
    expect(cleared.items).toEqual({})
    expect(cleared.imageOrder).toEqual([])
    expect(cleared.videoOrder).toEqual([])
    expect(cleared.audioOrder).toEqual([])
    expect(cleared.ui.gridColumns).toBe(5)
    expect(loaderReducer(cleared, { type: "clear" })).toBe(cleared)
  })

  test("keeps a video audio caption override separate from its visual caption", () => {
    const video = createMediaItem("video", source("v.mp4", "video/mp4"), "v")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    state = loaderReducer(state, {
      type: "set-caption",
      id: "v",
      channel: "video",
      caption: "visual",
    })
    state = loaderReducer(state, {
      type: "set-caption",
      id: "v",
      channel: "audio",
      caption: "spoken",
    })
    expect(state.items.v).toMatchObject({ caption: "visual", audioCaptionOverride: "spoken" })
  })

  test("defaults every video out of the separate audio output", () => {
    const video = createMediaItem("video", source("v.mp4", "video/mp4"), "video")
    expect(video).toMatchObject({
      videoEnabled: true,
      videoAudioEnabled: true,
      audioEnabled: false,
    })
  })

  test("toggles embedded video audio independently and survives serialization", () => {
    const video = createMediaItem("video", source("v.mp4", "video/mp4"), "video")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const before = executionFingerprintSource(state)
    const beforeProjection = projectLoaderExecution(state)

    state = loaderReducer(state, { type: "toggle-video-audio", id: "video" })
    expect(state.items.video).toMatchObject({
      videoEnabled: true,
      videoAudioEnabled: false,
      audioEnabled: false,
    })
    expect(executionFingerprintSource(state)).not.toBe(before)
    expect(projectLoaderExecution(state).videos.map((item) => item.id)).toEqual(
      beforeProjection.videos.map((item) => item.id),
    )
    expect(projectLoaderExecution(state).audios).toEqual(beforeProjection.audios)

    const history = commitHistory(
      createHistory(state),
      loaderReducer(state, { type: "toggle-video-audio", id: "video" }),
    )
    expect(undoHistory(history).present.items.video).toMatchObject({ videoAudioEnabled: false })
    expect(redoHistory(history).present.items.video).toMatchObject({ videoAudioEnabled: true })

    state = loaderReducer(state, { type: "toggle", id: "video", channel: "audio" })
    expect(state.items.video).toMatchObject({ videoAudioEnabled: false, audioEnabled: true })
    expect(projectLoaderExecution(state).videos[0]?.videoAudioEnabled).toBe(false)
    expect(deserializeLoaderState(serializeLoaderState(state)).state).toEqual(state)
  })

  test("stores timeline roles separately and clears them with removed media", () => {
    const start = createMediaItem("image", source("start.png", "image/png"), "start")
    const end = createMediaItem("image", source("end.png", "image/png"), "end")
    const video = createMediaItem("video", source("guide.mp4", "video/mp4"), "video")
    const guideImage = createMediaItem("image", source("guide.png", "image/png"), "guide-image")
    let state = createEmptyLoaderState()
    for (const item of [start, end, video, guideImage])
      state = loaderReducer(state, { type: "add", item })
    state = loaderReducer(state, { type: "toggle", id: "guide-image", channel: "image" })
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    state = loaderReducer(state, { type: "set-h3-start", id: "start" })
    state = loaderReducer(state, { type: "set-h3-end", id: "end" })
    state = loaderReducer(state, {
      type: "add-h3-guide",
      guide: { id: "guide-1", frameIndex: 48, visualId: "guide-image", audioId: null },
    })

    expect(state.h3Timeline).toMatchObject({
      enabled: true,
      startImageId: "start",
      endImageId: "end",
      guides: [{ id: "guide-1", frameIndex: 48, visualId: "guide-image" }],
    })
    const projection = projectLoaderExecution(state)
    expect(projection.images.map((item) => item.id)).toEqual(["start", "end", "guide-image"])
    expect(projection.videos.map((item) => item.id)).toEqual(["video"])
    expect(executionFingerprintSource(state)).not.toBe(
      executionFingerprintSource(createEmptyLoaderState()),
    )

    state = loaderReducer(state, { type: "remove", id: "guide-image" })
    expect(state.h3Timeline.guides[0]).toMatchObject({ visualId: null, audioId: null })
    state = loaderReducer(state, { type: "remove", id: "start" })
    state = loaderReducer(state, { type: "remove", id: "end" })
    expect(state.h3Timeline.startImageId).toBeNull()
    expect(state.h3Timeline.endImageId).toBeNull()
  })

  test("toggles timeline activity without discarding saved placements", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        version: 1,
        enabled: true,
        startImageId: "scene",
        endImageId: "scene",
        guides: [{ id: "guide-1", frameIndex: 48, visualId: "scene", audioId: null }],
      },
    })
    const configured = state.h3Timeline

    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: false })
    expect(state.h3Timeline).toEqual({ ...configured, enabled: false })
    expect(projectLoaderExecution(state).h3Timeline).toEqual({ ...configured, enabled: false })

    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    expect(state.h3Timeline).toEqual(configured)
  })

  test("bounds timeline guide additions and round-trips timeline state", () => {
    let state = createEmptyLoaderState()
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    for (let index = 0; index < MAX_H3_GUIDES + 1; index += 1) {
      state = loaderReducer(state, {
        type: "add-h3-guide",
        guide: { id: `guide-${index}`, frameIndex: index, visualId: null, audioId: null },
      })
    }
    expect(state.h3Timeline.guides).toHaveLength(MAX_H3_GUIDES)
    expect(deserializeLoaderState(serializeLoaderState(state)).state).toEqual(state)
  })
})

describe("validation and serialization", () => {
  test("validates only the current state schema and repairs missing orders", () => {
    const result = validateLoaderState({
      version: 1,
      items: {
        video: {
          id: "video",
          kind: "video",
          source: source("v.mp4", "video/mp4"),
          caption: "clip",
          videoEnabled: false,
          audioEnabled: true,
          audioCaptionOverride: "voice",
        },
      },
      imageOrder: [],
      videoOrder: [],
      audioOrder: [],
      h3Output: { fps: 300, totalFrames: 0 },
      ui: {
        cardAspectRatio: "3 / 4",
        gridColumns: 99,
        previewMaxPixels: 1_750_000,
        previewFit: "cover",
        waveformPeaks: 999,
      },
    })
    expect(result.state.imageOrder).toEqual([])
    expect(result.state.videoOrder).toEqual(["video"])
    expect(result.state.audioOrder).toEqual(["video"])
    expect(result.state.ui.waveformPeaks).toBe(999)
    expect(result.state.ui.cardAspectRatio).toBe("3 / 4")
    expect(result.state.ui.previewFit).toBe("cover")
    expect(result.state.ui.gridColumns).toBe(8)
    expect(result.state.h3Output.fps).toBe(240)
    expect(result.state.h3Output.totalFrames).toBe(1)
    expect(result.state.ui.previewMaxPixels).toBe(1_750_000)
    expect(validateLoaderState({ version: 0 }).state).toEqual(createEmptyLoaderState())
  })

  test("falls back safely for malformed JSON and unsupported versions", () => {
    expect(deserializeLoaderState("{").state).toEqual(createEmptyLoaderState())
    expect(validateLoaderState({ version: 20 }).state).toEqual(createEmptyLoaderState())
  })

  test("defaults a restored video with no explicit audio toggle out of derived AUDIO", () => {
    const result = validateLoaderState({
      version: 1,
      items: {
        video: {
          id: "video",
          kind: "video",
          source: source("v.mp4", "video/mp4"),
          caption: "",
        },
      },
      imageOrder: [],
      videoOrder: ["video"],
      audioOrder: ["video"],
    })
    expect(result.state.items.video).toMatchObject({
      videoEnabled: true,
      videoAudioEnabled: true,
      audioEnabled: false,
    })
  })

  test("repairs unavailable timeline sources while preserving valid guide rows", () => {
    const result = validateLoaderState({
      version: 1,
      items: {
        image: {
          id: "image",
          kind: "image",
          source: source("i.png", "image/png"),
          originalSource: source("i.png", "image/png"),
          caption: "",
          imageEnabled: false,
        },
        video: {
          id: "video",
          kind: "video",
          source: source("v.mp4", "video/mp4"),
          caption: "",
          videoEnabled: false,
          videoAudioEnabled: true,
          audioEnabled: false,
        },
        audio: {
          id: "audio",
          kind: "audio",
          source: source("a.wav", "audio/wav"),
          originalSource: source("a.wav", "audio/wav"),
          caption: "",
          audioEnabled: false,
        },
      },
      imageOrder: ["image"],
      videoOrder: ["video"],
      audioOrder: ["video", "audio"],
      videoAudioPolicy: "preserve",
      h3Timeline: {
        version: 1,
        enabled: true,
        startImageId: "image",
        endImageId: "missing",
        guides: [
          { id: "guide", frameIndex: 24, visualId: "image", audioId: "audio" },
          { id: "legacy-video", frameIndex: 48, visualId: "video", audioId: "video:audio" },
          { id: "bad", frameIndex: 72, visualId: "missing", audioId: null },
        ],
      },
    })

    expect(result.state.h3Timeline).toMatchObject({
      enabled: true,
      startImageId: "image",
      endImageId: null,
      guides: [
        { id: "guide", frameIndex: 24, visualId: "image", audioId: "audio" },
        { id: "legacy-video", frameIndex: 48, visualId: null, audioId: null },
        { id: "bad", frameIndex: 72, visualId: null, audioId: null },
      ],
    })
    expect(result.issues.some((issue) => issue.includes("endImageId"))).toBe(true)
    expect(result.issues.some((issue) => issue.includes("visualId"))).toBe(true)
  })

  test("rejects oversized workflow state before parsing JSON", () => {
    const restored = deserializeLoaderState(" ".repeat(1_000_001))
    expect(restored.state).toEqual(createEmptyLoaderState())
    expect(restored.issues).toContain("State JSON exceeded the 1,000,000-character limit.")
  })

  test("serializes deterministically and stores no runtime data", () => {
    let state = createEmptyLoaderState()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("audio", source("a.wav", "audio/wav"), "z"),
    })
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("image", source("i.png", "image/png"), "a"),
    })
    const serialized = serializeLoaderState(state)
    expect(serialized.indexOf('"a"')).toBeLessThan(serialized.indexOf('"z"'))
    expect(serialized).not.toContain("blob:")
    expect(deserializeLoaderState(serialized).state).toEqual(state)
    expect(deserializeLoaderState(serialized).state.items.a?.sourceFilename).toBe("i.png")
  })

  test("keeps a portable content-addressed mask in state and execution", () => {
    const image = createMediaItem("image", source("i.png", "image/png"), "i")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const before = executionFingerprintSource(state)
    state = loaderReducer(state, {
      type: "apply-image-edit",
      id: "i",
      edit: {
        mask: source("mask.png", "image/png"),
        maskMode: "keep",
        revision: 1,
      },
    })
    const restored = deserializeLoaderState(serializeLoaderState(state)).state
    expect(restored.items.i?.kind === "image" && restored.items.i.edit?.mask?.path).toBe(
      "reference_loader/sources/mask.png",
    )
    expect(projectLoaderExecution(restored).images[0]?.edit?.maskMode).toBe("keep")
    expect(executionFingerprintSource(restored)).not.toBe(before)
  })

  test("preserves the immutable original source and restores it after workflow serialization", () => {
    const original = source("original.png", "image/png")
    const image = createMediaItem("image", original, "i")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, {
      type: "apply-image-edit",
      id: "i",
      source: { ...source("edited.png", "image/png"), sha256: "e".repeat(64), revision: 1 },
      edit: { crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 }, revision: 1 },
      caption: "edited",
    })
    state = deserializeLoaderState(serializeLoaderState(state)).state
    expect(state.items.i).toMatchObject({ originalSource: original, imageEnabled: true })

    state = loaderReducer(state, { type: "toggle", channel: "image", id: "i" })
    state = loaderReducer(state, { type: "restore-image-original", id: "i", caption: "restored" })
    expect(state.items.i).toMatchObject({
      source: original,
      originalSource: original,
      caption: "restored",
      imageEnabled: false,
    })
    expect(state.items.i).not.toHaveProperty("edit")
    expect(state.imageOrder).toEqual(["i"])
  })
})

describe("history and execution projection", () => {
  test("supports bounded undo/redo and caption merge keys", () => {
    let history = createHistory(0)
    history = commitHistory(history, 1, { mergeKey: "caption" })
    history = commitHistory(history, 2, { mergeKey: "caption" })
    expect(history.past).toEqual([0])
    expect(canUndo(history)).toBe(true)
    history = undoHistory(history)
    expect(history.present).toBe(0)
    expect(canRedo(history)).toBe(true)
    history = redoHistory(history)
    expect(history.present).toBe(2)
  })

  test("bounds editor-local snapshot history", () => {
    const history = new LocalHistory(0, 20)
    for (let value = 1; value <= 30; value += 1) history.commit(value)
    for (let count = 0; count < 25; count += 1) history.undo()
    expect(history.value).toBe(10)
  })

  test("replaces transient state without creating an undo entry", () => {
    const history = new LocalHistory(0)
    history.replace(1)
    expect(history.value).toBe(1)
    expect(history.canUndo).toBe(false)
    history.commit(2)
    history.replace(3)
    expect(history.undo()).toBe(1)
  })

  test("maps video sound to a derived audio id and excludes UI from fingerprint", () => {
    const video = createMediaItem("video", source("v.mp4", "video/mp4"), "v")
    if (video.kind !== "video") throw new Error("Expected a video test item.")
    video.audioEnabled = true
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    state = loaderReducer(state, {
      type: "set-caption",
      id: "v",
      channel: "audio",
      caption: "voice",
    })
    const projection = projectLoaderExecution(state)
    expect(projection.audios[0]).toMatchObject({
      id: "v:audio",
      kind: "audio",
      derivedFrom: "v",
      caption: "voice",
    })
    const fingerprint = executionFingerprintSource(state)
    state = loaderReducer(state, {
      type: "set-ui",
      values: { cardAspectRatio: "1 / 1", previewMaxPixels: 200_000 },
    })
    expect(executionFingerprintSource(state)).toBe(fingerprint)
  })

  test("drops API-only source revisions from the backend execution projection", () => {
    const image = createMediaItem("image", { ...source("i.png", "image/png"), revision: 2 }, "i")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, {
      type: "apply-image-edit",
      id: "i",
      edit: {
        mask: { ...source("mask.png", "image/png"), revision: 3 },
        maskMode: "keep",
        revision: 2,
      },
    })
    const projection = projectLoaderExecution(state)
    expect(projection.images[0]?.source).not.toHaveProperty("revision")
    expect(projection.images[0]?.edit?.mask).not.toHaveProperty("revision")
    expect(projection.images[0]?.edit?.revision).toBe(2)
  })

  test("clamps captions to the backend contract", () => {
    const image = createMediaItem("image", source("i.png", "image/png"), "i")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, { type: "set-caption", id: "i", caption: "x".repeat(20_000) })
    expect(state.items.i?.caption).toHaveLength(16_384)
  })
})
