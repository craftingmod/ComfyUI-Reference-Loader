import type {
  ComfyApi,
  ComfyApiLike,
  ComfyApp,
  ComfyAppLike,
  ComfyNode,
  ComfyWidget,
} from "../comfyui.ts"
import { ReferenceLoaderApi } from "./api.ts"
import {
  ComfyPromptAdapter,
  REFERENCE_PROMPT_DEFINITIONS_WIDGET_TYPE,
  REFERENCE_PROMPT_WIDGET_TYPE,
} from "./comfy-prompt-adapter.ts"
import {
  bindRenderedWidgetRoot,
  ComfyUILifecycleBridge,
  type NativeDisplayProxy,
} from "./comfyui-lifecycle-bridge.ts"
import { ReferenceLoaderController } from "./components/loader.ts"
import type { ReferencePromptController } from "./components/prompt-editor.ts"
import { bindComfyLocale } from "./i18n.ts"
import {
  applyReferenceLoaderSnapshotSettings,
  captureReferenceLoaderSnapshotSettings,
  MAX_REFERENCE_LOADER_SNAPSHOT_BYTES,
  parseReferenceLoaderSnapshot,
  REFERENCE_LOADER_SNAPSHOT_FILENAME,
  serializeReferenceLoaderSnapshot,
} from "./snapshot.ts"

export const REFERENCE_LOADER_WIDGET_TYPE = "REFERENCE_LOADER"
export const REFERENCE_IMAGE_LOADER_WIDGET_TYPE = "REFERENCE_IMAGE_LOADER"
export const REFERENCE_H3_TIMELINE_WIDGET_TYPE = "REFERENCE_H3_TIMELINE"
export {
  REFERENCE_PROMPT_DEFINITIONS_WIDGET_TYPE,
  REFERENCE_PROMPT_WIDGET_TYPE,
} from "./comfy-prompt-adapter.ts"
const VUE_WIDGET_GRID_CLASS = "rl-reference-loader-widgets"
let registeredLifecycleBridge: ComfyUILifecycleBridge | undefined

function mountH3Timeline(
  lifecycle: ComfyUILifecycleBridge,
  node: ComfyNode,
  root: HTMLElement,
): void {
  lifecycle.disposeH3Timeline(node)
  lifecycle.setH3TimelineRoot(node, root)
  const controller = lifecycle.getController(node)
  if (controller) lifecycle.setH3TimelineReactMount(node, controller.mountH3Workspace(root))
}

