import { describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
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

function stateWithMedia() {
  let state = createEmptyLoaderState()
  for (const item of [
    createMediaItem("image", source("scene.png", "image/png"), "scene"),
    createMediaItem("image", source("second.png", "image/png"), "second"),
    createMediaItem("video", source("clip.mp4", "video/mp4"), "clip"),
    createMediaItem("audio", source("voice.wav", "audio/wav"), "voice"),
  ])
    state = loaderReducer(state, { type: "add", item })
  return state
}

function mount() {
  const root = document.createElement("div")
  document.body.append(root)
  const controller = new ReferenceLoaderController(
    root,
    node,
    new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
    serializeLoaderState(stateWithMedia()),
  )
  return { root, controller }
}

describe("Reference Loader React Media surface", () => {
  test("mounts one permanent root for GUIDE-free Media and keeps keyed DOM across updates", () => {
    const { root, controller } = mount()
    const surface = root.querySelector<HTMLElement>("[data-loader-react-surface]")
    const scene = root.querySelector<HTMLElement>('.rl-card[data-id="scene"][data-channel="image"]')
    expect(surface).not.toBeNull()
    expect(root.querySelector("[data-loader-legacy-root]")?.textContent).toBe("")
    expect(root.querySelector(".rl-h3-media-guides")).toBeNull()
    expect(root.querySelector('[data-action="toggle-h3-guide"]')).toBeNull()
    expect(root.querySelectorAll(".rl-channel")).toHaveLength(3)
    expect(root.querySelectorAll('.rl-card[data-id="clip"]')).toHaveLength(2)

    controller.setPromptShots([{ tag: "shot", frameIndex: 48 }])
    controller.selectItem("scene")

    expect(root.querySelector<HTMLElement>("[data-loader-react-surface]")).toBe(surface)
    expect(root.querySelector<HTMLElement>('.rl-card[data-id="scene"][data-channel="image"]')).toBe(
      scene,
    )
    expect(scene?.classList.contains("is-selected")).toBe(true)

    controller.destroy()
    expect(root.childElementCount).toBe(0)
    root.remove()
  })

  test("routes output, caption, reorder, and undo through Controller commands once", () => {
    const { root, controller } = mount()
    const scene = root.querySelector<HTMLElement>('.rl-card[data-id="scene"][data-channel="image"]')
    const imageToggle = scene?.querySelector<HTMLButtonElement>('[data-action="toggle-image"]')
    imageToggle?.click()
    const sceneItem = controller.state.items.scene
    expect(sceneItem?.kind).toBe("image")
    expect(sceneItem?.kind === "image" ? sceneItem.imageEnabled : undefined).toBe(false)
    expect(imageToggle?.getAttribute("aria-pressed")).toBe("false")
    expect(scene?.classList.contains("is-output-disabled")).toBe(true)

    const caption = scene?.querySelector<HTMLTextAreaElement>('textarea[data-field="caption"]')
    caption?.focus()
    caption?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
    for (const value of ["한", "한글"]) {
      flushSync(() => {
        if (caption) caption.value = value
        caption?.dispatchEvent(new Event("input", { bubbles: true }))
      })
    }
    caption?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }))
    expect(controller.state.items.scene?.caption).toBe("한글")

    flushSync(() => root.querySelector<HTMLButtonElement>('[data-action="undo"]')?.click())
    expect(controller.state.items.scene?.caption).toBe("")

    flushSync(() =>
      root
        .querySelector<HTMLElement>('.rl-card[data-id="second"][data-channel="image"]')
        ?.querySelector<HTMLButtonElement>('[data-action="move-back"]')
        ?.click(),
    )
    expect(controller.state.imageOrder).toEqual(["second", "scene"])
    expect(
      root
        .querySelector('.rl-card-grid[data-drop-zone="image"]')
        ?.firstElementChild?.getAttribute("data-id"),
    ).toBe("second")

    flushSync(() => root.querySelector<HTMLButtonElement>('[data-action="undo"]')?.click())
    expect(controller.state.imageOrder).toEqual(["scene", "second"])

    controller.destroy()
    root.remove()
  })
})
