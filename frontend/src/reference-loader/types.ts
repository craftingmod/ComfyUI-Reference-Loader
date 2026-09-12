export const LOADER_STATE_VERSION = 1 as const
export const VIDEO_AUDIO_POLICY = "preserve" as const
export const H3_TIMELINE_VERSION = 1 as const
export const MAX_H3_GUIDES = 32
export const H3_OUTPUT_DEFAULT_FPS = 24
export const H3_OUTPUT_MIN_FPS = 1
export const H3_OUTPUT_MAX_FPS = 240
export const H3_OUTPUT_DEFAULT_TOTAL_FRAMES = 124
export const H3_OUTPUT_MIN_TOTAL_FRAMES = 1
export const H3_OUTPUT_MAX_TOTAL_FRAMES = 3600
// MiniMax H3 stores Guide positions on a native 24 fps output timeline.
export const H3_TIMELINE_NATIVE_FPS = H3_OUTPUT_DEFAULT_FPS
export const H3_TIMELINE_DEFAULT_FRAME_COUNT = H3_OUTPUT_DEFAULT_TOTAL_FRAMES

export type MediaKind = "image" | "audio" | "video"

export interface H3GuideEntry {
  id: string
  frameIndex: number
  visualId: string | null
  audioId: string | null
}

export interface H3TimelineState {
  version: typeof H3_TIMELINE_VERSION
  enabled: boolean
  startImageId: string | null
  endImageId: string | null
  guides: H3GuideEntry[]
  disabledVisualIds?: string[]
  disabledAudioIds?: string[]
}

export interface H3OutputSettings {
  fps: number
  totalFrames: number
}

export interface MediaSource {
  path: string
  mime: string
  sha256: string
  size?: number
  revision?: number
}

export interface NormalizedCrop {
  x: number
  y: number
  width: number
  height: number
}

export interface TimeRange {
  start: number
  end: number
}

export interface BackgroundEdit {
  mode: "transparent" | "solid"
  color: string
}

export interface ImageEditRecipe {
  crop?: NormalizedCrop
  flipX?: boolean
  flipY?: boolean
  removeBackground?: boolean
  background?: BackgroundEdit
  mask?: MediaSource
  maskMode?: "keep" | "erase"
  revision?: number
}

interface BaseItem {
  id: string
  kind: MediaKind
  source: MediaSource
  sourceFilename?: string
  caption: string
}

export interface ImageItem extends BaseItem {
  kind: "image"
  originalSource: MediaSource
  imageEnabled: boolean
  edit?: ImageEditRecipe
}

export interface AudioItem extends BaseItem {
  kind: "audio"
  audioEnabled: boolean
  crop?: TimeRange
}

export interface VideoItem extends BaseItem {
  kind: "video"
  videoEnabled: boolean
  videoAudioEnabled: boolean
  audioEnabled: boolean
  audioCaptionOverride?: string
  crop?: TimeRange
}

export type MediaItem = ImageItem | AudioItem | VideoItem

export interface LoaderUiPreferences {
  cardAspectRatio: string
  gridColumns: number
  previewMaxPixels: number
  previewFit: "contain" | "cover"
  waveformPeaks: number
}

export interface LoaderState {
  version: typeof LOADER_STATE_VERSION
  items: Record<string, MediaItem>
  imageOrder: string[]
  videoOrder: string[]
  audioOrder: string[]
  videoAudioPolicy: typeof VIDEO_AUDIO_POLICY
  h3Output: H3OutputSettings
  h3Timeline: H3TimelineState
  ui: LoaderUiPreferences
}

export interface MediaMetadata {
  width?: number
  height?: number
  duration?: number
  frameRate?: number
  sampleRate?: number
  channels?: number
  hasAudio?: boolean
}

export interface ItemRuntime {
  loading: boolean
  applyingEdit?: boolean
  error?: string
  previewUrl?: string
  waveform?: ReadonlyArray<readonly [number, number]>
  metadata?: MediaMetadata
}

export const DEFAULT_UI_PREFERENCES: LoaderUiPreferences = {
  cardAspectRatio: "4 / 3",
  gridColumns: 3,
  previewMaxPixels: 1_000_000,
  previewFit: "contain",
  waveformPeaks: 300,
}

export const DEFAULT_H3_OUTPUT: H3OutputSettings = {
  fps: H3_OUTPUT_DEFAULT_FPS,
  totalFrames: H3_OUTPUT_DEFAULT_TOTAL_FRAMES,
}

export function createEmptyLoaderState(): LoaderState {
  return {
    version: LOADER_STATE_VERSION,
    items: {},
    imageOrder: [],
    videoOrder: [],
    audioOrder: [],
    videoAudioPolicy: VIDEO_AUDIO_POLICY,
    h3Output: { ...DEFAULT_H3_OUTPUT },
    h3Timeline: createEmptyH3Timeline(),
    ui: { ...DEFAULT_UI_PREFERENCES },
  }
}

export function createEmptyH3Timeline(): H3TimelineState {
  return {
    version: H3_TIMELINE_VERSION,
    enabled: false,
    startImageId: null,
    endImageId: null,
    guides: [],
  }
}

export function createMediaItem(
  kind: MediaKind,
  source: MediaSource,
  id: string = globalThis.crypto?.randomUUID?.() ?? `reference-${Date.now()}-${Math.random()}`,
): MediaItem {
  const sourceFilename = source.path.split("/").pop() ?? source.path
  const base = { id, kind, source, sourceFilename, caption: "" }
  if (kind === "image") {
    return { ...base, kind, originalSource: source, imageEnabled: true }
  }
  if (kind === "audio") {
    return { ...base, kind, audioEnabled: true }
  }
  return { ...base, kind, videoEnabled: true, videoAudioEnabled: true, audioEnabled: false }
}

export function isAudioItem(item: MediaItem): item is AudioItem | VideoItem {
  return item.kind === "audio" || item.kind === "video"
}
