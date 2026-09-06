import { describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import {
  canUseAsH3Guide,
  h3TimelineCounts,
  mediaUsage,
  timelineMediaId,
  validateH3Timeline,
} from "../src/reference-loader/h3-media-guides.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  type MediaSource,
} from "../src/reference-loader/types.ts"

const source = (name: string, mime: string): MediaSource => ({
  path: `reference_loader/sources/${name}`,
  mime,
  sha256: "a".repeat(64),
})

const node: ComfyNode = {
  addWidget: () => ({ name: "unused", value: null }),
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

function stateWithImage() {
  return loaderReducer(createEmptyLoaderState(), {
    type: "add",
    item: createMediaItem("image", source("scene.png", "image/png"), "scene"),
  })
}

describe("Reference Loader Media Timeline integration", () => {
  test("calculates independent reference and guide roles without changing output order", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    state = loaderReducer(state, {
      type: "apply-h3-media-edit",
      mediaId: "scene",
      channel: "visual",
      referenceEnabled: false,
      timeline: {
        ...state.h3Timeline,
        guides: [{ id: "g1", frameIndex: 48, visualId: "scene", audioId: null }],
      },
    })

    const updated = state.items.scene
    if (!updated || updated.kind !== "image") throw new Error("Expected updated image.")
    expect(mediaUsage(state, updated)).toBe("guide")
    expect(h3TimelineCounts(state)).toMatchObject({
      mediaCount: 1,
      referenceCount: 0,
      placementCount: 1,
    })
    expect(state.items.scene).toMatchObject({ imageEnabled: false })
  })

  test("keeps a paired audio source when the visual side is detached", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    const audio = createMediaItem("audio", source("voice.wav", "audio/wav"), "voice")
    let state = createEmptyLoaderState()
    state = loaderReducer(state, { type: "add", item: image })
    state = loaderReducer(state, { type: "add", item: audio })
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    const paired = {
      ...state.h3Timeline,
      guides: [{ id: "g1", frameIndex: 48, visualId: "scene", audioId: "voice" }],
    }
    state = loaderReducer(state, {
      type: "apply-h3-media-edit",
      mediaId: "scene",
      channel: "visual",
      referenceEnabled: false,
      timeline: { ...paired, guides: [{ ...paired.guides[0], visualId: null }] },
    })

    expect(state.h3Timeline.guides).toEqual([
      { id: "g1", frameIndex: 48, visualId: null, audioId: "voice" },
    ])
  })

  test("renders Media-owned guides and applies Guide only atomically", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    expect(root.querySelector(".rl-h3-media-guides")).not.toBeNull()
    expect(root.querySelector('.rl-channel[data-channel="image"] .rl-h3-editor-overlay')).toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-reference')?.textContent,
    ).toBe("Ref #1")
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
    expect(root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.disabled).toBe(
      false,
    )
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()

    expect(controller.state.items.scene).toMatchObject({ imageEnabled: true })
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: expect.any(String), frameIndex: 0, visualId: "scene", audioId: null },
    ])
    expect(
      [...root.querySelectorAll('.rl-card[data-id="scene"] .rl-h3-card-badge')].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Ref #1", "Guide #1", "0f"])
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-guide-index')?.textContent).toBe("G#1")
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-reference')).not.toBeNull()
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-guide')).not.toBeNull()
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-order')?.textContent).toBe("0f")
    expect(
      root.querySelector('.rl-card[data-id="scene"]')?.classList.contains("is-output-disabled"),
    ).toBe(false)
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badges')).not.toBeNull()
    controller.destroy()
  })

  test("edits Start and End roles from the Media overlay", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    for (const role of ["start", "end"]) {
      const input = root.querySelector<HTMLInputElement>(`[data-h3-draft-role="${role}"]`)
      if (!input) throw new Error(`Missing ${role} role input.`)
      input.checked = true
      input.dispatchEvent(new Event("change", { bubbles: true }))
    }
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()

    expect(controller.state.h3Timeline.startImageId).toBe("scene")
    expect(controller.state.h3Timeline.endImageId).toBe("scene")
    controller.destroy()
  })

  test("excludes a video's derived audio from Guide sources", () => {
    const video = createMediaItem("video", source("clip.mp4", "video/mp4"), "clip")
    expect(timelineMediaId(video, "audio")).toBe("clip:audio")
    expect(canUseAsH3Guide(video, "audio")).toBe(false)
    expect(canUseAsH3Guide(video, "visual")).toBe(false)
  })

  test("counts enabled visual and audio channels separately", () => {
    const video = createMediaItem("video", source("clip.mp4", "video/mp4"), "clip")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    state = loaderReducer(state, { type: "toggle", id: "clip", channel: "audio" })

    expect(h3TimelineCounts(state)).toMatchObject({ mediaCount: 1, referenceCount: 2 })
  })

  test("allows paired visual and audio at one frame but rejects a visual Start collision", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    const audio = createMediaItem("audio", source("voice.wav", "audio/wav"), "voice")
    let state = createEmptyLoaderState()
    state = loaderReducer(state, { type: "add", item: image })
    state = loaderReducer(state, { type: "add", item: audio })
    const paired = {
      ...state.h3Timeline,
      startImageId: "scene",
      guides: [{ id: "paired", frameIndex: 0, visualId: "scene", audioId: "voice" }],
    }

    expect(validateH3Timeline(state, paired, { allowIncomplete: true })).toEqual([
      "Guide 1 overlaps visual placement Start.",
    ])
    expect(
      validateH3Timeline(state, {
        ...paired,
        startImageId: null,
      }),
    ).toEqual([])
  })

  test("does not enable a third Image through an atomic Guide edit in two-image mode", () => {
    let state = createEmptyLoaderState()
    for (const id of ["one", "two", "three"]) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem("image", source(`${id}.png`, "image/png"), id),
      })
    }
    state = loaderReducer(state, { type: "toggle", id: "three", channel: "image" })
    const next = loaderReducer(state, {
      type: "apply-h3-media-edit",
      mediaId: "three",
      channel: "visual",
      referenceEnabled: true,
      timeline: state.h3Timeline,
      twoImageMode: true,
    })

    expect(next).toBe(state)
  })

  test("adds a Guide to an existing reference without losing either role", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()
    expect(root.querySelector(".rl-card-grid.has-h3-editor .rl-h3-editor-overlay")).not.toBeNull()
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()

    expect(controller.state.items.scene).toMatchObject({ imageEnabled: true })
    expect(controller.state.h3Timeline.guides).toHaveLength(1)
    expect(controller.state.h3Timeline.guides[0]).toMatchObject({
      visualId: "scene",
      frameIndex: 0,
    })
    controller.destroy()
  })

  test("turns off one channel without deleting its paired Guide row", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    const audio = createMediaItem("audio", source("voice.wav", "audio/wav"), "voice")
    let state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    state = loaderReducer(state, { type: "add", item: audio })
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        ...state.h3Timeline,
        guides: [{ id: "paired", frameIndex: 48, visualId: "scene", audioId: "voice" }],
      },
    })
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()

    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "paired", frameIndex: 48, visualId: null, audioId: "voice" },
    ])
    controller.destroy()
  })

  test("does not expose Guide controls or accept video Guide sources", () => {
    const video = createMediaItem("video", source("clip.mp4", "video/mp4"), "clip")
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(loaderReducer(createEmptyLoaderState(), { type: "add", item: video })),
    )

    expect(root.querySelector('[data-action="toggle-h3-guide"]')).toBeNull()
    expect(root.querySelector('[data-action="edit-h3-guide"]')).toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="clip"] .rl-h3-card-badge.is-reference')?.textContent,
    ).toBe("Ref #1")
    expect(root.querySelector('[data-h3-draft-field="visual"]')).toBeNull()
    controller.destroy()
  })

  test("opens and removes an incomplete Guide from the Media summary", () => {
    const state = {
      ...createEmptyLoaderState(),
      h3Timeline: {
        ...createEmptyLoaderState().h3Timeline,
        guides: [{ id: "incomplete", frameIndex: 48, visualId: null, audioId: null }],
      },
    }
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    const summary = root.querySelector<HTMLButtonElement>('[data-h3-guide-id="incomplete"]')
    expect(summary?.textContent).toContain("48f")
    summary?.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="delete-draft-placement"]')?.click()
    expect(root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.disabled).toBe(
      false,
    )
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()

    expect(controller.state.h3Timeline.guides).toEqual([])
    controller.destroy()
  })

  test("clears Timeline-only state when Media is already empty", () => {
    const state = {
      ...createEmptyLoaderState(),
      h3Timeline: {
        ...createEmptyLoaderState().h3Timeline,
        guides: [{ id: "incomplete", frameIndex: 48, visualId: null, audioId: null }],
      },
    }
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )

    const clear = root.querySelector<HTMLButtonElement>('[data-action="clear"]')
    expect(clear?.disabled).toBe(false)
    clear?.click()

    expect(controller.state.h3Timeline.guides).toEqual([])
    controller.destroy()
  })
})
