import {
  canUseAsH3Guide,
  mediaGuideEnabled,
  mediaHasGuide,
  timelineMediaId,
  type H3GuideChannel,
} from "./h3-media-guides.ts"
import type { PromptReference } from "./prompt-v6.ts"
import {
  isAudioItem,
  type H3TimelineState,
  type ItemRuntime,
  type LoaderState,
  type MediaItem,
} from "./types.ts"
import { isSilentWaveform } from "./waveform.ts"

export type LoaderViewChannel = "image" | "video" | "audio"

export interface LoaderDisplayState {
  gridColumns: number
  previewPixels: number
  showCaptions: boolean
  horizontalCards: boolean
  cardAspect: string
  previewFit: "contain" | "cover"
  waveformPairs: number
}

export interface PendingUploadView {
  id: string
  filename: string
}

export type H3Selection =
  | { kind: "source"; mediaId: string; channel: H3GuideChannel }
  | { kind: "guide"; guideId: string; channel: H3GuideChannel }
  | { kind: "start" | "end" }
  | { kind: "shot"; id: string; tag: string }
  | undefined

export interface H3EditorView {
  readonly mediaId: string | undefined
  readonly channel: H3GuideChannel
  readonly selectedGuideId: string | undefined
  readonly timelineEdit: boolean
  readonly recovery: boolean
  readonly ownedGuideIds: readonly string[]
}

export interface H3WorkspaceView {
  readonly collapsed: boolean
  readonly selection: H3Selection
  readonly editScope: "none" | "source" | "guide" | "shot"
  readonly sessionId: number
  readonly dirty: boolean
  readonly canApply: boolean
  readonly shotDirty: boolean
  readonly shotCanApply: boolean
  readonly issue: string | undefined
  readonly draftError: string | undefined
  readonly timeline: H3TimelineState
  readonly editor: H3EditorView | undefined
  readonly shots: readonly { id: string; tag: string; frameIndex: number }[]
}

export type GuideBadge =
  | { readonly kind: "reference"; readonly index: number }
  | { readonly kind: "guide"; readonly index: number }
  | { readonly kind: "frame"; readonly frameIndex: number }
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "off" }
  | { readonly kind: "paused" }

export interface LoaderViewSnapshot {
  readonly state: LoaderState
  readonly display: LoaderDisplayState
  readonly runtime: ReadonlyMap<string, Readonly<ItemRuntime>>
  readonly pending: readonly PendingUploadView[]
  readonly selectedId: string | undefined
  readonly status: string
  readonly deferPreviews: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly h3: H3WorkspaceView | undefined
}

export interface LoaderViewInput {
  state: LoaderState
  display: LoaderDisplayState
  runtime: ReadonlyMap<string, ItemRuntime>
  pending: Iterable<PendingUploadView>
  selectedId: string | undefined
  status: string
  deferPreviews?: boolean
  canUndo: boolean
  canRedo: boolean
  h3?: H3WorkspaceView
}

export interface LoaderCardView {
  readonly id: string
  readonly kind: MediaItem["kind"]
  readonly channel: LoaderViewChannel
  readonly replaceIndex: number
  readonly sourceRevision: number | undefined
  readonly outputIndex: number | undefined
  readonly filename: string
  readonly caption: string
  readonly selected: boolean
  readonly outputEnabled: boolean
  readonly imageEnabled: boolean
  readonly videoEnabled: boolean
  readonly videoAudioEnabled: boolean
  readonly audioEnabled: boolean
  readonly silentVideo: boolean
  readonly loading: boolean
  readonly applyingEdit: boolean
  readonly error: string | undefined
  readonly previewUrl: string | undefined
  readonly waveformStatus: "No audio track" | "Silent" | undefined
  readonly metadata: Readonly<NonNullable<ItemRuntime["metadata"]>> | undefined
  readonly playbackDuration: number | undefined
  readonly durationLabel: string
  readonly megapixelLabel: string
  readonly guideChannel: H3GuideChannel | undefined
  readonly guideMediaId: string | undefined
  readonly guideAvailable: boolean
  readonly guideConfigured: boolean
  readonly guideEnabled: boolean
  readonly guideIndex: number | undefined
  readonly guideBadges: readonly GuideBadge[]
}

