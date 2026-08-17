import type {
  ComfyApi,
  ComfyApiLike,
  ComfyApp,
  ComfyAppLike,
  ComfyNode,
  ComfyWidget,
} from "../comfyui.ts"
import { ReferenceLoaderApi } from "./api.ts"
import { promptByOrderProperty, ReferenceLoaderController } from "./components/loader.ts"
import { ReferencePromptController } from "./components/prompt-editor.ts"
import {
  applyReferenceLoaderSnapshotSettings,
  captureReferenceLoaderSnapshotSettings,
  MAX_REFERENCE_LOADER_SNAPSHOT_BYTES,
  parseReferenceLoaderSnapshot,
  REFERENCE_LOADER_SNAPSHOT_FILENAME,
  serializeReferenceLoaderSnapshot,
} from "./snapshot.ts"

export const REFERENCE_LOADER_WIDGET_TYPE = "REFERENCE_LOADER"
export const REFERENCE_PROMPT_WIDGET_TYPE = "REFERENCE_PROMPT"
const controllers = new WeakMap<ComfyNode, ReferenceLoaderController>()
const promptControllers = new WeakMap<ComfyNode, ReferencePromptController>()
const promptSubscriptions = new WeakMap<ComfyNode, () => void>()
const promptPresetBindings = new WeakMap<ComfyNode, PromptPresetBinding>()
const removalHooks = new WeakSet<ComfyNode>()
const displayProxies = new WeakMap<ComfyNode, NativeDisplayProxy>()
const nodeFileDropBindings = new WeakMap<ComfyNode, () => void>()
const VUE_WIDGET_GRID_CLASS = "rl-reference-loader-widgets"

interface NativeDisplayProxy {
  syncFromState(): void
  dispose(): void
}

interface PromptPresetBinding {
  dispose(): void
}

