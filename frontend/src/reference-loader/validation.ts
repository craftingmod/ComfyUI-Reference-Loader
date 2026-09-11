import {
  DEFAULT_UI_PREFERENCES,
  H3_TIMELINE_VERSION,
  LOADER_STATE_VERSION,
  MAX_H3_GUIDES,
  VIDEO_AUDIO_POLICY,
  createEmptyH3Timeline,
  createEmptyLoaderState,
  isAudioItem,
  type BackgroundEdit,
  type LoaderState,
  type LoaderUiPreferences,
  type ImageEditRecipe,
  type H3GuideEntry,
  type H3TimelineState,
  type MediaItem,
  type MediaKind,
  type MediaSource,
  type NormalizedCrop,
  type TimeRange,
} from "./types.ts"

export interface LoaderValidationResult {
  state: LoaderState
  issues: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function captionValue(value: unknown): string {
  return stringValue(value).slice(0, 16_384)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function sanitizeSource(value: unknown): MediaSource | undefined {
  if (!isRecord(value)) return undefined
  const path = stringValue(value.path)
  const mime = stringValue(value.mime).toLowerCase()
  const sha256 = stringValue(value.sha256).toLowerCase()
  const pathParts = path.split("/")
  if (
    !path ||
    path.length > 512 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    pathParts[0]?.toLowerCase() === "input" ||
    pathParts.some((part) => !part || part === "." || part === ".." || part.includes(":")) ||
    !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return undefined
  const size = finiteNumber(value.size)
  const revision = finiteNumber(value.revision)
  return {
    path,
    mime,
    sha256,
    ...(size !== undefined && Number.isInteger(size) && size >= 0 ? { size } : {}),
    ...(revision !== undefined && Number.isInteger(revision) && revision >= 0 ? { revision } : {}),
  }
}

function sanitizeTimeRange(value: unknown): TimeRange | undefined {
  if (!isRecord(value)) return undefined
  const start = finiteNumber(value.start)
  const end = finiteNumber(value.end)
  if (start === undefined || end === undefined || start < 0 || end <= start) return undefined
  return { start, end }
}

function sanitizeNormalizedCrop(value: unknown): NormalizedCrop | undefined {
  if (!isRecord(value)) return undefined
  const x = finiteNumber(value.x)
  const y = finiteNumber(value.y)
  const width = finiteNumber(value.width)
  const height = finiteNumber(value.height)
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x + width > 1.000_001 ||
    y + height > 1.000_001
  ) {
    return undefined
  }
  return { x, y, width, height }
}

function sanitizeBackground(value: unknown): BackgroundEdit | undefined {
  if (!isRecord(value) || (value.mode !== "transparent" && value.mode !== "solid")) {
    return undefined
  }
  const color = stringValue(value.color, "#ffffff")
  return { mode: value.mode, color: /^#[\da-f]{6}$/i.test(color) ? color : "#ffffff" }
}

function sanitizeImageEdit(value: unknown): ImageEditRecipe | undefined {
  if (!isRecord(value)) return undefined
  const recipe: ImageEditRecipe = {}
  const crop = sanitizeNormalizedCrop(value.crop)
  const background = sanitizeBackground(value.background)
  const mask = sanitizeSource(value.mask)
  const revision = finiteNumber(value.revision)
  if (crop) recipe.crop = crop
  if (typeof value.flipX === "boolean") recipe.flipX = value.flipX
  if (typeof value.flipY === "boolean") recipe.flipY = value.flipY
  if (typeof value.removeBackground === "boolean") recipe.removeBackground = value.removeBackground
  if (background) recipe.background = background
  if (mask?.mime.startsWith("image/")) {
    recipe.mask = mask
    recipe.maskMode = value.maskMode === "erase" ? "erase" : "keep"
  }
  if (revision !== undefined && revision >= 0) recipe.revision = Math.floor(revision)
  return Object.keys(recipe).length > 0 ? recipe : undefined
}

function sanitizeKind(value: unknown): MediaKind | undefined {
  return value === "image" || value === "audio" || value === "video" ? value : undefined
}

function sanitizeItem(key: string, value: unknown): MediaItem | undefined {
  if (!isRecord(value)) return undefined
  const id = stringValue(value.id, key)
  const kind = sanitizeKind(value.kind)
  const source = sanitizeSource(value.source)
  if (
    !id ||
    id !== key ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
    !kind ||
    !source ||
    !source.mime.startsWith(`${kind}/`)
  )
    return undefined
  const caption = captionValue(value.caption)
  const sourceFilenameValue = stringValue(value.sourceFilename)
  const sourceFilename = (
    sourceFilenameValue.replace(/\\/g, "/").split("/").pop() ||
    source.path.split("/").pop() ||
    source.path
  )
    .replace(/\p{Cc}/gu, "")
    .slice(0, 255)

  if (kind === "image") {
    const originalSource = sanitizeSource(value.originalSource)
    if (!originalSource?.mime.startsWith("image/")) return undefined
    const item: MediaItem = {
      id,
      kind,
      source,
      originalSource,
      sourceFilename,
      caption,
      imageEnabled: booleanValue(value.imageEnabled, true),
    }
    const edit = sanitizeImageEdit(value.edit)
    if (edit) item.edit = edit
    return item
  }

  const crop = sanitizeTimeRange(value.crop)
  if (kind === "audio") {
    const item: MediaItem = {
      id,
      kind,
      source,
      sourceFilename,
      caption,
      audioEnabled: booleanValue(value.audioEnabled, true),
    }
    if (crop) item.crop = crop
    return item
  }

  const item: MediaItem = {
    id,
    kind,
    source,
    sourceFilename,
    caption,
    videoEnabled: booleanValue(value.videoEnabled, true),
    videoAudioEnabled: booleanValue(value.videoAudioEnabled, true),
    audioEnabled: booleanValue(value.audioEnabled, false),
  }
  const audioCaption = value.audioCaptionOverride
  if (typeof audioCaption === "string") item.audioCaptionOverride = audioCaption.slice(0, 16_384)
  if (crop) item.crop = crop
  return item
}

function sanitizeUi(value: unknown): LoaderUiPreferences {
  if (!isRecord(value)) return { ...DEFAULT_UI_PREFERENCES }
  const aspect = stringValue(value.cardAspectRatio)
  const columns = finiteNumber(value.gridColumns)
  const preview = finiteNumber(value.previewMaxPixels)
  const previewFit = stringValue(value.previewFit)
  const peaks = finiteNumber(value.waveformPeaks)
  return {
    cardAspectRatio: ["1 / 1", "4 / 3", "3 / 4", "16 / 9", "9 / 16"].includes(aspect)
      ? aspect
      : DEFAULT_UI_PREFERENCES.cardAspectRatio,
    gridColumns:
      columns === undefined
        ? DEFAULT_UI_PREFERENCES.gridColumns
        : Math.min(8, Math.max(1, Math.round(columns))),
    previewMaxPixels:
      preview === undefined
        ? DEFAULT_UI_PREFERENCES.previewMaxPixels
        : Math.min(16_000_000, Math.max(250_000, Math.round(preview))),
    previewFit: previewFit === "cover" ? "cover" : "contain",
    waveformPeaks:
      peaks !== undefined
        ? Math.min(1000, Math.max(100, Math.round(peaks)))
        : DEFAULT_UI_PREFERENCES.waveformPeaks,
  }
}

const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function sanitizeTimelineId(
  value: unknown,
  items: Record<string, MediaItem>,
  predicate: (item: MediaItem) => boolean,
  issues: string[],
  path: string,
): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value) {
    issues.push(`${path} must be null or a stable media ID.`)
    return null
  }
  const derivedVideoId = value.endsWith(":audio") ? value.slice(0, -6) : undefined
  const item = derivedVideoId ? items[derivedVideoId] : items[value]
  const valid = !derivedVideoId && item !== undefined && predicate(item)
  if (!valid) {
    issues.push(`${path} refers to an unavailable media kind.`)
    return null
  }
  return value
}

function sanitizeH3Timeline(
  value: unknown,
  items: Record<string, MediaItem>,
  issues: string[],
): H3TimelineState {
  if (value === undefined) return createEmptyH3Timeline()
  if (!isRecord(value)) {
    issues.push("h3Timeline was not an object and was reset.")
    return createEmptyH3Timeline()
  }
  if (value.version !== H3_TIMELINE_VERSION) {
    issues.push(`Unsupported h3Timeline version: ${String(value.version)}.`)
    return createEmptyH3Timeline()
  }
  const enabled = booleanValue(value.enabled, false)
  if (typeof value.enabled !== "boolean") issues.push("h3Timeline.enabled was reset.")
  const startImageId = sanitizeTimelineId(
    value.startImageId,
    items,
    (item) => item.kind === "image",
    issues,
    "h3Timeline.startImageId",
  )
  const endImageId = sanitizeTimelineId(
    value.endImageId,
    items,
    (item) => item.kind === "image",
    issues,
    "h3Timeline.endImageId",
  )
  const guides: H3GuideEntry[] = []
  if (!Array.isArray(value.guides)) {
    issues.push("h3Timeline.guides was not an array and was reset.")
  } else {
    const seen = new Set<string>()
    for (const [index, rawGuide] of value.guides.entries()) {
      const path = `h3Timeline.guides[${index}]`
      if (guides.length >= MAX_H3_GUIDES) {
        issues.push(`h3Timeline contains at most ${MAX_H3_GUIDES} guides.`)
        break
      }
      if (!isRecord(rawGuide)) {
        issues.push(`${path} was discarded because it was not an object.`)
        continue
      }
      const id = rawGuide.id
      const frameIndex = rawGuide.frameIndex
      if (
        typeof id !== "string" ||
        !STABLE_ID_RE.test(id) ||
        seen.has(id) ||
        typeof frameIndex !== "number" ||
        !Number.isSafeInteger(frameIndex) ||
        frameIndex < 0
      ) {
        issues.push(`${path} was discarded because its ID or frameIndex is invalid.`)
        continue
      }
      const visualId = sanitizeTimelineId(
        rawGuide.visualId,
        items,
        (item) => item.kind === "image",
        issues,
        `${path}.visualId`,
      )
      const audioId = sanitizeTimelineId(
        rawGuide.audioId,
        items,
        (item) => item.kind === "audio",
        issues,
        `${path}.audioId`,
      )
      seen.add(id)
      guides.push({ id, frameIndex, visualId, audioId })
    }
  }
  const guideVisualIds = new Set<string>()
  if (startImageId !== null) guideVisualIds.add(startImageId)
  if (endImageId !== null) guideVisualIds.add(endImageId)
  const guideAudioIds = new Set<string>()
  for (const guide of guides) {
    if (guide.visualId !== null) guideVisualIds.add(guide.visualId)
    if (guide.audioId !== null) guideAudioIds.add(guide.audioId)
  }
  const sanitizeDisabledIds = (
    raw: unknown,
    path: string,
    predicate: (item: MediaItem) => boolean,
    usedIds: Set<string>,
  ): string[] | undefined => {
    if (raw === undefined) return undefined
    if (!Array.isArray(raw)) {
      issues.push(`${path} was not an array and was reset.`)
      return undefined
    }
    const seen = new Set<string>()
    const ids: string[] = []
    for (const [index, id] of raw.entries()) {
      const entryPath = `${path}[${index}]`
      if (typeof id !== "string" || !STABLE_ID_RE.test(id) || seen.has(id)) {
        issues.push(`${entryPath} was discarded because its ID is invalid or duplicated.`)
        continue
      }
      const item = items[id]
      if (!item || !predicate(item) || !usedIds.has(id)) {
        issues.push(`${entryPath} refers to an unavailable or unused Guide source.`)
        continue
      }
      seen.add(id)
      ids.push(id)
    }
    return ids.length > 0 ? ids : undefined
  }
  const disabledVisualIds = sanitizeDisabledIds(
    value.disabledVisualIds,
    "h3Timeline.disabledVisualIds",
    (item) => item.kind === "image",
    guideVisualIds,
  )
  const disabledAudioIds = sanitizeDisabledIds(
    value.disabledAudioIds,
    "h3Timeline.disabledAudioIds",
    (item) => item.kind === "audio",
    guideAudioIds,
  )
  return {
    version: H3_TIMELINE_VERSION,
    enabled,
    startImageId,
    endImageId,
    guides,
    ...(disabledVisualIds ? { disabledVisualIds } : {}),
    ...(disabledAudioIds ? { disabledAudioIds } : {}),
  }
}

function sanitizeOrder(
  value: unknown,
  items: Record<string, MediaItem>,
  predicate: (item: MediaItem) => boolean,
  issues: string[],
  label: string,
): string[] {
  const order: string[] = []
  const seen = new Set<string>()
  if (Array.isArray(value)) {
    for (const candidate of value) {
      if (typeof candidate !== "string" || seen.has(candidate)) continue
      const item = items[candidate]
      if (!item || !predicate(item)) continue
      seen.add(candidate)
      order.push(candidate)
    }
  } else {
    issues.push(`${label} was not an array.`)
  }
  for (const item of Object.values(items)) {
    if (predicate(item) && !seen.has(item.id)) {
      order.push(item.id)
      issues.push(`${label} was missing item ${item.id}.`)
    }
  }
  return order
}

export function validateLoaderState(value: unknown): LoaderValidationResult {
  if (!isRecord(value)) {
    return { state: createEmptyLoaderState(), issues: ["State was not an object."] }
  }
  const issues: string[] = []
  const rawVersion = value.version
  if (rawVersion !== LOADER_STATE_VERSION) {
    return {
      state: createEmptyLoaderState(),
      issues: [`Unsupported Reference Loader state version: ${String(rawVersion)}.`],
    }
  }

  const items: Record<string, MediaItem> = {}
  if (isRecord(value.items)) {
    const counts: Record<MediaKind, number> = { image: 0, audio: 0, video: 0 }
    const limits: Record<MediaKind, number> = { image: 32, audio: 8, video: 4 }
    for (const [id, rawItem] of Object.entries(value.items)) {
      const item = sanitizeItem(id, rawItem)
      if (item && counts[item.kind] < limits[item.kind]) {
        items[id] = item
        counts[item.kind] += 1
      } else if (item)
        issues.push(`Media item ${id} exceeded the ${item.kind} limit and was discarded.`)
      else issues.push(`Invalid media item ${id} was discarded.`)
    }
  } else {
    issues.push("items was not an object.")
  }

  const imageOrder = sanitizeOrder(
    value.imageOrder,
    items,
    (item) => item.kind === "image",
    issues,
    "imageOrder",
  )
  const videoOrder = sanitizeOrder(
    value.videoOrder,
    items,
    (item) => item.kind === "video",
    issues,
    "videoOrder",
  )
  const audioOrder = sanitizeOrder(value.audioOrder, items, isAudioItem, issues, "audioOrder")
  if (value.videoAudioPolicy !== undefined && value.videoAudioPolicy !== VIDEO_AUDIO_POLICY) {
    issues.push("Unsupported videoAudioPolicy was reset to preserve.")
  }
  const h3Timeline = sanitizeH3Timeline(value.h3Timeline, items, issues)

  return {
    state: {
      version: LOADER_STATE_VERSION,
      items,
      imageOrder,
      videoOrder,
      audioOrder,
      videoAudioPolicy: VIDEO_AUDIO_POLICY,
      h3Timeline,
      ui: sanitizeUi(value.ui),
    },
    issues,
  }
}