export interface LoaderChannelView {
  readonly channel: LoaderViewChannel
  readonly label: string
  readonly description: string
  readonly count: number
  readonly hasOpenCell: boolean
  readonly cards: readonly LoaderCardView[]
}

const CHANNEL_LABELS: Record<LoaderViewChannel, string> = {
  image: "Images",
  video: "Videos",
  audio: "Audio",
}

const CHANNEL_DESCRIPTIONS: Record<LoaderViewChannel, string> = {
  image: "Image output and captions",
  video: "Video output and captions",
  audio: "Standalone and video sound",
}

function channelOrder(state: LoaderState, channel: LoaderViewChannel): readonly string[] {
  return channel === "image"
    ? state.imageOrder
    : channel === "video"
      ? state.videoOrder
      : state.audioOrder
}

function channelOutputEnabled(channel: LoaderViewChannel, item: MediaItem): boolean {
  if (channel === "image") return item.kind === "image" && item.imageEnabled
  if (channel === "video") return item.kind === "video" && item.videoEnabled
  return isAudioItem(item) && item.audioEnabled
}

function itemFilename(item: MediaItem): string {
  return item.sourceFilename || item.source.path.split("/").pop() || item.source.path
}

function durationLabel(item: MediaItem, runtime: ItemRuntime | undefined): string {
  const duration =
    item.kind === "image"
      ? undefined
      : item.crop
        ? item.crop.end - item.crop.start
        : runtime?.metadata?.duration
  return duration === undefined ? "" : `${duration.toFixed(duration < 10 ? 2 : 1)}s`
}

function megapixelLabel(item: MediaItem, runtime: ItemRuntime | undefined): string {
  if (item.kind !== "image") return ""
  const width = runtime?.metadata?.width
  const height = runtime?.metadata?.height
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return ""
  const megapixels = (width * height) / 1_000_000
  if (megapixels < 0.01) return "<0.01 MP"
  return `${Number(megapixels.toFixed(megapixels >= 10 ? 1 : 2))} MP`
}

function outputIndexFor(
  state: LoaderState,
  channel: LoaderViewChannel,
  orderIndex: number,
): number | undefined {
  const order = channelOrder(state, channel)
  let outputIndex = 0
  for (let index = 0; index <= orderIndex; index += 1) {
    const item = state.items[order[index] ?? ""]
    if (!item || !channelOutputEnabled(channel, item)) continue
    outputIndex += 1
  }
  const item = state.items[order[orderIndex] ?? ""]
  return item && channelOutputEnabled(channel, item) ? outputIndex : undefined
}

function guideIndexFor(
  snapshot: LoaderViewSnapshot,
  channel: LoaderViewChannel,
  orderIndex: number,
): number | undefined {
  const order = channelOrder(snapshot.state, channel)
  const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
  let guideIndex = 0
  for (let index = 0; index <= orderIndex; index += 1) {
    const item = snapshot.state.items[order[index] ?? ""]
    if (!item || !canUseAsH3Guide(item, guideChannel)) continue
    const mediaId = timelineMediaId(item, guideChannel)
    if (!mediaGuideEnabled(snapshot.state.h3Timeline, mediaId, guideChannel)) continue
    guideIndex += 1
  }
  const item = snapshot.state.items[order[orderIndex] ?? ""]
  if (!item || !canUseAsH3Guide(item, guideChannel)) return undefined
  return mediaGuideEnabled(
    snapshot.state.h3Timeline,
    timelineMediaId(item, guideChannel),
    guideChannel,
  )
    ? guideIndex
    : undefined
}

