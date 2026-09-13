import { describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

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
import {
  deserializeLoaderState,
  serializeLoaderState,
} from "../src/reference-loader/serialization.ts"
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
  const state = loaderReducer(createEmptyLoaderState(), {
    type: "add",
    item: createMediaItem("image", source("scene.png", "image/png"), "scene"),
  })
  return loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
}

function addGuide(root: HTMLElement, frame: string): void {
  const input = root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')
  if (!input) throw new Error("Missing Guide frame input.")
  flushSync(() => {
    input.value = frame
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
  root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
}

function mountController(root: HTMLElement, serialized: unknown): ReferenceLoaderController {
  const controller = new ReferenceLoaderController(
    root,
    node,
    new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
    serialized,
  )
  const h3Root = document.createElement("div")
  root.append(h3Root)
  controller.mountH3Workspace(h3Root)
  return controller
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

  test("renders Media-owned guides in the permanent workspace and applies atomically", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    document.body.append(root)
    const controller = mountController(root, serializeLoaderState(state))
    const h3Root = document.createElement("div")
    root.append(h3Root)
    const h3Mount = controller.mountH3Workspace(h3Root)

    const workspace = root.querySelector<HTMLElement>("[data-h3-workspace]")
    expect(workspace).not.toBeNull()
    expect(workspace?.classList.contains("is-collapsed")).toBe(true)
    expect(root.querySelector('.rl-channel[data-channel="image"] > .rl-h3-editor')).toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="scene"]')?.classList.contains("rl-card--has-caption"),
    ).toBe(true)
    expect(
      root
        .querySelector('.rl-card[data-id="scene"] textarea[data-field="caption"]')
        ?.getAttribute("rows"),
    ).toBe("2")
    expect(
      root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-reference')?.textContent,
    ).toBe("Ref #1")
    const guideEdit = root.querySelector<HTMLButtonElement>(
      '[data-action="edit-h3-guide"][data-id="scene"]',
    )
    expect(guideEdit?.classList.contains("rl-button--guide-edit")).toBe(true)
    expect(guideEdit?.classList.contains("rl-button--edit")).toBe(false)
    expect(guideEdit?.classList.contains("rl-button--card-action")).toBe(true)
    guideEdit?.click()
    expect(workspace?.classList.contains("is-collapsed")).toBe(false)
    expect(document.activeElement).toBe(root.querySelector('[data-h3-action="collapse"]'))
    expect(
      root.querySelector('.rl-card[data-id="scene"]')?.classList.contains("rl-card--h3-editor"),
    ).toBe(false)
    expect(
      root.querySelector('.rl-card[data-id="scene"] textarea[data-field="caption"]'),
    ).not.toBeNull()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
    expect(root.querySelector("[data-h3-inspector] .rl-h3-editor__title")?.textContent).toBe(
      "scene.png",
    )
    expect(
      root.querySelector('[data-h3-inspector] [data-h3-action="add-draft-placement"]'),
    ).not.toBeNull()
    expect(root.querySelector('.rl-card[data-id="scene"] [data-h3-editor]')).toBeNull()
    expect(root.querySelector('[data-h3-inspector] [data-h3-draft-field="visual"]')).toBeNull()
    expect(root.querySelector('[data-h3-inspector] [data-h3-draft-field="audio"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')?.click()
    expect(workspace?.classList.contains("is-collapsed")).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    expect(workspace?.classList.contains("is-collapsed")).toBe(false)
    expect(document.activeElement).toBe(root.querySelector('[data-h3-action="collapse"]'))
    addGuide(root, "0")
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
    expect(
      root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-reference'),
    ).not.toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-guide'),
    ).not.toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge.is-order')?.textContent,
    ).toBe("0f")
    expect(
      root.querySelector('.rl-card[data-id="scene"]')?.classList.contains("is-output-disabled"),
    ).toBe(false)
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badges')).not.toBeNull()
    const guideToggle = root.querySelector<HTMLButtonElement>(
      '.rl-card[data-id="scene"] [data-action="toggle-h3-guide"]',
    )
    expect(guideToggle?.classList.contains("rl-button--guide")).toBe(true)
    expect(guideToggle?.classList.contains("rl-button--output")).toBe(false)
    expect(guideToggle?.classList.contains("rl-button--card-action")).toBe(true)
    expect(guideToggle?.closest(".rl-output-actions")).not.toBeNull()
    expect(
      root
        .querySelector('.rl-card[data-id="scene"] [data-action="edit-h3-guide"]')
        ?.closest(".rl-media-actions"),
    ).not.toBeNull()
    h3Mount.destroy()
    controller.destroy()
    root.remove()
  })

  test("opens the Guide editor from a Shot at the matching frame", () => {
    let state = stateWithImage()
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        ...state.h3Timeline,
        guides: [{ id: "shot-guide", frameIndex: 48, visualId: "scene", audioId: null }],
      },
    })
    const root = document.createElement("div")
    document.body.append(root)
    const controller = mountController(root, serializeLoaderState(state))
    controller.setPromptShots([{ tag: "opening", frameIndex: 48 }])

    controller.editH3GuidesForShot("opening")

    expect(
      root.querySelector<HTMLElement>("[data-h3-workspace]")?.classList.contains("is-collapsed"),
    ).toBe(false)
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
    expect(
      root.querySelector<HTMLInputElement>('[data-h3-inspector] [data-h3-draft-field="frame"]')
        ?.value,
    ).toBe("48")
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-timeline-guide="shot-guide"]')
        ?.classList.contains("is-selected"),
    ).toBe(true)

    controller.destroy()
    root.remove()
  })

  test("opens Timeline Guides and selects the Shot when no Guide exists at its frame", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = mountController(root, serializeLoaderState(stateWithImage()))
    controller.setPromptShots([{ tag: "opening", frameIndex: 48 }])
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    const scrollCalls: ScrollIntoViewOptions[] = []
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: (options?: ScrollIntoViewOptions) => {
        if (options) scrollCalls.push(options)
      },
    })

    try {
      controller.editH3GuidesForShot("opening")
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      })
    }

    expect(
      root.querySelector<HTMLElement>("[data-h3-workspace]")?.classList.contains("is-collapsed"),
    ).toBe(false)
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(scrollCalls).toEqual([{ block: "nearest", inline: "nearest" }])

    controller.destroy()
    root.remove()
  })

  test("renders every Guide role and frame badge", () => {
    let state = stateWithImage()
    state = loaderReducer(state, { type: "toggle-h3-timeline", enabled: true })
    state = loaderReducer(state, {
      type: "apply-h3-media-edit",
      mediaId: "scene",
      channel: "visual",
      referenceEnabled: true,
      timeline: {
        ...state.h3Timeline,
        startImageId: "scene",
        endImageId: "scene",
        guides: [
          { id: "g2", frameIndex: 60, visualId: "scene", audioId: null },
          { id: "g1", frameIndex: 30, visualId: "scene", audioId: null },
        ],
      },
    })
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    expect(
      [...root.querySelectorAll('.rl-card[data-id="scene"] .rl-h3-card-badge')].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Ref #1", "Guide #1", "Start", "30f", "60f", "End"])
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-h3-card-badge__more')).toBeNull()
    controller.destroy()
  })

  test("toggles one card Guide without deleting its saved placements", () => {
    let state = stateWithImage()
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        ...state.h3Timeline,
        enabled: true,
        startImageId: "scene",
        guides: [{ id: "saved-guide", frameIndex: 48, visualId: "scene", audioId: null }],
      },
    })
    const savedTimeline = state.h3Timeline
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    const button = () =>
      root.querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
    expect(button()?.getAttribute("aria-pressed")).toBe("true")
    button()?.click()
    expect(controller.state.h3Timeline).toMatchObject({
      enabled: true,
      startImageId: "scene",
      guides: savedTimeline.guides,
      disabledVisualIds: ["scene"],
    })
    expect(button()?.getAttribute("aria-pressed")).toBe("false")
    expect(
      [...root.querySelectorAll('.rl-card[data-id="scene"] .rl-h3-card-badge')].map(
        (badge) => badge.textContent,
      ),
    ).toEqual(["Ref #1", "Guide off"])
    expect(root.querySelector('.rl-card[data-id="scene"] .rl-guide-index')).toBeNull()
    expect(deserializeLoaderState(serializeLoaderState(controller.state)).state).toEqual(
      controller.state,
    )

    button()?.click()
    expect(controller.state.h3Timeline).toEqual(savedTimeline)
    expect(button()?.getAttribute("aria-pressed")).toBe("true")
    controller.destroy()
  })

  test("allows Cancel when a new Guide still needs a frame placement", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))
    const before = controller.serialize()

    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()

    expect(root.querySelector(".rl-h3-workspace__footer")?.textContent).toContain(
      "Add a frame placement or select Start/End.",
    )
    const cancel = root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')
    expect(cancel?.disabled).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.disabled).toBe(
      true,
    )
    cancel?.click()

    expect(root.querySelector("[data-h3-inspector]")).toBeNull()
    expect(controller.serialize()).toBe(before)
    controller.destroy()
  })

  test("allows Cancel from a clean Guide editor before adding a placement", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))
    const before = controller.serialize()

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()

    expect(root.querySelector("[data-h3-inspector]")).not.toBeNull()
    expect(
      root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')?.disabled,
    ).toBe(false)
    expect(root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.disabled).toBe(
      true,
    )
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')?.click()

    expect(root.querySelector("[data-h3-inspector]")).toBeNull()
    expect(controller.serialize()).toBe(before)
    controller.destroy()
  })

  test("edits Start and End roles from the source Inspector", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    for (const role of ["start", "end"] as const) {
      const position = root.querySelector<HTMLButtonElement>(
        `[data-h3-add-field="position"][value="${role}"]`,
      )
      if (!position) throw new Error("Missing Guide position button.")
      flushSync(() => position.click())
      root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
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

  test("adds a Guide to an existing reference without losing either role", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
    addGuide(root, "0")
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()

    expect(controller.state.items.scene).toMatchObject({ imageEnabled: true })
    expect(controller.state.h3Timeline.guides).toHaveLength(1)
    expect(controller.state.h3Timeline.guides[0]).toMatchObject({
      visualId: "scene",
      frameIndex: 0,
    })
    controller.destroy()
  })

  test("keeps one Inspector and orders Start, guides, and End", () => {
    let state = stateWithImage()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("image", source("second.png", "image/png"), "second"),
    })
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        ...state.h3Timeline,
        startImageId: "scene",
        endImageId: "scene",
        guides: [{ id: "middle", frameIndex: 48, visualId: "scene", audioId: null }],
      },
    })
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    const card = root.querySelector('.rl-card[data-id="scene"][data-channel="image"]')
    expect(card?.querySelector("[data-h3-editor]")).toBeNull()
    expect(root.querySelectorAll("[data-h3-inspector][data-h3-editor]")).toHaveLength(1)
    expect(root.querySelector('.rl-card[data-id="second"] [data-h3-editor]')).toBeNull()
    expect(root.querySelector('.rl-card[data-channel="audio"] [data-h3-editor]')).toBeNull()
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-h3-inspector] .rl-h3-editor__placement")].map(
        (row) =>
          row.dataset.h3Role === "start"
            ? "Start"
            : row.dataset.h3Role === "end"
              ? "End"
              : `${row.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.value}f`,
      ),
    ).toEqual(["Start", "48f", "End"])
    expect(root.querySelector('[data-h3-inspector] [data-h3-add-field="position"]')).not.toBeNull()
    controller.destroy()
  })

  test("rejects an empty, fractional, negative, or duplicate frame without changing the draft", () => {
    const state = stateWithImage()
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    const before = controller.serialize()
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
    expect(root.querySelector("[data-h3-add-error]")?.textContent).toContain("non-negative integer")
    expect(root.querySelectorAll("[data-h3-inspector] .rl-h3-editor__placement")).toHaveLength(0)
    const add = (value: string) => addGuide(root, value)
    add("1.5")
    expect(root.querySelector("[data-h3-add-error]")?.textContent).toContain("non-negative integer")
    add("-1")
    expect(root.querySelector("[data-h3-add-error]")?.textContent).toContain("non-negative integer")
    add("48")
    expect(root.querySelectorAll("[data-h3-inspector] .rl-h3-editor__placement")).toHaveLength(1)
    add("48")
    expect(root.querySelector("[data-h3-add-error]")?.textContent).toContain("overlaps")
    expect(controller.serialize()).toBe(before)
    controller.destroy()
  })

  test("deletes only the current side and splits a paired guide when its frame changes", () => {
    const image = createMediaItem("image", source("scene.png", "image/png"), "scene")
    const audio = createMediaItem("audio", source("voice.wav", "audio/wav"), "voice")
    let state = createEmptyLoaderState()
    state = loaderReducer(state, { type: "add", item: image })
    state = loaderReducer(state, { type: "add", item: audio })
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: {
        ...state.h3Timeline,
        guides: [{ id: "paired", frameIndex: 48, visualId: "scene", audioId: "voice" }],
      },
    })
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    const frame = root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')
    if (!frame) throw new Error("Missing paired frame input.")
    frame.value = "96"
    frame.dispatchEvent(new Event("input", { bubbles: true }))
    frame.dispatchEvent(new Event("blur", { bubbles: true }))
    expect(root.querySelectorAll("[data-h3-inspector] .rl-h3-editor__placement")).toHaveLength(1)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "paired", frameIndex: 48, visualId: null, audioId: "voice" },
      { id: expect.any(String), frameIndex: 96, visualId: "scene", audioId: null },
    ])
    controller.destroy()
  })

  test("blocks a dirty editor from switching to another Media card", () => {
    let state = stateWithImage()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("image", source("second.png", "image/png"), "second"),
    })
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')?.click()
    addGuide(root, "48")
    root
      .querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="second"]')
      ?.click()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
    expect(root.querySelector("[data-h3-inspector] .rl-h3-editor__title")?.textContent).toBe(
      "scene.png",
    )
    expect(root.querySelector(".rl-status")?.textContent).toContain("Apply or cancel")
    controller.destroy()
  })

  test("reports a Start owner conflict and limits standalone Audio to frame guides", () => {
    let state = stateWithImage()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("image", source("second.png", "image/png"), "second"),
    })
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem("audio", source("voice.wav", "audio/wav"), "voice"),
    })
    state = loaderReducer(state, {
      type: "set-h3-timeline",
      timeline: { ...state.h3Timeline, startImageId: "scene" },
    })
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))
    root
      .querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="second"]')
      ?.click()
    const position = root.querySelector<HTMLButtonElement>(
      '[data-h3-add-field="position"][value="start"]',
    )
    if (!position) throw new Error("Missing Guide position button.")
    flushSync(() => position.click())
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')?.click()
    expect(root.querySelector("[data-h3-add-error]")?.textContent).toContain("Image · scene.png")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')?.click()

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="voice"]')?.click()
    expect(root.querySelector('[data-h3-add-field="position"] option[value="start"]')).toBeNull()
    expect(root.querySelector('[data-h3-add-field="position"] option[value="end"]')).toBeNull()
    addGuide(root, "24")
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: expect.any(String), frameIndex: 24, visualId: null, audioId: "voice" },
    ])
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
    const controller = mountController(root, serializeLoaderState(state))

    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()

    expect(controller.state.h3Timeline).toMatchObject({
      guides: [{ id: "paired", frameIndex: 48, visualId: "scene", audioId: "voice" }],
      disabledVisualIds: ["scene"],
    })
    root
      .querySelector<HTMLButtonElement>('[data-action="toggle-h3-guide"][data-id="scene"]')
      ?.click()
    expect(controller.state.h3Timeline).toEqual(state.h3Timeline)
    controller.destroy()
  })

  test("does not expose Guide controls or accept video Guide sources", () => {
    const video = createMediaItem("video", source("clip.mp4", "video/mp4"), "clip")
    const state = loaderReducer(
      loaderReducer(createEmptyLoaderState(), { type: "add", item: video }),
      { type: "toggle-h3-timeline", enabled: true },
    )
    const root = document.createElement("div")
    const controller = mountController(root, serializeLoaderState(state))

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
    const controller = mountController(root, serializeLoaderState(state))

    const summary = root.querySelector<HTMLButtonElement>('[data-timeline-guide="incomplete"]')
    expect(summary?.textContent).toContain("48f")
    summary?.click()
    root
      .querySelector<HTMLButtonElement>(".rl-h3-editor--recovery .rl-h3-guide-details__remove")
      ?.click()
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
    const controller = mountController(root, serializeLoaderState(state))

    const clear = root.querySelector<HTMLButtonElement>('[data-action="clear"]')
    expect(clear?.disabled).toBe(false)
    clear?.click()

    expect(controller.state.h3Timeline.guides).toEqual([])
    controller.destroy()
  })
})
