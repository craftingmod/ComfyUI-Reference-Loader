import type { NormalizedCrop } from "../types.ts"
import type {
  CropAspectPreset,
  CropHandle,
  CropSelectionMode,
  ImageEditorDraft,
  ImageEditorPointerContext,
  ImageEditorPointerIntent,
} from "./image-editor-model.ts"

export interface PixelCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface CropViewport {
  zoom: number
  panX: number
  panY: number
  flipX: boolean
  flipY: boolean
}

export interface ViewportPanBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export const FULL_STAGE_FRAME: NormalizedCrop = { x: 0, y: 0, width: 1, height: 1 }

const CROP_ASPECT_PRESETS: readonly CropAspectPreset[] = [
  "custom",
  "original",
  "1:1",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "16:9",
  "9:16",
]

export function isCropAspectPreset(value: string): value is CropAspectPreset {
  return CROP_ASPECT_PRESETS.includes(value as CropAspectPreset)
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function resolveImageEditorPointerIntent(
  context: ImageEditorPointerContext,
): ImageEditorPointerIntent {
  if (context.ctrlKey) return "pan"
  if (context.interactionMode === "view") return context.surface === "stage" ? "pan" : "ignore"
  if (context.interactionMode === "mask")
    return context.surface === "mask" ? "paint-mask" : "ignore"
  if (context.surface === "stage") return "unfocus-and-pan"
  if (context.surface === "crop-handle") return "resize-crop"
  if (context.surface !== "crop-body") return "ignore"
  if (context.cropSelection === "unfocused") return "pending-select"
  if (context.cropSelection === "clipped") return "pending-pan"
  return context.viewportFilling ? "pan" : "move-crop"
}

export function viewportPanBounds(
  frame: NormalizedCrop,
  zoom: number,
  viewportWidth: number,
  viewportHeight: number,
): ViewportPanBounds {
  const safeZoom = Math.max(1, zoom)
  const width = Math.max(1, viewportWidth)
  const height = Math.max(1, viewportHeight)
  return {
    minX: (frame.x + frame.width - 0.5 - safeZoom / 2) * width,
    maxX: (frame.x - 0.5 + safeZoom / 2) * width,
    minY: (frame.y + frame.height - 0.5 - safeZoom / 2) * height,
    maxY: (frame.y - 0.5 + safeZoom / 2) * height,
  }
}

export function constrainCropViewport(
  frame: NormalizedCrop,
  viewport: Pick<ImageEditorDraft, "zoom" | "panX" | "panY">,
  viewportWidth: number,
  viewportHeight: number,
): Pick<ImageEditorDraft, "zoom" | "panX" | "panY"> {
  const zoom = clamp(viewport.zoom, 1, 3)
  const bounds = viewportPanBounds(frame, zoom, viewportWidth, viewportHeight)
  return {
    zoom,
    panX: clamp(viewport.panX, bounds.minX, bounds.maxX),
    panY: clamp(viewport.panY, bounds.minY, bounds.maxY),
  }
}

export function resizeNormalizedCrop(
  crop: NormalizedCrop,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
): NormalizedCrop {
  const minimumSize = 0.01
  let left = crop.x
  let top = crop.y
  let right = crop.x + crop.width
  let bottom = crop.y + crop.height
  if (handle.endsWith("west")) left = clamp(left + deltaX, 0, right - minimumSize)
  else right = clamp(right + deltaX, left + minimumSize, 1)
  if (handle.startsWith("north")) top = clamp(top + deltaY, 0, bottom - minimumSize)
  else bottom = clamp(bottom + deltaY, top + minimumSize, 1)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function cropAspectRatioValue(
  preset: CropAspectPreset,
  imageWidth: number,
  imageHeight: number,
): number | undefined {
  if (preset === "custom") return undefined
  if (preset === "original") return Math.max(1, imageWidth) / Math.max(1, imageHeight)
  const [width, height] = preset.split(":").map(Number)
  return width && height ? width / height : undefined
}

export function fitNormalizedCropToAspect(
  crop: NormalizedCrop,
  aspectRatio: number,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const safeAspect = Math.max(1 / 1_000_000, aspectRatio)
  const sourceAspect = Math.max(1, imageWidth) / Math.max(1, imageHeight)
  const normalizedAspect = safeAspect / sourceAspect
  let width = crop.width
  let height = crop.height
  if (width / height > normalizedAspect) width = height * normalizedAspect
  else height = width / normalizedAspect
  return {
    x: clamp(crop.x + (crop.width - width) / 2, 0, 1 - width),
    y: clamp(crop.y + (crop.height - height) / 2, 0, 1 - height),
    width,
    height,
  }
}

export function resizeNormalizedCropToAspect(
  crop: NormalizedCrop,
  handle: CropHandle,
  deltaX: number,
  deltaY: number,
  aspectRatio: number,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedCrop {
  const normalizedAspect =
    (Math.max(1 / 1_000_000, aspectRatio) * Math.max(1, viewportHeight)) /
    Math.max(1, viewportWidth)
  const movingWest = handle.endsWith("west")
  const movingNorth = handle.startsWith("north")
  const anchorX = movingWest ? crop.x + crop.width : crop.x
  const anchorY = movingNorth ? crop.y + crop.height : crop.y
  const pointerX = (movingWest ? crop.x : crop.x + crop.width) + deltaX
  const pointerY = (movingNorth ? crop.y : crop.y + crop.height) + deltaY
  const rawWidth = Math.abs(pointerX - anchorX)
  const rawHeight = Math.abs(pointerY - anchorY)
  const widthDrivenDistance = (rawWidth / normalizedAspect - rawHeight) ** 2
  const heightDrivenWidth = rawHeight * normalizedAspect
  const heightDrivenDistance = (heightDrivenWidth - rawWidth) ** 2
  const desiredWidth = widthDrivenDistance <= heightDrivenDistance ? rawWidth : heightDrivenWidth
  const horizontalLimit = movingWest ? anchorX : 1 - anchorX
  const verticalLimit = movingNorth ? anchorY : 1 - anchorY
  const maximumWidth = Math.max(
    1 / 1_000_000,
    Math.min(horizontalLimit, verticalLimit * normalizedAspect),
  )
  const minimumWidth = Math.min(maximumWidth, Math.max(0.01, 0.01 * normalizedAspect))
  const width = clamp(desiredWidth, minimumWidth, maximumWidth)
  const height = width / normalizedAspect
  return {
    x: movingWest ? anchorX - width : anchorX,
    y: movingNorth ? anchorY - height : anchorY,
    width,
    height,
  }
}

export function moveNormalizedCrop(
  crop: NormalizedCrop,
  deltaX: number,
  deltaY: number,
): NormalizedCrop {
  return {
    ...crop,
    x: clamp(crop.x + deltaX, 0, 1 - crop.width),
    y: clamp(crop.y + deltaY, 0, 1 - crop.height),
  }
}

export function isNormalizedCropFullyVisible(crop: NormalizedCrop, epsilon = 1e-9): boolean {
  return (
    crop.x >= -epsilon &&
    crop.y >= -epsilon &&
    crop.x + crop.width <= 1 + epsilon &&
    crop.y + crop.height <= 1 + epsilon
  )
}

export function isNormalizedCropViewportFilling(crop: NormalizedCrop, epsilon = 1e-9): boolean {
  return (
    Math.abs(crop.x) <= epsilon &&
    Math.abs(crop.y) <= epsilon &&
    Math.abs(crop.x + crop.width - 1) <= epsilon &&
    Math.abs(crop.y + crop.height - 1) <= epsilon
  )
}

export function cropSelectionModeForFrame(
  crop: NormalizedCrop,
): Exclude<CropSelectionMode, "unfocused"> {
  return isNormalizedCropFullyVisible(crop) ? "focused" : "clipped"
}

export function isCropHandleVisible(
  crop: NormalizedCrop,
  handle: CropHandle,
  epsilon = 1e-9,
): boolean {
  const x = handle.endsWith("west") ? crop.x : crop.x + crop.width
  const y = handle.startsWith("north") ? crop.y : crop.y + crop.height
  return x >= -epsilon && x <= 1 + epsilon && y >= -epsilon && y <= 1 + epsilon
}

function viewportCoordinate(value: number, zoom: number, pan: number, flipped: boolean): number {
  const oriented = flipped ? 1 - value : value
  return 0.5 + (oriented - 0.5) * zoom + pan
}

function sourceCoordinate(value: number, zoom: number, pan: number, flipped: boolean): number {
  const oriented = (value - 0.5 - pan) / zoom + 0.5
  return flipped ? 1 - oriented : oriented
}

export function projectCropToViewport(
  crop: NormalizedCrop,
  viewport: CropViewport,
): NormalizedCrop {
  const x1 = viewportCoordinate(crop.x, viewport.zoom, viewport.panX, viewport.flipX)
  const x2 = viewportCoordinate(crop.x + crop.width, viewport.zoom, viewport.panX, viewport.flipX)
  const y1 = viewportCoordinate(crop.y, viewport.zoom, viewport.panY, viewport.flipY)
  const y2 = viewportCoordinate(crop.y + crop.height, viewport.zoom, viewport.panY, viewport.flipY)
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  }
}

export function unprojectCropFromViewport(
  crop: NormalizedCrop,
  viewport: CropViewport,
): NormalizedCrop {
  const x1 = sourceCoordinate(crop.x, viewport.zoom, viewport.panX, viewport.flipX)
  const x2 = sourceCoordinate(crop.x + crop.width, viewport.zoom, viewport.panX, viewport.flipX)
  const y1 = sourceCoordinate(crop.y, viewport.zoom, viewport.panY, viewport.flipY)
  const y2 = sourceCoordinate(crop.y + crop.height, viewport.zoom, viewport.panY, viewport.flipY)
  const width = clamp(Math.abs(x2 - x1), 1 / 1_000_000, 1)
  const height = clamp(Math.abs(y2 - y1), 1 / 1_000_000, 1)
  return {
    x: clamp(Math.min(x1, x2), 0, 1 - width),
    y: clamp(Math.min(y1, y2), 0, 1 - height),
    width,
    height,
  }
}

export function normalizedCropToPixels(
  crop: NormalizedCrop,
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  const width = Math.max(1, Math.round(imageWidth))
  const height = Math.max(1, Math.round(imageHeight))
  const left = clamp(Math.round(crop.x * width), 0, width - 1)
  const top = clamp(Math.round(crop.y * height), 0, height - 1)
  const right = clamp(Math.round((crop.x + crop.width) * width), left + 1, width)
  const bottom = clamp(Math.round((crop.y + crop.height) * height), top + 1, height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function pixelCropToNormalized(
  crop: PixelCrop,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const width = Math.max(1, Math.round(imageWidth))
  const height = Math.max(1, Math.round(imageHeight))
  const left = clamp(Math.round(crop.x), 0, width - 1)
  const top = clamp(Math.round(crop.y), 0, height - 1)
  const cropWidth = clamp(Math.round(crop.width), 1, width - left)
  const cropHeight = clamp(Math.round(crop.height), 1, height - top)
  return { x: left / width, y: top / height, width: cropWidth / width, height: cropHeight / height }
}

export function updatePixelCrop(
  crop: PixelCrop,
  field: keyof PixelCrop,
  value: number,
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  const width = Math.max(1, Math.round(imageWidth))
  const height = Math.max(1, Math.round(imageHeight))
  const integer = Math.round(value)
  if (field === "x") return { ...crop, x: clamp(integer, 0, width - crop.width) }
  if (field === "y") return { ...crop, y: clamp(integer, 0, height - crop.height) }
  if (field === "width") return { ...crop, width: clamp(integer, 1, width - crop.x) }
  return { ...crop, height: clamp(integer, 1, height - crop.y) }
}

export function updatePixelCropForAspect(
  crop: PixelCrop,
  field: keyof PixelCrop,
  value: number,
  imageWidth: number,
  imageHeight: number,
  aspectRatio?: number,
): PixelCrop {
  if (aspectRatio === undefined || field === "x" || field === "y") {
    return updatePixelCrop(crop, field, value, imageWidth, imageHeight)
  }
  const maximumWidth = Math.max(1, Math.round(imageWidth) - crop.x)
  const maximumHeight = Math.max(1, Math.round(imageHeight) - crop.y)
  if (field === "width") {
    let width = clamp(Math.round(value), 1, maximumWidth)
    let height = Math.max(1, Math.round(width / aspectRatio))
    if (height > maximumHeight) {
      height = maximumHeight
      width = clamp(Math.round(height * aspectRatio), 1, maximumWidth)
    }
    return { ...crop, width, height }
  }
  let height = clamp(Math.round(value), 1, maximumHeight)
  let width = Math.max(1, Math.round(height * aspectRatio))
  if (width > maximumWidth) {
    width = maximumWidth
    height = clamp(Math.round(width / aspectRatio), 1, maximumHeight)
  }
  return { ...crop, width, height }
}
