import { describe, expect, test } from "bun:test"

import type { ComfyApiLike, ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

function createNode(): ComfyNode {
  return {
    addWidget: () => ({ name: "unused", value: null }),
    addDOMWidget: () => ({ name: "unused", value: null }),
    setDirtyCanvas: () => undefined,
  }
}

describe("Reference Loader view publication", () => {
  test("keeps a stable snapshot until state, display, or runtime changes", () => {
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      createNode(),
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      undefined,
    )
    const initial = controller.getViewSnapshot()
    let notifications = 0
    const unsubscribe = controller.subscribeView(() => {
      notifications += 1
    })

    expect(notifications).toBe(1)
    expect(controller.getViewSnapshot()).toBe(initial)
    controller.render(true)
    expect(notifications).toBe(1)
    expect(controller.getViewSnapshot()).toBe(initial)

    controller.writeDisplayProxy({ cardAspect: "1 / 1" })
    expect(notifications).toBe(2)
    const changed = controller.getViewSnapshot()
    expect(changed).not.toBe(initial)
    expect(changed.display.cardAspect).toBe("1 / 1")
    controller.render(true)
    expect(controller.getViewSnapshot()).toBe(changed)

    unsubscribe()
    controller.destroy()
    root.remove()
  })

  test("publishes caption changes without replacing the focused legacy input", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/image.png", mime: "image/png", sha256: "a".repeat(64) },
      "image-1",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      createNode(),
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      serializeLoaderState(state),
    )
    const textarea = root.querySelector<HTMLTextAreaElement>('textarea[data-field="caption"]')
    expect(textarea).not.toBeNull()
    textarea?.focus()
    let notifications = 0
    const unsubscribe = controller.subscribeView(() => {
      notifications += 1
    })
    const before = controller.getViewSnapshot()

    if (textarea) {
      textarea.value = "typed"
      textarea.dispatchEvent(new Event("input", { bubbles: true }))
    }

    expect(controller.state.items[image.id]?.caption).toBe("typed")
    expect(controller.getViewSnapshot()).not.toBe(before)
    expect(notifications).toBe(2)
    expect(document.activeElement).toBe(textarea)

    unsubscribe()
    controller.destroy()
    root.remove()
  })

  test("publishes runtime-only completion without adding Loader history", async () => {
    const root = document.createElement("div")
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/image.png", mime: "image/png", sha256: "b".repeat(64) },
      "image-1",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const api: ComfyApiLike = {
      fetchApi: async (route) =>
        route.endsWith("metadata")
          ? new Response(JSON.stringify({ metadata: { width: 2, height: 3 } }))
          : new Response(JSON.stringify({ url: "/runtime-preview.webp" })),
    }
    const controller = new ReferenceLoaderController(
      root,
      createNode(),
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    const initial = controller.getViewSnapshot()
    let notifications = 0
    const unsubscribe = controller.subscribeView(() => {
      notifications += 1
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(controller.getViewSnapshot()).not.toBe(initial)
    expect(controller.getViewSnapshot().runtime.get(image.id)).toMatchObject({
      loading: false,
      previewUrl: "/runtime-preview.webp",
    })
    expect(controller.getViewSnapshot().canUndo).toBe(false)
    expect(notifications).toBeGreaterThan(1)

    unsubscribe()
    controller.destroy()
    root.remove()
  })

  test("does not notify Prompt references for an unrelated render", () => {
    const root = document.createElement("div")
    const controller = new ReferenceLoaderController(
      root,
      createNode(),
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      undefined,
    )
    let notifications = 0
    const unsubscribe = controller.subscribePromptReferences(() => {
      notifications += 1
    })
    expect(notifications).toBe(1)
    controller.render(true)
    controller.render(true)
    expect(notifications).toBe(1)

    unsubscribe()
    controller.destroy()
    root.remove()
  })

  test("notifies Prompt references when a source changes behind the same visible filename", () => {
    const root = document.createElement("div")
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/image.png", mime: "image/png", sha256: "c".repeat(64) },
      "image-1",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      createNode(),
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )
    let notifications = 0
    const unsubscribe = controller.subscribePromptReferences(() => {
      notifications += 1
    })
    const replaced = loaderReducer(state, {
      type: "replace-media",
      id: image.id,
      item: createMediaItem(
        "image",
        {
          path: "reference_loader/edits/image.png",
          mime: "image/png",
          sha256: "d".repeat(64),
        },
        image.id,
      ),
    })

    controller.restore(serializeLoaderState(replaced))

    expect(notifications).toBe(2)
    unsubscribe()
    controller.destroy()
    root.remove()
  })
})
