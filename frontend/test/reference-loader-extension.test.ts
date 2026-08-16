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
  registerReferenceLoader,
  REFERENCE_LOADER_WIDGET_TYPE,
  REFERENCE_PROMPT_WIDGET_TYPE,
} from "../src/reference-loader/extension.ts"
import {
  createEmptyPromptDocument,
  serializePromptDocument,
} from "../src/reference-loader/prompt-state.ts"
import { loaderReducer } from "../src/reference-loader/reducer.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import { createMediaItem, createEmptyLoaderState } from "../src/reference-loader/types.ts"

describe("Reference Loader custom widget", () => {
  test("exposes getValue/setValue so workflow restoration replaces controller state", () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    const api: ComfyApiLike = { fetchApi: async () => new Response("{}") }
    registerReferenceLoader(app, api)
    const factory = extension?.getCustomWidgets?.()[REFERENCE_LOADER_WIDGET_TYPE]
    expect(factory).toBeDefined()
    expect(extension?.getCustomWidgets?.()[REFERENCE_PROMPT_WIDGET_TYPE]).toBeDefined()

    let domOptions: DomWidgetOptions | undefined
    let loaderRoot: HTMLElement | undefined
    let valueSetCount = 0
    let removeReceiver: ComfyWidget | undefined
    const widget = { name: "loader_state" } as ComfyWidget
    widget.onRemove = function (this: ComfyWidget) {
      removeReceiver = this
    }
    Object.defineProperty(widget, "value", {
      get: () => domOptions?.getValue?.() ?? "",
      set: (value: unknown) => {
        valueSetCount += 1
        domOptions?.setValue?.(value)
      },
    })
    const node: ComfyNode = {
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget(_name, _type, element, options) {
        loaderRoot = element
        domOptions = options
        return widget
      },
      setDirtyCanvas: () => undefined,
    }
    factory?.(
      node,
      "loader_state",
      ["STRING", { default: serializeLoaderState(createEmptyLoaderState()) }],
      app,
    )

    const item = createMediaItem(
      "image",
      { path: "reference_loader/sources/a.png", mime: "image/png", sha256: "a".repeat(64) },
      "restored",
    )
    const restored = loaderReducer(createEmptyLoaderState(), { type: "add", item })
    expect(valueSetCount).toBe(0)
    expect(domOptions?.getMinHeight?.()).toBe(360)
    expect(domOptions?.getMaxHeight?.()).toBe(360)
    const channels = loaderRoot?.querySelector(".rl-channels")
    expect(channels).toBeDefined()
    Object.defineProperty(channels as HTMLElement, "offsetTop", {
      configurable: true,
      value: 91,
    })
    Object.defineProperty(channels as HTMLElement, "offsetHeight", {
      configurable: true,
      value: 620,
    })
    expect(domOptions?.getMinHeight?.()).toBe(720)
    expect(domOptions?.getMaxHeight?.()).toBe(720)
    widget.value = serializeLoaderState(restored)
    expect(valueSetCount).toBe(1)
    expect(JSON.parse(String(domOptions?.getValue?.())).imageOrder).toEqual(["restored"])
    expect(String(widget.value)).toContain("restored")
    widget.onRemove?.()
    expect(removeReceiver).toBe(widget)
  })

  test("uses native advanced widgets as write-only proxies for Loader state", async () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    registerReferenceLoader(app, { fetchApi: async () => new Response("{}") })
    const factory = extension?.getCustomWidgets?.()[REFERENCE_LOADER_WIDGET_TYPE]
    let domOptions: DomWidgetOptions | undefined
    let loaderRoot: HTMLElement | undefined
    const vueWidgetGrid = document.createElement("div")
    vueWidgetGrid.dataset.testid = "node-widgets"
    const gridColumns: ComfyWidget = { name: "grid_columns", value: 3 }
    const previewPixels: ComfyWidget = { name: "preview_pixels", value: 1 }
    const showCaptions: ComfyWidget = { name: "show_captions", value: true }
    const twoImageMode: ComfyWidget = { name: "two_image_mode", value: false }
    const promptByOrder: ComfyWidget = { name: "prompt_by_order", value: false }
    const cardAspect: ComfyWidget = { name: "card_aspect", value: "4 / 3" }
    const previewFit: ComfyWidget = { name: "preview_fit", value: "contain" }
    const waveformPairs: ComfyWidget = { name: "waveform_pairs", value: 300 }
    const limitImagePixels: ComfyWidget = { name: "limit_image_pixels", value: false }
    const maxImagePixels: ComfyWidget = { name: "max_image_pixels", value: 2 }
    const compositeAlpha: ComfyWidget = { name: "composite_alpha", value: false }
    const alphaBackground: ComfyWidget = { name: "alpha_background", value: "#000000" }
    const loaderWidget: ComfyWidget = { name: "loader_state", value: "" }
    const node: ComfyNode = {
      widgets: [
        loaderWidget,
        limitImagePixels,
        maxImagePixels,
        compositeAlpha,
        alphaBackground,
        gridColumns,
        previewPixels,
        showCaptions,
        twoImageMode,
        promptByOrder,
        cardAspect,
        previewFit,
        waveformPairs,
      ],
      properties: {},
      addWidget: () => ({ name: "unused", value: null }),
      addDOMWidget(_name, _type, element, options) {
        loaderRoot = element
        vueWidgetGrid.append(element)
        domOptions = options
        return loaderWidget
      },
      setDirtyCanvas: () => undefined,
    }
    factory?.(
      node,
      "loader_state",
      ["STRING", { default: serializeLoaderState(createEmptyLoaderState()) }],
      app,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(vueWidgetGrid.classList.contains("rl-reference-loader-widgets")).toBe(true)

    previewPixels.value = 16
    gridColumns.callback?.(5)
    let serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(serialized.ui.gridColumns).toBe(5)
    expect(serialized.ui.previewMaxPixels).toBe(1_000_000)
    expect(previewPixels.value).toBe(1)
    previewPixels.callback?.(2.5)
    serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(serialized.ui.gridColumns).toBe(5)
    expect(serialized.ui.previewMaxPixels).toBe(2_500_000)
    expect(gridColumns.value).toBe(5)
    expect(previewPixels.value).toBe(2.5)
    expect(loaderRoot?.style.getPropertyValue("--rl-grid-columns")).toBe("5")
    showCaptions.callback?.(false)
    expect(showCaptions.value).toBe(false)
    expect(
      (node.properties?.referenceLoader as Record<string, unknown> | undefined)?.showCaptions,
    ).toBe(false)
    expect(loaderRoot?.querySelector("textarea[data-field='caption']")).toBeNull()
    twoImageMode.callback?.(true)
    expect(twoImageMode.value).toBe(true)
    expect(
      (node.properties?.referenceLoader as Record<string, unknown> | undefined)?.twoImageMode,
    ).toBe(true)
    promptByOrder.callback?.(true)
    expect(promptByOrder.value).toBe(true)
    expect(
      (node.properties?.referenceLoader as Record<string, unknown> | undefined)?.promptByOrder,
    ).toBe(true)
    cardAspect.callback?.("9 / 16")
    previewFit.callback?.("cover")
    waveformPairs.callback?.(750)
    serialized = JSON.parse(String(domOptions?.getValue?.()))
    expect(serialized.ui.cardAspectRatio).toBe("9 / 16")
    expect(serialized.ui.previewFit).toBe("cover")
    expect(serialized.ui.waveformPeaks).toBe(750)
    expect(cardAspect.value).toBe("9 / 16")
    expect(previewFit.value).toBe("cover")
    expect(waveformPairs.value).toBe(750)
    expect(loaderRoot?.style.getPropertyValue("--rl-preview-fit")).toBe("cover")
    expect(loaderRoot?.querySelector(".rl-settings")).toBeNull()
    const restored = createEmptyLoaderState()
    restored.ui.gridColumns = 2
    restored.ui.previewMaxPixels = 4_000_000
    restored.ui.cardAspectRatio = "1 / 1"
    restored.ui.previewFit = "contain"
    restored.ui.waveformPeaks = 450
    gridColumns.value = 8
    previewPixels.value = 16
    showCaptions.value = true
    twoImageMode.value = false
    promptByOrder.value = false
    cardAspect.value = "16 / 9"
    previewFit.value = "cover"
    waveformPairs.value = 1000
    limitImagePixels.value = true
    maxImagePixels.value = 6
    compositeAlpha.value = true
    alphaBackground.value = "#123456"
    domOptions?.setValue?.(serializeLoaderState(restored))
    expect(gridColumns.value).toBe(2)
    expect(previewPixels.value).toBe(4)
    expect(showCaptions.value).toBe(false)
    expect(twoImageMode.value).toBe(true)
    expect(promptByOrder.value).toBe(true)
    expect(cardAspect.value).toBe("1 / 1")
    expect(previewFit.value).toBe("contain")
    expect(waveformPairs.value).toBe(450)
    expect(limitImagePixels.value).toBe(true)
    expect(maxImagePixels.value).toBe(6)
    expect(compositeAlpha.value).toBe(true)
    expect(alphaBackground.value).toBe("#123456")
    gridColumns.value = 7
    previewPixels.value = 12
    showCaptions.value = true
    twoImageMode.value = false
    promptByOrder.value = false
    cardAspect.value = "16 / 9"
    previewFit.value = "cover"
    waveformPairs.value = 1000
    limitImagePixels.value = false
    maxImagePixels.value = 3.5
    compositeAlpha.value = false
    alphaBackground.value = "#abcdef"
    loaderWidget.beforeQueued?.()
    expect(gridColumns.value).toBe(2)
    expect(previewPixels.value).toBe(4)
    expect(showCaptions.value).toBe(false)
    expect(twoImageMode.value).toBe(true)
    expect(promptByOrder.value).toBe(true)
    expect(cardAspect.value).toBe("1 / 1")
    expect(previewFit.value).toBe("contain")
    expect(waveformPairs.value).toBe(450)
    expect(limitImagePixels.value).toBe(false)
    expect(maxImagePixels.value).toBe(3.5)
    expect(compositeAlpha.value).toBe(false)
    expect(alphaBackground.value).toBe("#abcdef")
    loaderWidget.onRemove?.()
    expect(vueWidgetGrid.classList.contains("rl-reference-loader-widgets")).toBe(false)
  })

  test("binds the advanced prompt preset without rewriting prompt state", async () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    registerReferenceLoader(app, { fetchApi: async () => new Response("{}") })
    const factory = extension?.getCustomWidgets?.()[REFERENCE_PROMPT_WIDGET_TYPE]
    const originalCalls: unknown[] = []
    const originalPresetCallback: NonNullable<ComfyWidget["callback"]> = (value) => {
      originalCalls.push(value)
    }
    const customCatalog = {
      version: 1,
      defaultPresetId: "custom_video",
      presets: [
        {
          id: "custom_video",
          label: { en: "Custom video", ko: "사용자 비디오" },
          description: { en: "Loaded from JSON", ko: "JSON에서 불러옴" },
          defaultSectionTitle: "custom_direction",
          aliases: [
            {
              command: "custom",
              title: "custom_direction",
              label: { en: "Custom", ko: "사용자" },
              description: { en: "Custom field", ko: "사용자 필드" },
              icon: "C",
            },
          ],
        },
      ],
    }
    const presetWidget: ComfyWidget = {
      name: "prompt_schema_preset",
      value: "custom_video",
      callback: originalPresetCallback,
    }
    const promptWidget: ComfyWidget = { name: "prompt", value: "" }
    let root: HTMLElement | undefined
    let options: DomWidgetOptions | undefined
    const node: ComfyNode = {
      widgets: [promptWidget],
      addDOMWidget(_name, _type, element, candidateOptions) {
        root = element
        options = candidateOptions
        return promptWidget
      },
      setDirtyCanvas: () => undefined,
    }
    const serialized = serializePromptDocument(createEmptyPromptDocument())
    factory?.(
      node,
      "prompt",
      ["STRING", { default: serialized, promptPresets: customCatalog }],
      app,
    )
    node.widgets?.push(presetWidget)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root?.querySelector("[data-prompt-section='custom_direction']")).toBeTruthy()
    expect(String(options?.getValue?.())).toBe(serialized)
    presetWidget.callback?.("freeform")
    expect(originalCalls).toEqual(["freeform"])
    expect(presetWidget.value).toBe("custom_video")
    expect(root?.querySelector("[data-prompt-preset]")?.textContent).toBe("Custom video")
    expect(root?.querySelector("[data-prompt-section='custom_direction']")).toBeTruthy()
    expect(String(options?.getValue?.())).toBe(serialized)

    promptWidget.onRemove?.()
    expect(presetWidget.callback).toBe(originalPresetCallback)
  })
})