export function registerReferenceLoader(app: ComfyApp, api: ComfyApi): void
export function registerReferenceLoader(app: ComfyAppLike, api: ComfyApiLike): void
export function registerReferenceLoader(
  app: ComfyApp | ComfyAppLike,
  api: ComfyApi | ComfyApiLike,
): void {
  const referenceApp = app as ComfyAppLike
  const lifecycle = new ComfyUILifecycleBridge(referenceApp)
  const promptAdapter = new ComfyPromptAdapter(lifecycle)
  registeredLifecycleBridge = lifecycle
  referenceApp.registerExtension({
    name: "reference-loader.extension",
    init() {
      bindComfyLocale(referenceApp)
    },
    getCustomWidgets() {
      const createLoaderWidget = (
        node: ComfyNode,
        inputName: string,
        inputData: unknown,
        singleImage: boolean,
      ) => {
        lifecycle.disposeLoader(node)
        const root = document.createElement("div")
        root.className = singleImage
          ? "reference-loader reference-image-loader"
          : "reference-loader"
        root.dataset.input = inputName
        // Restore when problem happened
        // root.addEventListener("pointerdown", (event) => event.stopPropagation())

        const initial = initialValue(inputData)
        let controller: ReferenceLoaderController
        controller = new ReferenceLoaderController(
          root,
          node,
          new ReferenceLoaderApi(api),
          initial,
          {
            recordGraphChange: (change) => lifecycle.recordGraphChange(node, change),
            markDirty: () => lifecycle.markDirty(node),
            saveSnapshot: () => saveSnapshot(lifecycle, node, controller),
            loadSnapshot: (file) => loadSnapshot(lifecycle, node, controller, file),
          },
          { mode: singleImage ? "single-image" : "references" },
        )
        let displayProxy: NativeDisplayProxy | undefined
        let removed = false
        const contentHeight = () => {
          const content = root.querySelector<HTMLElement>(
            singleImage ? ".rl-single-image-panel" : "[data-loader-content]",
          )
          const contentBottom = content ? content.offsetTop + content.offsetHeight : 0
          // Root is the offset parent. The content wrapper contains Media only;
          // H3 Timeline is a separate sibling widget.
          return Math.max(singleImage ? 250 : 360, contentBottom + 9)
        }
        const widgetType = singleImage
          ? REFERENCE_IMAGE_LOADER_WIDGET_TYPE
          : REFERENCE_LOADER_WIDGET_TYPE
        const layoutOptions = singleImage
          ? {
              getMinHeight: contentHeight,
            }
          : {
              getMinHeight: contentHeight,
              getMaxHeight: contentHeight,
            }
        const widget = node.addDOMWidget(inputName, widgetType, root, {
          serialize: true,
          hideOnZoom: false,
          getValue: () => controller.serialize(),
          setValue: (value) => {
            controller.restore(value)
            displayProxy?.syncFromState()
          },
          // The single-image preview accepts all spare node height. The Media board
          // keeps its intrinsic height so it stays adjacent to Prompt.
          ...layoutOptions,
        })
        const releaseRenderedRoot = bindRenderedWidgetRoot(node, root, ".reference-loader")
        const releaseVueWidgetGrid = singleImage ? () => undefined : bindVueWidgetGrid(root)
        widget.serialize = true
        widget.serializeValue = () => controller.serialize()
        const releaseQueueBinding = lifecycle.bindWidgetBeforeQueued(widget, () =>
          displayProxy?.syncFromState(),
        )
        const bindingTimer = globalThis.setTimeout(() => {
          if (removed) return
          displayProxy = singleImage
            ? bindPreviewDisplayProxy(node, controller)
            : bindNativeDisplayProxies(node, controller)
          if (displayProxy) lifecycle.setDisplayProxy(node, displayProxy)
        }, 0)
        let releaseLoaderLifecycle = (): void => undefined
        const originalWidgetRemove = widget.onRemove
        widget.onRemove = () => {
          if (removed) return
          removed = true
          globalThis.clearTimeout(bindingTimer)
          releaseLoaderLifecycle()
          originalWidgetRemove?.call(widget)
        }
        releaseLoaderLifecycle = lifecycle.attachLoader(node, controller, () => {
          globalThis.clearTimeout(bindingTimer)
          releaseRenderedRoot()
          releaseVueWidgetGrid()
          lifecycle.clearPromptSubscription(node)
          releaseQueueBinding()
        })
        lifecycle.bindFileDrop(node, controller)
        const h3TimelineRoot = lifecycle.getH3TimelineRoot(node)
        if (!singleImage && h3TimelineRoot) mountH3Timeline(lifecycle, node, h3TimelineRoot)
        if (!singleImage) promptAdapter.bindReferences(node)
        lifecycle.installNodeRemovalHook(node)
        if (!singleImage) {
          const [width = 560, height = 500] = node.size ?? []
          if (width < 520 || height < 460) {
            node.setSize?.([Math.max(width, 560), Math.max(height, 500)])
          }
        }
        return { widget }
      }
      return {
        [REFERENCE_LOADER_WIDGET_TYPE]: (node, inputName, inputData) =>
          createLoaderWidget(node, inputName, inputData, false),
        [REFERENCE_IMAGE_LOADER_WIDGET_TYPE]: (node, inputName, inputData) =>
          createLoaderWidget(node, inputName, inputData, true),
        [REFERENCE_H3_TIMELINE_WIDGET_TYPE]: (node, inputName) => {
          lifecycle.disposeH3Timeline(node)
          const root = document.createElement("div")
          root.className = "reference-h3-timeline"
          root.dataset.input = inputName
          const widget = node.addDOMWidget(inputName, REFERENCE_H3_TIMELINE_WIDGET_TYPE, root, {
            // Keep the required schema slot in the API payload. The Timeline
            // state is already carried by loader_state, so this is only the
            // empty placeholder required by the backend contract.
            serialize: true,
            hideOnZoom: false,
            getValue: () => "",
            setValue: () => undefined,
            getMinHeight: () => Math.max(44, Math.min(1200, root.scrollHeight + 9)),
            getMaxHeight: () => Math.max(44, Math.min(1200, root.scrollHeight + 9)),
          })
          const releaseRenderedRoot = bindRenderedWidgetRoot(node, root, ".reference-h3-timeline")
          widget.serialize = true
          mountH3Timeline(lifecycle, node, root)
          const releaseLifecycle = lifecycle.registerCleanup(node, () => {
            releaseRenderedRoot()
            lifecycle.disposeH3Timeline(node, root)
          })
          let removed = false
          const originalWidgetRemove = widget.onRemove
          widget.onRemove = () => {
            if (removed) return
            removed = true
            releaseLifecycle()
            originalWidgetRemove?.call(widget)
          }
          lifecycle.installNodeRemovalHook(node)
          return { widget }
        },
        [REFERENCE_PROMPT_DEFINITIONS_WIDGET_TYPE]: (node, inputName) => {
          return promptAdapter.createDefinitionsWidget(node, inputName)
        },
        [REFERENCE_PROMPT_WIDGET_TYPE]: (node, inputName, inputData) => {
          const result = promptAdapter.createPromptWidget(node, inputName, inputData)
          const [width = 560, height = 680] = node.size ?? []
          if (width < 520 || height < 620)
            node.setSize?.([Math.max(width, 560), Math.max(height, 680)])
          promptAdapter.bindReferences(node)
          return result
        },
      }
    },
  })
}

