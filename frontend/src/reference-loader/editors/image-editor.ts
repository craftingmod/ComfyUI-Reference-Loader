import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import { LocalHistory } from "../history.ts"
import type { NormalizedCrop } from "../types.ts"
import {
  FULL_STAGE_FRAME,
  clamp,
  constrainCropViewport,
  cropAspectRatioValue,
  cropSelectionModeForFrame,
  fitNormalizedCropToAspect,
  isCropAspectPreset,
  isCropHandleVisible,
  isNormalizedCropViewportFilling,
  moveNormalizedCrop,
  normalizedCropToPixels,
  pixelCropToNormalized,
  projectCropToViewport,
  resolveImageEditorPointerIntent,
  resizeNormalizedCrop,
  resizeNormalizedCropToAspect,
  unprojectCropFromViewport,
  updatePixelCropForAspect,
  viewportPanBounds,
} from "./image-editor-geometry.ts"
import { invertMaskPixels, maskBrushToolForModifier } from "./image-editor-mask.ts"
import {
  createInitialImageDraft,
  isMaterializedImageEdit,
  recipeFromDraft,
  type CropHandle,
  type CropSelectionMode,
  type ImageEditorDraft,
  type ImageEditorInteractionMode,
  type ImageEditorOptions,
  type ImageEditorPointerSurface,
  type ImageEditorResult,
  type MaskBrushTool,
} from "./image-editor-model.ts"
import {
  ImageEditorDialog,
  type ImageEditorReactOptions,
  type ImageEditorReactRefs,
} from "./image-editor-react.tsx"

export type {
  AppliedImageEditorResult,
  CropAspectPreset,
  CropHandle,
  CropSelectionMode,
  ImageEditorDraft,
  ImageEditorInteractionMode,
  ImageEditorOptions,
  ImageEditorPointerContext,
  ImageEditorPointerIntent,
  ImageEditorPointerSurface,
  ImageEditorResult,
  MaskBrushTool,
  RestoredImageEditorResult,
} from "./image-editor-model.ts"
export type { CropViewport, PixelCrop, ViewportPanBounds } from "./image-editor-geometry.ts"
export {
  createInitialImageDraft,
  initialImageEditorRecipe,
  isMaterializedImageEdit,
  recipeFromDraft,
} from "./image-editor-model.ts"
export {
  constrainCropViewport,
  cropAspectRatioValue,
  fitNormalizedCropToAspect,
  isCropHandleVisible,
  isNormalizedCropFullyVisible,
  isNormalizedCropViewportFilling,
  moveNormalizedCrop,
  normalizedCropToPixels,
  pixelCropToNormalized,
  projectCropToViewport,
  resolveImageEditorPointerIntent,
  resizeNormalizedCrop,
  resizeNormalizedCropToAspect,
  unprojectCropFromViewport,
  updatePixelCrop,
  updatePixelCropForAspect,
  viewportPanBounds,
} from "./image-editor-geometry.ts"
export { applyMaskBrush, invertMaskPixels, maskBrushToolForModifier } from "./image-editor-mask.ts"

type ImageEditorGesture =
  | { kind: "idle" }
  | {
      kind: "pending-pan"
      start: readonly [number, number]
      initialDraft: ImageEditorDraft
      focusCropOnClick: boolean
    }
  | {
      kind: "pan"
      start: readonly [number, number]
      initialDraft: ImageEditorDraft
      draft: ImageEditorDraft
    }
  | {
      kind: "move-crop" | "resize-crop"
      handle: CropHandle | undefined
      initialFrame: NormalizedCrop
      start: readonly [number, number]
      initialDraft: ImageEditorDraft
      draft: ImageEditorDraft
    }
  | { kind: "paint-mask"; lastPoint: readonly [number, number] }

function cssPercentage(value: number): string {
  const percentage = Math.abs(value) < 1e-10 ? 0 : value * 100
  return `${percentage}%`
}

function filename(path: string): string {
  return path.split("/").pop() ?? path
}

function canvasFile(canvas: HTMLCanvasElement, filename: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("The mask canvas could not be encoded."))
        return
      }
      resolve(new File([blob], filename, { type: "image/png", lastModified: Date.now() }))
    }, "image/png")
  })
}