function cardView(
  snapshot: LoaderViewSnapshot,
  channel: LoaderViewChannel,
  id: string,
  orderIndex: number,
): LoaderCardView | undefined {
  const item = snapshot.state.items[id]
  if (!item) return undefined
  const runtime = snapshot.runtime.get(id)
  const silentVideo = item.kind === "video" && runtime?.metadata?.hasAudio === false
  const audioChannel = channel === "audio"
  const waveformStatus =
    audioChannel && isAudioItem(item)
      ? silentVideo
        ? "No audio track"
        : isSilentWaveform(runtime?.waveform)
          ? "Silent"
          : undefined
      : undefined
  const caption =
    item.kind === "video" && audioChannel
      ? (item.audioCaptionOverride ?? item.caption)
      : item.caption
  const playbackDuration =
    item.kind === "image" ? undefined : (runtime?.metadata?.duration ?? item.crop?.end)
  const outputIndex = outputIndexFor(snapshot.state, channel, orderIndex)
  const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
  const guideAvailable = canUseAsH3Guide(item, guideChannel)
  const guideMediaId = guideAvailable ? timelineMediaId(item, guideChannel) : undefined
  const guideConfigured = Boolean(
    guideMediaId && mediaHasGuide(snapshot.state.h3Timeline, guideMediaId, guideChannel),
  )
  const guideEnabled = Boolean(
    guideMediaId && mediaGuideEnabled(snapshot.state.h3Timeline, guideMediaId, guideChannel),
  )
  const guideBadges: GuideBadge[] =
    outputIndex === undefined ? [] : [{ kind: "reference", index: outputIndex }]
  const guideIndex = guideEnabled ? guideIndexFor(snapshot, channel, orderIndex) : undefined
  if (guideIndex !== undefined) guideBadges.push({ kind: "guide", index: guideIndex })
  if (guideAvailable && guideMediaId && guideEnabled) {
    if (guideChannel === "visual" && snapshot.state.h3Timeline.startImageId === guideMediaId)
      guideBadges.push({ kind: "start" })
    guideBadges.push(
      ...snapshot.state.h3Timeline.guides
        .filter((guide) =>
          guideChannel === "visual"
            ? guide.visualId === guideMediaId
            : guide.audioId === guideMediaId,
        )
        .sort((left, right) => left.frameIndex - right.frameIndex)
        .map<GuideBadge>((guide) => ({ kind: "frame", frameIndex: guide.frameIndex })),
    )
    if (guideChannel === "visual" && snapshot.state.h3Timeline.endImageId === guideMediaId)
      guideBadges.push({ kind: "end" })
  }
  if (guideConfigured && !guideEnabled) guideBadges.push({ kind: "off" })
  else if (!snapshot.state.h3Timeline.enabled && guideBadges.length > 0)
    guideBadges.push({ kind: "paused" })
  return {
    id,
    kind: item.kind,
    channel,
    replaceIndex: orderIndex + 1,
    sourceRevision: item.source.revision,
    outputIndex,
    filename: itemFilename(item),
    caption,
    selected: snapshot.selectedId === id,
    outputEnabled: channelOutputEnabled(channel, item),
    imageEnabled: item.kind === "image" && item.imageEnabled,
    videoEnabled: item.kind === "video" && item.videoEnabled,
    videoAudioEnabled: item.kind === "video" && item.videoAudioEnabled && !silentVideo,
    audioEnabled: isAudioItem(item) && item.audioEnabled,
    silentVideo,
    loading: Boolean(runtime?.loading),
    applyingEdit: Boolean(runtime?.applyingEdit),
    error: runtime?.error,
    previewUrl: channel === "image" || channel === "video" ? runtime?.previewUrl : undefined,
    waveformStatus,
    metadata: runtime?.metadata,
    playbackDuration,
    durationLabel: durationLabel(item, runtime),
    megapixelLabel: megapixelLabel(item, runtime),
    guideChannel: guideAvailable ? guideChannel : undefined,
    guideMediaId,
    guideAvailable,
    guideConfigured,
    guideEnabled,
    guideIndex,
    guideBadges,
  }
}

