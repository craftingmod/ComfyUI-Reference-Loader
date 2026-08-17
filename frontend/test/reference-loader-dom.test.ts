import { describe, expect, test } from "bun:test"

import type { ComfyApiLike, ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

describe("Reference Loader DOM lifecycle", () => {
  test("mounts independent channels and removes its DOM on cleanup", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const api: ComfyApiLike = { fetchApi: async () => new Response("{}") }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    expect(root.querySelector("[data-media-title]")?.textContent).toBe("Media")
    expect(root.querySelector(".rl-media-header small")?.textContent).toContain(
      "image, video, and audio references",
    )
    expect(root.querySelector(".rl-media-header .rl-toolbar__count")?.textContent).toBe(
      "0 references",
    )
    expect(root.querySelector(".rl-media-topbar > .rl-media-header")).not.toBeNull()
    expect(root.querySelector(".rl-media-topbar > .rl-toolbar")).not.toBeNull()
    expect(root.querySelector(".rl-toolbar .rl-primary")?.textContent).toBe("Add")
    expect(root.querySelector(".rl-toolbar .rl-primary")?.getAttribute("aria-label")).toBe(
      "Add media",
    )
    expect(root.querySelector(".rl-snapshot__trigger")?.textContent).toContain("Snapshot")
    expect(root.querySelector(".rl-snapshot__trigger")?.getAttribute("aria-expanded")).toBe("false")
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(true)
    expect(root.querySelector('[data-action="snapshot-save"]')?.textContent).toBe("Save")
    expect(root.querySelector('[data-action="snapshot-load"]')?.textContent).toBe("Load")
    expect(root.querySelectorAll(".rl-channel")).toHaveLength(3)
    expect(root.querySelectorAll(".rl-card-grid.is-empty")).toHaveLength(3)
    expect(root.querySelectorAll(".rl-grid-add.is-wide")).toHaveLength(3)
    expect(root.querySelector<HTMLInputElement>('[data-upload-kind="image"]')?.accept).toBe(
      "image/*",
    )
    expect(root.querySelector<HTMLInputElement>('[data-upload-kind="video"]')?.accept).toBe(
      "video/*",
    )
    expect(root.querySelector<HTMLInputElement>('[data-upload-kind="audio"]')?.accept).toBe(
      "audio/*",
    )
    expect(root.textContent).toContain("Images")
    expect(root.textContent).toContain("Videos")
    expect(root.textContent).toContain("Audio")
    controller.destroy()
    expect(root.childElementCount).toBe(0)
    root.remove()
  })

  test("routes Snapshot Save and Load controls through controller actions", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let saves = 0
    let loadedName = ""
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      undefined,
      {
        saveSnapshot: () => {
          saves += 1
        },
        loadSnapshot: async (file) => {
          loadedName = file.name
          return "loaded"
        },
      },
    )

    root.querySelector<HTMLButtonElement>('[data-action="snapshot-menu"]')?.click()
    expect(root.querySelector(".rl-snapshot__trigger")?.getAttribute("aria-expanded")).toBe("true")
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(false)
    root.querySelector<HTMLButtonElement>('[data-action="snapshot-save"]')?.click()
    expect(saves).toBe(1)
    expect(root.querySelector(".rl-status")?.textContent).toBe("Snapshot saved.")
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(true)

    const input = root.querySelector<HTMLInputElement>("[data-snapshot-input]")
    let pickerClicks = 0
    if (input)
      input.click = () => {
        pickerClicks += 1
      }
    root.querySelector<HTMLButtonElement>('[data-action="snapshot-menu"]')?.click()
    root.querySelector<HTMLButtonElement>('[data-action="snapshot-load"]')?.click()
    expect(pickerClicks).toBe(1)
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(true)
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["{}"], "saved.json", { type: "application/json" })],
    })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    await Promise.resolve()
    expect(loadedName).toBe("saved.json")
    expect(root.querySelector(".rl-status")?.textContent).toBe("Snapshot loaded.")

    controller.destroy()
    root.remove()
  })

  test("closes the Snapshot dropdown with Escape and outside pointer input", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferenceLoaderController(
      root,
      {
        addWidget: () => ({ name: "unused", value: null }),
        addDOMWidget: () => ({ name: "unused", value: null }),
        setDirtyCanvas: () => undefined,
      },
      new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
      undefined,
    )
    const trigger = root.querySelector<HTMLButtonElement>('[data-action="snapshot-menu"]')
    trigger?.click()
    const save = root.querySelector<HTMLButtonElement>('[data-action="snapshot-save"]')
    expect(document.activeElement).toBe(save)
    save?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }))
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(true)
    expect(document.activeElement).toBe(trigger)

    trigger?.click()
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    expect(root.querySelector<HTMLElement>(".rl-snapshot__menu")?.hidden).toBe(true)

    controller.destroy()
    root.remove()
  })

  test("clears all references as one undoable toolbar action", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/clear.png",
        mime: "image/png",
        sha256: "f".repeat(64),
      },
      "clear-image",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )

    const clear = root.querySelector<HTMLButtonElement>('[data-action="clear"]')
    expect(clear?.textContent).toBe("Clear")
    expect(clear?.classList.contains("rl-clear")).toBe(true)
    expect(clear?.disabled).toBe(false)
    clear?.click()
    expect(controller.state.items).toEqual({})
    expect(root.querySelector<HTMLButtonElement>('[data-action="clear"]')?.disabled).toBe(true)
    expect(root.textContent).toContain("All references cleared. Undo is available.")

    root.querySelector<HTMLButtonElement>('[data-action="undo"]')?.click()
    expect(controller.state.items[image.id]).toBeDefined()
    expect(root.querySelector<HTMLButtonElement>('[data-action="clear"]')?.disabled).toBe(false)
    controller.destroy()
    root.remove()
  })

  test("numbers only enabled outputs independently in each media channel", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const media = [
      createMediaItem(
        "image",
        { path: "reference_loader/sources/i1.png", mime: "image/png", sha256: "1".repeat(64) },
        "i1",
      ),
      createMediaItem(
        "image",
        { path: "reference_loader/sources/i2.png", mime: "image/png", sha256: "2".repeat(64) },
        "i2",
      ),
      createMediaItem(
        "image",
        { path: "reference_loader/sources/i3.png", mime: "image/png", sha256: "3".repeat(64) },
        "i3",
      ),
      createMediaItem(
        "video",
        { path: "reference_loader/sources/v1.mp4", mime: "video/mp4", sha256: "4".repeat(64) },
        "v1",
      ),
      createMediaItem(
        "video",
        { path: "reference_loader/sources/v2.mp4", mime: "video/mp4", sha256: "5".repeat(64) },
        "v2",
      ),
      createMediaItem(
        "audio",
        { path: "reference_loader/sources/a1.wav", mime: "audio/wav", sha256: "6".repeat(64) },
        "a1",
      ),
      createMediaItem(
        "audio",
        { path: "reference_loader/sources/a2.wav", mime: "audio/wav", sha256: "7".repeat(64) },
        "a2",
      ),
    ]
    for (const item of media) {
      if (item.kind === "video") item.audioEnabled = true
    }
    let state = createEmptyLoaderState()
    for (const item of media) state = loaderReducer(state, { type: "add", item })
    state = loaderReducer(state, { type: "toggle", id: "i2", channel: "image" })
    state = loaderReducer(state, { type: "toggle", id: "v2", channel: "video" })
    state = loaderReducer(state, { type: "toggle", id: "a1", channel: "audio" })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )

    const channelIndices = (channel: string): string[] =>
      [
        ...root.querySelectorAll<HTMLElement>(
          `.rl-channel[data-channel="${channel}"] .rl-output-index`,
        ),
      ].map((badge) => badge.textContent ?? "")
    expect(channelIndices("image")).toEqual(["#1", "#2"])
    expect(channelIndices("video")).toEqual(["#1"])
    expect(channelIndices("audio")).toEqual(["#1", "#2", "#3"])
    expect(
      root.querySelector('.rl-card[data-id="i2"][data-channel="image"] .rl-output-index'),
    ).toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="v2"][data-channel="video"] .rl-output-index'),
    ).toBeNull()
    expect(
      root.querySelector('.rl-card[data-id="v2"][data-channel="audio"] .rl-output-index')
        ?.textContent,
    ).toBe("#2")
    expect(
      root.querySelector('.rl-card[data-id="a1"][data-channel="audio"] .rl-output-index'),
    ).toBeNull()
    expect(
      controller.promptReferences.map(({ referenceId, mediaKind, tag, label }) => ({
        referenceId,
        mediaKind,
        tag,
        label,
      })),
    ).toEqual([
      { referenceId: "i1", mediaKind: "image", tag: "<Picture 1>", label: "image1" },
      { referenceId: "i3", mediaKind: "image", tag: "<Picture 2>", label: "image2" },
      { referenceId: "v1", mediaKind: "video", tag: "<Video 1>", label: "video1" },
      {
        referenceId: "v1:audio",
        mediaKind: "audio",
        tag: "<Audio 1>",
        label: "audio1",
      },
      {
        referenceId: "v2:audio",
        mediaKind: "audio",
        tag: "<Audio 2>",
        label: "audio2",
      },
      { referenceId: "a2", mediaKind: "audio", tag: "<Audio 3>", label: "audio3" },
    ])
    let referenceNotifications = 0
    const unsubscribe = controller.subscribePromptReferences(() => {
      referenceNotifications += 1
    })

    root
      .querySelector<HTMLButtonElement>(
        '.rl-card[data-id="i2"][data-channel="image"] [data-action="toggle-image"]',
      )
      ?.click()
    expect(channelIndices("image")).toEqual(["#1", "#2", "#3"])
    expect(controller.promptReferences[1]).toMatchObject({
      referenceId: "i2",
      tag: "<Picture 2>",
      label: "image2",
    })
    controller.restore(serializeLoaderState(state))
    expect(referenceNotifications).toBeGreaterThanOrEqual(3)
    unsubscribe()
    controller.destroy()
    root.remove()
  })

  test("two-image mode blocks only a third enabled IMAGE output", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      properties: { referenceLoader: { twoImageMode: true } },
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let state = createEmptyLoaderState()
    for (const [index, id] of ["first", "second", "candidate"].entries()) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "image",
          {
            path: `reference_loader/sources/${id}.png`,
            mime: "image/png",
            sha256: String(index + 1).repeat(64),
          },
          id,
        ),
      })
    }
    state = loaderReducer(state, { type: "toggle", id: "candidate", channel: "image" })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )

    root
      .querySelector<HTMLButtonElement>(
        '.rl-card[data-id="candidate"] [data-action="toggle-image"]',
      )
      ?.click()
    expect(controller.state.items.candidate).toMatchObject({ imageEnabled: false })
    expect(root.querySelector(".rl-status")?.textContent).toContain("at most two enabled Images")

    root
      .querySelector<HTMLButtonElement>('.rl-card[data-id="second"] [data-action="toggle-image"]')
      ?.click()
    root
      .querySelector<HTMLButtonElement>(
        '.rl-card[data-id="candidate"] [data-action="toggle-image"]',
      )
      ?.click()
    expect(controller.state.items.second).toMatchObject({ imageEnabled: false })
    expect(controller.state.items.candidate).toMatchObject({ imageEnabled: true })

    controller.destroy()
    root.remove()
  })

  test("two-image mode rejects activation when three Images are already enabled", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      properties: {},
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let state = createEmptyLoaderState()
    for (const [index, id] of ["one", "two", "three"].entries()) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "image",
          {
            path: `reference_loader/sources/${id}.png`,
            mime: "image/png",
            sha256: String(index + 1).repeat(64),
          },
          id,
        ),
      })
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )

    controller.writeDisplayProxy({ twoImageMode: true })

    expect(
      (node.properties?.referenceLoader as Record<string, unknown> | undefined)?.twoImageMode,
    ).not.toBe(true)
    expect(root.querySelector(".rl-status")?.textContent).toContain(
      "requires at most two enabled Images",
    )
    controller.destroy()
    root.remove()
  })

  test("two-image mode keeps additional uploaded Images disabled", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      properties: { referenceLoader: { twoImageMode: true } },
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let state = createEmptyLoaderState()
    for (const [index, id] of ["start", "end"].entries()) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "image",
          {
            path: `reference_loader/sources/${id}.png`,
            mime: "image/png",
            sha256: String(index + 1).repeat(64),
          },
          id,
        ),
      })
    }
    const api: ComfyApiLike = {
      fetchApi: async (route) => {
        if (route.endsWith("/upload")) {
          return new Response(
            JSON.stringify({
              kind: "image",
              source: {
                path: "reference_loader/sources/extra.png",
                mime: "image/png",
                sha256: "e".repeat(64),
              },
              metadata: { width: 1, height: 1 },
            }),
            { status: 201 },
          )
        }
        if (route.endsWith("/metadata")) {
          return new Response(JSON.stringify({ metadata: { width: 1, height: 1 } }))
        }
        if (route.endsWith("/image_proxy")) {
          return new Response(JSON.stringify({ url: "/api/view?filename=extra.webp" }))
        }
        return new Response("{}")
      },
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const input = root.querySelector<HTMLInputElement>('[data-upload-kind="image"]')
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["extra"], "extra.png", { type: "image/png" })],
    })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const extra = Object.values(controller.state.items).find(
      (item) => item.source.path === "reference_loader/sources/extra.png",
    )
    expect(extra).toMatchObject({ kind: "image", imageEnabled: false })
    expect(root.querySelector(".rl-status")?.textContent).toContain("disabled by two-image mode")
    controller.destroy()
    root.remove()
  })

  test("uploads a media file dropped onto the loader and shows drop feedback", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const api: ComfyApiLike = {
      fetchApi: async (route) => {
        if (route.endsWith("/upload")) {
          return new Response(
            JSON.stringify({
              kind: "image",
              source: {
                path: "reference_loader/sources/dropped.png",
                mime: "image/png",
                sha256: "d".repeat(64),
              },
              metadata: { width: 2, height: 2 },
            }),
            { status: 201 },
          )
        }
        if (route.endsWith("/metadata"))
          return new Response(JSON.stringify({ metadata: { width: 2, height: 2 } }))
        if (route.endsWith("/image_proxy"))
          return new Response(JSON.stringify({ url: "/api/view?filename=dropped.webp" }))
        return new Response("{}")
      },
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    const transfer = new DataTransfer()
    transfer.items.add(new File(["image"], "dropped.png", { type: "image/png" }))
    const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true })
    Object.defineProperty(dragover, "dataTransfer", { value: transfer })
    root.dispatchEvent(dragover)

    expect(dragover.defaultPrevented).toBe(true)
    expect(root.classList.contains("is-file-dragging")).toBe(true)

    const drop = new DragEvent("drop", { bubbles: true, cancelable: true })
    Object.defineProperty(drop, "dataTransfer", { value: transfer })
    root.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    expect(root.classList.contains("is-file-dragging")).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(Object.values(controller.state.items)).toEqual([
      expect.objectContaining({
        kind: "image",
        sourceFilename: "dropped.png",
        source: expect.objectContaining({ path: "reference_loader/sources/dropped.png" }),
      }),
    ])
    controller.destroy()
    root.remove()
  })

  test("arms native article dragging from the card surface but not its controls", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const api: ComfyApiLike = { fetchApi: async () => new Response("{}") }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/a.png",
        mime: "image/png",
        sha256: "a".repeat(64),
      },
      "a",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    const card = root.querySelector<HTMLElement>('.rl-card[data-channel="image"]')
    const surface = card?.querySelector<HTMLElement>(".rl-card__media")
    const caption = card?.querySelector<HTMLTextAreaElement>("textarea")
    expect(card).toBeDefined()
    expect(surface?.classList.contains("is-transparent-preview")).toBe(true)
    expect(
      root.querySelector('.rl-channel[data-channel="image"] .rl-grid-add.is-tile'),
    ).not.toBeNull()
    expect(root.querySelector(".rl-settings")).toBeNull()
    expect(root.querySelector(".rl-drag")).toBeNull()
    surface?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true })
    card?.dispatchEvent(drag)
    expect(drag.defaultPrevented).toBe(false)
    card?.dispatchEvent(new DragEvent("dragend", { bubbles: true }))
    caption?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    const blockedDrag = new DragEvent("dragstart", { bubbles: true, cancelable: true })
    card?.dispatchEvent(blockedDrag)
    expect(blockedDrag.defaultPrevented).toBe(true)
    expect(card?.querySelector('[data-action="remove"]')?.classList.contains("rl-remove")).toBe(
      true,
    )
    expect(card?.querySelector('[data-action="remove"]')?.closest(".rl-card__media")).not.toBeNull()
    const actions = card?.querySelector(".rl-card__actions")
    expect(actions?.closest(".rl-card__media")).toBeNull()
    expect(actions?.closest(".rl-card__body")).not.toBeNull()
    expect(actions?.previousElementSibling?.matches("textarea[data-field='caption']")).toBe(true)
    const editButton = card?.querySelector<HTMLButtonElement>('[data-action="edit"]')
    expect(editButton?.textContent?.trim()).toBe("")
    expect(editButton?.getAttribute("aria-label")).toBe("Edit reference")
    expect(editButton?.querySelector("svg")).not.toBeNull()
    expect(card?.querySelector(".rl-card__title")).toBeNull()
    const imageFilename = card?.querySelector<HTMLElement>(".rl-media-filename")
    expect(imageFilename?.textContent).toBe("a.png")
    expect(imageFilename?.title).toBe("a.png")

    card
      ?.querySelector<HTMLButtonElement>('[data-action="remove"]')
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(document.querySelector(".rl-image-editor")).toBeNull()
    expect(controller.state.items.a).toBeDefined()
    card
      ?.querySelector<HTMLElement>(".rl-card__body")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(document.querySelector(".rl-image-editor")).toBeNull()
    surface?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    expect(card?.classList.contains("is-selected")).toBe(true)
    expect(card?.querySelector(".rl-card__media")).toBe(surface)
    surface?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    surface?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(document.querySelector(".rl-image-editor")).not.toBeNull()
    document.querySelector<HTMLButtonElement>('.rl-image-editor [data-action="cancel"]')?.click()
    controller.destroy()
    root.remove()
  })

  test("shows the original filename as a media overlay on Video and Audio cards", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const video = createMediaItem(
      "video",
      {
        path: "reference_loader/sources/scene soundtrack.mp4",
        mime: "video/mp4",
        sha256: "f".repeat(64),
      },
      "named-video",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )
    const videoCard = root.querySelector<HTMLElement>('.rl-card[data-channel="video"]')
    const audioCard = root.querySelector<HTMLElement>('.rl-card[data-channel="audio"]')
    const videoFilename = videoCard?.querySelector<HTMLElement>(".rl-media-filename")
    const audioFilename = audioCard?.querySelector<HTMLElement>(".rl-media-filename")
    expect(videoCard?.querySelector('[data-action="toggle-video"]')).not.toBeNull()
    expect(videoCard?.querySelector('[data-action="toggle-audio"]')).toBeNull()
    expect(audioCard?.querySelector('[data-action="toggle-audio"]')).not.toBeNull()
    expect(audioCard?.querySelector('[data-action="toggle-video"]')).toBeNull()
    expect(videoFilename?.textContent).toBe("scene soundtrack.mp4")
    expect(videoFilename?.title).toBe("scene soundtrack.mp4")
    expect(audioFilename?.textContent).toBe("scene soundtrack.mp4")
    expect(audioFilename?.title).toBe("scene soundtrack.mp4")

    audioFilename?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    const drag = new DragEvent("dragstart", { bubbles: true, cancelable: true })
    audioCard?.dispatchEvent(drag)
    expect(drag.defaultPrevented).toBe(false)
    audioCard?.dispatchEvent(new DragEvent("dragend", { bubbles: true }))
    controller.destroy()
    root.remove()
  })

  test("hides card captions from node properties while keeping them in Edit", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      properties: { referenceLoader: { showCaptions: false } },
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/captioned.png",
        mime: "image/png",
        sha256: "c".repeat(64),
      },
      "captioned",
    )
    image.caption = "kept detail caption"
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )
    expect(root.querySelector("textarea[data-field='caption']")).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click()
    expect(
      document.querySelector<HTMLTextAreaElement>('.rl-image-editor textarea[data-field="caption"]')
        ?.value,
    ).toBe("kept detail caption")
    document.querySelector<HTMLButtonElement>('.rl-image-editor [data-action="cancel"]')?.click()
    await Promise.resolve()
    controller.destroy()
    root.remove()
  })

  test("forces the card caption to refresh after applying the image editor", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const dirtyPreviewUrls: Array<string | undefined> = []
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => {
        dirtyPreviewUrls.push(
          root.querySelector<HTMLImageElement>("img")?.getAttribute("src") ?? undefined,
        )
      },
    }
    const api: ComfyApiLike = {
      async fetchApi(route) {
        if (route.endsWith("metadata")) {
          return new Response(JSON.stringify({ metadata: { width: 2048, height: 1024 } }), {
            status: 200,
          })
        }
        if (route.endsWith("image_proxy")) {
          return new Response(JSON.stringify({ url: "/caption-preview.webp" }), { status: 200 })
        }
        if (route.endsWith("apply_edit")) {
          return new Response(
            JSON.stringify({
              source: {
                path: "reference_loader/edits/captioned.png",
                mime: "image/png",
                sha256: "d".repeat(64),
                revision: 1,
              },
              edit: { revision: 1 },
              proxy_url: "/caption-edited.webp",
              metadata: { width: 1024, height: 1024 },
            }),
            { status: 201 },
          )
        }
        throw new Error(`Unexpected route: ${route}`)
      },
    }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/captioned.png",
        mime: "image/png",
        sha256: "c".repeat(64),
      },
      "captioned",
    )
    image.caption = "before"
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.querySelector(".rl-megapixels")?.textContent).toBe("2.1 MP")

    const previousCaption = root.querySelector<HTMLTextAreaElement>(
      'textarea[data-field="caption"]',
    )
    previousCaption?.focus()
    root.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click()
    const editorCaption = document.querySelector<HTMLTextAreaElement>(
      '.rl-image-editor textarea[data-field="caption"]',
    )
    if (editorCaption) editorCaption.value = "after"
    document.querySelector<HTMLButtonElement>('.rl-image-editor [data-action="apply"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const refreshedCaption = root.querySelector<HTMLTextAreaElement>(
      'textarea[data-field="caption"]',
    )
    expect(refreshedCaption).not.toBe(previousCaption)
    expect(refreshedCaption?.value).toBe("after")
    expect(root.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(
      "/caption-edited.webp",
    )
    expect(root.querySelector(".rl-megapixels")?.textContent).toBe("1.05 MP")
    expect(dirtyPreviewUrls[dirtyPreviewUrls.length - 1]).toBe("/caption-edited.webp")
    expect(JSON.parse(controller.serialize()).items.captioned.caption).toBe("after")
    controller.destroy()
    root.remove()
  })

  test("syncs an inherited video caption across cards without replacing the focused textarea", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const video = createMediaItem(
      "video",
      {
        path: "reference_loader/sources/video.mp4",
        mime: "video/mp4",
        sha256: "e".repeat(64),
      },
      "video",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )
    const visualCaption = root.querySelector<HTMLTextAreaElement>(
      '.rl-card[data-channel="video"] textarea',
    )
    const audioCaption = root.querySelector<HTMLTextAreaElement>(
      '.rl-card[data-channel="audio"] textarea',
    )
    if (visualCaption) {
      visualCaption.value = "shared"
      visualCaption.dispatchEvent(new Event("input", { bubbles: true }))
    }
    expect(audioCaption?.value).toBe("shared")
    if (audioCaption) {
      audioCaption.value = "audio override"
      audioCaption.dispatchEvent(new Event("input", { bubbles: true }))
    }
    if (visualCaption) {
      visualCaption.value = "visual only"
      visualCaption.dispatchEvent(new Event("input", { bubbles: true }))
    }
    expect(audioCaption?.value).toBe("audio override")
    expect(JSON.parse(controller.serialize()).items.video).toMatchObject({
      caption: "visual only",
      audioCaptionOverride: "audio override",
    })
    controller.destroy()
    root.remove()
  })

  test("highlights the card that will exchange position during drag reorder", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let state = createEmptyLoaderState()
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem(
        "image",
        { path: "reference_loader/sources/a.png", mime: "image/png", sha256: "a".repeat(64) },
        "a",
      ),
    })
    state = loaderReducer(state, {
      type: "add",
      item: createMediaItem(
        "image",
        { path: "reference_loader/sources/b.png", mime: "image/png", sha256: "b".repeat(64) },
        "b",
      ),
    })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
    )
    const sourceCard = root.querySelector<HTMLElement>('.rl-card[data-id="a"]')
    const targetCard = root.querySelector<HTMLElement>('.rl-card[data-id="b"]')
    sourceCard
      ?.querySelector<HTMLElement>(".rl-card__media")
      ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    sourceCard?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
    targetCard?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }))
    expect(targetCard?.classList.contains("is-drop-target")).toBe(true)
    expect(sourceCard?.classList.contains("is-drop-target")).toBe(false)
    sourceCard?.dispatchEvent(new DragEvent("dragend", { bubbles: true }))
    expect(targetCard?.classList.contains("is-drop-target")).toBe(false)
    controller.destroy()
    root.remove()
  })

  test("wraps state mutations in the owning graph change transaction", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const transactions: string[] = []
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
      graph: {
        beforeChange: () => transactions.push("before"),
        afterChange: () => transactions.push("after"),
      },
    }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/a.png",
        mime: "image/png",
        sha256: "a".repeat(64),
      },
      "a",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi({ fetchApi: async () => new Promise<Response>(() => undefined) }),
      serializeLoaderState(state),
      {
        beforeChange: () => transactions.push("emit-before"),
        afterChange: () => transactions.push("emit-after"),
      },
    )
    root.querySelector<HTMLButtonElement>('[data-action="toggle-image"]')?.click()
    expect(transactions).toEqual(["emit-before", "before", "after", "emit-after"])
    const disabledCard = root.querySelector<HTMLElement>('.rl-card[data-channel="image"]')
    expect(disabledCard?.classList.contains("is-output-disabled")).toBe(true)
    expect(disabledCard?.dataset.outputEnabled).toBe("false")
    expect(
      disabledCard?.querySelector<HTMLButtonElement>('[data-action="toggle-image"]')?.disabled,
    ).toBe(false)
    controller.destroy()
    root.remove()
  })

  test("ignores a delayed runtime response from before same-id workflow restore", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const resolvers: Array<(response: Response) => void> = []
    const api: ComfyApiLike = { fetchApi: () => new Promise((resolve) => resolvers.push(resolve)) }
    const first = createMediaItem(
      "image",
      { path: "reference_loader/sources/old.png", mime: "image/png", sha256: "a".repeat(64) },
      "same",
    )
    const second = createMediaItem(
      "image",
      { path: "reference_loader/sources/new.png", mime: "image/png", sha256: "b".repeat(64) },
      "same",
    )
    const firstState = loaderReducer(createEmptyLoaderState(), { type: "add", item: first })
    const secondState = loaderReducer(createEmptyLoaderState(), { type: "add", item: second })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(firstState),
    )
    await Promise.resolve()
    expect(resolvers.length).toBe(2)
    controller.restore(serializeLoaderState(secondState))
    await Promise.resolve()
    expect(resolvers.length).toBe(4)
    resolvers[0]?.(new Response(JSON.stringify({ metadata: { width: 1 } }), { status: 200 }))
    resolvers[1]?.(new Response(JSON.stringify({ url: "/old.webp" }), { status: 200 }))
    await Promise.resolve()
    await Promise.resolve()
    resolvers[2]?.(new Response(JSON.stringify({ metadata: { width: 2 } }), { status: 200 }))
    resolvers[3]?.(new Response(JSON.stringify({ url: "/new.webp" }), { status: 200 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("/new.webp")
    controller.destroy()
    root.remove()
  })

  test("limits runtime hydration to four media items at a time", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let activeRequests = 0
    let maximumActiveRequests = 0
    let calls = 0
    const api: ComfyApiLike = {
      fetchApi(route, init) {
        calls += 1
        activeRequests += 1
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
        return new Promise((resolve, reject) => {
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            activeRequests -= 1
            init?.signal?.removeEventListener("abort", abort)
            resolve(
              route.endsWith("metadata")
                ? new Response(JSON.stringify({ metadata: { width: 1, height: 1 } }), {
                    status: 200,
                  })
                : new Response(JSON.stringify({ url: `/preview-${calls}.webp` }), { status: 200 }),
            )
          }
          const abort = (): void => {
            if (settled) return
            settled = true
            activeRequests -= 1
            reject(new DOMException("Aborted", "AbortError"))
          }
          init?.signal?.addEventListener("abort", abort, { once: true })
          setTimeout(finish, 5)
        })
      },
    }
    let state = createEmptyLoaderState()
    for (let index = 0; index < 6; index += 1) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "image",
          {
            path: `reference_loader/sources/${index}.png`,
            mime: "image/png",
            sha256: String(index).repeat(64),
          },
          `image-${index}`,
        ),
      })
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await new Promise((resolve) => setTimeout(resolve, 35))

    expect(calls).toBe(12)
    // Each hydrated image performs metadata and proxy requests in parallel.
    expect(maximumActiveRequests).toBeLessThanOrEqual(8)
    expect(root.querySelectorAll("img")).toHaveLength(6)
    controller.destroy()
    root.remove()
  })

  test("renders restored loading cards once and batches runtime completions into one frame", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const api: ComfyApiLike = {
      fetchApi(route) {
        return Promise.resolve(
          route.endsWith("metadata")
            ? new Response(JSON.stringify({ metadata: { width: 1, height: 1 } }), { status: 200 })
            : new Response(JSON.stringify({ url: "/restored.webp" }), { status: 200 }),
        )
      },
    }
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    globalThis.requestAnimationFrame = (callback): number => {
      const frame = nextFrame
      nextFrame += 1
      frames.set(frame, callback)
      return frame
    }
    globalThis.cancelAnimationFrame = (frame): void => {
      frames.delete(frame)
    }

    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(createEmptyLoaderState()),
    )
    const originalRender = controller.render.bind(controller)
    let renderCalls = 0
    controller.render = (force = false): void => {
      renderCalls += 1
      originalRender(force)
    }
    let state = createEmptyLoaderState()
    for (let index = 0; index < 2; index += 1) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "image",
          {
            path: `reference_loader/sources/restored-${index}.png`,
            mime: "image/png",
            sha256: String(index + 1).repeat(64),
          },
          `restored-${index}`,
        ),
      })
    }

    try {
      controller.restore(serializeLoaderState(state))
      expect(renderCalls).toBe(1)
      expect(root.querySelectorAll(".rl-card__media > .rl-spinner")).toHaveLength(2)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(frames).toHaveLength(1)
      const [frame, callback] = frames.entries().next().value as [number, FrameRequestCallback]
      frames.delete(frame)
      callback(globalThis.performance.now())
      expect(renderCalls).toBe(2)
      expect(root.querySelectorAll(".rl-card__media > .rl-spinner")).toHaveLength(0)
      expect(root.querySelectorAll("img")).toHaveLength(2)
    } finally {
      controller.destroy()
      root.remove()
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })

  test("keeps a silent video's proxy without requesting a waveform", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const routes: string[] = []
    const api: ComfyApiLike = {
      async fetchApi(route) {
        routes.push(route)
        if (route.endsWith("metadata"))
          return new Response(JSON.stringify({ metadata: { duration: 2, has_audio: false } }), {
            status: 200,
          })
        if (route.endsWith("image_proxy"))
          return new Response(JSON.stringify({ url: "/silent.webp" }), { status: 200 })
        throw new Error("waveform must not be requested for silent video")
      },
    }
    const video = createMediaItem(
      "video",
      { path: "reference_loader/sources/v.mp4", mime: "video/mp4", sha256: "a".repeat(64) },
      "v",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(routes.some((route) => route.endsWith("waveform"))).toBe(false)
    expect(
      root
        .querySelector<HTMLImageElement>('.rl-card[data-channel="video"] img')
        ?.getAttribute("src"),
    ).toBe("/silent.webp")
    expect(root.querySelector('.rl-card[data-channel="audio"] img')).toBeNull()
    expect(root.querySelector('.rl-card[data-channel="audio"] canvas')).not.toBeNull()
    expect(
      root.querySelector('.rl-card[data-channel="audio"] .rl-waveform-status')?.textContent,
    ).toBe("No audio track")
    expect(root.querySelector<HTMLButtonElement>('[data-action="toggle-audio"]')?.disabled).toBe(
      true,
    )
    expect(
      root
        .querySelector('.rl-card[data-channel="audio"]')
        ?.classList.contains("is-output-disabled"),
    ).toBe(true)
    expect(
      root
        .querySelector('.rl-card[data-channel="video"]')
        ?.classList.contains("is-output-disabled"),
    ).toBe(false)
    const videoPreviewButton = root.querySelector<HTMLButtonElement>(
      '.rl-card[data-channel="video"] [data-action="preview-video"]',
    )
    expect(videoPreviewButton?.disabled).toBe(false)
    expect(
      root.querySelector<HTMLButtonElement>(
        '.rl-card[data-channel="audio"] [data-action="preview-audio"]',
      )?.disabled,
    ).toBe(true)
    const badges = root.querySelector<HTMLElement>(
      '.rl-card[data-channel="video"] .rl-media-badges',
    )
    expect(badges?.querySelector(".rl-kind")?.textContent).toBe("video")
    expect(badges?.querySelector(".rl-kind")?.classList.contains("rl-kind--video")).toBe(true)
    expect(badges?.querySelector(".rl-duration")?.textContent).toBe("2.00s")
    expect(JSON.parse(controller.serialize()).items.v.audioEnabled).toBe(false)
    controller.destroy()
    root.remove()
  })

  test("uses a play-stop toggle only on an audio GridView card", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const waveformRequests: Array<Record<string, unknown>> = []
    const api: ComfyApiLike = {
      async fetchApi(route, init) {
        if (route.endsWith("metadata"))
          return new Response(JSON.stringify({ metadata: { duration: 4 } }), { status: 200 })
        if (route.endsWith("waveform")) {
          waveformRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
          return new Response(JSON.stringify({ pairs: [[0, 0]], duration: 4 }), { status: 200 })
        }
        throw new Error(`Unexpected route: ${route}`)
      },
      apiURL: (route) => `/comfy${route}`,
    }
    const audio = createMediaItem(
      "audio",
      {
        path: "reference_loader/sources/voice.wav",
        mime: "audio/wav",
        sha256: "f".repeat(64),
      },
      "voice",
    )
    if (audio.kind !== "audio") throw new Error("Expected an audio test item.")
    audio.crop = { start: 1, end: 3 }
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: audio })
    const originalPlay = HTMLMediaElement.prototype.play
    const originalPause = HTMLMediaElement.prototype.pause
    const originalLoad = HTMLMediaElement.prototype.load
    let playCalls = 0
    let playedSource = ""
    Object.defineProperties(HTMLMediaElement.prototype, {
      play: {
        configurable: true,
        value: async function (this: HTMLMediaElement) {
          playCalls += 1
          playedSource = this.src
        },
      },
      pause: { configurable: true, value: () => undefined },
      load: { configurable: true, value: () => undefined },
    })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const button = root.querySelector<HTMLButtonElement>(
        '.rl-card[data-channel="audio"] [data-action="preview-audio"]',
      )
      expect(
        root.querySelector('.rl-card[data-channel="audio"] .rl-waveform-status')?.textContent,
      ).toBe("Silent")
      expect(button?.textContent).toBe("▶")
      button?.click()
      await Promise.resolve()
      expect(playCalls).toBe(1)
      expect(playedSource).toContain("/audio_preview?")
      expect(button?.textContent).toBe("■")
      button?.click()
      expect(button?.textContent).toBe("▶")
      button?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
      expect(document.querySelector(".rl-trim-editor")).toBeNull()
      root
        .querySelector<HTMLButtonElement>('.rl-card[data-channel="audio"] [data-action="edit"]')
        ?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(waveformRequests).toHaveLength(2)
      expect(waveformRequests[0]?.crop).toEqual({ start: 1, end: 3 })
      expect(waveformRequests[1]?.crop).toBeUndefined()
      expect(document.querySelector(".rl-trim-editor .rl-waveform-status")?.textContent).toBe(
        "Silent",
      )
      document.querySelector<HTMLButtonElement>('.rl-trim-editor [data-action="cancel"]')?.click()
    } finally {
      controller.destroy()
      Object.defineProperties(HTMLMediaElement.prototype, {
        play: { configurable: true, value: originalPlay },
        pause: { configurable: true, value: originalPause },
        load: { configurable: true, value: originalLoad },
      })
      root.remove()
    }
  })

  test("uses one video preview URL for video-with-audio and its audio-only card", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const api: ComfyApiLike = {
      async fetchApi(route) {
        if (route.endsWith("metadata")) {
          return new Response(JSON.stringify({ metadata: { duration: 4, has_audio: true } }), {
            status: 200,
          })
        }
        if (route.endsWith("image_proxy")) {
          return new Response(JSON.stringify({ url: "/video-poster.webp" }), { status: 200 })
        }
        if (route.endsWith("waveform")) {
          return new Response(JSON.stringify({ pairs: [[-0.2, 0.3]], duration: 4 }), {
            status: 200,
          })
        }
        throw new Error(`Unexpected route: ${route}`)
      },
      apiURL: (route) => `/comfy${route}`,
    }
    const video = createMediaItem(
      "video",
      {
        path: "reference_loader/sources/clip.mp4",
        mime: "video/mp4",
        sha256: "c".repeat(64),
      },
      "clip",
    )
    if (video.kind !== "video") throw new Error("Expected a video test item.")
    video.audioEnabled = true
    video.crop = { start: 1, end: 3 }
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: video })
    const originalPlay = HTMLMediaElement.prototype.play
    const originalPause = HTMLMediaElement.prototype.pause
    const originalLoad = HTMLMediaElement.prototype.load
    const played: Array<{ element: string; source: string; muted: boolean; currentTime: number }> =
      []
    Object.defineProperties(HTMLMediaElement.prototype, {
      play: {
        configurable: true,
        value: async function (this: HTMLMediaElement) {
          played.push({
            element: this.tagName,
            source: this.src,
            muted: this.muted,
            currentTime: this.currentTime,
          })
        },
      },
      pause: { configurable: true, value: () => undefined },
      load: { configurable: true, value: () => undefined },
    })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const videoButton = root.querySelector<HTMLButtonElement>(
        '.rl-card[data-channel="video"] [data-action="preview-video"]',
      )
      const audioButton = root.querySelector<HTMLButtonElement>(
        '.rl-card[data-channel="audio"] [data-action="preview-audio"]',
      )
      videoButton?.click()
      await Promise.resolve()
      const videoElement = root.querySelector<HTMLVideoElement>(
        '.rl-card[data-channel="video"] video',
      )
      expect(played[0]).toMatchObject({ element: "VIDEO", muted: false, currentTime: 1 })
      expect(played[0]?.source).toContain("/video_preview?")
      expect(videoElement?.playsInline).toBe(true)
      expect(videoElement?.hasAttribute("muted")).toBe(false)
      expect(videoButton?.textContent).toBe("■")

      audioButton?.click()
      await Promise.resolve()
      expect(played[1]).toMatchObject({ element: "AUDIO", currentTime: 1 })
      expect(played[1]?.source).toContain("/video_preview?")
      expect(root.querySelector('.rl-card[data-channel="video"] video')).toBeNull()
      expect(videoButton?.textContent).toBe("▶")
      expect(audioButton?.textContent).toBe("■")
    } finally {
      controller.destroy()
      Object.defineProperties(HTMLMediaElement.prototype, {
        play: { configurable: true, value: originalPlay },
        pause: { configurable: true, value: originalPause },
        load: { configurable: true, value: originalLoad },
      })
      root.remove()
    }
  })

  test("defers async preview rendering while a caption textarea owns focus", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const resolvers: Array<(response: Response) => void> = []
    const api: ComfyApiLike = { fetchApi: () => new Promise((resolve) => resolvers.push(resolve)) }
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/a.png", mime: "image/png", sha256: "a".repeat(64) },
      "a",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    const textarea = root.querySelector<HTMLTextAreaElement>("textarea")
    textarea?.focus()
    textarea?.setSelectionRange(0, 0)
    await Promise.resolve()
    resolvers[0]?.(new Response(JSON.stringify({ metadata: { width: 2 } }), { status: 200 }))
    resolvers[1]?.(new Response(JSON.stringify({ url: "/focused.webp" }), { status: 200 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(textarea)
    expect(root.querySelector("textarea")).toBe(textarea)
    expect(root.querySelector("img")).toBeNull()
    textarea?.blur()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("/focused.webp")
    controller.destroy()
    root.remove()
  })

  test("does not let an old-source preview overwrite a completed image edit", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const oldResolvers = new Map<string, (response: Response) => void>()
    let resolveApply: ((response: Response) => void) | undefined
    const api: ComfyApiLike = {
      fetchApi(route) {
        if (route.endsWith("apply_edit")) {
          return new Promise((resolve) => {
            resolveApply = resolve
          })
        }
        return new Promise((resolve) => oldResolvers.set(route, resolve))
      },
    }
    const image = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/old.png",
        mime: "image/png",
        sha256: "a".repeat(64),
      },
      "edited",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await Promise.resolve()
    expect(oldResolvers.size).toBe(2)

    root.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click()
    document.querySelector<HTMLButtonElement>('.rl-image-editor [data-action="apply"]')?.click()
    await Promise.resolve()
    expect(resolveApply).toBeDefined()
    const applyingOverlay = root.querySelector<HTMLElement>(".rl-card__loading-overlay")
    expect(applyingOverlay?.getAttribute("aria-label")).toBe("Applying image edit")
    expect(applyingOverlay?.textContent).toBe("")
    expect(applyingOverlay?.querySelector(".rl-spinner")).not.toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-action="edit"]')?.disabled).toBe(true)
    resolveApply?.(
      new Response(
        JSON.stringify({
          source: {
            path: "reference_loader/edits/fresh.png",
            mime: "image/png",
            sha256: "b".repeat(64),
            revision: 1,
          },
          edit: { revision: 1 },
          proxy_url: "/fresh.webp",
          metadata: { width: 2, height: 2 },
        }),
        { status: 201 },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    oldResolvers.get("/reference_loader/metadata")?.(
      new Response(JSON.stringify({ metadata: { width: 1, height: 1 } }), { status: 200 }),
    )
    oldResolvers.get("/reference_loader/image_proxy")?.(
      new Response(JSON.stringify({ url: "/stale.webp" }), { status: 200 }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.querySelector(".rl-card__loading-overlay")).toBeNull()
    expect(root.querySelector<HTMLButtonElement>('[data-action="edit"]')?.disabled).toBe(false)
    expect(root.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe("/fresh.webp")
    expect(JSON.parse(controller.serialize()).items.edited.source.path).toBe(
      "reference_loader/edits/fresh.png",
    )
    expect(JSON.parse(controller.serialize()).items.edited.sourceFilename).toBe("old.png")
    controller.destroy()
    root.remove()
  })

  test("never remounts or mutates after teardown when runtime requests finish late", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const resolvers: Array<(response: Response) => void> = []
    const api: ComfyApiLike = { fetchApi: () => new Promise((resolve) => resolvers.push(resolve)) }
    const image = createMediaItem(
      "image",
      { path: "reference_loader/sources/a.png", mime: "image/png", sha256: "a".repeat(64) },
      "a",
    )
    const state = loaderReducer(createEmptyLoaderState(), { type: "add", item: image })
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await Promise.resolve()
    expect(resolvers.length).toBe(2)
    controller.destroy()
    resolvers[0]?.(new Response(JSON.stringify({ metadata: { width: 2 } }), { status: 200 }))
    resolvers[1]?.(new Response(JSON.stringify({ url: "/late.webp" }), { status: 200 }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(root.childElementCount).toBe(0)
    expect(controller.serialize()).toBe(serializeLoaderState(state))
    root.remove()
  })

  test("does not let a pending upload cross a workflow restore", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let resolveUpload: ((response: Response) => void) | undefined
    const api: ComfyApiLike = {
      fetchApi: () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        }),
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    const file = new File(["image"], "pending.png", { type: "image/png" })
    Object.defineProperty(input, "files", { configurable: true, value: [file] })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    expect(root.textContent).toContain("pending.png")

    controller.restore(serializeLoaderState(createEmptyLoaderState()))
    resolveUpload?.(
      new Response(
        JSON.stringify({
          kind: "image",
          source: {
            path: "reference_loader/sources/pending.png",
            mime: "image/png",
            sha256: "c".repeat(64),
          },
          metadata: { width: 1, height: 1 },
        }),
        { status: 201 },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(JSON.parse(controller.serialize()).items).toEqual({})
    expect(root.textContent).not.toContain("pending.png")
    controller.destroy()
    root.remove()
  })

  test("isolates a stale upload rejection and finally render from restored workflow state", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let rejectUpload: ((reason: Error) => void) | undefined
    let uploadSignal: AbortSignal | undefined
    const api: ComfyApiLike = {
      fetchApi: (_route, init) => {
        uploadSignal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          rejectUpload = reject
        })
      },
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["image"], "stale.png", { type: "image/png" })],
    })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    controller.restore(serializeLoaderState(createEmptyLoaderState()))
    expect(uploadSignal?.aborted).toBe(true)
    rejectUpload?.(new Error("late stale failure"))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.querySelector(".rl-status")?.textContent).toBe("Workflow state restored.")
    expect(root.textContent).not.toContain("late stale failure")
    expect(root.textContent).not.toContain("stale.png")
    expect(JSON.parse(controller.serialize()).items).toEqual({})
    controller.destroy()
    root.remove()
  })

  test("shows a status when every dropped file has an unsupported extension", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let calls = 0
    const api: ComfyApiLike = {
      fetchApi: async () => {
        calls += 1
        return new Response("{}")
      },
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["image"], "unsupported.avif", { type: "" })],
    })
    input?.dispatchEvent(new Event("change", { bubbles: true }))

    expect(root.querySelector(".rl-status")?.textContent).toContain("unsupported or over-limit")
    expect(calls).toBe(0)
    controller.destroy()
    root.remove()
  })

  test("rechecks the server-detected media kind before adding an upload", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let state = createEmptyLoaderState()
    for (let index = 0; index < 8; index += 1) {
      state = loaderReducer(state, {
        type: "add",
        item: createMediaItem(
          "audio",
          {
            path: `reference_loader/sources/audio-${index}.wav`,
            mime: "audio/wav",
            sha256: index.toString(16).padStart(64, "0"),
          },
          `audio-${index}`,
        ),
      })
    }
    const api: ComfyApiLike = {
      fetchApi: async () =>
        new Response(
          JSON.stringify({
            kind: "audio",
            source: {
              path: "reference_loader/sources/audio-only.m4a",
              mime: "audio/mp4",
              sha256: "f".repeat(64),
            },
            metadata: { duration: 1 },
          }),
          { status: 201 },
        ),
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      serializeLoaderState(state),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [new File(["audio"], "looks-like-video.mp4", { type: "video/mp4" })],
    })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(Object.keys(JSON.parse(controller.serialize()).items)).toHaveLength(8)
    expect(root.querySelector(".rl-status")?.textContent).toContain("identified this as audio")
    controller.destroy()
    root.remove()
  })

  test("never remounts after teardown when an upload client ignores abort", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    let resolveUpload: ((response: Response) => void) | undefined
    const api: ComfyApiLike = {
      fetchApi: () =>
        new Promise((resolve) => {
          resolveUpload = resolve
        }),
    }
    const controller = new ReferenceLoaderController(
      root,
      node,
      new ReferenceLoaderApi(api),
      undefined,
    )
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')
    const file = new File(["image"], "late.png", { type: "image/png" })
    Object.defineProperty(input, "files", { configurable: true, value: [file] })
    input?.dispatchEvent(new Event("change", { bubbles: true }))
    controller.destroy()
    resolveUpload?.(
      new Response(
        JSON.stringify({
          kind: "image",
          source: {
            path: "reference_loader/sources/late.png",
            mime: "image/png",
            sha256: "d".repeat(64),
          },
          metadata: { width: 1, height: 1 },
        }),
        { status: 201 },
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.childElementCount).toBe(0)
    expect(controller.serialize()).toBe(serializeLoaderState(createEmptyLoaderState()))
    root.remove()
  })
})