export function registerReferenceLoader(app: ComfyApp, api: ComfyApi): void
export function registerReferenceLoader(app: ComfyAppLike, api: ComfyApiLike): void
export function registerReferenceLoader(
  app: ComfyApp | ComfyAppLike,
  api: ComfyApi | ComfyApiLike,
): void {
  const referenceApp = app as ComfyAppLike
  referenceApp.registerExtension({
    name: "reference-loader.extension",
    getCustomWidgets() {
      return {
        [REFERENCE_LOADER_WIDGET_TYPE]: (node, inputName, inputData) => {
          controllers.get(node)?.destroy()
          nodeFileDropBindings.get(node)?.()
          nodeFileDropBindings.delete(node)
          displayProxies.get(node)?.dispose()
          displayProxies.delete(node)
          const root = document.createElement("div")
          root.className = "reference-loader"
          root.dataset.input = inputName
          root.addEventListener("pointerdown", (event) => event.stopPropagation())
          root.addEventListener("wheel", (event) => event.stopPropagation())

          const initial = initialValue(inputData)
          let controller: ReferenceLoaderController
          controller = new ReferenceLoaderController(
            root,
            node,
            new ReferenceLoaderApi(api),
            initial,
            {
              beforeChange: () => referenceApp.canvas?.emitBeforeChange?.(),
              afterChange: () => referenceApp.canvas?.emitAfterChange?.(),
              saveSnapshot: () => saveSnapshot(node, controller),
              loadSnapshot: (file) => loadSnapshot(referenceApp, node, controller, file),
            },
          )
          const releaseNodeFileDrop = bindNodeFileDrop(node, controller)
          nodeFileDropBindings.set(node, releaseNodeFileDrop)
          let displayProxy: NativeDisplayProxy | undefined
          let removed = false
          const contentHeight = () => {
            const channels = root.querySelector<HTMLElement>(".rl-channels")
            // Root is the offset parent. Measure only through the final Media
            // section, excluding any spare height assigned to the DOM widget.
            return Math.max(360, (channels?.offsetTop ?? 0) + (channels?.offsetHeight ?? 0) + 9)
          }
          const widget = node.addDOMWidget(inputName, REFERENCE_LOADER_WIDGET_TYPE, root, {
            serialize: true,
            hideOnZoom: false,
            getValue: () => controller.serialize(),
            setValue: (value) => {
              controller.restore(value)
              displayProxy?.syncFromState()
            },
            // Use the full Media content height without accepting spare flex height.
            // Keeping min/max equal avoids both nested scrolling and a gap before Prompt.
            getMinHeight: contentHeight,
            getMaxHeight: contentHeight,
          })
          const releaseVueWidgetGrid = bindVueWidgetGrid(root)
          widget.serialize = true
          widget.serializeValue = () => controller.serialize()
          widget.beforeQueued = () => displayProxy?.syncFromState()
          const bindingTimer = globalThis.setTimeout(() => {
            if (removed) return
            displayProxy = bindNativeDisplayProxies(node, controller)
            if (displayProxy) displayProxies.set(node, displayProxy)
          }, 0)
          const originalWidgetRemove = widget.onRemove
          widget.onRemove = () => {
            removed = true
            globalThis.clearTimeout(bindingTimer)
            releaseVueWidgetGrid()
            promptSubscriptions.get(node)?.()
            promptSubscriptions.delete(node)
            releaseNodeFileDrop()
            if (nodeFileDropBindings.get(node) === releaseNodeFileDrop)
              nodeFileDropBindings.delete(node)
            displayProxy?.dispose()
            displayProxies.delete(node)
            if (controllers.get(node) === controller) controllers.delete(node)
            controller.destroy()
            originalWidgetRemove?.call(widget)
          }
          controllers.set(node, controller)
          bindPromptReferences(node)
          installNodeRemovalHook(node)
          const [width = 560, height = 500] = node.size ?? []
          if (width < 520 || height < 460)
            node.setSize?.([Math.max(width, 560), Math.max(height, 500)])
          return { widget }
        },
        [REFERENCE_PROMPT_WIDGET_TYPE]: (node, inputName, inputData) => {
          promptSubscriptions.get(node)?.()
          promptSubscriptions.delete(node)
          promptPresetBindings.get(node)?.dispose()
          promptPresetBindings.delete(node)
          promptControllers.get(node)?.destroy()
          const root = document.createElement("div")
          root.className = "reference-prompt"
          root.dataset.input = inputName
          root.addEventListener("pointerdown", (event) => event.stopPropagation())
          root.addEventListener("wheel", (event) => event.stopPropagation())
          const controller = new ReferencePromptController(
            root,
            node,
            () => controllers.get(node)?.promptReferences ?? [],
            initialValue(inputData),
            {
              presetId: node.widgets?.find((candidate) => candidate.name === "prompt_schema_preset")
                ?.value,
              presetCatalog: promptPresetCatalog(inputData),
            },
          )
          let removed = false
          const widget = node.addDOMWidget(inputName, REFERENCE_PROMPT_WIDGET_TYPE, root, {
            serialize: true,
            hideOnZoom: false,
            getValue: () => controller.serialize(),
            setValue: (value) => controller.restore(value),
            getMinHeight: () => 180,
            getMaxHeight: () => 480,
          })
          widget.serialize = true
          widget.serializeValue = () => controller.serialize()
          widget.beforeQueued = () => controller.serialize()
          const presetBindingTimer = globalThis.setTimeout(() => {
            if (removed) return
            const binding = bindPromptPresetWidget(node, controller)
            if (binding) promptPresetBindings.set(node, binding)
          }, 0)
          const originalWidgetRemove = widget.onRemove
          widget.onRemove = () => {
            if (removed) return
            removed = true
            globalThis.clearTimeout(presetBindingTimer)
            promptSubscriptions.get(node)?.()
            promptSubscriptions.delete(node)
            promptPresetBindings.get(node)?.dispose()
            promptPresetBindings.delete(node)
            if (promptControllers.get(node) === controller) promptControllers.delete(node)
            controller.destroy()
            originalWidgetRemove?.call(widget)
          }
          promptControllers.set(node, controller)
          bindPromptReferences(node)
          installNodeRemovalHook(node)
          const [width = 560, height = 680] = node.size ?? []
          if (width < 520 || height < 620)
            node.setSize?.([Math.max(width, 560), Math.max(height, 680)])
          return { widget }
        },
      }
    },
  })
}

