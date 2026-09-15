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
export const H3_OUTPUT_DEFAULT_WIDTH = 1344
export const H3_OUTPUT_DEFAULT_HEIGHT = 768
export const H3_OUTPUT_MIN_WIDTH = 32
export const H3_OUTPUT_MIN_HEIGHT = 32
export const H3_OUTPUT_MAX_WIDTH = 16_384
export const H3_OUTPUT_MAX_HEIGHT = 16_384
export const H3_OUTPUT_DIMENSION_STEP = 32
export const H3_OUTPUT_MIN_RESOLUTION_MULTIPLE = 1
export const H3_OUTPUT_MAX_RESOLUTION_MULTIPLE = H3_OUTPUT_MAX_WIDTH
export const H3_OUTPUT_DEFAULT_RESOLUTION_MULTIPLE = H3_OUTPUT_DIMENSION_STEP
export const H3_OUTPUT_MIN_FRAME_MODULO = 1
export const H3_OUTPUT_MAX_FRAME_MODULO = H3_OUTPUT_MAX_TOTAL_FRAMES
export const H3_OUTPUT_DEFAULT_FRAME_MODULO = 17
export const H3_OUTPUT_DEFAULT_FRAME_REMAINDER = 5
export const H3_OUTPUT_MIN_MEGAPIXELS = 0.01
export const H3_OUTPUT_MAX_MEGAPIXELS = 268.44
export const H3_OUTPUT_DEFAULT_MEGAPIXELS = Number(
  ((H3_OUTPUT_DEFAULT_WIDTH * H3_OUTPUT_DEFAULT_HEIGHT) / 1_000_000).toFixed(2),
)
// MiniMax H3 stores Guide positions on a native 24 fps output timeline.
export const H3_TIMELINE_NATIVE_FPS = H3_OUTPUT_DEFAULT_FPS
export const H3_TIMELINE_DEFAULT_FRAME_COUNT = H3_OUTPUT_DEFAULT_TOTAL_FRAMES

export type MediaKind = "image" | "audio" | "video"

export const H3_OUTPUT_MODES = ["image", "aspect", "manual"] as const
export type H3OutputMode = (typeof H3_OUTPUT_MODES)[number]

export const H3_OUTPUT_ASPECT_IDS = [
  "5:4",
  "4:3",
  "3:2",
  "16:9",
  "2:1",
  "1:1",
  "1:2",
  "9:16",
  "2:3",
  "3:4",
  "4:5",
] as const
export type H3OutputAspectId = (typeof H3_OUTPUT_ASPECT_IDS)[number]

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
  resolutionMultiple: number
  frameModulo: number
  frameRemainder: number
  width: number
  height: number
  mode: H3OutputMode
  imageId: string | null
  aspect: H3OutputAspectId
  targetMegapixels: number
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
  resolutionMultiple: H3_OUTPUT_DEFAULT_RESOLUTION_MULTIPLE,
  frameModulo: H3_OUTPUT_DEFAULT_FRAME_MODULO,
  frameRemainder: H3_OUTPUT_DEFAULT_FRAME_REMAINDER,
  width: H3_OUTPUT_DEFAULT_WIDTH,
  height: H3_OUTPUT_DEFAULT_HEIGHT,
  mode: "aspect",
  imageId: null,
  aspect: "16:9",
  targetMegapixels: H3_OUTPUT_DEFAULT_MEGAPIXELS,
}

export function normalizeH3OutputConfig(
  values: Partial<Pick<H3OutputSettings, "resolutionMultiple" | "frameModulo" | "frameRemainder">>,
  fallback: Pick<
    H3OutputSettings,
    "resolutionMultiple" | "frameModulo" | "frameRemainder"
  > = DEFAULT_H3_OUTPUT,
): Pick<H3OutputSettings, "resolutionMultiple" | "frameModulo" | "frameRemainder"> {
  const resolutionMultiple = Number.isFinite(values.resolutionMultiple)
    ? Math.min(
        H3_OUTPUT_MAX_RESOLUTION_MULTIPLE,
        Math.max(H3_OUTPUT_MIN_RESOLUTION_MULTIPLE, Math.round(values.resolutionMultiple!)),
      )
    : fallback.resolutionMultiple
  const frameModulo = Number.isFinite(values.frameModulo)
    ? Math.min(
        H3_OUTPUT_MAX_FRAME_MODULO,
        Math.max(H3_OUTPUT_MIN_FRAME_MODULO, Math.round(values.frameModulo!)),
      )
    : fallback.frameModulo
  const frameRemainder = Number.isFinite(values.frameRemainder)
    ? Math.min(frameModulo - 1, Math.max(0, Math.round(values.frameRemainder!)))
    : Math.min(frameModulo - 1, Math.max(0, fallback.frameRemainder))
  return { resolutionMultiple, frameModulo, frameRemainder }
}

export function normalizeH3OutputDimension(
  value: number,
  fallback: number,
  resolutionMultiple = H3_OUTPUT_DEFAULT_RESOLUTION_MULTIPLE,
): number {
  if (!Number.isFinite(value)) return fallback
  const multiple = normalizeH3OutputConfig({ resolutionMultiple }).resolutionMultiple
  const minimum = Math.ceil(H3_OUTPUT_MIN_WIDTH / multiple) * multiple
  const maximum = Math.floor(H3_OUTPUT_MAX_WIDTH / multiple) * multiple
  const stepped = Math.round(value / multiple) * multiple
  return Math.min(maximum, Math.max(minimum, stepped))
}

export function normalizeH3OutputFrameCount(
  value: number,
  fallback: number,
  config: Pick<H3OutputSettings, "frameModulo" | "frameRemainder"> = DEFAULT_H3_OUTPUT,
): number {
  if (!Number.isFinite(value)) return fallback
  const { frameModulo, frameRemainder } = normalizeH3OutputConfig(config)
  const minimumN = Math.max(
    0,
    Math.ceil((H3_OUTPUT_MIN_TOTAL_FRAMES - frameRemainder) / frameModulo),
  )
  const maximumN = Math.floor((H3_OUTPUT_MAX_TOTAL_FRAMES - frameRemainder) / frameModulo)
  if (maximumN < minimumN) return fallback
  const n = Math.min(
    maximumN,
    Math.max(minimumN, Math.round((value - frameRemainder) / frameModulo)),
  )
  return frameRemainder + n * frameModulo
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