function saveSnapshot(
  lifecycle: ComfyUILifecycleBridge,
  node: ComfyNode,
  loader: ReferenceLoaderController,
): void {
  const prompt = lifecycle.getPromptController(node)
  if (!prompt) throw new Error("Prompt editor is not ready.")
  const display = loader.displayState
  const snapshot = serializeReferenceLoaderSnapshot({
    loaderState: loader.serialize(),
    promptState: prompt.serialize(),
    settings: captureReferenceLoaderSnapshotSettings(
      node,
      {
        showCaptions: display.showCaptions,
        horizontalCards: display.horizontalCards,
      },
      prompt.presetId,
    ),
  })
  const url = URL.createObjectURL(new Blob([snapshot], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = REFERENCE_LOADER_SNAPSHOT_FILENAME
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  globalThis.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}

async function loadSnapshot(
  lifecycle: ComfyUILifecycleBridge,
  node: ComfyNode,
  loader: ReferenceLoaderController,
  file: File,
): Promise<"loaded" | "cancelled"> {
  const prompt = lifecycle.getPromptController(node)
  if (!prompt) throw new Error("Prompt editor is not ready.")
  if (file.size > MAX_REFERENCE_LOADER_SNAPSHOT_BYTES)
    throw new Error("Snapshot exceeds the 6,000,000-byte file limit.")
  const snapshot = parseReferenceLoaderSnapshot(await file.text())
  if (!globalThis.confirm("Replace the current Reference Loader and Prompt settings?"))
    return "cancelled"

  lifecycle.recordCanvasChange(() => {
    loader.restoreSnapshot(snapshot.loaderState, {
      showCaptions: snapshot.settings.showCaptions,
      horizontalCards: snapshot.settings.horizontalCards,
    })
    prompt.restore(snapshot.promptState)
    prompt.setPreset(snapshot.settings.promptSchemaPreset)
    applyReferenceLoaderSnapshotSettings(node, snapshot.settings)
    lifecycle.getDisplayProxy(node)?.syncFromState()
    lifecycle.markDirty(node)
  })
  return "loaded"
}

function bindVueWidgetGrid(root: HTMLElement): () => void {
  let widgetGrid: HTMLElement | undefined
  let retryFrame: number | undefined
  let disposed = false
  const bind = (): boolean => {
    if (disposed) return false
    const candidate = root.closest<HTMLElement>('[data-testid="node-widgets"]')
    if (!candidate) return false
    widgetGrid = candidate
    widgetGrid.classList.add(VUE_WIDGET_GRID_CLASS)
    return true
  }
  const bindingTimer = globalThis.setTimeout(() => {
    if (!bind()) retryFrame = globalThis.requestAnimationFrame(() => bind())
  }, 0)
  return () => {
    disposed = true
    globalThis.clearTimeout(bindingTimer)
    if (retryFrame !== undefined) globalThis.cancelAnimationFrame(retryFrame)
    widgetGrid?.classList.remove(VUE_WIDGET_GRID_CLASS)
  }
}

function initialValue(inputData: unknown): unknown {
  if (!Array.isArray(inputData)) return undefined
  const options = inputData[1]
  if (typeof options !== "object" || options === null) return undefined
  const record = options as Record<string, unknown>
  return record.default ?? record.defaultValue
}

function bindPreviewDisplayProxy(
  node: ComfyNode,
  controller: ReferenceLoaderController,
): NativeDisplayProxy | undefined {
  const previewPixels = node.widgets?.find((widget) => widget.name === "preview_pixels")
  if (!previewPixels) return undefined
  const originalCallback = previewPixels.callback
  const syncFromState = (): void => {
    previewPixels.value = controller.displayState.previewPixels
  }
  const callback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalCallback?.call(previewPixels, value, ...args)
    controller.writeDisplayProxy({
      previewPixels: typeof value === "number" ? value : Number(value),
    })
    syncFromState()
    return result
  }
  previewPixels.callback = callback
  syncFromState()
  return {
    syncFromState,
    dispose() {
      if (previewPixels.callback !== callback) return
      if (originalCallback) previewPixels.callback = originalCallback
      else delete previewPixels.callback
    },
  }
}

function bindNativeDisplayProxies(
  node: ComfyNode,
  controller: ReferenceLoaderController,
): NativeDisplayProxy | undefined {
  const gridColumns = node.widgets?.find((widget) => widget.name === "grid_columns")
  const previewPixels = node.widgets?.find((widget) => widget.name === "preview_pixels")
  const showCaptions = node.widgets?.find((widget) => widget.name === "show_captions")
  const horizontalCards = node.widgets?.find((widget) => widget.name === "horizontal_cards")
  const cardAspect = node.widgets?.find((widget) => widget.name === "card_aspect")
  const previewFit = node.widgets?.find((widget) => widget.name === "preview_fit")
  const waveformPairs = node.widgets?.find((widget) => widget.name === "waveform_pairs")
  const h3TotalFrames = node.widgets?.find((widget) => widget.name === "h3_total_frames")
  const h3Fps = node.widgets?.find((widget) => widget.name === "h3_fps")
  if (
    !gridColumns ||
    !previewPixels ||
    !showCaptions ||
    !horizontalCards ||
    !cardAspect ||
    !previewFit ||
    !waveformPairs
  ) {
    return undefined
  }

  const originalGridCallback = gridColumns.callback
  const originalPreviewCallback = previewPixels.callback
  const originalShowCaptionsCallback = showCaptions.callback
  const originalHorizontalCardsCallback = horizontalCards.callback
  const originalCardAspectCallback = cardAspect.callback
  const originalPreviewFitCallback = previewFit.callback
  const originalWaveformPairsCallback = waveformPairs.callback
  const originalH3TotalFramesCallback = h3TotalFrames?.callback
  const originalH3FpsCallback = h3Fps?.callback
  const syncFromState = (): void => {
    const values = controller.displayState
    gridColumns.value = values.gridColumns
    previewPixels.value = values.previewPixels
    showCaptions.value = values.showCaptions
    horizontalCards.value = values.horizontalCards
    cardAspect.value = values.cardAspect
    previewFit.value = values.previewFit
    waveformPairs.value = values.waveformPairs
    if (h3TotalFrames) h3TotalFrames.value = values.h3TotalFrames
    if (h3Fps) h3Fps.value = values.h3Fps
  }
  const gridCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalGridCallback?.call(gridColumns, value, ...args)
    controller.writeDisplayProxy({
      gridColumns: typeof value === "number" ? value : Number(value),
    })
    syncFromState()
    return result
  }
  const previewCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalPreviewCallback?.call(previewPixels, value, ...args)
    controller.writeDisplayProxy({
      previewPixels: typeof value === "number" ? value : Number(value),
    })
    syncFromState()
    return result
  }
  const showCaptionsCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalShowCaptionsCallback?.call(showCaptions, value, ...args)
    controller.writeDisplayProxy({ showCaptions: Boolean(value) })
    syncFromState()
    return result
  }
  const horizontalCardsCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalHorizontalCardsCallback?.call(horizontalCards, value, ...args)
    controller.writeDisplayProxy({ horizontalCards: Boolean(value) })
    syncFromState()
    return result
  }
  const cardAspectCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalCardAspectCallback?.call(cardAspect, value, ...args)
    controller.writeDisplayProxy({ cardAspect: String(value) })
    syncFromState()
    return result
  }
  const previewFitCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalPreviewFitCallback?.call(previewFit, value, ...args)
    controller.writeDisplayProxy({ previewFit: value === "cover" ? "cover" : "contain" })
    syncFromState()
    return result
  }
  const waveformPairsCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalWaveformPairsCallback?.call(waveformPairs, value, ...args)
    controller.writeDisplayProxy({
      waveformPairs: typeof value === "number" ? value : Number(value),
    })
    syncFromState()
    return result
  }
  gridColumns.callback = gridCallback
  previewPixels.callback = previewCallback
  showCaptions.callback = showCaptionsCallback
  horizontalCards.callback = horizontalCardsCallback
  cardAspect.callback = cardAspectCallback
  previewFit.callback = previewFitCallback
  waveformPairs.callback = waveformPairsCallback
  const h3TotalFramesCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalH3TotalFramesCallback?.call(h3TotalFrames, value, ...args)
    controller.writeDisplayProxy({
      h3TotalFrames: typeof value === "number" ? value : Number(value),
    })
    syncFromState()
    return result
  }
  const h3FpsCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalH3FpsCallback?.call(h3Fps, value, ...args)
    controller.writeDisplayProxy({ h3Fps: typeof value === "number" ? value : Number(value) })
    syncFromState()
    return result
  }
  if (h3TotalFrames) h3TotalFrames.callback = h3TotalFramesCallback
  if (h3Fps) h3Fps.callback = h3FpsCallback
  syncFromState()
  return {
    syncFromState,
    dispose() {
      if (gridColumns.callback === gridCallback) {
        if (originalGridCallback) gridColumns.callback = originalGridCallback
        else delete gridColumns.callback
      }
      if (previewPixels.callback === previewCallback) {
        if (originalPreviewCallback) previewPixels.callback = originalPreviewCallback
        else delete previewPixels.callback
      }
      if (showCaptions.callback === showCaptionsCallback) {
        if (originalShowCaptionsCallback) showCaptions.callback = originalShowCaptionsCallback
        else delete showCaptions.callback
      }
      if (horizontalCards.callback === horizontalCardsCallback) {
        if (originalHorizontalCardsCallback)
          horizontalCards.callback = originalHorizontalCardsCallback
        else delete horizontalCards.callback
      }
      if (cardAspect.callback === cardAspectCallback) {
        if (originalCardAspectCallback) cardAspect.callback = originalCardAspectCallback
        else delete cardAspect.callback
      }
      if (previewFit.callback === previewFitCallback) {
        if (originalPreviewFitCallback) previewFit.callback = originalPreviewFitCallback
        else delete previewFit.callback
      }
      if (waveformPairs.callback === waveformPairsCallback) {
        if (originalWaveformPairsCallback) waveformPairs.callback = originalWaveformPairsCallback
        else delete waveformPairs.callback
      }
      if (h3TotalFrames?.callback === h3TotalFramesCallback) {
        if (originalH3TotalFramesCallback) h3TotalFrames.callback = originalH3TotalFramesCallback
        else delete h3TotalFrames.callback
      }
      if (h3Fps?.callback === h3FpsCallback) {
        if (originalH3FpsCallback) h3Fps.callback = originalH3FpsCallback
        else delete h3Fps.callback
      }
    },
  }
}

export function getReferenceLoaderController(
  node: ComfyNode,
): ReferenceLoaderController | undefined {
  return registeredLifecycleBridge?.getController(node)
}

export function getReferencePromptController(
  node: ComfyNode,
): ReferencePromptController | undefined {
  return registeredLifecycleBridge?.getPromptController(node)
}

export type ReferenceLoaderWidget = ComfyWidget
