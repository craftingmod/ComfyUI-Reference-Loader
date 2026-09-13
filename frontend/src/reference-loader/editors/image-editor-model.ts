import type { ImageEditRecipe, ImageItem, NormalizedCrop } from "../types.ts"

export type MaskBrushTool = "erase" | "restore"
export type CropHandle = "north-west" | "north-east" | "south-west" | "south-east"
export type ImageEditorInteractionMode = "view" | "crop" | "mask"
export type CropSelectionMode = "unfocused" | "focused" | "clipped"
export type CropAspectPreset =
  | "custom"
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "3:2"
  | "2:3"
  | "16:9"
  | "9:16"
export type ImageEditorPointerSurface = "stage" | "crop-body" | "crop-handle" | "mask"
export type ImageEditorPointerIntent =
  | "ignore"
  | "pan"
  | "unfocus-and-pan"
  | "pending-select"
  | "pending-pan"
  | "move-crop"
  | "resize-crop"
  | "paint-mask"

export interface ImageEditorPointerContext {
  interactionMode: ImageEditorInteractionMode
  cropSelection: CropSelectionMode
  surface: ImageEditorPointerSurface
  ctrlKey: boolean
  viewportFilling: boolean
}

export interface ImageEditorDraft {
  interactionMode: ImageEditorInteractionMode
  cropAspect: CropAspectPreset
  crop: NormalizedCrop
  cropFrame: NormalizedCrop
  flipX: boolean
  flipY: boolean
  removeBackground: boolean
  backgroundMode: "transparent" | "solid"
  backgroundColor: string
  tool: MaskBrushTool
  brushSize: number
  brushOpacity: number
  zoom: number
  panX: number
  panY: number
  maskPixels?: Uint8ClampedArray
  maskWidth?: number
  maskHeight?: number
  maskTouched: boolean
}

export interface ImageEditorOptions {
  item: ImageItem
  previewUrl?: string
  captionLabel?: string
  captionPlaceholder?: string
  showCaption?: boolean
  imageWidth?: number
  imageHeight?: number
  imageMetadata?: (signal: AbortSignal) => Promise<{ width?: number; height?: number }>
  backgroundPreview?: (signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
}

export interface AppliedImageEditorResult {
  action: "apply"
  edit: ImageEditRecipe
  caption: string
  maskFile?: File
}

export interface RestoredImageEditorResult {
  action: "restore-original"
  caption: string
}

export type ImageEditorResult = AppliedImageEditorResult | RestoredImageEditorResult

function fullCrop(): NormalizedCrop {
  return { x: 0, y: 0, width: 1, height: 1 }
}

export function isMaterializedImageEdit(item: ImageItem): boolean {
  return (
    item.source.path !== item.originalSource.path ||
    item.source.sha256 !== item.originalSource.sha256
  )
}

export function createInitialImageDraft(item: ImageItem): ImageEditorDraft {
  const materialized = isMaterializedImageEdit(item)
  return {
    interactionMode: "view",
    cropAspect: "custom",
    crop: materialized ? fullCrop() : (item.edit?.crop ?? fullCrop()),
    cropFrame: materialized ? fullCrop() : (item.edit?.crop ?? fullCrop()),
    flipX: materialized ? false : (item.edit?.flipX ?? false),
    flipY: materialized ? false : (item.edit?.flipY ?? false),
    removeBackground: materialized ? false : (item.edit?.removeBackground ?? false),
    backgroundMode: materialized ? "transparent" : (item.edit?.background?.mode ?? "transparent"),
    backgroundColor: materialized ? "#ffffff" : (item.edit?.background?.color ?? "#ffffff"),
    tool: "erase",
    brushSize: 48,
    brushOpacity: 1,
    zoom: 1,
    panX: 0,
    panY: 0,
    maskTouched: false,
  }
}

export function recipeFromDraft(item: ImageItem, draft: ImageEditorDraft): ImageEditRecipe {
  const materialized = isMaterializedImageEdit(item)
  return {
    crop: draft.crop,
    flipX: draft.flipX,
    flipY: draft.flipY,
    ...(draft.removeBackground ? { removeBackground: true } : {}),
    background: { mode: draft.backgroundMode, color: draft.backgroundColor },
    ...(!materialized && item.edit?.mask
      ? { mask: item.edit.mask, maskMode: "keep" as const }
      : {}),
    revision: (item.source.revision ?? item.edit?.revision ?? 0) + 1,
  }
}

export function initialImageEditorRecipe(item: ImageItem): ImageEditRecipe {
  return recipeFromDraft(item, createInitialImageDraft(item))
}
