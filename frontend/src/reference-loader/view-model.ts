import type { PromptReference } from "./prompt-state.ts"
import type { ItemRuntime, LoaderState, MediaItem } from "./types.ts"

export interface LoaderDisplayState {
  gridColumns: number
  previewPixels: number
  showCaptions: boolean
  twoImageMode: boolean
  promptByOrder: boolean
  cardAspect: string
  previewFit: "contain" | "cover"
  waveformPairs: number
}

export interface PendingUploadView {
  id: string
  filename: string
}

export interface LoaderViewSnapshot {
  readonly state: LoaderState
  readonly display: LoaderDisplayState
  readonly runtime: ReadonlyMap<string, Readonly<ItemRuntime>>
  readonly pending: readonly PendingUploadView[]
  readonly selectedId: string | undefined
  readonly status: string
  readonly canUndo: boolean
  readonly canRedo: boolean
}

export interface LoaderViewInput {
  state: LoaderState
  display: LoaderDisplayState
  runtime: ReadonlyMap<string, ItemRuntime>
  pending: Iterable<PendingUploadView>
  selectedId: string | undefined
  status: string
  canUndo: boolean
  canRedo: boolean
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
    canUndo: input.canUndo,
    canRedo: input.canRedo,
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
    previous.canUndo !== next.canUndo ||
    previous.canRedo !== next.canRedo
  )
    return false
  const previousDisplay = previous.display
  const nextDisplay = next.display
  if (
    previousDisplay.gridColumns !== nextDisplay.gridColumns ||
    previousDisplay.previewPixels !== nextDisplay.previewPixels ||
    previousDisplay.showCaptions !== nextDisplay.showCaptions ||
    previousDisplay.twoImageMode !== nextDisplay.twoImageMode ||
    previousDisplay.promptByOrder !== nextDisplay.promptByOrder ||
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

function itemFilename(item: MediaItem): string {
  return item.sourceFilename || item.source.path.split("/").pop() || item.source.path
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