export function projectLoaderChannels(snapshot: LoaderViewSnapshot): LoaderChannelView[] {
  return (Object.keys(CHANNEL_LABELS) as LoaderViewChannel[]).map((channel) => {
    const order = channelOrder(snapshot.state, channel)
    return {
      channel,
      label: CHANNEL_LABELS[channel],
      description: CHANNEL_DESCRIPTIONS[channel],
      count: order.length,
      hasOpenCell: order.length > 0 && order.length % snapshot.display.gridColumns !== 0,
      cards: order.flatMap((id, index) => {
        const card = cardView(snapshot, channel, id, index)
        return card ? [card] : []
      }),
    }
  })
}

function cloneRuntime(runtime: ItemRuntime): Readonly<ItemRuntime> {
  return {
    ...runtime,
    ...(runtime.metadata ? { metadata: { ...runtime.metadata } } : {}),
    ...(runtime.waveform
      ? { waveform: runtime.waveform.map(([min, max]) => [min, max] as const) }
      : {}),
  }
}

export function createLoaderViewSnapshot(input: LoaderViewInput): LoaderViewSnapshot {
  const runtime = new Map<string, Readonly<ItemRuntime>>()
  for (const [id, value] of input.runtime) runtime.set(id, cloneRuntime(value))
  return {
    state: input.state,
    display: { ...input.display },
    runtime,
    pending: [...input.pending].map(({ id, filename }) => ({ id, filename })),
    selectedId: input.selectedId,
    status: input.status,
    deferPreviews: input.deferPreviews === true,
    canUndo: input.canUndo,
    canRedo: input.canRedo,
    h3: input.h3,
  }
}

function sameRuntime(a: Readonly<ItemRuntime> | undefined, b: ItemRuntime | undefined): boolean {
  if (!a || !b) return a === b
  if (
    a.loading !== b.loading ||
    a.applyingEdit !== b.applyingEdit ||
    a.error !== b.error ||
    a.previewUrl !== b.previewUrl
  )
    return false
  const aMetadata = a.metadata
  const bMetadata = b.metadata
  if (Boolean(aMetadata) !== Boolean(bMetadata)) return false
  if (
    aMetadata &&
    bMetadata &&
    (aMetadata.width !== bMetadata.width ||
      aMetadata.height !== bMetadata.height ||
      aMetadata.duration !== bMetadata.duration ||
      aMetadata.frameRate !== bMetadata.frameRate ||
      aMetadata.sampleRate !== bMetadata.sampleRate ||
      aMetadata.channels !== bMetadata.channels ||
      aMetadata.hasAudio !== bMetadata.hasAudio)
  )
    return false
  if (a.waveform === b.waveform) return true
  if (!a.waveform || !b.waveform || a.waveform.length !== b.waveform.length) return false
  return a.waveform.every(
    ([aMin, aMax], index) => aMin === b.waveform?.[index]?.[0] && aMax === b.waveform?.[index]?.[1],
  )
}

export function sameLoaderViewSnapshot(
  previous: LoaderViewSnapshot,
  next: LoaderViewSnapshot,
): boolean {
  if (
    previous.state !== next.state ||
    previous.selectedId !== next.selectedId ||
    previous.status !== next.status ||
    previous.deferPreviews !== next.deferPreviews ||
    previous.canUndo !== next.canUndo ||
    previous.canRedo !== next.canRedo
  )
    return false
  if (!sameH3WorkspaceView(previous.h3, next.h3)) return false
  const previousDisplay = previous.display
  const nextDisplay = next.display
  if (
    previousDisplay.gridColumns !== nextDisplay.gridColumns ||
    previousDisplay.previewPixels !== nextDisplay.previewPixels ||
    previousDisplay.showCaptions !== nextDisplay.showCaptions ||
    previousDisplay.horizontalCards !== nextDisplay.horizontalCards ||
    previousDisplay.cardAspect !== nextDisplay.cardAspect ||
    previousDisplay.previewFit !== nextDisplay.previewFit ||
    previousDisplay.waveformPairs !== nextDisplay.waveformPairs
  )
    return false
  if (previous.runtime.size !== next.runtime.size) return false
  for (const [id, runtime] of next.runtime) {
    if (!sameRuntime(previous.runtime.get(id), runtime)) return false
  }
  if (previous.pending.length !== next.pending.length) return false
  return next.pending.every(
    ({ id, filename }, index) =>
      previous.pending[index]?.id === id && previous.pending[index]?.filename === filename,
  )
}

