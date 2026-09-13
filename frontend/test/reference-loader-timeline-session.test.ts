import { describe, expect, test } from "bun:test"

import {
  H3TimelineSession,
  type H3TimelineHost,
} from "../src/reference-loader/h3-timeline-session.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  type LoaderState,
} from "../src/reference-loader/types.ts"

function fixture(): LoaderState {
  const state = createEmptyLoaderState()
  const image = createMediaItem(
    "image",
    { path: "reference_loader/sources/scene.png", mime: "image/png", sha256: "a".repeat(64) },
    "scene",
  )
  const audio = createMediaItem(
    "audio",
    { path: "reference_loader/sources/voice.wav", mime: "audio/wav", sha256: "b".repeat(64) },
    "voice",
  )
  state.items = { scene: image, voice: audio }
  state.imageOrder = ["scene"]
  state.audioOrder = ["voice"]
  state.h3Timeline = {
    version: 1,
    enabled: true,
    startImageId: null,
    endImageId: null,
    guides: [{ id: "pair", frameIndex: 48, visualId: "scene", audioId: "voice" }],
  }
  return state
}

function sessionHarness(initial = fixture()) {
  let state = initial
  const actions: H3TimelineHost["dispatch"] extends (...args: infer A) => unknown ? A[0][] : never =
    []
  const renders: unknown[] = []
  let selectedMedia: string | undefined
  let status = ""
  const host: H3TimelineHost = {
    getState: () => state,
    dispatch: (action) => {
      const next = loaderReducer(state, action)
      if (next === state) return false
      state = next
      actions.push(action)
      return true
    },
    setStatus: (message) => {
      status = message
    },
    requestRender: (_force, focus) => renders.push(focus),
    publishView: () => renders.push("publish"),
    selectMedia: (id) => {
      selectedMedia = id
    },
    resolveGuideDrop: (channel) =>
      channel === "visual"
        ? { id: "scene", item: state.items.scene! }
        : { id: "voice", item: state.items.voice! },
  }
  return {
    session: new H3TimelineSession({ host }),
    get state() {
      return state
    },
    actions,
    renders,
    get selectedMedia() {
      return selectedMedia
    },
    get status() {
      return status
    },
  }
}

describe("H3TimelineSession", () => {
  test("keeps frame input in a draft until Apply and discards it on Cancel", () => {
    const harness = sessionHarness()
    harness.session.openForMedia("scene", "visual", "pair")
    harness.session.inputFrame("pair", "60")

    expect(harness.session.view.dirty).toBe(true)
    expect(harness.session.view.timeline.guides[0]?.frameIndex).toBe(60)
    expect(harness.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(harness.actions).toHaveLength(0)

    harness.session.cancel()

    expect(harness.session.view.editor).toBeUndefined()
    expect(harness.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
  })

  test("merges a paired frame move and dispatches one canonical Timeline action on Apply", () => {
    const harness = sessionHarness()
    harness.session.openForMedia("scene", "visual", "pair")
    harness.session.commitFrame("pair", "60")

    expect(harness.state.h3Timeline.guides).toHaveLength(1)
    expect(harness.session.view.timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 60])

    harness.session.apply()

    expect(harness.actions).toHaveLength(1)
    expect(harness.actions[0]?.type).toBe("apply-h3-media-edit")
    expect(harness.state.h3Timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 60])
    expect(harness.session.view.editor).toBeUndefined()
  })

  test("owns dropped placements locally and applies them through the existing reducer", () => {
    const harness = sessionHarness()
    harness.session.dropGuide("visual", 96, null)

    expect(harness.session.view.dirty).toBe(true)
    expect(harness.state.h3Timeline.guides).toHaveLength(1)
    expect(harness.session.view.timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 96])

    harness.session.apply()

    expect(harness.actions).toHaveLength(1)
    expect(harness.actions[0]?.type).toBe("set-h3-timeline")
    expect(harness.state.h3Timeline.guides).toHaveLength(2)
    expect(harness.status).toContain("Timeline Guide settings applied")
  })

  test("reset closes a draft and destroy makes later commands inert", () => {
    const harness = sessionHarness()
    harness.session.openForMedia("scene", "visual", "pair")
    harness.session.inputFrame("pair", "72")
    harness.session.reset()

    expect(harness.session.view.dirty).toBe(false)
    expect(harness.session.view.editor).toBeUndefined()
    expect(harness.state.h3Timeline.guides[0]?.frameIndex).toBe(48)

    harness.session.destroy()
    harness.session.openForMedia("scene", "visual", "pair")
    harness.session.toggle()
    expect(harness.actions).toHaveLength(0)
  })
})