function saveSnapshot(node: ComfyNode, loader: ReferenceLoaderController): void {
  const prompt = promptControllers.get(node)
  if (!prompt) throw new Error("Prompt editor is not ready.")
  const display = loader.displayState
  const snapshot = serializeReferenceLoaderSnapshot({
    loaderState: loader.serialize(),
    promptState: prompt.serialize(),
    settings: captureReferenceLoaderSnapshotSettings(
      node,
      {
        showCaptions: display.showCaptions,
        twoImageMode: display.twoImageMode,
        promptByOrder: display.promptByOrder,
      },
      prompt.presetId,
    ),
  })
  const url = URL.createObjectURL(new Blob([snapshot], { type: "application/json" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = REFERENCE_LOADER_SNAPSHOT_FILENAME
  anchor.click()
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function loadSnapshot(
  app: ComfyAppLike,
  node: ComfyNode,
  loader: ReferenceLoaderController,
  file: File,
): Promise<"loaded" | "cancelled"> {
  const prompt = promptControllers.get(node)
  if (!prompt) throw new Error("Prompt editor is not ready.")
  if (file.size > MAX_REFERENCE_LOADER_SNAPSHOT_BYTES)
    throw new Error("Snapshot exceeds the 6,000,000-byte file limit.")
  const snapshot = parseReferenceLoaderSnapshot(await file.text())
  if (!globalThis.confirm("Replace the current Reference Loader and Prompt settings?"))
    return "cancelled"

  app.canvas?.emitBeforeChange?.()
  try {
    loader.restoreSnapshot(snapshot.loaderState, {
      showCaptions: snapshot.settings.showCaptions,
      twoImageMode: snapshot.settings.twoImageMode,
      promptByOrder: snapshot.settings.promptByOrder,
    })
    prompt.restore(snapshot.promptState)
    prompt.setPreset(snapshot.settings.promptSchemaPreset)
    applyReferenceLoaderSnapshotSettings(node, snapshot.settings)
    displayProxies.get(node)?.syncFromState()
    node.setDirtyCanvas(true, true)
  } finally {
    app.canvas?.emitAfterChange?.()
  }
  return "loaded"
}

function bindPromptReferences(node: ComfyNode): void {
  promptSubscriptions.get(node)?.()
  promptSubscriptions.delete(node)
  const loader = controllers.get(node)
  const prompt = promptControllers.get(node)
  if (!loader || !prompt) return
  promptSubscriptions.set(
    node,
    loader.subscribePromptReferences(() => prompt.refreshReferences(promptByOrderProperty(node))),
  )
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

function installNodeRemovalHook(node: ComfyNode): void {
  if (removalHooks.has(node)) return
  removalHooks.add(node)
  const originalRemoved = node.onRemoved
  node.onRemoved = function (...args: unknown[]): unknown {
    promptSubscriptions.get(this)?.()
    promptSubscriptions.delete(this)
    promptPresetBindings.get(this)?.dispose()
    promptPresetBindings.delete(this)
    promptControllers.get(this)?.destroy()
    promptControllers.delete(this)
    nodeFileDropBindings.get(this)?.()
    nodeFileDropBindings.delete(this)
    controllers.get(this)?.destroy()
    controllers.delete(this)
    displayProxies.get(this)?.dispose()
    displayProxies.delete(this)
    return originalRemoved?.apply(this, args)
  }
}

function bindNodeFileDrop(node: ComfyNode, controller: ReferenceLoaderController): () => void {
  const originalDragOver = node.onDragOver
  const originalDragDrop = node.onDragDrop
  const onDragOver = function (this: ComfyNode, event: DragEvent): boolean {
    if (controller.acceptsFileDrop(event.dataTransfer)) return true
    return originalDragOver?.call(this, event) === true
  }
  const onDragDrop = async function (this: ComfyNode, event: DragEvent): Promise<boolean> {
    if (await controller.addDroppedFiles(event.dataTransfer?.files ?? [])) return true
    return (await originalDragDrop?.call(this, event)) === true
  }
  node.onDragOver = onDragOver
  node.onDragDrop = onDragDrop
  let released = false
  return () => {
    if (released) return
    released = true
    if (node.onDragOver === onDragOver) {
      if (originalDragOver) node.onDragOver = originalDragOver
      else delete node.onDragOver
    }
    if (node.onDragDrop === onDragDrop) {
      if (originalDragDrop) node.onDragDrop = originalDragDrop
      else delete node.onDragDrop
    }
  }
}

function bindPromptPresetWidget(
  node: ComfyNode,
  controller: ReferencePromptController,
): PromptPresetBinding | undefined {
  const widget = node.widgets?.find((candidate) => candidate.name === "prompt_schema_preset")
  if (!widget) return undefined
  const originalCallback = widget.callback
  const sync = (value: unknown): void => {
    controller.setPreset(value)
    widget.value = controller.presetId
  }
  const callback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalCallback?.call(widget, value, ...args)
    sync(value)
    return result
  }
  widget.callback = callback
  sync(widget.value)
  return {
    dispose() {
      if (widget.callback !== callback) return
      if (originalCallback) widget.callback = originalCallback
      else delete widget.callback
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
  const twoImageMode = node.widgets?.find((widget) => widget.name === "two_image_mode")
  const promptByOrder = node.widgets?.find((widget) => widget.name === "prompt_by_order")
  const cardAspect = node.widgets?.find((widget) => widget.name === "card_aspect")
  const previewFit = node.widgets?.find((widget) => widget.name === "preview_fit")
  const waveformPairs = node.widgets?.find((widget) => widget.name === "waveform_pairs")
  if (
    !gridColumns ||
    !previewPixels ||
    !showCaptions ||
    !twoImageMode ||
    !promptByOrder ||
    !cardAspect ||
    !previewFit ||
    !waveformPairs
  ) {
    return undefined
  }

  const originalGridCallback = gridColumns.callback
  const originalPreviewCallback = previewPixels.callback
  const originalShowCaptionsCallback = showCaptions.callback
  const originalTwoImageModeCallback = twoImageMode.callback
  const originalPromptByOrderCallback = promptByOrder.callback
  const originalCardAspectCallback = cardAspect.callback
  const originalPreviewFitCallback = previewFit.callback
  const originalWaveformPairsCallback = waveformPairs.callback
  const syncFromState = (): void => {
    const values = controller.displayState
    gridColumns.value = values.gridColumns
    previewPixels.value = values.previewPixels
    showCaptions.value = values.showCaptions
    twoImageMode.value = values.twoImageMode
    promptByOrder.value = values.promptByOrder
    cardAspect.value = values.cardAspect
    previewFit.value = values.previewFit
    waveformPairs.value = values.waveformPairs
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
  const twoImageModeCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalTwoImageModeCallback?.call(twoImageMode, value, ...args)
    controller.writeDisplayProxy({ twoImageMode: Boolean(value) })
    syncFromState()
    return result
  }
  const promptByOrderCallback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalPromptByOrderCallback?.call(promptByOrder, value, ...args)
    controller.writeDisplayProxy({ promptByOrder: Boolean(value) })
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
  twoImageMode.callback = twoImageModeCallback
  promptByOrder.callback = promptByOrderCallback
  cardAspect.callback = cardAspectCallback
  previewFit.callback = previewFitCallback
  waveformPairs.callback = waveformPairsCallback
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
      if (twoImageMode.callback === twoImageModeCallback) {
        if (originalTwoImageModeCallback) twoImageMode.callback = originalTwoImageModeCallback
        else delete twoImageMode.callback
      }
      if (promptByOrder.callback === promptByOrderCallback) {
        if (originalPromptByOrderCallback) promptByOrder.callback = originalPromptByOrderCallback
        else delete promptByOrder.callback
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
    },
  }
}

function initialValue(inputData: unknown): unknown {
  if (!Array.isArray(inputData)) return undefined
  const options = inputData[1]
  if (typeof options !== "object" || options === null) return undefined
  const record = options as Record<string, unknown>
  return record.default ?? record.defaultValue
}

function promptPresetCatalog(inputData: unknown): unknown {
  if (!Array.isArray(inputData)) return undefined
  const options = inputData[1]
  if (typeof options !== "object" || options === null) return undefined
  return (options as Record<string, unknown>).promptPresets
}

export function getReferenceLoaderController(
  node: ComfyNode,
): ReferenceLoaderController | undefined {
  return controllers.get(node)
}

export function getReferencePromptController(
  node: ComfyNode,
): ReferencePromptController | undefined {
  return promptControllers.get(node)
}

export type ReferenceLoaderWidget = ComfyWidget
