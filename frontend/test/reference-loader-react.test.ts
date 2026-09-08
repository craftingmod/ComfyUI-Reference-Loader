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

  test("does not reorder a loader from a foreign drag scope", () => {
    const source = mount()
    const target = mount()
    const startDrag = (card: HTMLElement, transfer: DataTransfer): void => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))
      const event = new DragEvent("dragstart", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "dataTransfer", { value: transfer })
      card.dispatchEvent(event)
    }

    const sourceCard = source.root.querySelector<HTMLElement>('.rl-card[data-id="scene"]')!
    const targetSource = target.root.querySelector<HTMLElement>('.rl-card[data-id="scene"]')!
    const targetCard = target.root.querySelector<HTMLElement>('.rl-card[data-id="second"]')!
    const sourceTransfer = new DataTransfer()
    startDrag(sourceCard, sourceTransfer)
    startDrag(targetSource, new DataTransfer())

    const drop = new DragEvent("drop", { bubbles: true, cancelable: true })
    Object.defineProperty(drop, "dataTransfer", { value: sourceTransfer })
    targetCard.dispatchEvent(drop)

    expect(target.controller.state.imageOrder).toEqual(["scene", "second"])

    source.controller.destroy()
    target.controller.destroy()
    source.root.remove()
    target.root.remove()
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

  test("keeps a single-image root and reference identity while replacing its source", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    let uploadCount = 0
    const image = createMediaItem("image", source("original.png", "image/png"), "single")
    image.caption = "keep this caption"
    const initialState = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({
        async fetchApi(route, options) {
          if (route.endsWith("/upload")) {
            const form = options?.body
            const file = form instanceof FormData ? form.get("file") : undefined
            uploadCount += 1
            return new Response(
              JSON.stringify({
                kind: "image",
                source: {
                  path: `reference_loader/sources/${file instanceof File ? file.name : "replacement.png"}`,
                  mime: "image/png",
                  sha256: String(uploadCount).repeat(64),
                },
                metadata: { width: 800, height: 600 },
              }),
              { status: 201 },
            )
          }
          if (route.endsWith("/metadata"))
            return new Response(JSON.stringify({ metadata: { width: 800, height: 600 } }))
          if (route.endsWith("/image_proxy"))
            return new Response(JSON.stringify({ url: "/single-image-preview.webp" }))
          throw new Error(`Unexpected route: ${route}`)
        },
      }),
      serializeLoaderState(initialState),
      {},
      { mode: "single-image" },
    )
    const surface = root.querySelector<HTMLElement>("[data-loader-react-surface]")
    expect(surface).not.toBeNull()
    expect(root.querySelector(".rl-toolbar")).toBeNull()
    expect(root.querySelectorAll(".rl-channel")).toHaveLength(0)
    expect(root.querySelector('.rl-single-image-card[data-id="single"]')).not.toBeNull()

    await controller.uploadFiles([
      new File(["replacement"], "replacement.png", { type: "image/png" }),
    ])

    expect(root.querySelector<HTMLElement>("[data-loader-react-surface]")).toBe(surface)
    expect(controller.state.imageOrder).toEqual(["single"])
    expect(controller.state.items.single?.sourceFilename).toBe("replacement.png")
    expect(controller.state.items.single?.caption).toBe("keep this caption")
    expect(root.querySelector('.rl-single-image-card[data-id="single"]')).not.toBeNull()
    expect(root.querySelector(".rl-single-image-select__value")?.textContent).toBe(
      "replacement.png",
    )

    controller.destroy()
    root.remove()
  })
})
