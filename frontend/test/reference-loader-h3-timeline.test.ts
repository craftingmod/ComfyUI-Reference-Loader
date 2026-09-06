import { describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { H3TimelineController } from "../src/reference-loader/components/h3-timeline.ts"
import type {
  LoaderTimelineAction,
  ReferenceLoaderController,
} from "../src/reference-loader/components/loader.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  type LoaderState,
  type MediaSource,
} from "../src/reference-loader/types.ts"

const source = (name: string, mime: string): MediaSource => ({
  path: `reference_loader/sources/${name}`,
  mime,
  sha256: "a".repeat(64),
})

function createHost(initial: LoaderState): {
  host: ReferenceLoaderController
  getState: () => LoaderState
} {
  let state = initial
  const listeners = new Set<() => void>()
  const host = {
    get state() {
      return state
    },
    get h3Timeline() {
      return state.h3Timeline
    },
    subscribeH3Timeline(listener: () => void) {
      listeners.add(listener)
      listener()
      return () => listeners.delete(listener)
    },
    dispatchH3Timeline(action: LoaderTimelineAction) {
      state = loaderReducer(state, action)
      for (const listener of listeners) listener()
    },
  } as unknown as ReferenceLoaderController
  return { host, getState: () => state }
}

const node: ComfyNode = {
  addWidget: () => ({ name: "unused", value: null }),
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

describe("H3 Timeline Guides controller", () => {
  test("keeps the panel collapsed by default and edits disabled media by stable ID", () => {
    let state = createEmptyLoaderState()
    for (const item of [
      createMediaItem("image", source("disabled.png", "image/png"), "disabled-image"),
      createMediaItem("video", source("guide.mp4", "video/mp4"), "guide-video"),
      createMediaItem("audio", source("guide.wav", "audio/wav"), "guide-audio"),
    ]) {
      state = loaderReducer(state, { type: "add", item })
    }
    const image = state.items["disabled-image"]
    if (!image || image.kind !== "image") throw new Error("Expected image test item.")
    image.imageEnabled = false

    const { host, getState } = createHost(state)
    const root = document.createElement("section")
    const controller = new H3TimelineController(root, host, node)
    const collapse = root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')
    const body = root.querySelector<HTMLElement>(".rl-h3-timeline__body")
    expect(collapse?.getAttribute("aria-expanded")).toBe("false")
    expect(body?.hidden).toBe(true)
    expect(collapse?.getAttribute("aria-controls")).toBe(body?.id)

    root.querySelector<HTMLButtonElement>('[data-h3-action="toggle"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="add"]')?.click()

    const row = root.querySelector<HTMLElement>(".rl-h3-timeline__guide")
    expect(row).not.toBeNull()
    const selects = row?.querySelectorAll<HTMLSelectElement>("select")
    expect(
      [...root.querySelectorAll("option")].some((item) => item.value === "disabled-image"),
    ).toBe(true)
    if (!selects || selects.length !== 2) throw new Error("Expected Visual and Audio selects.")
    selects[0].value = "disabled-image"
    selects[0].dispatchEvent(new Event("change", { bubbles: true }))
    const currentRow = root.querySelector<HTMLElement>(".rl-h3-timeline__guide")
    const currentSelects = currentRow?.querySelectorAll<HTMLSelectElement>("select")
    if (!currentSelects || currentSelects.length !== 2) throw new Error("Expected current selects.")
    currentSelects[1].value = "guide-audio"
    currentSelects[1].dispatchEvent(new Event("change", { bubbles: true }))
    const frame = root.querySelector<HTMLInputElement>('input[data-h3-action="frame"]')
    if (!frame) throw new Error("Expected guide frame input.")
    frame.value = "48"
    frame.dispatchEvent(new Event("change", { bubbles: true }))

    expect(getState().h3Timeline.guides[0]).toMatchObject({
      frameIndex: 48,
      visualId: "disabled-image",
      audioId: "guide-audio",
    })
    controller.destroy()
    expect(root.childElementCount).toBe(0)
  })

  test("uses a unique accessible body ID for each mounted panel", () => {
    const first = createHost(createEmptyLoaderState())
    const second = createHost(createEmptyLoaderState())
    const firstRoot = document.createElement("section")
    const secondRoot = document.createElement("section")
    const firstController = new H3TimelineController(firstRoot, first.host, node)
    const secondController = new H3TimelineController(secondRoot, second.host, node)

    const firstBody = firstRoot.querySelector<HTMLElement>(".rl-h3-timeline__body")
    const secondBody = secondRoot.querySelector<HTMLElement>(".rl-h3-timeline__body")
    expect(firstBody?.id).not.toBe(secondBody?.id)
    expect(firstRoot.querySelector("[aria-controls]")?.getAttribute("aria-controls")).toBe(
      firstBody?.id,
    )
    expect(secondRoot.querySelector("[aria-controls]")?.getAttribute("aria-controls")).toBe(
      secondBody?.id,
    )
    firstController.destroy()
    secondController.destroy()
  })
})
