import { describe, expect, test } from "bun:test"

import type {
  ComfyApiLike,
  ComfyAppLike,
  ComfyExtension,
  ComfyNode,
  ComfyWidget,
  DomWidgetOptions,
} from "../src/comfyui.ts"
import {
  REFERENCE_IMAGE_LOADER_WIDGET_TYPE,
  REFERENCE_LOADER_WIDGET_TYPE,
  REFERENCE_PROMPT_WIDGET_TYPE,
  registerReferenceLoader,
} from "../src/reference-loader/extension.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

function fileDrop(file: File): DragEvent {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const event = new DragEvent("drop")
  Object.defineProperty(event, "dataTransfer", { value: transfer })
  return event
}

describe("Load Reference Image custom widget", () => {
  test("registers a native-style one-image widget with replacement, editing, filtering, restore, and cleanup", async () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    const previewPixelsRequested: number[] = []
    let uploadIndex = 0
    const api: ComfyApiLike = {
      async fetchApi(route, options) {
        if (route.endsWith("/upload")) {
          uploadIndex += 1
          const form = options?.body
          if (!(form instanceof FormData)) throw new Error("Expected a multipart upload.")
          const file = form.get("file")
          if (!(file instanceof File)) throw new Error("Expected one uploaded file.")
          return new Response(
            JSON.stringify({
              kind: "image",
              source: {
                path: `reference_loader/sources/${file.name}`,
                mime: file.type || "image/png",
                sha256: String(uploadIndex).repeat(64),
              },
              metadata: { width: 1600, height: 900 },
            }),
            { status: 201 },
          )
        }
        if (route.endsWith("/metadata"))
          return new Response(JSON.stringify({ metadata: { width: 1600, height: 900 } }))
        if (route.endsWith("/image_proxy")) {
          const body = JSON.parse(String(options?.body)) as { maxPixels: number }
          previewPixelsRequested.push(body.maxPixels)
          return new Response(JSON.stringify({ url: `/preview-${body.maxPixels}.webp` }))
        }
        throw new Error(`Unexpected route: ${route}`)
      },
    }
    registerReferenceLoader(app, api)
    const factories = extension?.getCustomWidgets?.()
    expect(factories?.[REFERENCE_LOADER_WIDGET_TYPE]).toBeDefined()
    expect(factories?.[REFERENCE_PROMPT_WIDGET_TYPE]).toBeDefined()
    const factory = factories?.[REFERENCE_IMAGE_LOADER_WIDGET_TYPE]
    expect(factory).toBeDefined()

    const imageWidget: ComfyWidget = { name: "image_state", value: "" }
    const originalPreviewCallback: NonNullable<ComfyWidget["callback"]> = () => undefined
    const previewWidget: ComfyWidget = {
      name: "preview_pixels",
      value: 1,
      callback: originalPreviewCallback,
    }
    const originalDragOver = () => false
    let fallbackDropCalls = 0
    const originalDragDrop = async () => {
      fallbackDropCalls += 1
      return false
    }
    let root: HTMLElement | undefined
    let domOptions: DomWidgetOptions | undefined
    let domWidgetType = ""
    const resizeCalls: Array<[number, number]> = []
    const vueWidgetGrid = document.createElement("div")
    vueWidgetGrid.dataset.testid = "node-widgets"
    document.body.append(vueWidgetGrid)
    const node: ComfyNode = {
      size: [160, 100],
      widgets: [imageWidget, previewWidget],
      addDOMWidget(_name, type, element, options) {
        root = element
        domOptions = options
        domWidgetType = type
        vueWidgetGrid.append(element)
        return imageWidget
      },
      onDragOver: originalDragOver,
      onDragDrop: originalDragDrop,
      setDirtyCanvas: () => undefined,
      setSize: (size) => resizeCalls.push(size),
    }

    factory?.(
      node,
      "image_state",
      ["STRING", { default: serializeLoaderState(createEmptyLoaderState()) }],
      app,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(domWidgetType).toBe(REFERENCE_IMAGE_LOADER_WIDGET_TYPE)
    expect(root?.classList.contains("reference-image-loader")).toBe(true)
    expect(root?.querySelector(".rl-single-image-panel")).toBeTruthy()
    expect(root?.querySelector(".rl-single-image-select")).toBeTruthy()
    expect(root?.querySelector(".rl-single-image-preview")).toBeTruthy()
    expect(root?.querySelector(".rl-media-topbar")).toBeNull()
    expect(root?.querySelector('[data-action="undo"]')).toBeNull()
    expect(root?.querySelector('[data-action="remove"]')).toBeNull()
    expect(root?.querySelector(".rl-media-badges")).toBeNull()
    expect(root?.querySelector('textarea[data-field="caption"]')).toBeNull()
    expect(root?.querySelector('[data-channel="video"]')).toBeNull()
    expect(root?.querySelector('[data-channel="audio"]')).toBeNull()
    expect(root?.querySelector<HTMLInputElement>('input[type="file"]')?.multiple).toBe(false)
    expect(root?.querySelector<HTMLInputElement>('input[type="file"]')?.accept).toBe("")
    expect(domOptions?.getMinHeight?.()).toBe(80)
    expect(domOptions?.getMaxHeight).toBeUndefined()
    expect(vueWidgetGrid.classList.contains("rl-reference-loader-widgets")).toBe(false)
    expect(previewWidget.callback).not.toBe(originalPreviewCallback)
    expect(resizeCalls).toEqual([])

    let emptyPreviewUploadRequests = 0
    const emptyImageInput = root?.querySelector<HTMLInputElement>('input[data-upload-kind="image"]')
    emptyImageInput?.addEventListener("click", (event) => {
      event.preventDefault()
      emptyPreviewUploadRequests += 1
    })
    root
      ?.querySelector(".rl-single-image-preview")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    expect(emptyPreviewUploadRequests).toBe(1)

    const audioEvent = fileDrop(new File(["audio"], "skip.wav", { type: "audio/wav" }))
    expect(node.onDragOver?.(audioEvent)).toBe(false)
    expect(await node.onDragDrop?.(audioEvent)).toBe(false)
    expect(fallbackDropCalls).toBe(1)
    expect(uploadIndex).toBe(0)

    expect(
      await node.onDragDrop?.(fileDrop(new File(["image"], "unknown.avif", { type: "" }))),
    ).toBe(true)
    expect(uploadIndex).toBe(1)
    expect(JSON.parse(String(domOptions?.getValue?.())).imageOrder).toHaveLength(1)

    previewWidget.callback?.(0.25)
    expect(previewWidget.value).toBe(0.25)
    expect(
      await node.onDragDrop?.(fileDrop(new File(["one"], "one.png", { type: "image/png" }))),
    ).toBe(true)
    let serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(serialized.ui.previewMaxPixels).toBe(250_000)
    expect(Object.values(serialized.items)).toEqual([
      expect.objectContaining({ kind: "image", sourceFilename: "one.png" }),
    ])
    expect(root?.querySelector(".rl-single-image-select__value")?.textContent).toBe("one.png")
    const editButton = root?.querySelector<HTMLButtonElement>('[data-action="edit"]')
    expect(editButton?.textContent).toBe("Edit")
    expect(editButton?.closest(".rl-single-image-controls")).toBeTruthy()
    expect(editButton?.closest(".rl-single-image-card")).toBeNull()

    previewWidget.callback?.(0.5)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(previewPixelsRequested.at(-1)).toBe(500_000)
    expect(root?.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(
      "/preview-500000.webp",
    )

    expect(
      await node.onDragDrop?.(fileDrop(new File(["two"], "two.png", { type: "image/png" }))),
    ).toBe(true)
    serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(Object.keys(serialized.items)).toHaveLength(1)
    expect(Object.values(serialized.items)).toEqual([
      expect.objectContaining({ sourceFilename: "two.png" }),
    ])
    expect(root?.querySelector('[data-action="undo"]')).toBeNull()
    expect(root?.querySelector(".rl-single-image-select__value")?.textContent).toBe("two.png")

    root?.querySelector<HTMLButtonElement>('[data-action="edit"]')?.click()
    const editorDescription = document.querySelector<HTMLTextAreaElement>(
      '.rl-image-editor textarea[data-field="caption"]',
    )
    expect(editorDescription).toBeNull()
    expect(document.querySelector(".rl-editor-media-column.is-captionless")).toBeTruthy()
    document.querySelector<HTMLButtonElement>('.rl-image-editor [data-action="cancel"]')?.click()
    await Promise.resolve()

    let restored = createEmptyLoaderState()
    restored.ui.previewMaxPixels = 2_000_000
    restored = loaderReducer(restored, {
      type: "add",
      item: createMediaItem(
        "image",
        {
          path: "reference_loader/sources/restored-first.png",
          mime: "image/png",
          sha256: "a".repeat(64),
        },
        "restored-first",
      ),
    })
    restored = loaderReducer(restored, {
      type: "add",
      item: createMediaItem(
        "image",
        {
          path: "reference_loader/sources/restored-second.png",
          mime: "image/png",
          sha256: "b".repeat(64),
        },
        "restored-second",
      ),
    })
    restored = loaderReducer(restored, {
      type: "add",
      item: createMediaItem(
        "audio",
        {
          path: "reference_loader/sources/ignored.wav",
          mime: "audio/wav",
          sha256: "c".repeat(64),
        },
        "ignored-audio",
      ),
    })
    domOptions?.setValue?.(serializeLoaderState(restored))
    serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(serialized.imageOrder).toEqual(["restored-first"])
    expect(serialized.videoOrder).toEqual([])
    expect(serialized.audioOrder).toEqual([])
    expect(Object.keys(serialized.items)).toEqual(["restored-first"])
    expect(previewWidget.value).toBe(2)

    imageWidget.onRemove?.()
    expect(previewWidget.callback).toBe(originalPreviewCallback)
    expect(node.onDragOver).toBe(originalDragOver)
    expect(node.onDragDrop).toBe(originalDragDrop)
    expect(root?.childElementCount).toBe(0)
    expect(vueWidgetGrid.classList.contains("rl-reference-loader-widgets")).toBe(false)
    vueWidgetGrid.remove()
  })

  test("keeps the current display proxy registered when an older widget is removed late", async () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    registerReferenceLoader(app, { fetchApi: async () => new Response("{}") })
    const factory = extension?.getCustomWidgets?.()[REFERENCE_IMAGE_LOADER_WIDGET_TYPE]
    expect(factory).toBeDefined()

    const originalPreviewCallback: NonNullable<ComfyWidget["callback"]> = () => undefined
    const previewWidget: ComfyWidget = {
      name: "preview_pixels",
      value: 1,
      callback: originalPreviewCallback,
    }
    const createdWidgets: ComfyWidget[] = []
    const node: ComfyNode = {
      widgets: [previewWidget],
      addDOMWidget(name) {
        const widget: ComfyWidget = { name, value: "" }
        createdWidgets.push(widget)
        node.widgets = [widget, previewWidget]
        return widget
      },
      setDirtyCanvas: () => undefined,
    }
    const createWidget = (): void => {
      factory?.(
        node,
        "image_state",
        ["STRING", { default: serializeLoaderState(createEmptyLoaderState()) }],
        app,
      )
    }

    createWidget()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(createdWidgets).toHaveLength(1)
    expect(previewWidget.callback).not.toBe(originalPreviewCallback)

    createWidget()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(createdWidgets).toHaveLength(2)
    const secondBinding = previewWidget.callback
    expect(secondBinding).not.toBe(originalPreviewCallback)

    createdWidgets[0]?.onRemove?.()
    expect(previewWidget.callback).toBe(secondBinding)

    createWidget()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(createdWidgets).toHaveLength(3)
    expect(previewWidget.callback).not.toBe(secondBinding)
    createdWidgets[2]?.onRemove?.()
    expect(previewWidget.callback).toBe(originalPreviewCallback)

    createdWidgets[1]?.onRemove?.()
    createdWidgets[0]?.onRemove?.()
  })
})