function sameH3WorkspaceView(
  previous: H3WorkspaceView | undefined,
  next: H3WorkspaceView | undefined,
): boolean {
  if (!previous || !next) return previous === next
  if (
    previous.collapsed !== next.collapsed ||
    previous.editScope !== next.editScope ||
    previous.sessionId !== next.sessionId ||
    previous.dirty !== next.dirty ||
    previous.canApply !== next.canApply ||
    previous.shotDirty !== next.shotDirty ||
    previous.shotCanApply !== next.shotCanApply ||
    previous.issue !== next.issue ||
    previous.draftError !== next.draftError ||
    JSON.stringify(previous.selection) !== JSON.stringify(next.selection) ||
    JSON.stringify(previous.timeline) !== JSON.stringify(next.timeline) ||
    JSON.stringify(previous.editor) !== JSON.stringify(next.editor)
  )
    return false
  if (previous.shots.length !== next.shots.length) return false
  return next.shots.every(
    (shot, index) =>
      previous.shots[index]?.id === shot.id &&
      previous.shots[index]?.tag === shot.tag &&
      previous.shots[index]?.frameIndex === shot.frameIndex,
  )
}

export function projectPromptReferences(
  state: LoaderState,
  runtime: ReadonlyMap<string, ItemRuntime>,
): PromptReference[] {
  const references: PromptReference[] = []
  let ordinal = 0
  for (const id of state.imageOrder) {
    const item = state.items[id]
    if (!item || item.kind !== "image" || !item.imageEnabled) continue
    ordinal += 1
    references.push({
      referenceId: id,
      itemId: id,
      mediaKind: "image",
      ordinal,
      tag: `<Picture ${ordinal}>`,
      label: `image${ordinal}`,
      filename: itemFilename(item),
      ...(runtime.get(id)?.previewUrl ? { previewUrl: runtime.get(id)?.previewUrl } : {}),
    })
  }
  ordinal = 0
  for (const id of state.videoOrder) {
    const item = state.items[id]
    if (!item || item.kind !== "video" || !item.videoEnabled) continue
    ordinal += 1
    references.push({
      referenceId: id,
      itemId: id,
      mediaKind: "video",
      ordinal,
      tag: `<Video ${ordinal}>`,
      label: `video${ordinal}`,
      filename: itemFilename(item),
      ...(runtime.get(id)?.previewUrl ? { previewUrl: runtime.get(id)?.previewUrl } : {}),
    })
  }
  ordinal = 0
  for (const id of state.audioOrder) {
    const item = state.items[id]
    if (!item || (item.kind !== "audio" && item.kind !== "video") || !item.audioEnabled) continue
    ordinal += 1
    references.push({
      referenceId: item.kind === "video" ? `${id}:audio` : id,
      itemId: id,
      mediaKind: "audio",
      ordinal,
      tag: `<Audio ${ordinal}>`,
      label: `audio${ordinal}`,
      filename: itemFilename(item),
    })
  }
  return references
}

export function promptReferenceSourceKey(state: LoaderState): string {
  return projectPromptReferences(state, new Map())
    .map((reference) => {
      const source = state.items[reference.itemId]?.source
      return [
        reference.referenceId,
        source?.path,
        source?.mime,
        source?.sha256,
        source?.size,
        source?.revision,
      ]
        .map((value) => String(value ?? ""))
        .join("\u0000")
    })
    .join("\u0001")
}

export function samePromptReferences(
  a: readonly PromptReference[],
  b: readonly PromptReference[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((reference, index) => {
    const other = b[index]
    return (
      reference.referenceId === other?.referenceId &&
      reference.itemId === other.itemId &&
      reference.mediaKind === other.mediaKind &&
      reference.ordinal === other.ordinal &&
      reference.tag === other.tag &&
      reference.label === other.label &&
      reference.filename === other.filename &&
      reference.previewUrl === other.previewUrl
    )
  })
}