export function openImageEditor(options: ImageEditorOptions): Promise<ImageEditorResult | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog")
    const captionLabel = options.captionLabel ?? "Caption"
    const captionPlaceholder = options.captionPlaceholder ?? captionLabel
    dialog.className = "rl-modal rl-image-editor"
    dialog.setAttribute("aria-label", "Image reference editor")
    // At most ~20 MiB of 512px RGBA mask snapshots, plus lightweight recipe references.
    const history = new LocalHistory(createInitialImageDraft(options.item), 20)
    let refs: ImageEditorReactRefs | undefined
    let root: Root | undefined
    const reactOptions: ImageEditorReactOptions = {
      filename: options.item.sourceFilename || filename(options.item.source.path),
      sourcePath: options.item.source.path,
      caption: options.item.caption,
      captionLabel,
      captionPlaceholder,
      showCaption: options.showCaption !== false,
      materialized: isMaterializedImageEdit(options.item),
      initialDraft: history.value,
      onAction: (action) => handleAction(action),
      onInput: (field, value) => handleInput(field, value),
      onChange: (field, value) => handleChange(field, value),
      onReady(nextRefs) {
        refs = nextRefs
      },
    }
    document.body.append(dialog)
    root = createRoot(dialog)
    flushSync(() => root?.render(createElement(ImageEditorDialog, { options: reactOptions })))
    const image = refs?.image
    const stage = refs?.stage
    const visual = refs?.visual
    const maskCanvas = refs?.maskCanvas
    const cropOverlay = refs?.cropOverlay
    const maskBrushPreview = refs?.maskBrushPreview
    let settled = false
    let canvasReady = false
    let resolvedImageWidth = options.imageWidth
    let resolvedImageHeight = options.imageHeight
    let sourceWidth = Math.max(1, Math.round(resolvedImageWidth ?? 1024))
    let sourceHeight = Math.max(1, Math.round(resolvedImageHeight ?? 1024))
    const metadataController = new AbortController()
    let backgroundPreviewUrl: string | undefined
    let backgroundPreviewLoading = false
    let backgroundPreviewController: AbortController | undefined
    let wheelMergeSequence = 0
    let wheelMergeTimer: ReturnType<typeof setTimeout> | undefined
    let cropSelection: CropSelectionMode = "focused"
    let gesture: ImageEditorGesture = { kind: "idle" }
    let maskBrushHover: readonly [number, number] | undefined
    let altMaskTool = false

    const getInput = (field: string): HTMLInputElement | HTMLSelectElement | null =>
      refs?.fields[field] ?? null

    const initializeCanvas = (): void => {
      if (!maskCanvas || !image) return
      const naturalWidth = Math.max(1, image.naturalWidth || 1024)
      const naturalHeight = Math.max(1, image.naturalHeight || 1024)
      sourceWidth = Math.max(1, Math.round(resolvedImageWidth ?? naturalWidth))
      sourceHeight = Math.max(1, Math.round(resolvedImageHeight ?? naturalHeight))
      const scale = Math.min(1, 512 / Math.max(naturalWidth, naturalHeight))
      maskCanvas.width = Math.max(1, Math.round(naturalWidth * scale))
      maskCanvas.height = Math.max(1, Math.round(naturalHeight * scale))
      if (stage) {
        const aspect = sourceWidth / sourceHeight
        const viewportHeight = Math.max(360, globalThis.innerHeight || 900)
        const maxStageWidth = Math.max(1, Math.min(1024, viewportHeight * 0.65 * aspect))
        stage.style.aspectRatio = `${sourceWidth} / ${sourceHeight}`
        stage.style.width = `min(100%, ${maxStageWidth}px)`
      }
      const context = maskCanvas.getContext("2d")
      if (context) {
        context.fillStyle = "#ffffff"
        context.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
      }
      canvasReady = true
    }

    const restoreMask = (draft: ImageEditorDraft): void => {
      if (!maskCanvas) return
      const context = maskCanvas.getContext("2d")
      if (!context) return
      if (
        draft.maskPixels &&
        draft.maskWidth === maskCanvas.width &&
        draft.maskHeight === maskCanvas.height &&
        typeof ImageData !== "undefined"
      ) {
        context.putImageData(
          new ImageData(
            new Uint8ClampedArray(draft.maskPixels),
            maskCanvas.width,
            maskCanvas.height,
          ),
          0,
          0,
        )
      } else {
        context.fillStyle = "#ffffff"
        context.fillRect(0, 0, maskCanvas.width, maskCanvas.height)
      }
    }

    const renderMaskBrushPreview = (draft: ImageEditorDraft = history.value): void => {
      if (!maskBrushPreview) return
      const visible =
        canvasReady && draft.interactionMode === "mask" && maskBrushHover !== undefined
      maskBrushPreview.hidden = !visible
      if (!visible || !maskBrushHover) return
      maskBrushPreview.dataset.maskTool = maskBrushToolForModifier(draft.tool, altMaskTool)
      maskBrushPreview.style.left = `${maskBrushHover[0]}px`
      maskBrushPreview.style.top = `${maskBrushHover[1]}px`
      maskBrushPreview.style.width = `${draft.brushSize}px`
      maskBrushPreview.style.height = `${draft.brushSize}px`
    }

    const render = (restoreCanvas = true): void => {
      const draft =
        gesture.kind === "pan" || gesture.kind === "move-crop" || gesture.kind === "resize-crop"
          ? gesture.draft
          : history.value
      const interactionMode = draft.interactionMode
      const crop = draft.crop
      const cropFrame = draft.cropFrame
      const cropFocused = cropSelection !== "unfocused"
      const resizeOnly = cropSelection === "clipped"
      const viewportFillCrop =
        interactionMode === "crop" &&
        cropSelection === "focused" &&
        isNormalizedCropViewportFilling(cropFrame)
      const pixelCrop = normalizedCropToPixels(crop, sourceWidth, sourceHeight)
      for (const field of ["x", "y", "width", "height"] as const) {
        const input = getInput(field)
        if (input instanceof HTMLInputElement) {
          input.value = String(pixelCrop[field])
          input.disabled = interactionMode !== "crop"
          input.max = String(
            field === "x"
              ? sourceWidth - pixelCrop.width
              : field === "y"
                ? sourceHeight - pixelCrop.height
                : field === "width"
                  ? sourceWidth - pixelCrop.x
                  : sourceHeight - pixelCrop.y,
          )
        }
      }
      const cropAspect = getInput("crop-aspect")
      if (cropAspect instanceof HTMLSelectElement) {
        cropAspect.value = draft.cropAspect
        cropAspect.disabled = interactionMode !== "crop"
      }
      const cropDimensions = refs?.cropDimensions
      if (cropDimensions) cropDimensions.textContent = `(${sourceWidth} × ${sourceHeight})`
      for (const [field, value] of [
        ["zoom", draft.zoom],
        ["pan-x", draft.panX],
        ["pan-y", draft.panY],
        ["brush-size", draft.brushSize],
        ["brush-opacity", draft.brushOpacity],
      ] as const) {
        const input = getInput(field)
        if (input) input.value = String(value)
      }
      const stageRect = stage?.getBoundingClientRect()
      const panBounds = viewportPanBounds(
        FULL_STAGE_FRAME,
        draft.zoom,
        Math.max(1, stageRect?.width ?? 1),
        Math.max(1, stageRect?.height ?? 1),
      )
      const panXInput = getInput("pan-x")
      const panYInput = getInput("pan-y")
      if (panXInput instanceof HTMLInputElement) {
        panXInput.min = String(Math.ceil(panBounds.minX))
        panXInput.max = String(Math.floor(panBounds.maxX))
      }
      if (panYInput instanceof HTMLInputElement) {
        panYInput.min = String(Math.ceil(panBounds.minY))
        panYInput.max = String(Math.floor(panBounds.maxY))
      }
      const mode = getInput("background-mode")
      const color = getInput("background-color")
      if (mode) mode.value = draft.backgroundMode
      if (color) {
        color.value = draft.backgroundColor
        color.toggleAttribute("disabled", draft.backgroundMode !== "solid")
      }
      refs?.erase.setAttribute("aria-pressed", String(draft.tool === "erase"))
      refs?.restore.setAttribute("aria-pressed", String(draft.tool === "restore"))
      refs?.modeView.setAttribute("aria-pressed", String(interactionMode === "view"))
      refs?.modeCrop.setAttribute("aria-pressed", String(interactionMode === "crop"))
      refs?.modeMask.setAttribute("aria-pressed", String(interactionMode === "mask"))
      for (const control of [
        refs?.erase,
        refs?.restore,
        refs?.invertMask,
        getInput("brush-size"),
        getInput("brush-opacity"),
      ]) {
        if (control) control.disabled = interactionMode !== "mask"
      }
      const removeBackground = refs?.removeBackground
      if (removeBackground) {
        removeBackground.setAttribute("aria-pressed", String(draft.removeBackground))
        removeBackground.setAttribute("aria-busy", String(backgroundPreviewLoading))
        removeBackground.textContent = backgroundPreviewLoading
          ? "Cancel rembg preview"
          : draft.removeBackground && backgroundPreviewUrl
            ? "Background removed (previewed)"
            : "Remove background (rembg)"
      }
      const backgroundStatus = refs?.backgroundStatus
      if (backgroundStatus) {
        backgroundStatus.textContent = backgroundPreviewLoading
          ? "Generating a full-resolution foreground preview…"
          : draft.removeBackground && backgroundPreviewUrl
            ? "Preview ready. Apply will reuse this cached rembg result."
            : "Optional server dependency. Click to generate a preview; the first run may download a model."
      }
      const transform = `translate(${draft.panX}px, ${draft.panY}px) scale(${draft.zoom}) scaleX(${draft.flipX ? -1 : 1}) scaleY(${draft.flipY ? -1 : 1})`
      if (stage) {
        stage.dataset.interactionMode = interactionMode
        stage.classList.toggle(
          "is-pan-available",
          panBounds.maxX > panBounds.minX || panBounds.maxY > panBounds.minY,
        )
        stage.classList.toggle("is-panning", gesture.kind === "pan")
        stage.classList.toggle("is-moving-crop", gesture.kind === "move-crop")
        stage.classList.toggle("is-resize-only", interactionMode === "crop" && resizeOnly)
        stage.classList.toggle("is-viewport-fill-crop", viewportFillCrop)
        stage.style.background =
          draft.backgroundMode === "solid"
            ? draft.backgroundColor
            : "repeating-conic-gradient(#666 0 25%, #888 0 50%) 0 / 18px 18px"
      }
      if (visual) visual.style.transform = transform
      if (image) {
        const desiredSource =
          draft.removeBackground && backgroundPreviewUrl ? backgroundPreviewUrl : options.previewUrl
        if (desiredSource && image.getAttribute("src") !== desiredSource) image.src = desiredSource
        else if (!desiredSource && image.hasAttribute("src")) image.removeAttribute("src")
      }
      if (maskCanvas) {
        maskCanvas.setAttribute("aria-disabled", String(!canvasReady || interactionMode !== "mask"))
        if (restoreCanvas) restoreMask(draft)
      }
      renderMaskBrushPreview(draft)
      if (cropOverlay) {
        const clippedSelection = interactionMode === "crop" && resizeOnly
        cropOverlay.classList.toggle("is-inactive", interactionMode !== "crop")
        cropOverlay.classList.toggle(
          "is-focused",
          interactionMode === "crop" && cropSelection === "focused",
        )
        cropOverlay.classList.toggle("is-resize-only", clippedSelection)
        cropOverlay.classList.toggle("is-unfocused", interactionMode === "crop" && !cropFocused)
        cropOverlay.dataset.cropFocused = String(cropFocused)
        cropOverlay.dataset.cropFocusMode = !cropFocused
          ? "unfocused"
          : resizeOnly
            ? "resize-only"
            : "focused"
        cropOverlay.setAttribute(
          "aria-label",
          clippedSelection
            ? "Clipped crop viewport; drag to pan the image or use a visible corner to resize the crop"
            : viewportFillCrop
              ? "Full-viewport crop; drag to pan the image or use a corner to resize the crop"
              : cropFocused
                ? "Selected crop viewport; drag inside to move it, use a corner to resize it, or click outside to pan"
                : "Unselected crop viewport; click to select it or drag to pan the image",
        )
        cropOverlay.style.left = cssPercentage(cropFrame.x)
        cropOverlay.style.top = cssPercentage(cropFrame.y)
        cropOverlay.style.width = cssPercentage(cropFrame.width)
        cropOverlay.style.height = cssPercentage(cropFrame.height)
        for (const handle of refs?.cropHandles ?? []) {
          const cropHandle = handle.dataset.cropHandle as CropHandle
          const visible = !clippedSelection || isCropHandleVisible(cropFrame, cropHandle)
          handle.hidden = interactionMode !== "crop" || !cropFocused || !visible
          handle.disabled = !canvasReady || interactionMode !== "crop" || !cropFocused || !visible
        }
      }
      const undo = refs?.undo
      const redo = refs?.redo
      const apply = refs?.apply
      if (undo) undo.disabled = !history.canUndo
      if (redo) redo.disabled = !history.canRedo
      if (apply)
        apply.disabled =
          draft.removeBackground && (!backgroundPreviewUrl || backgroundPreviewLoading)
    }

    const setAltMaskTool = (active: boolean): void => {
      if (altMaskTool === active) return
      altMaskTool = active
      renderMaskBrushPreview()
    }
    const onMaskModifierKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Alt") return
      if (history.value.interactionMode === "mask") event.preventDefault()
      setAltMaskTool(true)
    }
    const onMaskModifierKeyUp = (event: KeyboardEvent): void => {
      if (event.key === "Alt") setAltMaskTool(false)
    }
    const onWindowBlur = (): void => setAltMaskTool(false)
    globalThis.addEventListener("keydown", onMaskModifierKeyDown, true)
    globalThis.addEventListener("keyup", onMaskModifierKeyUp, true)
    globalThis.addEventListener("blur", onWindowBlur)

    const finish = (value: ImageEditorResult | null): void => {
      if (settled) return
      settled = true
      backgroundPreviewController?.abort()
      metadataController.abort()
      if (wheelMergeTimer !== undefined) clearTimeout(wheelMergeTimer)
      globalThis.removeEventListener("keydown", onMaskModifierKeyDown, true)
      globalThis.removeEventListener("keyup", onMaskModifierKeyUp, true)
      globalThis.removeEventListener("blur", onWindowBlur)
      options.signal?.removeEventListener("abort", onAbort)
      root?.unmount()
      dialog.remove()
      resolve(value)
    }
    const onAbort = (): void => finish(null)

    const showError = (error: unknown): void => {
      const message = refs?.error
      if (!message) return
      message.hidden = false
      message.textContent =
        error instanceof Error ? error.message : "The background preview could not be created."
    }

    const clearError = (): void => {
      const message = refs?.error
      if (message) message.hidden = true
    }

    const cancelBackgroundPreview = (): void => {
      backgroundPreviewController?.abort()
      backgroundPreviewController = undefined
      backgroundPreviewLoading = false
    }

    const ensureBackgroundPreview = (): void => {
      if (
        settled ||
        !history.value.removeBackground ||
        backgroundPreviewUrl ||
        backgroundPreviewLoading ||
        !options.backgroundPreview
      )
        return
      clearError()
      const controller = new AbortController()
      backgroundPreviewController = controller
      backgroundPreviewLoading = true
      render(false)
      void options
        .backgroundPreview(controller.signal)
        .then((url) => {
          if (settled || controller.signal.aborted || backgroundPreviewController !== controller)
            return
          backgroundPreviewController = undefined
          backgroundPreviewLoading = false
          backgroundPreviewUrl = url
          render(false)
        })
        .catch((error: unknown) => {
          if (settled || controller.signal.aborted || backgroundPreviewController !== controller)
            return
          backgroundPreviewController = undefined
          backgroundPreviewLoading = false
          if (history.value.removeBackground && history.canUndo) history.undo()
          showError(error)
          render(false)
        })
    }

    const commitMask = (): void => {
      if (!maskCanvas) return
      const context = maskCanvas.getContext("2d")
      if (!context) return
      const snapshot = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
      history.commit({
        ...history.value,
        maskPixels: new Uint8ClampedArray(snapshot.data),
        maskWidth: maskCanvas.width,
        maskHeight: maskCanvas.height,
        maskTouched: true,
      })
      render()
    }

    const canvasPoint = (event: PointerEvent): readonly [number, number] | undefined => {
      if (!maskCanvas) return undefined
      const rect = maskCanvas.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return undefined
      let x = ((event.clientX - rect.left) / rect.width) * maskCanvas.width
      let y = ((event.clientY - rect.top) / rect.height) * maskCanvas.height
      if (history.value.flipX) x = maskCanvas.width - x
      if (history.value.flipY) y = maskCanvas.height - y
      return [x, y]
    }

    const stagePoint = (event: PointerEvent): readonly [number, number] | undefined => {
      if (!stage) return undefined
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return undefined
      return [
        clamp((event.clientX - rect.left) / rect.width, 0, 1),
        clamp((event.clientY - rect.top) / rect.height, 0, 1),
      ]
    }

    const cropFromFrame = (
      draft: ImageEditorDraft,
      frame: NormalizedCrop = draft.cropFrame,
      viewportValues: Partial<Pick<ImageEditorDraft, "zoom" | "panX" | "panY">> = {},
    ): NormalizedCrop => {
      const rect = stage?.getBoundingClientRect()
      const width = Math.max(1, rect?.width ?? 1)
      const height = Math.max(1, rect?.height ?? 1)
      return unprojectCropFromViewport(frame, {
        zoom: viewportValues.zoom ?? draft.zoom,
        panX: (viewportValues.panX ?? draft.panX) / width,
        panY: (viewportValues.panY ?? draft.panY) / height,
        flipX: draft.flipX,
        flipY: draft.flipY,
      })
    }

    const frameFromCrop = (draft: ImageEditorDraft, crop: NormalizedCrop): NormalizedCrop => {
      const rect = stage?.getBoundingClientRect()
      const width = Math.max(1, rect?.width ?? 1)
      const height = Math.max(1, rect?.height ?? 1)
      return projectCropToViewport(crop, {
        zoom: draft.zoom,
        panX: draft.panX / width,
        panY: draft.panY / height,
        flipX: draft.flipX,
        flipY: draft.flipY,
      })
    }

    const withViewport = (
      draft: ImageEditorDraft,
      values: Partial<Pick<ImageEditorDraft, "zoom" | "panX" | "panY">>,
      frame: NormalizedCrop = draft.cropFrame,
    ): ImageEditorDraft => {
      const rect = stage?.getBoundingClientRect()
      const viewport = constrainCropViewport(
        FULL_STAGE_FRAME,
        {
          zoom: values.zoom ?? draft.zoom,
          panX: values.panX ?? draft.panX,
          panY: values.panY ?? draft.panY,
        },
        Math.max(1, rect?.width ?? 1),
        Math.max(1, rect?.height ?? 1),
      )
      const next = { ...draft, ...viewport, cropFrame: frame }
      if (draft.interactionMode !== "crop") return next
      if (cropSelection === "focused" || gesture.kind === "resize-crop") {
        return { ...next, crop: cropFromFrame(next, frame) }
      }
      return { ...next, cropFrame: frameFromCrop(next, draft.crop) }
    }

    const paint = (
      from: readonly [number, number],
      to: readonly [number, number],
      tool: MaskBrushTool,
    ): void => {
      if (!maskCanvas) return
      const context = maskCanvas.getContext("2d")
      if (!context) return
      const draft = history.value
      const rect = maskCanvas.getBoundingClientRect()
      const canvasScale = maskCanvas.width / Math.max(1, rect.width)
      context.save()
      context.strokeStyle = tool === "erase" ? "#000000" : "#ffffff"
      context.globalAlpha = draft.brushOpacity
      context.lineWidth = draft.brushSize * canvasScale
      context.lineCap = "round"
      context.lineJoin = "round"
      context.beginPath()
      if (from[0] === to[0] && from[1] === to[1]) {
        context.fillStyle = context.strokeStyle
        context.arc(from[0], from[1], context.lineWidth / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.moveTo(from[0], from[1])
        context.lineTo(to[0], to[1])
        context.stroke()
      }
      context.restore()
    }

    const beginPan = (event: PointerEvent, captureTarget: HTMLElement): void => {
      if (!canvasReady || event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      gesture = {
        kind: "pan",
        start: [event.clientX, event.clientY],
        initialDraft: history.value,
        draft: history.value,
      }
      captureTarget.setPointerCapture?.(event.pointerId)
      render(false)
    }

    const beginPendingPan = (
      event: PointerEvent,
      captureTarget: HTMLElement,
      focusCropOnClick: boolean,
    ): void => {
      event.preventDefault()
      event.stopPropagation()
      gesture = {
        kind: "pending-pan",
        start: [event.clientX, event.clientY],
        initialDraft: history.value,
        focusCropOnClick,
      }
      captureTarget.setPointerCapture?.(event.pointerId)
    }

    const beginCropDrag = (
      event: PointerEvent,
      captureTarget: HTMLElement,
      kind: "move-crop" | "resize-crop",
      handle?: CropHandle,
    ): void => {
      const start = stagePoint(event)
      if (!start) return
      event.preventDefault()
      event.stopPropagation()
      gesture = {
        kind,
        handle,
        initialFrame: history.value.cropFrame,
        start,
        initialDraft: history.value,
        draft: history.value,
      }
      captureTarget.setPointerCapture?.(event.pointerId)
    }

    const beginPointerGesture = (
      event: PointerEvent,
      surface: ImageEditorPointerSurface,
      captureTarget: HTMLElement,
      handle?: CropHandle,
    ): void => {
      if (!canvasReady || event.button !== 0) return
      const intent = resolveImageEditorPointerIntent({
        interactionMode: history.value.interactionMode,
        cropSelection,
        surface,
        ctrlKey: event.ctrlKey,
        viewportFilling: isNormalizedCropViewportFilling(history.value.cropFrame),
      })
      if (intent === "pan") beginPan(event, captureTarget)
      else if (intent === "unfocus-and-pan") {
        cropSelection = "unfocused"
        beginPan(event, captureTarget)
      } else if (intent === "pending-select") beginPendingPan(event, captureTarget, true)
      else if (intent === "pending-pan") beginPendingPan(event, captureTarget, false)
      else if (intent === "move-crop") beginCropDrag(event, captureTarget, "move-crop")
      else if (intent === "resize-crop" && handle)
        beginCropDrag(event, captureTarget, "resize-crop", handle)
      else if (intent === "paint-mask" && maskCanvas) {
        updateMaskBrushPreview(event)
        const point = canvasPoint(event)
        if (!point) return
        event.preventDefault()
        event.stopPropagation()
        gesture = { kind: "paint-mask", lastPoint: point }
        maskCanvas.setPointerCapture?.(event.pointerId)
        paint(
          point,
          point,
          maskBrushToolForModifier(history.value.tool, event.altKey || altMaskTool),
        )
      }
    }

    const updateMaskBrushPreview = (event: PointerEvent): void => {
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        maskBrushHover = undefined
      } else {
        maskBrushHover = [event.clientX - rect.left, event.clientY - rect.top]
      }
      setAltMaskTool(event.altKey)
      renderMaskBrushPreview()
    }

    maskCanvas?.addEventListener("pointerenter", updateMaskBrushPreview)
    maskCanvas?.addEventListener("pointerdown", (event) =>
      beginPointerGesture(event, "mask", maskCanvas),
    )
    maskCanvas?.addEventListener("pointermove", (event) => {
      updateMaskBrushPreview(event)
      if (gesture.kind !== "paint-mask") return
      const point = canvasPoint(event)
      if (!point) return
      paint(
        gesture.lastPoint,
        point,
        maskBrushToolForModifier(history.value.tool, event.altKey || altMaskTool),
      )
      gesture = { kind: "paint-mask", lastPoint: point }
    })
    maskCanvas?.addEventListener("pointerleave", () => {
      maskBrushHover = undefined
      renderMaskBrushPreview()
    })
    const stopPainting = (): void => {
      if (gesture.kind !== "paint-mask") return
      gesture = { kind: "idle" }
      commitMask()
    }
    maskCanvas?.addEventListener("pointerup", stopPainting)
    maskCanvas?.addEventListener("pointercancel", stopPainting)

    cropOverlay?.addEventListener("pointerdown", (event) => {
      const handleElement = (event.target as Element).closest<HTMLElement>("[data-crop-handle]")
      const handle = handleElement?.dataset.cropHandle as CropHandle | undefined
      beginPointerGesture(
        event,
        handle ? "crop-handle" : "crop-body",
        handleElement ?? cropOverlay,
        handle,
      )
    })

    stage?.addEventListener("pointerdown", (event) => {
      beginPointerGesture(event, "stage", stage)
    })

    stage?.addEventListener("pointermove", (event) => {
      if (gesture.kind === "pending-pan") {
        const deltaX = event.clientX - gesture.start[0]
        const deltaY = event.clientY - gesture.start[1]
        if (Math.hypot(deltaX, deltaY) < 4) return
        gesture = {
          kind: "pan",
          start: gesture.start,
          initialDraft: gesture.initialDraft,
          draft: gesture.initialDraft,
        }
      }
      if (gesture.kind === "pan") {
        const panX = gesture.initialDraft.panX + event.clientX - gesture.start[0]
        const panY = gesture.initialDraft.panY + event.clientY - gesture.start[1]
        gesture.draft = withViewport(gesture.initialDraft, { panX, panY })
        render(false)
        return
      }
      if (gesture.kind !== "move-crop" && gesture.kind !== "resize-crop") return
      const point = stagePoint(event)
      if (!point) return
      const deltaX = point[0] - gesture.start[0]
      const deltaY = point[1] - gesture.start[1]
      let frame: NormalizedCrop
      if (gesture.kind === "resize-crop" && gesture.handle) {
        const aspectRatio = cropAspectRatioValue(
          gesture.initialDraft.cropAspect,
          sourceWidth,
          sourceHeight,
        )
        const rect = stage?.getBoundingClientRect()
        frame =
          aspectRatio === undefined
            ? resizeNormalizedCrop(gesture.initialFrame, gesture.handle, deltaX, deltaY)
            : resizeNormalizedCropToAspect(
                gesture.initialFrame,
                gesture.handle,
                deltaX,
                deltaY,
                aspectRatio,
                Math.max(1, rect?.width ?? 1),
                Math.max(1, rect?.height ?? 1),
              )
      } else {
        frame = moveNormalizedCrop(gesture.initialFrame, deltaX, deltaY)
      }
      gesture.draft = withViewport(gesture.initialDraft, {}, frame)
      render(false)
    })

    const stopPointerDrag = (commit: boolean): void => {
      if (gesture.kind === "pending-pan") {
        const focusCrop = commit && gesture.focusCropOnClick
        gesture = { kind: "idle" }
        if (focusCrop) cropSelection = cropSelectionModeForFrame(history.value.cropFrame)
        render(false)
        return
      }
      if (gesture.kind !== "pan" && gesture.kind !== "move-crop" && gesture.kind !== "resize-crop")
        return
      const drag = gesture
      gesture = { kind: "idle" }
      if (commit && drag.draft !== drag.initialDraft) {
        if (drag.kind === "pan" && drag.initialDraft.interactionMode === "view")
          history.replace(drag.draft)
        else history.commit(drag.draft)
      }
      if (cropSelection === "clipped") {
        cropSelection = cropSelectionModeForFrame(
          commit ? drag.draft.cropFrame : history.value.cropFrame,
        )
      }
      render()
    }
    stage?.addEventListener("pointerup", () => stopPointerDrag(true))
    stage?.addEventListener("pointercancel", () => stopPointerDrag(false))

    stage?.addEventListener(
      "wheel",
      (event) => {
        if (!canvasReady) return
        const rect = stage.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return
        event.preventDefault()
        const draft = history.value
        const viewport = {
          zoom: draft.zoom,
          panX: draft.panX / rect.width,
          panY: draft.panY / rect.height,
        }
        const delta =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? event.deltaY * 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? event.deltaY * rect.height
              : event.deltaY
        const zoom = clamp(draft.zoom * Math.exp(-delta * 0.0015), 1, 3)
        if (zoom === draft.zoom) return
        const anchorX = clamp((event.clientX - rect.left) / rect.width, 0, 1)
        const anchorY = clamp((event.clientY - rect.top) / rect.height, 0, 1)
        const ratio = zoom / draft.zoom
        const panX = (anchorX - 0.5 - (anchorX - 0.5 - viewport.panX) * ratio) * rect.width
        const panY = (anchorY - 0.5 - (anchorY - 0.5 - viewport.panY) * ratio) * rect.height
        const next = withViewport(draft, { zoom, panX, panY })
        if (wheelMergeTimer === undefined) wheelMergeSequence += 1
        else clearTimeout(wheelMergeTimer)
        wheelMergeTimer = setTimeout(() => {
          wheelMergeTimer = undefined
          if (cropSelection === "clipped") {
            cropSelection = cropSelectionModeForFrame(history.value.cropFrame)
            render(false)
          }
        }, 250)
        if (draft.interactionMode === "view") history.replace(next)
        else
          history.commit(next, {
            mergeKey: `wheel-${draft.interactionMode}-zoom-${wheelMergeSequence}`,
          })
        render(false)
      },
      { passive: false },
    )

    function handleAction(action: string): void {
      const draft = history.value
      if (action === "cancel") finish(null)
      else if (action === "restore-original") {
        const caption = refs?.caption?.value.slice(0, 16_384) ?? options.item.caption
        finish({ action: "restore-original", caption })
      } else if (action === "mode-view" || action === "mode-crop" || action === "mode-mask") {
        const interactionMode: ImageEditorInteractionMode =
          action === "mode-view" ? "view" : action === "mode-crop" ? "crop" : "mask"
        if (interactionMode === draft.interactionMode) return
        let next: ImageEditorDraft = { ...draft, interactionMode }
        if (interactionMode === "crop") {
          if (cropSelection === "focused") {
            const crop = pixelCropToNormalized(
              normalizedCropToPixels(cropFromFrame(next), sourceWidth, sourceHeight),
              sourceWidth,
              sourceHeight,
            )
            next = { ...next, crop }
          } else {
            const cropFrame = frameFromCrop(next, next.crop)
            next = { ...next, cropFrame }
            if (cropSelection !== "unfocused") cropSelection = cropSelectionModeForFrame(cropFrame)
          }
        }
        history.commit(next)
        render(false)
      } else if (action === "undo") {
        history.undo()
        if (!history.value.removeBackground) cancelBackgroundPreview()
        render()
        if (history.value.removeBackground) ensureBackgroundPreview()
      } else if (action === "redo") {
        history.redo()
        if (!history.value.removeBackground) cancelBackgroundPreview()
        render()
        if (history.value.removeBackground) ensureBackgroundPreview()
      } else if (action === "flip-x") {
        history.commit({ ...draft, flipX: !draft.flipX })
        render()
      } else if (action === "flip-y") {
        history.commit({ ...draft, flipY: !draft.flipY })
        render()
      } else if (action === "remove-background") {
        if (draft.removeBackground) cancelBackgroundPreview()
        history.commit({ ...draft, removeBackground: !draft.removeBackground })
        render()
        if (!draft.removeBackground) ensureBackgroundPreview()
      } else if (action === "invert-mask") {
        if (!maskCanvas || !canvasReady || draft.interactionMode !== "mask") return
        const context = maskCanvas.getContext("2d")
        if (!context) return
        const snapshot = context.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
        history.commit({
          ...draft,
          maskPixels: invertMaskPixels(snapshot.data),
          maskWidth: maskCanvas.width,
          maskHeight: maskCanvas.height,
          maskTouched: true,
        })
        render()
      } else if (action === "erase" || action === "restore") {
        history.commit({ ...draft, tool: action })
        render()
      } else if (action === "reset-view") {
        const next = withViewport(draft, { zoom: 1, panX: 0, panY: 0 })
        if (draft.interactionMode === "view") history.replace(next)
        else history.commit(next)
        if (cropSelection === "clipped") cropSelection = cropSelectionModeForFrame(next.cropFrame)
        render()
      } else if (action === "apply") {
        if (refs?.apply) refs.apply.disabled = true
        void (async () => {
          try {
            const edit = recipeFromDraft(options.item, history.value)
            const maskFile =
              history.value.maskTouched && maskCanvas
                ? await canvasFile(maskCanvas, `${options.item.id}-mask.png`)
                : undefined
            const caption = refs?.caption?.value.slice(0, 16_384) ?? options.item.caption
            finish({ action: "apply", edit, caption, ...(maskFile ? { maskFile } : {}) })
          } catch (error) {
            if (refs?.apply) refs.apply.disabled = false
            showError(error instanceof Error ? error : new Error("The mask could not be prepared."))
          }
        })()
      }
    }

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !history.canUndo && !history.canRedo) finish(null)
    })

    function handleInput(field: string, value: number): void {
      if (!Number.isFinite(value)) return
      const draft = history.value
      const updateViewport = (next: ImageEditorDraft): void => {
        if (draft.interactionMode === "view") history.replace(next)
        else history.commit(next)
      }
      if (field === "zoom") updateViewport(withViewport(draft, { zoom: clamp(value, 1, 3) }))
      else if (field === "pan-x") updateViewport(withViewport(draft, { panX: value }))
      else if (field === "pan-y") updateViewport(withViewport(draft, { panY: value }))
      else if (field === "brush-size") history.commit({ ...draft, brushSize: clamp(value, 4, 200) })
      else if (field === "brush-opacity")
        history.commit({ ...draft, brushOpacity: clamp(value, 0.05, 1) })
      else return
      render()
    }

    function handleChange(field: string, value: string): void {
      const draft = history.value
      if (field === "crop-aspect" && isCropAspectPreset(value)) {
        const cropAspect = value
        const aspectRatio = cropAspectRatioValue(cropAspect, sourceWidth, sourceHeight)
        const crop =
          aspectRatio === undefined
            ? draft.crop
            : fitNormalizedCropToAspect(draft.crop, aspectRatio, sourceWidth, sourceHeight)
        const next = { ...draft, cropAspect, crop }
        const cropFrame = frameFromCrop(next, crop)
        history.commit({ ...next, cropFrame })
        if (cropSelection !== "unfocused") cropSelection = cropSelectionModeForFrame(cropFrame)
      } else if (
        (field === "zoom" || field === "pan-x" || field === "pan-y") &&
        cropSelection === "clipped"
      ) {
        cropSelection = cropSelectionModeForFrame(draft.cropFrame)
      } else if (field === "background-mode" && (value === "solid" || value === "transparent")) {
        history.commit({ ...draft, backgroundMode: value })
      } else if (field === "background-color" && /^#[\da-f]{6}$/i.test(value)) {
        history.commit({ ...draft, backgroundColor: value })
      } else if (field === "x" || field === "y" || field === "width" || field === "height") {
        const number = Number(value)
        if (!Number.isFinite(number)) return
        const pixelCrop = normalizedCropToPixels(draft.crop, sourceWidth, sourceHeight)
        const aspectRatio = cropAspectRatioValue(draft.cropAspect, sourceWidth, sourceHeight)
        const nextPixelCrop = updatePixelCropForAspect(
          pixelCrop,
          field,
          number,
          sourceWidth,
          sourceHeight,
          aspectRatio,
        )
        const crop = pixelCropToNormalized(nextPixelCrop, sourceWidth, sourceHeight)
        history.commit({ ...draft, crop, cropFrame: frameFromCrop(draft, crop) })
      }
      render()
    }
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault()
      finish(null)
    })
    options.signal?.addEventListener("abort", onAbort, { once: true })
    if (image && options.previewUrl) {
      maskCanvas?.setAttribute("aria-disabled", "true")
      image.addEventListener(
        "load",
        () => {
          initializeCanvas()
          render()
        },
        { once: true },
      )
      image.src = options.previewUrl
    } else {
      initializeCanvas()
    }
    render()
    if (
      options.imageMetadata &&
      (resolvedImageWidth === undefined || resolvedImageHeight === undefined)
    ) {
      void options
        .imageMetadata(metadataController.signal)
        .then((metadata) => {
          if (settled || metadataController.signal.aborted) return
          if (metadata.width !== undefined) resolvedImageWidth = metadata.width
          if (metadata.height !== undefined) resolvedImageHeight = metadata.height
          sourceWidth = Math.max(1, Math.round(resolvedImageWidth ?? sourceWidth))
          sourceHeight = Math.max(1, Math.round(resolvedImageHeight ?? sourceHeight))
          render(false)
        })
        .catch(() => undefined)
    }
    if (history.value.removeBackground) ensureBackgroundPreview()
    if (typeof dialog.showModal === "function") dialog.showModal()
    else dialog.setAttribute("open", "")
    if (options.signal?.aborted) finish(null)
  })
}
