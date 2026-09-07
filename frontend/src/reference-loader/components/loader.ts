import type { ComfyNode } from "../../comfyui.ts"
import { ReferenceLoaderApi } from "../api.ts"
import { AudioPreviewPlayer } from "../audio-preview-player.ts"
import { openImageEditor } from "../editors/image-editor.ts"
import { openTrimEditor } from "../editors/trim-editor.ts"
import {
  cloneH3Timeline,
  guideUsesMedia,
  h3Placements,
  h3TimelineCounts,
  canUseAsH3Guide,
  mediaHasGuide,
  mediaGuideEnabled,
  setMediaGuideEnabled,
  pruneDisabledGuideMedia,
  referenceEnabled,
  timelineMediaId,
  validateH3Timeline,
  type H3GuideChannel,
} from "../h3-media-guides.ts"
import { LoaderStore, type LoaderDispatchOptions } from "../loader-store.ts"
import type { PromptReference, PromptShot } from "../prompt-state.ts"
import { loaderReducer, type LoaderAction, type LoaderChannel } from "../reducer.ts"
import { deserializeLoaderState, serializeLoaderState } from "../serialization.ts"
import {
  createEmptyH3Timeline,
  createMediaItem,
  isAudioItem,
  type H3TimelineState,
  type LoaderState,
  type ItemRuntime,
  type MediaItem,
} from "../types.ts"
import { VideoPreviewPlayer } from "../video-preview-player.ts"
import {
  createLoaderViewSnapshot,
  projectPromptReferences,
  promptReferenceSourceKey,
  sameLoaderViewSnapshot,
  samePromptReferences,
  type LoaderDisplayState,
  type LoaderViewSnapshot,
} from "../view-model.ts"
import { isSilentWaveform } from "../waveform.ts"
import { createH3GuideEditor, type H3GuidePosition } from "./h3-guide-editor.tsx"
import { H3Timeline, type TimelineView } from "./h3-timeline.ts"

function isH3ReactEvent(event: Event): boolean {
  return event
    .composedPath()
    .some((target) => target instanceof HTMLElement && target.hasAttribute("data-h3-react-surface"))
}

interface PendingUpload {
  id: string
  file: File
  objectUrl: string
}

interface RuntimeLoadOptions {
  renderStart?: boolean
  completionRender?: "immediate" | "scheduled"
}

interface H3EditorState {
  mediaId: string | undefined
  channel: H3GuideChannel
  timeline: ReturnType<typeof cloneH3Timeline>
  initialTimeline: ReturnType<typeof cloneH3Timeline>
  ownedGuideIds: Set<string>
  originalGuideFrames: Map<string, number>
  draftError?: string
  selectedGuideId?: string
  removedGuideIds: Set<string>
  allowTimelineOnly?: boolean
  timelineEdit?: boolean
  requireGuide?: boolean
  returnFocus?: {
    mediaId?: string
    channel?: H3GuideChannel
    guideId?: string
    control?: "toggle" | "edit"
  }
}

export interface LoaderChangeEvents {
  beforeChange?(): void
  afterChange?(): void
  saveSnapshot?(): void
  loadSnapshot?(file: File): Promise<"loaded" | "cancelled">
}

export type ReferenceLoaderMode = "references" | "single-image"

export interface ReferenceLoaderControllerOptions {
  mode?: ReferenceLoaderMode
}

export type { LoaderDisplayState } from "../view-model.ts"

const DRAG_MIME = "application/x-reference-loader-item"
const NODE_PROPERTY_KEY = "referenceLoader"
const MEDIA_EXTENSIONS = {
  image: new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff"]),
  audio: new Set(["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "mka"]),
  video: new Set(["mp4", "mkv", "webm", "mov", "avi"]),
} as const
const MEDIA_LIMITS = { image: 32, audio: 8, video: 4 } as const
type MediaDropKind = keyof typeof MEDIA_EXTENSIONS

function mimeMediaKind(mime: string): MediaDropKind | undefined {
  const match = /^(image|audio|video)\//.exec(mime)
  return match?.[1] as MediaDropKind | undefined
}

function fileMediaKind(file: File): MediaDropKind | undefined {
  const mimeKind = mimeMediaKind(file.type)
  if (mimeKind) return mimeKind
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (!extension) return undefined
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if ((extensions as ReadonlySet<string>).has(extension))
      return kind as keyof typeof MEDIA_EXTENSIONS
  }
  return undefined
}

function mediaDropKinds(dataTransfer: DataTransfer | null): MediaDropKind[] {
  if (!dataTransfer) return []
  const kinds = new Set<MediaDropKind>()
  for (const file of dataTransfer.files) {
    const kind = fileMediaKind(file)
    if (kind) kinds.add(kind)
  }
  if (kinds.size === 0) {
    for (const item of dataTransfer.items) {
      const kind = mimeMediaKind(item.type)
      if (kind) kinds.add(kind)
    }
  }
  return [...kinds]
}

function isSingleMediaDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const files = [...dataTransfer.files]
  if (files.length > 0) return files.length === 1
  const fileItems = [...dataTransfer.items].filter((item) => item.kind === "file")
  return fileItems.length === 1
}

function isSingleImageCandidate(file: File): boolean {
  const kind = fileMediaKind(file)
  return kind === undefined || kind === "image"
}

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return dataTransfer.files.length > 0 || [...dataTransfer.types].includes("Files")
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    }
    return entities[character] ?? character
  })
}

function filename(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

function itemFilename(item: MediaItem): string {
  return item.sourceFilename || filename(item.source.path)
}

function showCaptionsProperty(node: ComfyNode): boolean {
  const value = node.properties?.[NODE_PROPERTY_KEY]
  if (typeof value !== "object" || value === null) return true
  const showCaptions = (value as Record<string, unknown>).showCaptions
  return typeof showCaptions === "boolean" ? showCaptions : true
}

function twoImageModeProperty(node: ComfyNode): boolean {
  const value = node.properties?.[NODE_PROPERTY_KEY]
  if (typeof value !== "object" || value === null) return false
  return (value as Record<string, unknown>).twoImageMode === true
}

export function promptByOrderProperty(node: ComfyNode): boolean {
  const value = node.properties?.[NODE_PROPERTY_KEY]
  if (typeof value !== "object" || value === null) return false
  return (value as Record<string, unknown>).promptByOrder === true
}

function setShowCaptionsProperty(node: ComfyNode, showCaptions: boolean): void {
  const current = node.properties?.[NODE_PROPERTY_KEY]
  const namespace =
    typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
  node.properties = {
    ...node.properties,
    [NODE_PROPERTY_KEY]: { ...namespace, showCaptions },
  }
}

function setTwoImageModeProperty(node: ComfyNode, twoImageMode: boolean): void {
  const current = node.properties?.[NODE_PROPERTY_KEY]
  const namespace =
    typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
  node.properties = {
    ...node.properties,
    [NODE_PROPERTY_KEY]: { ...namespace, twoImageMode },
  }
}

function setPromptByOrderProperty(node: ComfyNode, promptByOrder: boolean): void {
  const current = node.properties?.[NODE_PROPERTY_KEY]
  const namespace =
    typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
  node.properties = {
    ...node.properties,
    [NODE_PROPERTY_KEY]: { ...namespace, promptByOrder },
  }
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

function drawWaveform(
  canvas: HTMLCanvasElement,
  pairs: ReadonlyArray<readonly [number, number]>,
): void {
  const width = Math.max(160, Math.floor(canvas.clientWidth * (globalThis.devicePixelRatio || 1)))
  const height = Math.max(80, Math.floor(canvas.clientHeight * (globalThis.devicePixelRatio || 1)))
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) return
  context.clearRect(0, 0, width, height)
  if (isSilentWaveform(pairs)) {
    context.strokeStyle = "#596273"
    context.lineWidth = Math.max(1, globalThis.devicePixelRatio || 1)
    context.beginPath()
    context.moveTo(0, height / 2)
    context.lineTo(width, height / 2)
    context.stroke()
    return
  }
  context.strokeStyle = "#8eb9ff"
  context.lineWidth = Math.max(1, globalThis.devicePixelRatio || 1)
  context.beginPath()
  pairs.forEach(([minimum, maximum], index) => {
    const x = (index / Math.max(1, pairs.length - 1)) * width
    context.moveTo(x, height / 2 - maximum * height * 0.42)
    context.lineTo(x, height / 2 - minimum * height * 0.42)
  })
  context.stroke()
}

type ReleaseRuntimeSlot = () => void

interface RuntimeWaiter {
  signal: AbortSignal
  resolve: (release: ReleaseRuntimeSlot | undefined) => void
  onAbort: () => void
}

class RuntimeLoadLimiter {
  #active = 0
  #queue: RuntimeWaiter[] = []

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<ReleaseRuntimeSlot | undefined> {
    if (signal.aborted) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const waiter: RuntimeWaiter = {
        signal,
        resolve,
        onAbort: () => {
          const index = this.#queue.indexOf(waiter)
          if (index >= 0) this.#queue.splice(index, 1)
          resolve(undefined)
        },
      }
      signal.addEventListener("abort", waiter.onAbort, { once: true })
      this.#queue.push(waiter)
      this.#pump()
    })
  }

  #pump(): void {
    while (this.#active < this.limit && this.#queue.length > 0) {
      const waiter = this.#queue.shift()
      if (!waiter) return
      waiter.signal.removeEventListener("abort", waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.resolve(undefined)
        continue
      }
      this.#active += 1
      let released = false
      waiter.resolve(() => {
        if (released) return
        released = true
        this.#active -= 1
        this.#pump()
      })
    }
  }
}

export class ReferenceLoaderController {
  readonly root: HTMLElement
  #node: ComfyNode
  #api: ReferenceLoaderApi
  #store: LoaderStore
  #runtime = new Map<string, ItemRuntime>()
  #runtimeSequences = new Map<string, number>()
  #runtimeSequence = 0
  #runtimeEpoch = 0
  #runtimeLimiter = new RuntimeLoadLimiter(4)
  #audioPreview = new AudioPreviewPlayer()
  #videoPreview = new VideoPreviewPlayer()
  #unsubscribeAudioPreview: (() => void) | undefined
  #unsubscribeVideoPreview: (() => void) | undefined
  #pending = new Map<string, PendingUpload>()
  #selectedId: string | undefined
  #status = "Drop image, audio, or video files to begin."
  #destroyController = new AbortController()
  #stateController = new AbortController()
  #modalController: AbortController | undefined
  #drag: { id: string; channel: LoaderChannel } | undefined
  #armedDrag: { id: string; channel: LoaderChannel } | undefined
  #dropTarget: HTMLElement | undefined
  #fileDropTarget: HTMLElement | undefined
  #composing = false
  #renderPending = false
  #renderFrame: number | undefined
  #destroyed = false
  #snapshotMenuOpen = false
  #changeEvents: LoaderChangeEvents
  #mode: ReferenceLoaderMode
  #referenceListeners = new Set<() => void>()
  #viewListeners = new Set<() => void>()
  #viewSnapshot: LoaderViewSnapshot | undefined
  #promptReferences: PromptReference[] = []
  #promptReferenceSourceKey = ""
  #h3Collapsed = true
  #h3SummaryExpanded = false
  #h3BodyId = `rl-h3-media-guides-body-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
  #h3Editor: H3EditorState | undefined
  #h3ReactEditor:
    | { session: H3EditorState; view: ReturnType<typeof createH3GuideEditor> }
    | undefined
  #h3Axis: H3Timeline | undefined
  #h3View: TimelineView = { zoom: 1, scrollLeft: 0 }
  #promptShots: readonly Pick<PromptShot, "tag" | "frameIndex">[] = []
  #promptShotChange: ((tag: string, frameIndex: number) => void) | undefined
  #promptShotRemove: ((tag: string) => void) | undefined
  #promptShotSelect: ((tag: string) => void) | undefined

  constructor(
    root: HTMLElement,
    node: ComfyNode,
    api: ReferenceLoaderApi,
    serialized: unknown,
    changeEvents: LoaderChangeEvents = {},
    options: ReferenceLoaderControllerOptions = {},
  ) {
    this.root = root
    this.#node = node
    this.#api = api
    this.#changeEvents = changeEvents
    this.#mode = options.mode ?? "references"
    const parsed = deserializeLoaderState(serialized)
    this.#store = new LoaderStore(this.#stateForMode(parsed.state))
    if (parsed.issues.length > 0) this.#status = parsed.issues.join(" ")
    else if (this.#mode === "single-image") this.#status = ""
    this.#promptReferences = projectPromptReferences(this.state, this.#runtime)
    this.#promptReferenceSourceKey = promptReferenceSourceKey(this.state)
    this.#viewSnapshot = this.#buildViewSnapshot()
    this.#installEvents()
    this.#unsubscribeAudioPreview = this.#audioPreview.subscribe(() => this.#syncPlaybackUi())
    this.#unsubscribeVideoPreview = this.#videoPreview.subscribe(() => this.#syncPlaybackUi())
    this.#hydrateRestoredRuntime()
  }

  get state(): LoaderState {
    return this.#store.state
  }

  get h3Timeline(): H3TimelineState {
    return this.state.h3Timeline
  }

  get displayState(): LoaderDisplayState {
    return this.getViewSnapshot().display
  }

  getViewSnapshot(): LoaderViewSnapshot {
    if (!this.#viewSnapshot) this.#viewSnapshot = this.#buildViewSnapshot()
    return this.#viewSnapshot
  }

  subscribeView(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#viewListeners.add(listener)
    listener()
    return () => this.#viewListeners.delete(listener)
  }

  #displayState(): LoaderDisplayState {
    return {
      gridColumns: this.state.ui.gridColumns,
      previewPixels: this.state.ui.previewMaxPixels / 1_000_000,
      showCaptions: showCaptionsProperty(this.#node),
      twoImageMode: twoImageModeProperty(this.#node),
      promptByOrder: promptByOrderProperty(this.#node),
      cardAspect: this.state.ui.cardAspectRatio,
      previewFit: this.state.ui.previewFit,
      waveformPairs: this.state.ui.waveformPeaks,
    }
  }

  get promptReferences(): PromptReference[] {
    this.#syncPromptReferences(false)
    return this.#promptReferences
  }

  subscribePromptReferences(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#referenceListeners.add(listener)
    listener()
    return () => this.#referenceListeners.delete(listener)
  }

  setPromptShots(
    shots: readonly Pick<PromptShot, "tag" | "frameIndex">[],
    onChange?: (tag: string, frameIndex: number) => void,
    onSelect?: (tag: string) => void,
    onRemove?: (tag: string) => void,
  ): void {
    if (this.#destroyed) return
    this.#promptShots = shots.map((shot) => ({ tag: shot.tag, frameIndex: shot.frameIndex }))
    this.#promptShotChange = onChange
    this.#promptShotSelect = onSelect
    this.#promptShotRemove = onRemove
    this.render(true)
  }

  acceptsFileDrop(dataTransfer: DataTransfer | null): boolean {
    if (this.#destroyed || !hasFilePayload(dataTransfer)) return false
    const files = [...(dataTransfer?.files ?? [])]
    return (
      files.length === 0 ||
      files.some((file) => {
        const kind = fileMediaKind(file)
        return this.#mode === "single-image" ? isSingleImageCandidate(file) : kind !== undefined
      })
    )
  }

  async addDroppedFiles(files: Iterable<File>, replaceId?: string): Promise<boolean> {
    if (this.#destroyed) return false
    const dropped = [...files]
    if (
      !dropped.some((file) => {
        const kind = fileMediaKind(file)
        return this.#mode === "single-image" ? isSingleImageCandidate(file) : kind !== undefined
      })
    )
      return false
    await this.#uploadFiles(dropped, replaceId)
    return true
  }

  writeDisplayProxy(values: Partial<LoaderDisplayState>): void {
    if (this.#destroyed) return
    const gridColumns =
      values.gridColumns === undefined || !Number.isFinite(values.gridColumns)
        ? this.state.ui.gridColumns
        : Math.min(8, Math.max(1, Math.round(values.gridColumns)))
    const previewMaxPixels =
      values.previewPixels === undefined || !Number.isFinite(values.previewPixels)
        ? this.state.ui.previewMaxPixels
        : Math.min(16_000_000, Math.max(250_000, Math.round(values.previewPixels * 1_000_000)))
    const previewChanged = previewMaxPixels !== this.state.ui.previewMaxPixels
    const cardAspect =
      values.cardAspect !== undefined &&
      ["1 / 1", "4 / 3", "3 / 4", "16 / 9", "9 / 16"].includes(values.cardAspect)
        ? values.cardAspect
        : this.state.ui.cardAspectRatio
    const waveformPairs =
      values.waveformPairs === undefined || !Number.isFinite(values.waveformPairs)
        ? this.state.ui.waveformPeaks
        : Math.min(1000, Math.max(100, Math.round(values.waveformPairs)))
    const previewFit =
      values.previewFit === "cover"
        ? "cover"
        : values.previewFit === "contain"
          ? "contain"
          : this.state.ui.previewFit
    const waveformChanged = waveformPairs !== this.state.ui.waveformPeaks
    if (
      gridColumns !== this.state.ui.gridColumns ||
      previewChanged ||
      cardAspect !== this.state.ui.cardAspectRatio ||
      previewFit !== this.state.ui.previewFit ||
      waveformChanged
    ) {
      this.#dispatch({
        type: "set-ui",
        values: {
          gridColumns,
          previewMaxPixels,
          cardAspectRatio: cardAspect,
          previewFit,
          waveformPeaks: waveformPairs,
        },
      })
      if (previewChanged) {
        this.#reloadChannelRuntime("image")
        this.#reloadChannelRuntime("video")
      }
      if (waveformChanged) this.#reloadChannelRuntime("audio")
    }
    if (values.showCaptions !== undefined) {
      const showCaptions = Boolean(values.showCaptions)
      if (showCaptions !== showCaptionsProperty(this.#node)) {
        this.#recordGraphChange(() => setShowCaptionsProperty(this.#node, showCaptions))
        this.#node.setDirtyCanvas(true, true)
        this.render()
      }
    }
    if (values.twoImageMode !== undefined) {
      const twoImageMode = Boolean(values.twoImageMode)
      if (twoImageMode && this.#activeImageCount() > 2) {
        this.#status = "Two-image mode requires at most two enabled Images."
        this.render()
      } else if (twoImageMode !== twoImageModeProperty(this.#node)) {
        this.#recordGraphChange(() => setTwoImageModeProperty(this.#node, twoImageMode))
        this.#node.setDirtyCanvas(true, true)
        this.#status = twoImageMode
          ? "Two-image mode enabled. Additional Images will be added disabled."
          : "Two-image mode disabled."
        this.render()
      }
    }
    if (values.promptByOrder !== undefined) {
      const promptByOrder = Boolean(values.promptByOrder)
      if (promptByOrder !== promptByOrderProperty(this.#node)) {
        this.#recordGraphChange(() => setPromptByOrderProperty(this.#node, promptByOrder))
        this.#node.setDirtyCanvas(true, true)
        this.#status = promptByOrder
          ? "Prompt mentions are now locked to their image/video/audio order."
          : "Prompt mentions are now locked to their original media."
        this.render()
      }
    }
  }

  restore(serialized: unknown): void {
    if (this.#destroyed) return
    this.#h3Axis?.destroy()
    this.#h3View = { zoom: 1, scrollLeft: 0 }
    this.#audioPreview.stop()
    this.#videoPreview.stop()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#stateController = new AbortController()
    this.#runtimeEpoch += 1
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    const parsed = deserializeLoaderState(serialized)
    this.#store.restore(this.#stateForMode(parsed.state))
    this.#selectedId = undefined
    this.#h3Editor = undefined
    this.#h3SummaryExpanded = false
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#runtimeSequence = 0
    this.#status =
      parsed.issues.length > 0
        ? parsed.issues.join(" ")
        : this.#mode === "single-image"
          ? ""
          : "Workflow state restored."
    this.#syncPromptReferences()
    this.#cancelScheduledRender()
    this.#hydrateRestoredRuntime(true)
  }

  restoreSnapshot(
    serialized: unknown,
    display: Pick<LoaderDisplayState, "showCaptions" | "twoImageMode" | "promptByOrder">,
  ): void {
    this.restore(serialized)
    setShowCaptionsProperty(this.#node, display.showCaptions)
    setTwoImageModeProperty(this.#node, display.twoImageMode)
    setPromptByOrderProperty(this.#node, display.promptByOrder)
    this.render(true)
  }

  serialize(): string {
    return serializeLoaderState(this.state)
  }

  #stateForMode(state: LoaderState): LoaderState {
    if (this.#mode !== "single-image") return state
    const id = state.imageOrder.find((candidate) => state.items[candidate]?.kind === "image")
    const item = id ? state.items[id] : undefined
    return {
      ...state,
      items: id && item?.kind === "image" ? { [id]: { ...item, imageEnabled: true } } : {},
      imageOrder: id && item?.kind === "image" ? [id] : [],
      videoOrder: [],
      audioOrder: [],
      h3Timeline: createEmptyH3Timeline(),
      ui: { ...state.ui, gridColumns: 1 },
    }
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#h3ReactEditor?.view.destroy()
    this.#h3ReactEditor = undefined
    this.#h3Axis?.destroy()
    this.#cancelScheduledRender()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#destroyController.abort()
    this.#unsubscribeAudioPreview?.()
    this.#unsubscribeVideoPreview?.()
    this.#audioPreview.destroy()
    this.#videoPreview.destroy()
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#referenceListeners.clear()
    this.#viewListeners.clear()
    this.#promptShots = []
    this.#promptShotChange = undefined
    this.#promptShotSelect = undefined
    this.#promptShotRemove = undefined
    this.#h3Editor = undefined
    this.#dropTarget = undefined
    this.#setFileDropTarget(undefined)
    this.root.classList.remove("is-dragging", "is-file-dragging")
    delete this.root.dataset.fileDropKinds
    this.root.replaceChildren()
  }

  render(force = false): void {
    if (this.#destroyed) return
    this.#publishView()
    if (this.#h3Axis?.dragging) {
      this.#renderPending = true
      return
    }
    this.#cancelScheduledRender()
    const active = document.activeElement
    const activeH3EditorField =
      (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) &&
      this.root.contains(active) &&
      Boolean(active.closest("[data-h3-editor], [data-h3-axis]"))
    if (
      !force &&
      (this.#composing ||
        (active instanceof HTMLTextAreaElement && this.root.contains(active)) ||
        activeH3EditorField)
    ) {
      this.#renderPending = true
      return
    }
    this.#renderPending = false
    const state = this.state
    const hasClearableState =
      Object.keys(state.items).length > 0 ||
      this.#pending.size > 0 ||
      state.h3Timeline.enabled ||
      state.h3Timeline.startImageId !== null ||
      state.h3Timeline.endImageId !== null ||
      state.h3Timeline.guides.length > 0
    this.root.style.setProperty("--rl-card-aspect", state.ui.cardAspectRatio)
    this.root.style.setProperty(
      "--rl-grid-columns",
      String(this.#mode === "single-image" ? 1 : state.ui.gridColumns),
    )
    this.root.style.setProperty("--rl-preview-fit", state.ui.previewFit)
    if (this.#mode === "single-image") {
      this.#renderSingleImage(state)
      return
    }
    const reactEditor = this.#h3ReactEditor
    const activeReactField =
      active instanceof HTMLElement &&
      (reactEditor?.view.media.contains(active) || reactEditor?.view.body.contains(active))
        ? active
        : undefined
    if (reactEditor && reactEditor.session !== this.#h3Editor) {
      reactEditor.view.destroy()
      this.#h3ReactEditor = undefined
    }
    this.#h3Axis?.destroy()
    this.root.innerHTML = `
      <div class="rl-media-topbar">
        <header class="rl-media-header">
          <div>
            <strong data-media-title>Media</strong>
            <small>Add, edit, and order image, video, and audio references.</small>
          </div>
          <span class="rl-toolbar__count">${Object.keys(state.items).length} reference${Object.keys(state.items).length === 1 ? "" : "s"}</span>
        </header>
        <section class="rl-toolbar" aria-label="Reference Loader toolbar">
          <label class="rl-primary rl-file-button" aria-label="Add media" title="Add media">Add<input type="file" accept="image/*,audio/*,video/*" multiple></label>
          <button type="button" data-action="undo" ${this.#store.canUndo ? "" : "disabled"} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button type="button" data-action="redo" ${this.#store.canRedo ? "" : "disabled"} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          <button type="button" class="rl-clear" data-action="clear" ${hasClearableState ? "" : "disabled"} title="Clear all references and Timeline Guides (Undo available)">Clear</button>
          <span class="rl-snapshot"><button type="button" class="rl-snapshot__trigger" data-action="snapshot-menu" aria-haspopup="menu" aria-expanded="${String(this.#snapshotMenuOpen)}">Snapshot <span aria-hidden="true">▾</span></button><span class="rl-snapshot__menu" role="menu"${this.#snapshotMenuOpen ? "" : " hidden"}><button type="button" role="menuitem" data-action="snapshot-save" title="Save Loader and Prompt settings to JSON">Save</button><button type="button" role="menuitem" data-action="snapshot-load" title="Load Loader and Prompt settings from JSON">Load</button></span><input type="file" accept="application/json,.json" data-snapshot-input aria-label="Load snapshot" hidden></span>
        </section>
      </div>
      ${this.#h3Markup(state)}
      <p class="rl-status" role="status">${escapeHtml(this.#status)}</p>
      ${this.#pendingMarkup()}
      <div class="rl-channels">
        ${this.#channelMarkup("image", "Images", state.imageOrder)}
        ${this.#channelMarkup("video", "Videos", state.videoOrder)}
        ${this.#channelMarkup("audio", "Audio", state.audioOrder)}
      </div>`
    this.#mountH3GuideEditor()
    if (activeReactField?.isConnected && document.activeElement !== activeReactField)
      activeReactField.focus({ preventScroll: true })
    this.#mountH3Timeline()
    this.#drawWaveforms()
    this.#syncPlaybackUi()
  }

  #renderSingleImage(state: LoaderState): void {
    const id = state.imageOrder[0]
    const item = id ? state.items[id] : undefined
    const hasImage = Boolean(id && item?.kind === "image")
    const runtime = id ? this.#runtime.get(id) : undefined
    const pending = this.#pending.values().next().value as PendingUpload | undefined
    const filename = item?.kind === "image" ? itemFilename(item) : pending?.file.name
    const previewUrl = runtime?.previewUrl ?? pending?.objectUrl
    const loading = Boolean(pending || runtime?.loading || runtime?.applyingEdit)
    const error = runtime?.error
      ? `<p class="rl-card__error" role="alert">${escapeHtml(runtime.error)}</p>`
      : ""
    const status = this.#status
      ? `<p class="rl-status rl-single-image-status" role="status">${escapeHtml(this.#status)}</p>`
      : ""
    const preview = previewUrl
      ? `<img src="${escapeHtml(previewUrl)}" alt="" draggable="false">`
      : '<span class="rl-single-image-placeholder">No image selected</span>'
    const loadingOverlay = loading
      ? '<span class="rl-card__loading-overlay" role="status" aria-label="Loading image"><span class="rl-spinner" aria-hidden="true"></span></span>'
      : ""
    this.root.innerHTML = `
      <section class="rl-single-image-panel" aria-label="Reference image">
        <div class="rl-single-image-controls">
          <label class="rl-single-image-select" aria-label="Choose image" title="Choose image">
            <span class="rl-single-image-select__value" title="${escapeHtml(filename ?? "Choose image")}">${escapeHtml(filename ?? "Choose image")}</span>
            <span class="rl-single-image-select__arrow" aria-hidden="true">▾</span>
            <input type="file" data-upload-kind="image" aria-label="Choose image">
          </label>
          <button type="button" class="rl-single-image-edit" data-action="edit" data-id="${escapeHtml(id ?? "")}" data-channel="image"${!hasImage || runtime?.applyingEdit ? " disabled" : ""}>Edit</button>
        </div>
        ${
          hasImage && id
            ? `<article class="rl-card rl-single-image-card${error ? " has-error" : ""}" data-id="${escapeHtml(id)}" data-channel="image" data-media-kind="image" data-replace-index="1" tabindex="0">
                <div class="rl-card__media rl-single-image-preview is-transparent-preview" title="Double-click to edit">${preview}${loadingOverlay}</div>
                ${error}
              </article>`
            : `<div class="rl-single-image-preview${loading ? " is-loading" : " is-empty"}" data-drop-zone="image" title="Double-click to choose an image">${preview}${loadingOverlay}</div>${error}`
        }
        ${status}
      </section>`
  }

  #hydrateRestoredRuntime(force = false): void {
    const items = Object.values(this.state.items)
    for (const item of items) this.#runtime.set(item.id, { loading: true })
    this.render(force)
    for (const item of items) {
      void this.#loadRuntime(item, { renderStart: false, completionRender: "scheduled" })
    }
  }

  #scheduleRender(): void {
    if (this.#destroyed || this.#renderFrame !== undefined) return
    this.#renderFrame = globalThis.requestAnimationFrame(() => {
      this.#renderFrame = undefined
      this.render()
    })
  }

  #cancelScheduledRender(): void {
    if (this.#renderFrame === undefined) return
    globalThis.cancelAnimationFrame(this.#renderFrame)
    this.#renderFrame = undefined
  }

  #buildViewSnapshot(): LoaderViewSnapshot {
    return createLoaderViewSnapshot({
      state: this.state,
      display: this.#displayState(),
      runtime: this.#runtime,
      pending: [...this.#pending.values()].map((pending) => ({
        id: pending.id,
        filename: pending.file.name,
      })),
      selectedId: this.#selectedId,
      status: this.#status,
      canUndo: this.#store.canUndo,
      canRedo: this.#store.canRedo,
    })
  }

  #publishView(): void {
    const next = this.#buildViewSnapshot()
    if (this.#viewSnapshot && sameLoaderViewSnapshot(this.#viewSnapshot, next)) return
    this.#viewSnapshot = next
    for (const listener of this.#viewListeners) listener()
  }

  #syncPromptReferences(notify = true): boolean {
    const next = projectPromptReferences(this.state, this.#runtime)
    const nextSourceKey = promptReferenceSourceKey(this.state)
    if (
      samePromptReferences(this.#promptReferences, next) &&
      this.#promptReferenceSourceKey === nextSourceKey
    )
      return false
    this.#promptReferences = next
    this.#promptReferenceSourceKey = nextSourceKey
    if (notify) for (const listener of this.#referenceListeners) listener()
    return true
  }

  #publishRuntimeUpdate(): void {
    this.#publishView()
    this.#syncPromptReferences()
  }

  #pendingMarkup(): string {
    if (this.#pending.size === 0) return ""
    return `<div class="rl-pending" aria-label="Pending uploads">${[...this.#pending.values()]
      .map(
        (pending) =>
          `<div><span class="rl-spinner" aria-hidden="true"></span><span>${escapeHtml(pending.file.name)}</span><small>Uploading…</small></div>`,
      )
      .join("")}</div>`
  }

  #h3Markup(state: LoaderState): string {
    if (this.#h3Editor) state = { ...state, h3Timeline: this.#h3EditorTimeline(this.#h3Editor) }
    const timeline = state.h3Timeline
    const issue = this.#h3Editor ? this.#h3DraftIssue(this.#h3Editor) : undefined
    const counts = h3TimelineCounts(state)
    const summary = [
      `${counts.mediaCount} media`,
      `${counts.referenceCount} references`,
      `${counts.placementCount} placements`,
      counts.incompleteCount > 0 ? `${counts.incompleteCount} incomplete` : "",
      `${this.#promptShots.length} shots`,
      timeline.enabled ? "" : "Paused",
    ]
      .filter(Boolean)
      .join(" · ")
    const expandedSummary = this.#h3SummaryExpanded
      ? this.#h3PlacementMarkup(state)
      : `${this.#h3PlacementMarkup(state, 3)}${h3Placements(timeline).length > 3 ? `<button type="button" class="rl-h3-summary__more" data-h3-action="toggle-summary" aria-expanded="false">Show all placements (${h3Placements(timeline).length})</button>` : ""}`
    return `<section class="rl-h3-timeline rl-h3-media-guides" data-h3-root>
      <header class="rl-h3-timeline__header">
        <button type="button" class="rl-h3-timeline__collapse" data-h3-action="collapse" aria-expanded="${String(!this.#h3Collapsed)}" aria-controls="${this.#h3BodyId}">${this.#h3Collapsed ? "▸" : "▾"} H3 Timeline Guides</button>
        <span class="rl-h3-timeline__status${timeline.enabled ? " is-on" : ""}">${timeline.enabled ? "ON" : "OFF"}</span>
        <span class="rl-h3-timeline__summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>
        <button type="button" class="rl-h3-timeline__toggle${timeline.enabled ? " is-on" : ""}" data-h3-action="toggle" aria-pressed="${String(timeline.enabled)}">${timeline.enabled ? "Disable Media Guides" : "Enable Media Guides"}</button>
      </header>
      <div id="${this.#h3BodyId}" class="rl-h3-timeline__body"${this.#h3Collapsed ? " hidden" : ""}>
        <p class="rl-h3-timeline__hint">24 fps · Media Guides are conditioning only. Shots are independent text markers and remain visible when Media Guides are OFF.</p>
        <div class="rl-h3-media-counts" aria-label="Timeline counts"><span>Media ${counts.mediaCount}</span><span title="Enabled visual and audio channels count separately">References ${counts.referenceCount}</span><span>Placements ${counts.placementCount}</span>${counts.incompleteCount > 0 ? `<span class="is-error">Incomplete ${counts.incompleteCount}</span>` : ""}</div>
        <div data-h3-axis></div>
        ${this.#h3Editor ? `<div class="rl-time-axis__draft"><span>Unsaved Guide editor · Apply or Cancel</span><button type="button" data-h3-action="cancel-editor">Cancel</button><button type="button" data-h3-action="apply-editor"${issue ? " disabled" : ""}>Apply</button></div>${issue ? `<p class="rl-h3-editor__error" role="alert">${escapeHtml(issue)}</p>` : ""}` : ""}
        <details class="rl-time-axis__list"><summary>Placement details</summary><div class="rl-h3-summary-list" aria-label="Timeline placements">${expandedSummary || '<span class="rl-h3-summary__empty">No placements yet. Open a Media card to add one.</span>'}</div></details>
        ${!this.#h3Editor?.mediaId && this.#h3Editor && !this.#h3Editor.timelineEdit ? this.#h3RecoveryEditorMarkup(this.#h3Editor, issue) : ""}
      </div>
    </section>`
  }

  #mountH3Timeline(): void {
    const host = this.root.querySelector<HTMLElement>("[data-h3-axis]")
    if (!host) return
    this.#h3Axis?.destroy()
    const state = this.#h3Editor
      ? { ...this.state, h3Timeline: this.#h3EditorTimeline(this.#h3Editor) }
      : this.state
    this.#h3Axis = new H3Timeline(host, state, this.#runtime, this.#h3View, {
      shots: this.#promptShots,
      select: (placement, channel) => {
        if (this.#h3Editor?.timelineEdit && placement.guideId) {
          this.#h3Editor.selectedGuideId = placement.guideId
          this.#mountH3Timeline()
          return
        }
        const id = channel === "visual" ? placement.visualId : placement.audioId
        if (id) this.#openH3EditorForMedia(id, channel, placement.guideId, "edit", false, false)
        else if (placement.guideId) this.#openH3EditorForGuide(placement.guideId)
      },
      change: (id, frame) => this.#moveH3TimelineGuide(id, frame),
      remove: (id) => this.#removeH3TimelineGuide(id),
      selectShot: (tag) => this.#promptShotSelect?.(tag),
      changeShot: (tag, frame) => this.#promptShotChange?.(tag, frame),
      removeShot: (tag) => this.#promptShotRemove?.(tag),
      canDrop: (channel, dataTransfer) => Boolean(this.#h3GuideDragSource(channel, dataTransfer)),
      drop: (channel, frame, dataTransfer) =>
        this.#addH3GuideFromDrop(channel, frame, dataTransfer),
      settled: () => {
        if (this.#renderPending) this.render(true)
      },
    })
  }

  #moveH3TimelineGuide(id: string, frameIndex: number): void {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    let editor = this.#h3Editor
    if (!editor?.ownedGuideIds.has(id)) {
      if (editor && this.#h3EditorDirty()) {
        this.#status = "Apply or cancel the current Guide edit before moving another Guide."
        this.render(true)
        return
      }
      const timeline = cloneH3Timeline(this.state.h3Timeline)
      if (!timeline.guides.some((guide) => guide.id === id)) return
      editor = {
        mediaId: undefined,
        channel: "visual",
        timeline,
        initialTimeline: cloneH3Timeline(timeline),
        ownedGuideIds: new Set(timeline.guides.map((guide) => guide.id)),
        originalGuideFrames: new Map(timeline.guides.map((guide) => [guide.id, guide.frameIndex])),
        removedGuideIds: new Set(),
        allowTimelineOnly: true,
        timelineEdit: true,
        returnFocus: { guideId: id },
      }
      this.#h3Editor = editor
    }
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === id ? { ...guide, frameIndex } : guide,
      ),
    }
    // A timeline move carries both channels. Later card edits may detach from this new frame.
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    editor.draftError = undefined
    this.render(true)
    const mark = [...this.root.querySelectorAll<HTMLButtonElement>("[data-timeline-guide]")].find(
      (button) => button.dataset.timelineGuide === id,
    )
    mark?.focus({ preventScroll: true })
  }

  #h3GuideDragSource(
    channel: H3GuideChannel,
    dataTransfer: DataTransfer | null,
  ): { id: string; item: MediaItem } | undefined {
    const source =
      this.#drag ??
      (() => {
        const raw = dataTransfer?.getData(DRAG_MIME)
        if (!raw) return undefined
        try {
          const parsed = JSON.parse(raw) as { id?: unknown; channel?: unknown }
          return typeof parsed.id === "string" && typeof parsed.channel === "string"
            ? { id: parsed.id, channel: parsed.channel as LoaderChannel }
            : undefined
        } catch {
          return undefined
        }
      })()
    if (!source) return undefined
    const item = this.state.items[source.id]
    const expectedChannel =
      source.channel === "image" ? "visual" : source.channel === "audio" ? "audio" : undefined
    if (!item || expectedChannel !== channel || !canUseAsH3Guide(item, channel)) return undefined
    return { id: source.id, item }
  }

  #ensureH3TimelineEditor(): H3EditorState | undefined {
    if (this.#h3Editor) {
      if (this.#h3Editor.timelineEdit) return this.#h3Editor
      if (this.#h3EditorDirty()) {
        this.#status = "Apply or cancel the current Guide edit before changing Timeline Guides."
        this.render(true)
        return undefined
      }
    }
    const timeline = cloneH3Timeline(this.state.h3Timeline)
    this.#h3Editor = {
      mediaId: undefined,
      channel: "visual",
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds: new Set(timeline.guides.map((guide) => guide.id)),
      originalGuideFrames: new Map(timeline.guides.map((guide) => [guide.id, guide.frameIndex])),
      removedGuideIds: new Set(),
      allowTimelineOnly: true,
      timelineEdit: true,
    }
    this.#h3Collapsed = false
    return this.#h3Editor
  }

  #addH3GuideFromDrop(
    channel: H3GuideChannel,
    frameIndex: number,
    dataTransfer: DataTransfer | null,
  ): void {
    const source = this.#h3GuideDragSource(channel, dataTransfer)
    if (!source || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    const editor = this.#ensureH3TimelineEditor()
    if (!editor) return
    if (editor.timeline.guides.length >= 32) {
      this.#status = "Timeline supports at most 32 specific frame guides."
      this.render(true)
      return
    }
    const id = this.#newH3GuideId()
    const guide =
      channel === "visual"
        ? { id, frameIndex, visualId: source.id, audioId: null }
        : { id, frameIndex, visualId: null, audioId: source.id }
    const candidate = { ...editor.timeline, guides: [...editor.timeline.guides, guide] }
    const issue = validateH3Timeline(this.state, candidate, { allowIncomplete: true })[0]
    if (issue) {
      this.#status = issue
      this.render(true)
      return
    }
    editor.timeline = candidate
    editor.ownedGuideIds.add(id)
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    this.#status = `${itemFilename(source.item)} added as a ${channel === "visual" ? "visual" : "audio"} Guide at ${frameIndex}f. Apply to save.`
    this.render(true)
  }

  #removeH3TimelineGuide(id: string): void {
    const editor = this.#h3Editor
    if (
      !this.state.h3Timeline.guides.some((guide) => guide.id === id) &&
      !editor?.timeline.guides.some((guide) => guide.id === id)
    )
      return
    const timelineEditor = this.#ensureH3TimelineEditor()
    if (!timelineEditor) return
    timelineEditor.timeline = {
      ...timelineEditor.timeline,
      guides: timelineEditor.timeline.guides.filter((guide) => guide.id !== id),
    }
    timelineEditor.removedGuideIds.add(id)
    if (timelineEditor.selectedGuideId === id) timelineEditor.selectedGuideId = undefined
    this.#status = "Guide removed from the Timeline draft. Apply to save."
    this.render(true)
  }

  #h3PlacementMarkup(state: LoaderState, limit?: number): string {
    const placements = h3Placements(state.h3Timeline)
    const visible = limit === undefined ? placements : placements.slice(0, limit)
    return visible
      .map((placement) => {
        const sourceId = placement.visualId ?? placement.audioId ?? ""
        const channel: H3GuideChannel =
          placement.visualId !== null && placement.visualId !== undefined
            ? "visual"
            : placement.audioId !== null && placement.audioId !== undefined
              ? "audio"
              : "visual"
        const frame = placement.frameIndex
        const label =
          placement.kind === "start"
            ? "Start"
            : placement.kind === "end"
              ? "End"
              : typeof frame === "number" && Number.isInteger(frame) && frame >= 0
                ? `${frame}f · ${(frame / 24).toFixed(2)}s`
                : "Unspecified frame"
        const secondary = [
          placement.visualId ? this.#h3MediaLabel(placement.visualId, "visual") : "",
          placement.audioId ? this.#h3MediaLabel(placement.audioId, "audio") : "",
          !placement.visualId && !placement.audioId ? "Media needed" : "",
        ]
          .filter(Boolean)
          .join(" + ")
        return `<button type="button" class="rl-h3-summary-item${!sourceId ? " is-incomplete" : ""}" data-h3-action="select-placement" data-h3-media-id="${escapeHtml(sourceId)}" data-h3-channel="${channel}"${placement.guideId ? ` data-h3-guide-id="${escapeHtml(placement.guideId)}"` : ""} title="${sourceId ? "Open the connected Media card" : "Open incomplete Guide"}"><span class="rl-h3-summary-item__preview">${sourceId ? this.#h3PreviewMarkup(sourceId, channel) : "?"}</span><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(secondary)}</small></span></button>`
      })
      .join("")
  }

  #h3MediaLabel(mediaId: string, channel: H3GuideChannel): string {
    const parentId =
      channel === "audio" && mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.state.items[parentId]
    if (!item) return "Media needed"
    const kind = channel === "audio" ? "Audio" : item.kind === "video" ? "Video" : "Image"
    return `${kind} · ${itemFilename(item)}`
  }

  #h3PreviewMarkup(mediaId: string, channel: H3GuideChannel): string {
    const parentId =
      channel === "audio" && mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const previewUrl = this.#runtime.get(parentId)?.previewUrl
    if (channel === "visual" && previewUrl)
      return `<img src="${escapeHtml(previewUrl)}" alt="" draggable="false">`
    return `<span class="rl-h3-summary-item__icon" aria-hidden="true">${channel === "audio" ? "♫" : "▧"}</span>`
  }

  #channelMarkup(channel: LoaderChannel, label: string, order: string[]): string {
    let outputIndex = 0
    let guideIndex = 0
    const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
    const cards = order
      .map((id, position) => {
        const item = this.state.items[id]
        const referenceIndex =
          item && isChannelOutputEnabled(channel, item) ? ++outputIndex : undefined
        const guideIndexForItem =
          item &&
          canUseAsH3Guide(item, guideChannel) &&
          mediaGuideEnabled(
            this.state.h3Timeline,
            timelineMediaId(item, guideChannel),
            guideChannel,
          )
            ? ++guideIndex
            : undefined
        return this.#cardMarkup(channel, id, position + 1, referenceIndex, guideIndexForItem)
      })
      .join("")
    const accepts: Record<LoaderChannel, string> = {
      image: "image/*",
      video: "video/*",
      audio: "audio/*",
    }
    const hasOpenCell = order.length > 0 && order.length % this.state.ui.gridColumns !== 0
    const addLabel = `Add ${label.toLowerCase()}`
    const addControl = `<label class="rl-grid-add ${hasOpenCell ? "is-tile" : "is-wide"}" data-media-kind="${channel}" title="${addLabel}">
      <span class="rl-grid-add__icon" aria-hidden="true">+</span>${hasOpenCell ? "" : `<span>${addLabel}</span>`}
      <input type="file" accept="${accepts[channel]}" data-upload-kind="${channel}" multiple aria-label="${addLabel}">
    </label>`
    const descriptions: Record<LoaderChannel, string> = {
      image: "Image output and captions",
      video: "Video output and captions",
      audio: "Standalone and video sound",
    }
    return `<section class="rl-channel" data-channel="${channel}" aria-label="${label} references">
      <header><div><strong>${label}</strong><span>${order.length}</span></div><small>${descriptions[channel]}</small></header>
      <div class="rl-card-grid${cards ? "" : " is-empty"}" data-drop-zone="${channel}">${cards}${addControl}</div>
    </section>`
  }

  #cardMarkup(
    channel: LoaderChannel,
    id: string,
    replaceIndex: number,
    outputIndex?: number,
    guideIndex?: number,
  ): string {
    const item = this.state.items[id]
    if (!item) return ""
    const singleImage = this.#mode === "single-image"
    const showCaptions = showCaptionsProperty(this.#node)
    const runtime = this.#runtime.get(id)
    const selected = this.#selectedId === id
    const caption =
      item.kind === "video" && channel === "audio"
        ? (item.audioCaptionOverride ?? item.caption)
        : item.caption
    const media = this.#mediaMarkup(channel, item, runtime)
    const loading = runtime?.applyingEdit
      ? '<span class="rl-card__loading-overlay" role="status" aria-label="Applying image edit"><span class="rl-spinner" aria-hidden="true"></span></span>'
      : runtime?.loading
        ? `<span class="rl-spinner" title="Loading"></span>`
        : ""
    const error = runtime?.error
      ? `<p class="rl-card__error" role="alert">${escapeHtml(runtime.error)}</p>`
      : ""
    const imageEnabled = item.kind === "image" ? item.imageEnabled : false
    const videoEnabled = item.kind === "video" ? item.videoEnabled : false
    const silentVideo = item.kind === "video" && runtime?.metadata?.hasAudio === false
    const videoAudioEnabled = item.kind === "video" ? item.videoAudioEnabled && !silentVideo : false
    const audioEnabled = isAudioItem(item) ? item.audioEnabled : false
    const outputEnabled = isChannelOutputEnabled(channel, item)
    const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
    const guideMediaId = timelineMediaId(item, guideChannel)
    const guideAvailable = canUseAsH3Guide(item, guideChannel)
    const guideEnabled =
      guideAvailable && mediaGuideEnabled(this.state.h3Timeline, guideMediaId, guideChannel)
    const guideEditorActive =
      this.#h3Editor?.mediaId === guideMediaId && this.#h3Editor.channel === guideChannel
    const duration = durationLabel(item, runtime)
    const megapixels = megapixelLabel(item, runtime)
    const mediaFilename = itemFilename(item)
    const playbackOwner = `grid:${id}`
    const audioPlaybackActive =
      this.#audioPreview.snapshot.owner === playbackOwner &&
      (this.#audioPreview.snapshot.status === "playing" ||
        this.#audioPreview.snapshot.status === "loading")
    const videoPlaybackActive =
      this.#videoPreview.snapshot.owner === playbackOwner &&
      (this.#videoPreview.snapshot.status === "playing" ||
        this.#videoPreview.snapshot.status === "loading")
    const playbackDuration =
      item.kind === "image" ? undefined : (runtime?.metadata?.duration ?? item.crop?.end)
    const audioPlaybackDisabled = silentVideo || runtime?.loading || playbackDuration === undefined
    const videoPlaybackDisabled = runtime?.loading || playbackDuration === undefined
    const normalMediaMarkup = `<div class="rl-media-badges"><span class="rl-kind rl-kind--${item.kind}">${item.kind}</span>${outputIndex === undefined ? "" : `<span class="rl-output-index" title="${labelForCaption(channel)} output #${outputIndex}">#${outputIndex}</span>`}${guideIndex === undefined ? "" : `<span class="rl-guide-index" title="Guide #${guideIndex}">G#${guideIndex}</span>`}${megapixels ? `<span class="rl-megapixels" title="Current source resolution: ${megapixels}">${megapixels}</span>` : ""}${duration ? `<span class="rl-duration">${duration}</span>` : ""}</div><span class="rl-media-filename" title="${escapeHtml(mediaFilename)}">${escapeHtml(mediaFilename)}</span><button type="button" class="rl-remove" data-action="remove" aria-label="Remove reference" title="Delete reference">×</button>`
    const normalBodyMarkup = `${this.#guideBadgeMarkup(item, guideChannel, guideMediaId, outputIndex, guideIndex)}
        ${showCaptions ? `<textarea data-field="caption" rows="2" maxlength="16384" placeholder="Caption" aria-label="${labelForCaption(channel)} caption">${escapeHtml(caption)}</textarea>` : ""}
        <div class="rl-card__actions">
        ${!singleImage && channel === "image" && item.kind === "image" ? `<button type="button" data-action="toggle-image" class="rl-output-button${imageEnabled ? " is-on" : ""}" aria-label="Toggle image output" aria-pressed="${String(imageEnabled)}">I</button>` : ""}
        ${!singleImage && channel === "video" && item.kind === "video" ? `<button type="button" data-action="toggle-video" class="rl-output-button${videoEnabled ? " is-on" : ""}" aria-label="Toggle video output" aria-pressed="${String(videoEnabled)}">V</button>` : ""}
        ${!singleImage && channel === "video" && item.kind === "video" ? `<button type="button" data-action="toggle-video-audio" class="rl-output-button${videoAudioEnabled ? " is-on" : ""}" aria-label="Include embedded audio in video output" aria-pressed="${String(videoAudioEnabled)}" title="${silentVideo ? "No embedded audio track" : videoAudioEnabled ? "VIDEO output includes embedded audio" : "VIDEO output is muted"}"${silentVideo ? " disabled" : ""}>VA</button>` : ""}
        ${!singleImage && channel === "audio" && isAudioItem(item) ? `<button type="button" data-action="toggle-audio" class="rl-output-button${audioEnabled ? " is-on" : ""}" aria-label="Toggle audio output" aria-pressed="${String(audioEnabled)}"${silentVideo ? ' disabled title="No embedded audio track"' : ""}>A</button>` : ""}
        ${this.#guideButtonMarkup(item, channel)}
        ${channel === "video" && item.kind === "video" ? `<button type="button" data-action="preview-video" data-playback-owner="${escapeHtml(playbackOwner)}" class="rl-preview-media${videoPlaybackActive ? " is-playing" : ""}" aria-label="${videoPlaybackActive ? "Stop" : "Play"} video preview ${videoAudioEnabled ? "with audio" : "muted"}" title="${runtime?.loading || playbackDuration === undefined ? "Loading video preview" : videoPlaybackActive ? "Stop video preview" : videoAudioEnabled ? "Play trimmed video preview with audio" : "Play trimmed muted video preview"}"${videoPlaybackDisabled ? " disabled" : ""}>${videoPlaybackActive ? "■" : "▶"}</button>` : ""}
        ${channel === "audio" && isAudioItem(item) ? `<button type="button" data-action="preview-audio" data-playback-owner="${escapeHtml(playbackOwner)}" class="rl-preview-media${audioPlaybackActive ? " is-playing" : ""}" aria-label="${audioPlaybackActive ? "Stop" : "Play"} audio preview" title="${silentVideo ? "No embedded audio track" : runtime?.loading || playbackDuration === undefined ? "Loading audio preview" : audioPlaybackActive ? "Stop audio preview" : "Play trimmed audio preview"}"${audioPlaybackDisabled ? " disabled" : ""}>${audioPlaybackActive ? "■" : "▶"}</button>` : ""}
        ${singleImage ? "" : '<button type="button" data-action="move-back" aria-label="Move earlier" title="Move earlier (Alt+ArrowLeft)">←</button><button type="button" data-action="move-forward" aria-label="Move later" title="Move later (Alt+ArrowRight)">→</button>'}
        <span class="rl-edit-actions">${this.#guideEditButtonMarkup(item, channel)}<button type="button" class="rl-edit-button" data-action="edit" aria-label="${singleImage ? "Edit image" : "Edit reference"}" title="${singleImage ? "Edit image" : "Edit reference"}"${runtime?.applyingEdit ? " disabled" : ""}><span aria-hidden="true">R</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg></button></span>
        </div>
        ${error}`
    const cardContent = guideEditorActive
      ? `<div class="rl-h3-editor__background" aria-hidden="true"><div class="rl-card__media${channel === "image" && item.kind === "image" ? " is-transparent-preview" : ""}">${media}${loading}</div></div><div data-h3-react-media></div><div data-h3-react-body></div>`
      : `<div class="rl-card__media${channel === "image" && item.kind === "image" ? " is-transparent-preview" : ""}" title="Double-click to edit">${media}${normalMediaMarkup}${loading}</div><div class="rl-card__body">${normalBodyMarkup}</div>`
    return `<article class="rl-card${showCaptions && !guideEditorActive ? " rl-card--has-caption" : ""}${guideEditorActive ? " rl-card--h3-editor" : ""}${singleImage ? " rl-single-image-card" : ""}${selected ? " is-selected" : ""}${runtime?.error ? " has-error" : ""}${outputEnabled || guideEnabled ? "" : " is-output-disabled"}" data-id="${escapeHtml(id)}" data-channel="${channel}" data-media-kind="${item.kind}" data-replace-index="${replaceIndex}" data-output-enabled="${String(outputEnabled)}" data-guide-enabled="${String(guideEnabled || guideEditorActive)}" tabindex="0" draggable="${String(!singleImage && !guideEditorActive)}" aria-selected="${String(selected)}">${cardContent}</article>`
  }

  #guideBadgeMarkup(
    item: MediaItem,
    channel: H3GuideChannel,
    mediaId: string,
    referenceIndex?: number,
    guideIndex?: number,
  ): string {
    const labels: string[] = []
    const configured =
      canUseAsH3Guide(item, channel) && mediaHasGuide(this.state.h3Timeline, mediaId, channel)
    const active =
      canUseAsH3Guide(item, channel) && mediaGuideEnabled(this.state.h3Timeline, mediaId, channel)
    if (referenceIndex !== undefined) labels.push(`Ref #${referenceIndex}`)
    if (guideIndex !== undefined) labels.push(`Guide #${guideIndex}`)
    if (active) {
      if (channel === "visual" && this.state.h3Timeline.startImageId === mediaId)
        labels.push("Start")
      const frameLabels = this.state.h3Timeline.guides
        .filter((guide) => guideUsesMedia(guide, mediaId, channel))
        .sort((left, right) => left.frameIndex - right.frameIndex)
        .map((guide) => `${guide.frameIndex}f`)
      labels.push(...frameLabels)
      if (channel === "visual" && this.state.h3Timeline.endImageId === mediaId) labels.push("End")
    }
    if (configured && !active) labels.push("Guide off")
    else if (
      !this.state.h3Timeline.enabled &&
      labels.some((label) => /^\d+f$/.test(label) || label === "Start" || label === "End")
    )
      labels.push("Paused")
    if (labels.length === 0) return '<div class="rl-h3-card-badges" aria-hidden="true"></div>'
    return `<div class="rl-h3-card-badges" aria-label="Reference order and media roles">${labels.map((label) => `<span class="rl-h3-card-badge${label.startsWith("Ref #") ? " is-reference" : label.startsWith("Guide #") ? " is-guide" : /^\d+f$/.test(label) || label === "Start" || label === "End" ? " is-order" : label === "Paused" || label === "Guide off" ? " is-paused" : ""}">${escapeHtml(label)}</span>`).join("")}</div>`
  }

  #guideButtonMarkup(item: MediaItem, channel: LoaderChannel): string {
    if (this.#mode === "single-image") return ""
    const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
    const valid =
      (channel === "image" && item.kind === "image") ||
      (channel === "audio" && item.kind === "audio")
    if (!valid) return ""
    const mediaId = timelineMediaId(item, guideChannel)
    const configured = mediaHasGuide(this.state.h3Timeline, mediaId, guideChannel)
    const active = configured && mediaGuideEnabled(this.state.h3Timeline, mediaId, guideChannel)
    return `<button type="button" data-action="toggle-h3-guide" data-id="${escapeHtml(item.id)}" data-h3-channel="${guideChannel}" class="rl-guide-button${active ? " is-on" : ""}" aria-label="Toggle Guide usage" aria-pressed="${String(active)}" title="${active ? "Disable Guide usage for this media" : configured ? "Enable saved Guide placements for this media" : "Enable Guide usage and choose a frame"}">G</button>`
  }

  #guideEditButtonMarkup(item: MediaItem, channel: LoaderChannel): string {
    if (this.#mode === "single-image") return ""
    const guideChannel: H3GuideChannel = channel === "audio" ? "audio" : "visual"
    if (!canUseAsH3Guide(item, guideChannel)) return ""
    const mediaId = timelineMediaId(item, guideChannel)
    const active = this.#h3Editor?.mediaId === mediaId && this.#h3Editor.channel === guideChannel
    return `<button type="button" class="rl-edit-button rl-edit-button--guide${active ? " is-on" : ""}" data-action="edit-h3-guide" data-id="${escapeHtml(item.id)}" data-h3-channel="${guideChannel}" aria-label="Edit Guide placements" title="Edit Guide placements"><span aria-hidden="true">G</span><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg></button>`
  }

  #mountH3GuideEditor(): void {
    const editor = this.#h3Editor
    const media = this.root.querySelector<HTMLElement>("[data-h3-react-media]")
    const body = this.root.querySelector<HTMLElement>("[data-h3-react-body]")
    if (!editor?.mediaId || !media || !body) {
      this.#h3ReactEditor?.view.destroy()
      this.#h3ReactEditor = undefined
      return
    }
    this.#h3ReactEditor ??= { session: editor, view: createH3GuideEditor() }
    // Move the same containers back into the rebuilt board. React retains the
    // keyed fields and the add form; the native renderer never edits their DOM.
    media.replaceWith(this.#h3ReactEditor.view.media)
    body.replaceWith(this.#h3ReactEditor.view.body)
    this.#updateH3GuideEditor()
  }

  #updateH3GuideEditor(): void {
    const editor = this.#h3Editor
    const mounted = this.#h3ReactEditor
    if (!editor?.mediaId || mounted?.session !== editor) return
    const item = this.state.items[editor.mediaId]
    if (!item) return
    mounted.view.update({
      sourceLabel: itemFilename(item),
      channel: editor.channel,
      start: editor.channel === "visual" && editor.timeline.startImageId === editor.mediaId,
      end: editor.channel === "visual" && editor.timeline.endImageId === editor.mediaId,
      guides: this.#h3EditorGuides(editor).map((guide) => {
        const pairedId = editor.channel === "visual" ? guide.audioId : guide.visualId
        return {
          id: guide.id,
          frameIndex: guide.frameIndex,
          pairedLabel: pairedId
            ? this.#h3MediaLabel(pairedId, editor.channel === "visual" ? "audio" : "visual")
            : undefined,
        }
      }),
      atGuideLimit: editor.timeline.guides.length >= 32,
      issue: this.#h3DraftIssue(editor),
      addError: editor.draftError,
      onAdd: (position, frame) => this.#addH3DraftPlacement(position, frame),
      onRemoveRole: (role) => this.#removeH3DraftRole(role),
      onRemoveGuide: (id) => this.#deleteH3DraftPlacement(id),
      onInputFrame: (id, value) => {
        this.#inputH3DraftFrame(id, value)
        this.#updateH3GuideEditor()
      },
      onCommitFrame: (id, value) => this.#commitH3DraftFrame(id, value),
      onApply: () => this.#applyH3Editor(),
      onCancel: () => this.#closeH3Editor(),
    })
  }

  #h3RecoveryEditorMarkup(editor: H3EditorState, issue?: string): string {
    const guides = [...editor.ownedGuideIds]
      .map((id) => editor.timeline.guides.find((guide) => guide.id === id))
      .filter((guide): guide is NonNullable<typeof guide> => guide !== undefined)
      .map((guide) => this.#h3RecoveryGuideMarkup(guide))
      .join("")
    return `<section class="rl-h3-editor rl-h3-editor--recovery" data-h3-editor aria-label="Recover incomplete Timeline Guide"><div class="rl-h3-editor__header"><span class="rl-h3-editor__title">Recover incomplete Guide</span><button type="button" data-h3-action="cancel-editor" aria-label="Cancel Guide edit" title="Cancel Guide edit">×</button></div><p class="rl-h3-editor__hint">Choose the missing Image or standalone Audio source, or delete this incomplete Guide.</p><div class="rl-h3-editor__stack"><div class="rl-h3-editor__placements">${guides || '<p class="rl-h3-editor__empty">No incomplete Guide selected.</p>'}</div></div>${issue ? `<p class="rl-h3-editor__error" role="alert" data-h3-editor-error>${escapeHtml(issue)}</p>` : ""}<div class="rl-h3-editor__actions"><button type="button" data-h3-action="cancel-editor">Cancel</button><button type="button" data-h3-action="apply-editor"${issue ? " disabled" : ""}>Apply</button></div></section>`
  }

  #h3EditorGuides(editor: H3EditorState) {
    return [...editor.ownedGuideIds]
      .map((id) => editor.timeline.guides.find((guide) => guide.id === id))
      .filter((guide): guide is NonNullable<typeof guide> => guide !== undefined)
      .filter((guide) => guideUsesMedia(guide, editor.mediaId ?? "", editor.channel))
      .sort((left, right) => {
        if (!Number.isInteger(left.frameIndex) || !Number.isInteger(right.frameIndex)) return 0
        return left.frameIndex - right.frameIndex
      })
  }

  #h3RecoveryGuideMarkup(guide: {
    id: string
    frameIndex: number
    visualId: string | null
    audioId: string | null
  }): string {
    const visualOptions = this.#h3VisualOptions(guide.visualId)
    const audioOptions = this.#h3AudioOptions(guide.audioId)
    return `<article class="rl-h3-editor__placement rl-h3-editor__stack-row" data-h3-guide-id="${escapeHtml(guide.id)}"><div class="rl-h3-editor__placement-heading"><label><span>Frame</span><input type="number" min="0" step="1" value="${Number.isInteger(guide.frameIndex) ? String(guide.frameIndex) : ""}" data-h3-draft-field="frame" data-h3-guide-id="${escapeHtml(guide.id)}" aria-describedby="h3-frame-${escapeHtml(guide.id)}"></label><span id="h3-frame-${escapeHtml(guide.id)}" class="rl-h3-editor__seconds">${Number.isInteger(guide.frameIndex) ? `${(guide.frameIndex / 24).toFixed(2)}s` : ""}</span><button type="button" data-h3-action="delete-draft-placement" data-h3-delete-mode="entry" data-h3-guide-id="${escapeHtml(guide.id)}" aria-label="Delete incomplete Guide" title="Delete incomplete Guide">×</button></div><label><span>Visual source</span><select data-h3-draft-field="visual" data-h3-guide-id="${escapeHtml(guide.id)}">${visualOptions}</select></label><label><span>Audio source</span><select data-h3-draft-field="audio" data-h3-guide-id="${escapeHtml(guide.id)}">${audioOptions}</select></label></article>`
  }

  #h3VisualOptions(selected: string | null): string {
    const options = [`<option value="">None</option>`]
    for (const id of [...this.state.imageOrder, ...this.state.videoOrder]) {
      const item = this.state.items[id]
      if (!item || item.kind !== "image") continue
      options.push(
        `<option value="${escapeHtml(id)}"${selected === id ? " selected" : ""}>Image · ${escapeHtml(itemFilename(item))}</option>`,
      )
    }
    return options.join("")
  }

  #h3AudioOptions(selected: string | null): string {
    const options = [`<option value="">None</option>`]
    for (const id of this.state.audioOrder) {
      const item = this.state.items[id]
      if (!item || item.kind !== "audio") continue
      const sourceId = timelineMediaId(item, "audio")
      options.push(
        `<option value="${escapeHtml(sourceId)}"${selected === sourceId ? " selected" : ""}>Audio · ${escapeHtml(itemFilename(item))}</option>`,
      )
    }
    return options.join("")
  }

  #h3DraftIssue(editor: H3EditorState): string | undefined {
    if (!editor.mediaId && !editor.allowTimelineOnly)
      return "Choose a Media source before applying."
    if (!editor.mediaId)
      return validateH3Timeline(this.state, editor.timeline, { allowIncomplete: true })[0]
    const parentId = editor.mediaId.endsWith(":audio")
      ? editor.mediaId.slice(0, -6)
      : editor.mediaId
    const item = this.state.items[parentId]
    if (!item) return "The selected Media source is no longer available."
    if (!canUseAsH3Guide(item, editor.channel)) return "Video cannot be used as an H3 Guide source."
    if (
      twoImageModeProperty(this.#node) &&
      editor.channel === "visual" &&
      item.kind === "image" &&
      !item.imageEnabled &&
      this.#activeImageCount() >= 2
    )
      return "Two-image mode permits at most two enabled Images."
    const candidate = this.#h3EditorTimeline(editor)
    const hasGuide = mediaHasGuide(candidate, editor.mediaId, editor.channel)
    if (editor.requireGuide && !hasGuide) return "Add a frame placement or select Start/End."
    return validateH3Timeline(this.state, candidate, { allowIncomplete: true })[0]
  }

  #mediaMarkup(channel: LoaderChannel, item: MediaItem, runtime: ItemRuntime | undefined): string {
    if ((channel === "image" || channel === "video") && runtime?.previewUrl) {
      return `<img src="${escapeHtml(runtime.previewUrl)}" alt="" draggable="false">`
    }
    if (channel === "audio" && (item.kind === "audio" || item.kind === "video")) {
      const noAudioTrack = item.kind === "video" && runtime?.metadata?.hasAudio === false
      const silent = !noAudioTrack && isSilentWaveform(runtime?.waveform)
      const status = noAudioTrack ? "No audio track" : silent ? "Silent" : undefined
      return `<canvas data-waveform-id="${escapeHtml(item.id)}" aria-label="${status ? `${status} waveform` : "Waveform"}"></canvas>${status ? `<span class="rl-waveform-status" aria-hidden="true">${status}</span>` : ""}`
    }
    return `<div class="rl-placeholder" aria-hidden="true">▧</div>`
  }

  #drawWaveforms(): void {
    for (const canvas of this.root.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-waveform-id]",
    )) {
      const id = canvas.dataset.waveformId
      if (id) drawWaveform(canvas, this.#runtime.get(id)?.waveform ?? [])
    }
  }

  #syncPlaybackUi(): void {
    if (this.#destroyed) return
    const audioSnapshot = this.#audioPreview.snapshot
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      'button[data-action="preview-audio"]',
    )) {
      if (button.disabled) continue
      const active =
        button.dataset.playbackOwner === audioSnapshot.owner &&
        (audioSnapshot.status === "playing" || audioSnapshot.status === "loading")
      button.textContent = active ? "■" : "▶"
      button.classList.toggle("is-playing", active)
      button.setAttribute("aria-label", `${active ? "Stop" : "Play"} audio preview`)
      button.title = active ? "Stop audio preview" : "Play trimmed audio preview"
    }
    const videoSnapshot = this.#videoPreview.snapshot
    let activeMedia: HTMLElement | undefined
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      'button[data-action="preview-video"]',
    )) {
      if (button.disabled) continue
      const active =
        button.dataset.playbackOwner === videoSnapshot.owner &&
        (videoSnapshot.status === "playing" || videoSnapshot.status === "loading")
      button.textContent = active ? "■" : "▶"
      button.classList.toggle("is-playing", active)
      const card = button.closest<HTMLElement>('.rl-card[data-channel="video"]')
      const id = card?.dataset.id
      const item = id ? this.state.items[id] : undefined
      const withAudio = item?.kind === "video" && item.videoAudioEnabled
      button.setAttribute(
        "aria-label",
        `${active ? "Stop" : "Play"} video preview ${withAudio ? "with audio" : "muted"}`,
      )
      button.title = active
        ? "Stop video preview"
        : withAudio
          ? "Play trimmed video preview with audio"
          : "Play trimmed muted video preview"
      if (active)
        activeMedia =
          button.closest<HTMLElement>(".rl-card")?.querySelector<HTMLElement>(".rl-card__media") ??
          undefined
    }
    if (activeMedia) {
      activeMedia.querySelector("img")?.classList.add("is-video-poster-hidden")
      if (this.#videoPreview.element.parentElement !== activeMedia)
        activeMedia.prepend(this.#videoPreview.element)
    } else {
      this.#videoPreview.element.remove()
      for (const poster of this.root.querySelectorAll("img.is-video-poster-hidden")) {
        poster.classList.remove("is-video-poster-hidden")
      }
    }
  }

  #installEvents(): void {
    const signal = this.#destroyController.signal
    this.root.addEventListener("click", (event) => this.#onClick(event), { signal })
    this.root.addEventListener("dblclick", (event) => this.#onDoubleClick(event), { signal })
    this.root.addEventListener("input", (event) => this.#onInput(event), { signal })
    this.root.addEventListener("change", (event) => this.#onChange(event), { signal })
    this.root.addEventListener("compositionstart", () => (this.#composing = true), { signal })
    this.root.addEventListener(
      "compositionend",
      () => {
        this.#composing = false
      },
      { signal },
    )
    this.root.addEventListener(
      "focusout",
      () => {
        setTimeout(() => {
          const snapshot = this.root.querySelector<HTMLElement>(".rl-snapshot")
          if (
            this.#snapshotMenuOpen &&
            document.activeElement instanceof Node &&
            !snapshot?.contains(document.activeElement)
          )
            this.#setSnapshotMenu(false)
          if (
            this.#renderPending &&
            !(
              (document.activeElement instanceof HTMLTextAreaElement ||
                document.activeElement instanceof HTMLInputElement ||
                document.activeElement instanceof HTMLSelectElement) &&
              this.root.contains(document.activeElement) &&
              (document.activeElement instanceof HTMLTextAreaElement ||
                Boolean(document.activeElement.closest("[data-h3-editor]")))
            )
          ) {
            this.render()
          }
        }, 0)
      },
      { signal },
    )
    this.root.addEventListener("keydown", (event) => this.#onKeydown(event), { signal })
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (
          this.#snapshotMenuOpen &&
          event.target instanceof Node &&
          !this.root.querySelector(".rl-snapshot")?.contains(event.target)
        )
          this.#setSnapshotMenu(false)
      },
      { capture: true, signal },
    )
    this.root.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target as Element
        const card = target.closest<HTMLElement>(".rl-card")
        const interactive = target.closest(
          "button, textarea, input, select, a, [contenteditable='true']",
        )
        this.#armedDrag =
          !interactive && card?.dataset.id && card.dataset.channel
            ? { id: card.dataset.id, channel: card.dataset.channel as LoaderChannel }
            : undefined
      },
      { signal },
    )
    this.root.addEventListener(
      "pointerup",
      () => {
        if (!this.#drag) this.#armedDrag = undefined
      },
      { signal },
    )
    this.root.addEventListener("dragstart", (event) => this.#onDragStart(event), { signal })
    this.root.addEventListener(
      "dragend",
      () => {
        this.#clearDropTarget()
        this.#drag = undefined
        this.#armedDrag = undefined
        this.root.classList.remove("is-dragging", "is-file-dragging")
        this.#setFileDropGuide(null)
        this.#setFileDropTarget(undefined)
      },
      { signal },
    )
    this.root.addEventListener(
      "dragover",
      (event) => {
        const fileDrop = this.acceptsFileDrop(event.dataTransfer)
        if (!fileDrop && !this.#drag) return
        event.preventDefault()
        this.root.classList.toggle("is-file-dragging", fileDrop)
        this.#setFileDropGuide(fileDrop ? event.dataTransfer : null)
        this.#updateFileDropTarget(fileDrop ? event : undefined)
        if (event.dataTransfer) event.dataTransfer.dropEffect = fileDrop ? "copy" : "move"
        this.#updateDropTarget(event)
      },
      { signal },
    )
    this.root.addEventListener(
      "dragleave",
      (event) => {
        const related = event.relatedTarget
        if (!(related instanceof Node) || !this.root.contains(related)) {
          this.#clearDropTarget()
          this.root.classList.remove("is-file-dragging")
          this.#setFileDropGuide(null)
          this.#setFileDropTarget(undefined)
        }
      },
      { signal },
    )
    this.root.addEventListener("drop", (event) => this.#onDrop(event), { signal })
  }

  #onClick(event: MouseEvent): void {
    if (isH3ReactEvent(event)) return
    const h3Button = (event.target as Element).closest<HTMLElement>("[data-h3-action]")
    if (h3Button && this.root.contains(h3Button)) {
      this.#onH3Click(h3Button)
      return
    }
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]")
    if (!button) {
      const card = (event.target as Element).closest<HTMLElement>(".rl-card")
      if (card?.dataset.id && !(event.target instanceof HTMLTextAreaElement)) {
        this.#selectItem(card.dataset.id)
      }
      return
    }
    const card = button.closest<HTMLElement>(".rl-card")
    const id = card?.dataset.id || button.dataset.id
    const channel = (card?.dataset.channel || button.dataset.channel) as LoaderChannel | undefined
    switch (button.dataset.action) {
      case "snapshot-menu":
        this.#setSnapshotMenu(!this.#snapshotMenuOpen, this.#snapshotMenuOpen ? undefined : "first")
        return
      case "snapshot-save":
        this.#setSnapshotMenu(false)
        try {
          this.#changeEvents.saveSnapshot?.()
          this.#status = "Snapshot saved."
        } catch (error) {
          this.#status = error instanceof Error ? error.message : "Snapshot could not be saved."
        }
        this.render(true)
        return
      case "snapshot-load":
        this.#setSnapshotMenu(false)
        this.root.querySelector<HTMLInputElement>("[data-snapshot-input]")?.click()
        return
      case "undo":
        if (!this.#store.canUndo) return
        this.#recordGraphChange(() => {
          this.#store.undo()
        })
        this.#changed(true)
        return
      case "redo":
        if (!this.#store.canRedo) return
        this.#recordGraphChange(() => {
          this.#store.redo()
        })
        this.#changed(true)
        return
      case "clear":
        this.#clearAll()
        return
      case "remove":
        if (id && this.#audioPreview.snapshot.owner === `grid:${id}`) this.#audioPreview.stop()
        if (id && this.#videoPreview.snapshot.owner === `grid:${id}`) this.#videoPreview.stop()
        if (id) {
          this.#runtime.delete(id)
          this.#dispatch({ type: "remove", id })
        }
        return
      case "toggle-image":
        if (id) this.#toggleOutput(id, "image")
        return
      case "toggle-video":
        if (id) this.#toggleOutput(id, "video")
        return
      case "toggle-video-audio":
        if (id) this.#toggleVideoAudio(id)
        return
      case "toggle-audio":
        if (id) this.#toggleOutput(id, "audio")
        return
      case "toggle-h3-guide":
        if (id) this.#toggleH3Guide(id, button.dataset.h3Channel as H3GuideChannel | undefined)
        return
      case "edit-h3-guide":
        if (id) this.#openH3Editor(id, button.dataset.h3Channel as H3GuideChannel | undefined)
        return
      case "preview-audio":
        if (id) void this.#toggleAudioPreview(id)
        return
      case "preview-video":
        if (id) void this.#toggleVideoPreview(id)
        return
      case "move-back":
      case "move-forward":
        if (id && channel)
          this.#dispatch({
            type: "move",
            id,
            channel,
            delta: button.dataset.action === "move-back" ? -1 : 1,
          })
        return
      case "edit":
        if (id) void this.#editItem(id, channel)
    }
  }

  #onH3Click(target: HTMLElement): void {
    const action = target.dataset.h3Action
    if (!action) return
    if (action === "collapse") {
      this.#h3Collapsed = !this.#h3Collapsed
      this.render(true)
      return
    }
    if (action === "toggle") {
      this.#dispatch({ type: "toggle-h3-timeline", enabled: !this.state.h3Timeline.enabled })
      return
    }
    if (action === "toggle-summary") {
      this.#h3SummaryExpanded = !this.#h3SummaryExpanded
      this.render(true)
      return
    }
    if (action === "cancel-editor") {
      this.#closeH3Editor()
      return
    }
    if (action === "apply-editor") {
      this.#applyH3Editor()
      return
    }
    if (action === "delete-draft-placement" && target.dataset.h3GuideId) {
      this.#deleteH3DraftPlacement(target.dataset.h3GuideId)
      return
    }
    if (action === "select-placement") {
      const mediaId = target.dataset.h3MediaId
      const channel = target.dataset.h3Channel as H3GuideChannel | undefined
      if (!channel) return
      if (!mediaId && target.dataset.h3GuideId) {
        this.#openH3EditorForGuide(target.dataset.h3GuideId)
        return
      }
      if (!mediaId) return
      this.#openH3EditorForMedia(mediaId, channel, target.dataset.h3GuideId)
    }
  }

  #openH3Editor(id: string, channel?: H3GuideChannel): void {
    const item = this.state.items[id]
    if (!item) return
    const resolvedChannel: H3GuideChannel = channel ?? (item.kind === "audio" ? "audio" : "visual")
    this.#openH3EditorForMedia(
      timelineMediaId(item, resolvedChannel),
      resolvedChannel,
      undefined,
      "edit",
    )
  }

  #openH3EditorForMedia(
    mediaId: string,
    channel: H3GuideChannel,
    guideId?: string,
    control: "toggle" | "edit" = "edit",
    requireGuide = false,
    focusGuide = true,
  ): void {
    if (!this.#canSwitchH3Editor(mediaId, channel)) return
    if (this.#h3Editor?.mediaId === mediaId && this.#h3Editor.channel === channel) {
      if (guideId) {
        this.#h3Editor.selectedGuideId = guideId
        if (focusGuide) this.#focusH3EditorGuide(guideId)
      }
      this.#mountH3Timeline()
      return
    }
    const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.state.items[itemId]
    if (!item || !canUseAsH3Guide(item, channel)) {
      this.#status = "The selected Timeline source is unavailable."
      this.render(true)
      return
    }
    const timeline = cloneH3Timeline(this.state.h3Timeline)
    const ownedGuideIds = new Set(
      timeline.guides
        .filter((guide) => guideUsesMedia(guide, mediaId, channel))
        .map((guide) => guide.id),
    )
    this.#h3View.selectedId = guideId ?? [...ownedGuideIds][0]
    if (guideId) ownedGuideIds.add(guideId)
    this.#h3Editor = {
      mediaId,
      channel,
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds,
      originalGuideFrames: new Map(
        timeline.guides.map((guide) => [guide.id, guide.frameIndex] as const),
      ),
      removedGuideIds: new Set(),
      ...(requireGuide ? { requireGuide: true } : {}),
      ...(guideId ? { selectedGuideId: guideId } : {}),
      returnFocus: { mediaId, channel, control },
    }
    this.#selectedId = item.id
    this.#h3Collapsed = false
    this.render(true)
    if (guideId && focusGuide) this.#focusH3EditorGuide(guideId)
  }

  #openH3EditorForGuide(guideId: string): void {
    if (
      this.#h3Editor &&
      !(this.#h3Editor.mediaId === undefined && this.#h3Editor.selectedGuideId === guideId) &&
      this.#h3EditorDirty()
    ) {
      this.#status = "Apply or cancel the current Guide edit before opening another Guide."
      this.render(true)
      return
    }
    const guide = this.state.h3Timeline.guides.find((candidate) => candidate.id === guideId)
    if (!guide) return
    const timeline = cloneH3Timeline(this.state.h3Timeline)
    this.#h3Editor = {
      mediaId: undefined,
      channel: guide.visualId !== null ? "visual" : "audio",
      timeline,
      initialTimeline: cloneH3Timeline(timeline),
      ownedGuideIds: new Set([guideId]),
      originalGuideFrames: new Map([[guide.id, guide.frameIndex]]),
      selectedGuideId: guideId,
      removedGuideIds: new Set(),
      allowTimelineOnly: true,
      returnFocus: { guideId },
    }
    this.#h3Collapsed = false
    this.render(true)
    this.#focusH3EditorGuide(guideId)
  }

  #focusH3EditorGuide(guideId: string): void {
    for (const row of this.root.querySelectorAll<HTMLElement>(
      "[data-h3-editor] [data-h3-guide-id]",
    )) {
      if (row.dataset.h3GuideId !== guideId) continue
      row.scrollIntoView?.({ block: "nearest" })
      row.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.focus()
      return
    }
  }

  #h3EditorDirty(): boolean {
    const editor = this.#h3Editor
    return Boolean(
      editor && JSON.stringify(editor.timeline) !== JSON.stringify(editor.initialTimeline),
    )
  }

  #canSwitchH3Editor(mediaId: string | undefined, channel: H3GuideChannel): boolean {
    const editor = this.#h3Editor
    if (!editor || (editor.mediaId === mediaId && editor.channel === channel)) return true
    if (!this.#h3EditorDirty()) return true
    this.#status = "Apply or cancel the current Guide edit before opening another Guide."
    this.render(true)
    return false
  }

  #toggleH3Guide(id: string, channel?: H3GuideChannel): void {
    const item = this.state.items[id]
    if (!item || !channel || !canUseAsH3Guide(item, channel)) return
    const mediaId = timelineMediaId(item, channel)
    if (!this.#canSwitchH3Editor(mediaId, channel)) return
    const configured = mediaHasGuide(this.state.h3Timeline, mediaId, channel)
    if (!configured) {
      this.#openH3EditorForMedia(mediaId, channel, undefined, "toggle", true)
      return
    }
    const active = mediaGuideEnabled(this.state.h3Timeline, mediaId, channel)
    const timeline = setMediaGuideEnabled(
      cloneH3Timeline(this.state.h3Timeline),
      mediaId,
      channel,
      !active,
    )
    this.#status = `${itemFilename(item)} Guide usage ${active ? "disabled" : "enabled"}.`
    this.#dispatch({
      type: "apply-h3-media-edit",
      mediaId,
      channel,
      referenceEnabled: referenceEnabled(item, channel),
      timeline,
      twoImageMode: twoImageModeProperty(this.#node),
    })
  }

  #newH3GuideId(): string {
    return `guide-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`
  }

  #addH3DraftPlacement(position: H3GuidePosition, frame: string): void {
    const editor = this.#h3Editor
    if (!editor?.mediaId) return
    editor.draftError = undefined
    if (position === "start" || position === "end") {
      if (editor.channel !== "visual") {
        editor.draftError = "Only an Image can be used for Start or End."
      } else {
        const role = position === "start" ? "startImageId" : "endImageId"
        const label = position === "start" ? "Start" : "End"
        const current = editor.timeline[role]
        if (current === editor.mediaId) editor.draftError = `${label} is already connected.`
        else if (current !== null)
          editor.draftError = `${label} is already assigned to ${this.#h3MediaLabel(current, "visual")}.`
        else {
          editor.timeline = { ...editor.timeline, [role]: editor.mediaId }
        }
      }
      this.render(true)
      return
    }
    if (position !== "guide") return
    if (editor.timeline.guides.length >= 32) {
      editor.draftError = "Timeline supports at most 32 specific frame guides."
      this.render(true)
      return
    }
    const rawFrame = frame.trim()
    const frameIndex = rawFrame === "" ? Number.NaN : Number(rawFrame)
    if (rawFrame === "") editor.draftError = "Enter a non-negative integer output frame."
    else if (!Number.isInteger(frameIndex) || frameIndex < 0)
      editor.draftError = "Output frame must be a non-negative integer."
    if (editor.draftError) {
      this.render(true)
      return
    }
    const id = this.#newH3GuideId()
    const guide =
      editor.channel === "visual"
        ? { id, frameIndex, visualId: editor.mediaId, audioId: null }
        : { id, frameIndex, visualId: null, audioId: editor.mediaId }
    const candidate = { ...editor.timeline, guides: [...editor.timeline.guides, guide] }
    const issue = validateH3Timeline(this.state, candidate, { allowIncomplete: true })[0]
    if (issue) {
      editor.draftError = issue
      this.render(true)
      return
    }
    editor.timeline = candidate
    editor.ownedGuideIds.add(id)
    editor.originalGuideFrames.set(id, frameIndex)
    editor.selectedGuideId = id
    this.render(true)
  }

  #deleteH3DraftPlacement(id: string): void {
    const editor = this.#h3Editor
    if (!editor) return
    if (!editor.mediaId) {
      editor.timeline = {
        ...editor.timeline,
        guides: editor.timeline.guides.filter((guide) => guide.id !== id),
      }
      editor.removedGuideIds.add(id)
      if (editor.selectedGuideId === id) editor.selectedGuideId = undefined
      this.render(true)
      return
    }
    const guide = editor.timeline.guides.find((candidate) => candidate.id === id)
    if (!guide || !guideUsesMedia(guide, editor.mediaId, editor.channel)) return
    const detached =
      editor.channel === "visual" ? { ...guide, visualId: null } : { ...guide, audioId: null }
    editor.timeline = {
      ...editor.timeline,
      guides:
        detached.visualId === null && detached.audioId === null
          ? editor.timeline.guides.filter((candidate) => candidate.id !== id)
          : editor.timeline.guides.map((candidate) => (candidate.id === id ? detached : candidate)),
    }
    if (detached.visualId === null && detached.audioId === null) editor.removedGuideIds.add(id)
    else editor.removedGuideIds.delete(id)
    if (editor.selectedGuideId === id) editor.selectedGuideId = undefined
    this.render(true)
  }

  #removeH3DraftRole(role: "start" | "end"): void {
    const editor = this.#h3Editor
    if (!editor?.mediaId || editor.channel !== "visual") return
    const key = role === "start" ? "startImageId" : "endImageId"
    if (editor.timeline[key] !== editor.mediaId) return
    editor.timeline = { ...editor.timeline, [key]: null }
    this.render(true)
  }

  #renderH3PreservingFocus(focusGuideId?: string): void {
    const active = document.activeElement
    const field =
      active instanceof HTMLInputElement || active instanceof HTMLSelectElement
        ? active.dataset.h3DraftField
        : undefined
    const guideId =
      active instanceof HTMLInputElement || active instanceof HTMLSelectElement
        ? active.dataset.h3GuideId
        : undefined
    this.render(true)
    if (field) {
      for (const element of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "[data-h3-draft-field]",
      )) {
        if (element.dataset.h3DraftField === field && element.dataset.h3GuideId === guideId) {
          element.focus()
          return
        }
      }
    }
    if (focusGuideId) {
      for (const input of this.root.querySelectorAll<HTMLInputElement>(
        '[data-h3-draft-field="frame"]',
      )) {
        if (input.dataset.h3GuideId === focusGuideId) {
          input.focus()
          break
        }
      }
    }
  }

  #closeH3Editor(): void {
    const focus = this.#h3Editor?.returnFocus
    this.#h3Editor = undefined
    this.render(true)
    if (focus?.mediaId && focus.channel) {
      const parentId = focus.mediaId.endsWith(":audio") ? focus.mediaId.slice(0, -6) : focus.mediaId
      const action = focus.control === "toggle" ? "toggle-h3-guide" : "edit-h3-guide"
      for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
        if (
          button.dataset.action === action &&
          button.dataset.id === parentId &&
          button.dataset.h3Channel === focus.channel
        ) {
          button.focus()
          break
        }
      }
    } else if (focus?.guideId) {
      const marker = [
        ...this.root.querySelectorAll<HTMLButtonElement>("[data-timeline-guide]"),
      ].find((button) => button.dataset.timelineGuide === focus.guideId)
      if (marker) {
        marker.focus({ preventScroll: true })
        return
      }
      for (const button of this.root.querySelectorAll<HTMLButtonElement>(
        '[data-h3-action="select-placement"]',
      )) {
        if (button.dataset.h3GuideId === focus.guideId) {
          button.focus()
          break
        }
      }
    }
  }

  #onH3DraftChange(target: HTMLInputElement | HTMLSelectElement): void {
    const editor = this.#h3Editor
    if (!editor) return
    const field = target.dataset.h3DraftField
    const guideId = target.dataset.h3GuideId
    if (field === "visual" || field === "audio") {
      if (!guideId || !(target instanceof HTMLSelectElement)) return
      const value = target.value || null
      editor.timeline = {
        ...editor.timeline,
        guides: editor.timeline.guides.map((guide) =>
          guide.id === guideId
            ? field === "visual"
              ? { ...guide, visualId: value }
              : { ...guide, audioId: value }
            : guide,
        ),
      }
      const changedGuide = editor.timeline.guides.find((guide) => guide.id === guideId)
      if (changedGuide && changedGuide.visualId === null && changedGuide.audioId === null)
        editor.removedGuideIds.add(guideId)
      else editor.removedGuideIds.delete(guideId)
      this.#renderH3PreservingFocus()
      return
    }
    if (field === "frame" && guideId && target instanceof HTMLInputElement)
      this.#commitH3DraftFrame(guideId, target.value)
  }

  #inputH3DraftFrame(guideId: string, value: string): void {
    const editor = this.#h3Editor
    if (!editor) return
    const frameIndex = value === "" ? Number.NaN : Number(value)
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === guideId ? { ...guide, frameIndex } : guide,
      ),
    }
    this.#mountH3Timeline()
  }

  #commitH3DraftFrame(guideId: string, value: string): void {
    const editor = this.#h3Editor
    if (!editor) return
    const rawFrame = value.trim()
    const frameIndex = rawFrame === "" ? Number.NaN : Number(rawFrame)
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      editor.draftError = "Output frame must be a non-negative integer."
      this.#renderH3PreservingFocus()
      return
    }
    const guide = editor.timeline.guides.find((candidate) => candidate.id === guideId)
    if (!guide) return
    if (!editor.mediaId) {
      editor.timeline = {
        ...editor.timeline,
        guides: editor.timeline.guides.map((candidate) =>
          candidate.id === guideId ? { ...candidate, frameIndex } : candidate,
        ),
      }
      editor.draftError = undefined
      this.#renderH3PreservingFocus()
      return
    }
    const pairedId = editor.channel === "visual" ? guide.audioId : guide.visualId
    const originalFrame = editor.originalGuideFrames.get(guideId)
    if (
      pairedId !== null &&
      pairedId !== undefined &&
      originalFrame !== undefined &&
      frameIndex !== originalFrame
    ) {
      if (editor.timeline.guides.length >= 32) {
        editor.timeline = {
          ...editor.timeline,
          guides: editor.timeline.guides.map((candidate) =>
            candidate.id === guideId ? { ...candidate, frameIndex: originalFrame } : candidate,
          ),
        }
        editor.draftError = "Cannot move a paired Guide: the 32-guide limit has been reached."
        this.#renderH3PreservingFocus()
        return
      }
      const newId = this.#newH3GuideId()
      const detached =
        editor.channel === "visual"
          ? { ...guide, frameIndex: originalFrame, visualId: null }
          : { ...guide, frameIndex: originalFrame, audioId: null }
      const moved =
        editor.channel === "visual"
          ? { id: newId, frameIndex, visualId: editor.mediaId, audioId: null }
          : { id: newId, frameIndex, visualId: null, audioId: editor.mediaId }
      editor.timeline = {
        ...editor.timeline,
        guides: [
          ...editor.timeline.guides.map((candidate) =>
            candidate.id === guideId ? detached : candidate,
          ),
          moved,
        ],
      }
      editor.ownedGuideIds.add(newId)
      editor.originalGuideFrames.set(newId, frameIndex)
      editor.selectedGuideId = newId
      editor.draftError = undefined
      this.#renderH3PreservingFocus(newId)
      return
    }
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((candidate) =>
        candidate.id === guideId ? { ...candidate, frameIndex } : candidate,
      ),
    }
    editor.draftError = undefined
    this.#renderH3PreservingFocus()
  }

  #h3EditorTimeline(editor: H3EditorState): H3TimelineState {
    const current = cloneH3Timeline(this.state.h3Timeline)
    const owned = editor.ownedGuideIds
    const draftById = new Map(
      editor.timeline.guides
        .filter((guide) => owned.has(guide.id))
        .map((guide) => [guide.id, { ...guide }] as const),
    )
    const guides: typeof current.guides = []
    for (const guide of current.guides) {
      if (!owned.has(guide.id)) {
        guides.push({ ...guide })
        continue
      }
      const draft = draftById.get(guide.id)
      if (
        draft &&
        (draft.visualId !== null || draft.audioId !== null || !editor.removedGuideIds.has(guide.id))
      )
        guides.push(draft)
    }
    for (const guide of editor.timeline.guides) {
      if (owned.has(guide.id) && !current.guides.some((candidate) => candidate.id === guide.id)) {
        if (
          guide.visualId !== null ||
          guide.audioId !== null ||
          !editor.removedGuideIds.has(guide.id)
        )
          guides.push({ ...guide })
      }
    }
    return pruneDisabledGuideMedia({
      ...current,
      startImageId: editor.timeline.startImageId,
      endImageId: editor.timeline.endImageId,
      guides,
    })
  }

  #applyH3Editor(): void {
    const editor = this.#h3Editor
    if (!editor) return
    const issue = this.#h3DraftIssue(editor)
    if (issue) {
      this.#status = issue
      this.render(true)
      return
    }
    const timeline = this.#h3EditorTimeline(editor)
    const mediaId = editor.mediaId
    if (!mediaId) {
      if (!editor.allowTimelineOnly) return
      this.#h3Editor = undefined
      this.#dispatch({ type: "set-h3-timeline", timeline })
      this.#status = "Timeline Guide settings applied."
      this.render(true)
      return
    }
    const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.state.items[itemId]
    if (!item) return
    if (!canUseAsH3Guide(item, editor.channel)) return
    this.#h3Editor = undefined
    this.#dispatch({
      type: "apply-h3-media-edit",
      mediaId,
      channel: editor.channel,
      referenceEnabled: referenceEnabled(item, editor.channel),
      timeline,
      twoImageMode: twoImageModeProperty(this.#node),
    })
    this.#status = `${itemFilename(item)} Guide settings applied.`
    this.render(true)
  }

  #onDoubleClick(event: MouseEvent): void {
    const target = event.target as Element
    if (target.closest("button, textarea, input, select, a, [contenteditable='true']")) return
    if (
      this.#mode === "single-image" &&
      this.state.imageOrder.length === 0 &&
      target.closest(".rl-single-image-preview")
    ) {
      this.root.querySelector<HTMLInputElement>('input[data-upload-kind="image"]')?.click()
      return
    }
    const media = target.closest<HTMLElement>(".rl-card__media")
    if (!media) return
    const card = media.closest<HTMLElement>(".rl-card")
    if (card?.dataset.id) {
      void this.#editItem(card.dataset.id, card.dataset.channel as LoaderChannel | undefined)
    }
  }

  #selectItem(id: string): void {
    this.#selectedId = id
    for (const card of this.root.querySelectorAll<HTMLElement>(".rl-card")) {
      const selected = card.dataset.id === id
      card.classList.toggle("is-selected", selected)
      card.setAttribute("aria-selected", String(selected))
    }
    this.#publishView()
  }

  #clearAll(): void {
    const hadItems = Object.keys(this.state.items).length > 0
    const hadTimeline =
      this.state.h3Timeline.enabled ||
      this.state.h3Timeline.startImageId !== null ||
      this.state.h3Timeline.endImageId !== null ||
      this.state.h3Timeline.guides.length > 0
    if (!hadItems && !hadTimeline && this.#pending.size === 0) return
    this.#audioPreview.stop()
    this.#videoPreview.stop()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#stateController = new AbortController()
    this.#runtimeEpoch += 1
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    this.#selectedId = undefined
    this.#h3Editor = undefined
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#runtimeSequence = 0
    this.#status =
      hadItems || hadTimeline
        ? this.#mode === "single-image"
          ? "Image removed. Undo is available."
          : hadTimeline
            ? "All references and Timeline Guides cleared. Undo is available."
            : "All references cleared. Undo is available."
        : "Pending uploads cleared."
    if (hadItems || hadTimeline) this.#dispatch({ type: "clear" })
    else this.render()
  }

  async #toggleAudioPreview(id: string): Promise<void> {
    const item = this.state.items[id]
    const runtime = this.#runtime.get(id)
    if (
      !item ||
      !isAudioItem(item) ||
      runtime?.loading ||
      (item.kind === "video" && runtime?.metadata?.hasAudio === false)
    )
      return
    const duration = runtime?.metadata?.duration ?? item.crop?.end
    if (duration === undefined) return
    const owner = `grid:${id}`
    const snapshot = this.#audioPreview.snapshot
    if (
      snapshot.owner === owner &&
      (snapshot.status === "playing" || snapshot.status === "loading")
    ) {
      this.#audioPreview.stop(owner)
      return
    }
    try {
      this.#videoPreview.stop()
      const url =
        item.kind === "video"
          ? this.#api.videoPreviewUrl(item.source)
          : this.#api.audioPreviewUrl(item.source)
      await this.#audioPreview.play(owner, url, item.crop ?? { start: 0, end: duration })
    } catch (error) {
      if (this.#destroyed) return
      this.#status = `${itemFilename(item)}: ${error instanceof Error ? error.message : "Audio preview failed."}`
      this.render()
    }
  }

  async #toggleVideoPreview(id: string): Promise<void> {
    const item = this.state.items[id]
    const runtime = this.#runtime.get(id)
    if (!item || item.kind !== "video" || runtime?.loading) return
    const duration = runtime?.metadata?.duration ?? item.crop?.end
    if (duration === undefined) return
    const owner = `grid:${id}`
    const snapshot = this.#videoPreview.snapshot
    if (
      snapshot.owner === owner &&
      (snapshot.status === "playing" || snapshot.status === "loading")
    ) {
      this.#videoPreview.stop(owner)
      return
    }
    try {
      this.#audioPreview.stop()
      await this.#videoPreview.play(
        owner,
        this.#api.videoPreviewUrl(item.source),
        item.crop ?? { start: 0, end: duration },
        undefined,
        { muted: !item.videoAudioEnabled },
      )
    } catch (error) {
      if (this.#destroyed) return
      this.#status = `${itemFilename(item)}: ${error instanceof Error ? error.message : "Video preview failed."}`
      this.render()
    }
  }

  #onInput(event: Event): void {
    if (isH3ReactEvent(event)) return
    const h3Input = event.target
    if (h3Input instanceof HTMLInputElement && h3Input.dataset.h3DraftField === "frame") {
      const editor = this.#h3Editor
      const guideId = h3Input.dataset.h3GuideId
      if (!editor || !guideId) return
      const frameIndex = h3Input.value === "" ? Number.NaN : Number(h3Input.value)
      this.#inputH3DraftFrame(guideId, h3Input.value)
      const seconds = h3Input
        .closest<HTMLElement>("[data-h3-guide-id]")
        ?.querySelector<HTMLElement>(".rl-h3-editor__seconds")
      if (seconds)
        seconds.textContent =
          Number.isInteger(frameIndex) && frameIndex >= 0 ? `${(frameIndex / 24).toFixed(2)}s` : ""
      return
    }
    const textarea = event.target
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.field !== "caption") return
    const card = textarea.closest<HTMLElement>(".rl-card")
    const id = card?.dataset.id
    const channel = card?.dataset.channel as LoaderChannel | undefined
    if (!id || !channel) return
    const changed = this.#dispatch(
      { type: "set-caption", id, caption: textarea.value, channel },
      {
        mergeKey: this.#composing ? `ime:${channel}:${id}` : `caption:${channel}:${id}`,
        render: false,
      },
    )
    if (!changed) return
    this.#syncCaptionFields(id, textarea)
    this.#node.setDirtyCanvas(true, true)
  }

  #syncCaptionFields(id: string, source?: HTMLTextAreaElement): void {
    const item = this.state.items[id]
    if (!item) return
    for (const textarea of this.root.querySelectorAll<HTMLTextAreaElement>(
      'textarea[data-field="caption"]',
    )) {
      if (textarea === source || document.activeElement === textarea) continue
      const card = textarea.closest<HTMLElement>(".rl-card")
      if (card?.dataset.id !== id) continue
      const channel = card.dataset.channel as LoaderChannel | undefined
      textarea.value =
        item.kind === "video" && channel === "audio"
          ? (item.audioCaptionOverride ?? item.caption)
          : item.caption
    }
  }

  #onChange(event: Event): void {
    if (isH3ReactEvent(event)) return
    const input = event.target
    if (
      (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) &&
      input.dataset.h3DraftField
    ) {
      this.#onH3DraftChange(input)
      return
    }
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return
    if (input.hasAttribute("data-snapshot-input")) {
      this.#setSnapshotMenu(false)
      const file = input.files?.[0]
      input.value = ""
      if (file) void this.#loadSnapshot(file)
      return
    }
    const expectedKind = input.dataset.uploadKind
    const files = [...(input.files ?? [])].filter(
      (file) =>
        !expectedKind ||
        fileMediaKind(file) === expectedKind ||
        (this.#mode === "single-image" && expectedKind === "image" && isSingleImageCandidate(file)),
    )
    input.value = ""
    void this.#uploadFiles(files)
  }

  async #loadSnapshot(file: File): Promise<void> {
    try {
      const result = await this.#changeEvents.loadSnapshot?.(file)
      this.#status = result === "cancelled" ? "Snapshot load cancelled." : "Snapshot loaded."
    } catch (error) {
      this.#status = error instanceof Error ? error.message : "Snapshot could not be loaded."
    }
    this.render(true)
  }

  #onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && (event.target as Element).closest("[data-h3-editor]")) {
      event.preventDefault()
      this.#closeH3Editor()
      return
    }
    const snapshot = (event.target as Element).closest<HTMLElement>(".rl-snapshot")
    if (snapshot) {
      const trigger = snapshot.querySelector<HTMLButtonElement>(".rl-snapshot__trigger")
      const items = [...snapshot.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      if (event.key === "Escape" && this.#snapshotMenuOpen) {
        event.preventDefault()
        this.#setSnapshotMenu(false)
        trigger?.focus()
        return
      }
      if (event.target === trigger && event.key === "ArrowDown") {
        event.preventDefault()
        this.#setSnapshotMenu(true, "first")
        return
      }
      const index = items.indexOf(event.target as HTMLButtonElement)
      if (index >= 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        items[(index + delta + items.length) % items.length]?.focus()
        return
      }
    }
    const card = (event.target as Element).closest<HTMLElement>(".rl-card")
    if (card?.classList.contains("rl-card--h3-editor")) return
    if (
      event.altKey &&
      card?.dataset.id &&
      card.dataset.channel &&
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault()
      const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1
      this.#dispatch({
        type: "move",
        id: card.dataset.id,
        channel: card.dataset.channel as LoaderChannel,
        delta,
      })
      return
    }
  }

  #setSnapshotMenu(open: boolean, focus?: "first"): void {
    this.#snapshotMenuOpen = open
    const trigger = this.root.querySelector<HTMLButtonElement>(".rl-snapshot__trigger")
    const menu = this.root.querySelector<HTMLElement>(".rl-snapshot__menu")
    trigger?.setAttribute("aria-expanded", String(open))
    if (menu) menu.hidden = !open
    if (open && focus === "first")
      menu?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }

  #onDragStart(event: DragEvent): void {
    const card = (event.target as Element).closest<HTMLElement>(".rl-card")
    if (
      !card?.dataset.id ||
      !card.dataset.channel ||
      !this.#armedDrag ||
      this.#armedDrag.id !== card.dataset.id ||
      this.#armedDrag.channel !== card.dataset.channel
    ) {
      event.preventDefault()
      return
    }
    this.#drag = { id: card.dataset.id, channel: card.dataset.channel as LoaderChannel }
    event.dataTransfer?.setData(DRAG_MIME, JSON.stringify(this.#drag))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove"
    this.root.classList.add("is-dragging")
  }

  #updateDropTarget(event: DragEvent): void {
    const target = event.target
    if (
      !(target instanceof Element) ||
      !this.#drag ||
      (event.dataTransfer?.files.length ?? 0) > 0
    ) {
      this.#clearDropTarget()
      return
    }
    const zone = target.closest<HTMLElement>("[data-drop-zone]")
    const card = target.closest<HTMLElement>(".rl-card")
    const valid =
      zone?.dataset.dropZone === this.#drag.channel &&
      card?.dataset.channel === this.#drag.channel &&
      card.dataset.id !== this.#drag.id
    this.#setDropTarget(valid ? card : undefined)
  }

  #setDropTarget(card: HTMLElement | undefined): void {
    if (this.#dropTarget === card) return
    this.#dropTarget?.classList.remove("is-drop-target")
    this.#dropTarget = card
    this.#dropTarget?.classList.add("is-drop-target")
  }

  #clearDropTarget(): void {
    this.#setDropTarget(undefined)
  }

  #setFileDropTarget(card: HTMLElement | undefined): void {
    if (this.#fileDropTarget === card) return
    this.#fileDropTarget?.classList.remove("is-file-drop-target")
    this.#fileDropTarget = card
    if (card) {
      card.classList.add("is-file-drop-target")
      this.root.dataset.fileDropTarget = card.classList.contains("rl-card") ? "replace" : "add"
    } else {
      delete this.root.dataset.fileDropTarget
    }
  }

  #setFileDropGuide(dataTransfer: DataTransfer | null): void {
    const kinds = mediaDropKinds(dataTransfer).filter(
      (kind) => this.#mode !== "single-image" || kind === "image",
    )
    if (kinds.length > 0) this.root.dataset.fileDropKinds = kinds.join(" ")
    else delete this.root.dataset.fileDropKinds
  }

  #updateFileDropTarget(event: DragEvent | undefined): void {
    if (!event || !isSingleMediaDrop(event.dataTransfer)) {
      this.#setFileDropTarget(undefined)
      return
    }
    const target = (event.target as Element).closest<HTMLElement>(
      ".rl-card, .rl-grid-add, .rl-single-image-preview.is-empty",
    )
    const targetId = target?.dataset.id
    const targetItem = targetId ? this.state.items[targetId] : undefined
    const targetKind = target?.dataset.mediaKind ?? target?.dataset.dropZone
    const kinds = mediaDropKinds(event.dataTransfer)
    const valid =
      target &&
      (targetItem?.kind ?? targetKind) &&
      kinds.length === 1 &&
      kinds[0] === (targetItem?.kind ?? targetKind)
        ? target
        : undefined
    this.#setFileDropTarget(valid)
  }

  #onDrop(event: DragEvent): void {
    this.#clearDropTarget()
    this.root.classList.remove("is-file-dragging")
    this.#setFileDropGuide(null)
    this.#setFileDropTarget(undefined)
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) {
      if (!this.acceptsFileDrop(event.dataTransfer)) return
      event.preventDefault()
      const target = (event.target as Element).closest<HTMLElement>(".rl-card")
      const targetId = target?.dataset.id
      const targetItem = targetId ? this.state.items[targetId] : undefined
      if (
        targetItem &&
        target?.classList.contains("rl-card--h3-editor") &&
        this.#h3Editor?.mediaId ===
          timelineMediaId(targetItem, target.dataset.channel === "audio" ? "audio" : "visual")
      ) {
        this.#status = "Apply or cancel the current Guide edit before replacing this Media."
        this.render(true)
        return
      }
      const replaceId =
        files.length === 1 &&
        targetId &&
        targetItem &&
        fileMediaKind(files[0] as File) === targetItem.kind
          ? targetId
          : undefined
      void this.addDroppedFiles(files, replaceId)
      return
    }
    const zone = (event.target as Element).closest<HTMLElement>("[data-drop-zone]")
    const channel = zone?.dataset.dropZone as LoaderChannel | undefined
    if (!channel || !this.#drag || this.#drag.channel !== channel) return
    event.preventDefault()
    const targetCard = (event.target as Element).closest<HTMLElement>(".rl-card")
    const order =
      channel === "image"
        ? this.state.imageOrder
        : channel === "video"
          ? this.state.videoOrder
          : this.state.audioOrder
    const index = targetCard?.dataset.id ? order.indexOf(targetCard.dataset.id) : order.length
    this.#dispatch({ type: "reorder", channel, id: this.#drag.id, toIndex: Math.max(0, index) })
  }

  async #uploadFiles(files: File[], replaceId?: string): Promise<void> {
    if (this.#mode === "single-image") {
      const images = files.filter(isSingleImageCandidate)
      if (images.length === 0) {
        this.#status = "Only image files are supported."
        this.render()
        return
      }
      if (this.#pending.size > 0) {
        this.#status = "Wait for the current image upload to finish."
        this.render()
        return
      }
      if (images.length > 1)
        this.#status = `${images.length - 1} additional image${images.length === 2 ? " was" : "s were"} skipped.`
      await this.#uploadFile(images[0] as File, replaceId)
      return
    }
    if (replaceId && files.length === 1) {
      const target = this.state.items[replaceId]
      const kind = fileMediaKind(files[0] as File)
      if (target && kind === target.kind) {
        await this.#uploadFile(files[0] as File, replaceId)
        return
      }
    }
    const counts = { image: 0, audio: 0, video: 0 }
    for (const item of Object.values(this.state.items)) counts[item.kind] += 1
    for (const pending of this.#pending.values()) {
      const kind = fileMediaKind(pending.file)
      if (kind) counts[kind] += 1
    }
    const accepted: File[] = []
    let skipped = 0
    for (const file of files) {
      const kind = fileMediaKind(file)
      if (!kind) {
        skipped += 1
        continue
      }
      if (counts[kind] >= MEDIA_LIMITS[kind]) {
        skipped += 1
        continue
      }
      counts[kind] += 1
      accepted.push(file)
    }
    if (skipped > 0)
      this.#status = `${skipped} unsupported or over-limit file${skipped === 1 ? " was" : "s were"} skipped.`
    if (accepted.length === 0) {
      if (skipped > 0) this.render()
      return
    }
    await Promise.allSettled(accepted.map((file) => this.#uploadFile(file)))
  }

  #reloadChannelRuntime(channel: LoaderChannel): void {
    const ids =
      channel === "image"
        ? this.state.imageOrder
        : channel === "video"
          ? this.state.videoOrder
          : this.state.audioOrder
    for (const id of new Set(ids)) {
      const item = this.state.items[id]
      if (item) void this.#loadRuntime(item)
    }
  }

  #disableSilentVideoAudio(id: string): void {
    if (this.#destroyed) return
    if (!this.#store.canDisableSilentVideoAudio(id)) return
    this.#recordGraphChange(() => {
      this.#store.disableSilentVideoAudio(id)
    })
    this.#finishStateChange()
    this.render()
  }

  async #uploadFile(file: File, replaceId?: string): Promise<void> {
    const epoch = this.#runtimeEpoch
    const stateController = this.#stateController
    const id = `pending-${globalThis.crypto?.randomUUID?.() ?? Math.random()}`
    const objectUrl = URL.createObjectURL(file)
    this.#pending.set(id, { id, file, objectUrl })
    this.#status = `Uploading ${file.name}…`
    this.render()
    try {
      const uploaded = await this.#api.upload(file, stateController.signal)
      if (!this.#isStateRequestCurrent(epoch, stateController)) return
      if (this.#mode === "single-image" && uploaded.kind !== "image") {
        this.#status = `${file.name}: the server did not recognize this as an image.`
        return
      }
      const canonicalCount = Object.values(this.state.items).filter(
        (candidate) => candidate.kind === uploaded.kind,
      ).length
      const currentTarget = replaceId ? this.state.items[replaceId] : undefined
      if (replaceId && currentTarget?.kind !== uploaded.kind) {
        this.#status = `${file.name}: the server identified a different media type, so the reference was not replaced.`
        return
      }
      if (
        this.#mode !== "single-image" &&
        !replaceId &&
        canonicalCount >= MEDIA_LIMITS[uploaded.kind]
      ) {
        this.#status = `${file.name}: the server identified this as ${uploaded.kind}, but that media limit is already full.`
        return
      }
      let item = createMediaItem(uploaded.kind, uploaded.source, replaceId)
      const addedDisabled =
        !replaceId &&
        item.kind === "image" &&
        twoImageModeProperty(this.#node) &&
        this.#activeImageCount() >= 2
      if (addedDisabled && item.kind === "image") item = { ...item, imageEnabled: false }
      this.#runtime.set(item.id, { loading: true, metadata: uploaded.metadata })
      if (replaceId) {
        if (this.#audioPreview.snapshot.owner === `grid:${replaceId}`) this.#audioPreview.stop()
        if (this.#videoPreview.snapshot.owner === `grid:${replaceId}`) this.#videoPreview.stop()
        this.#dispatch({ type: "replace-media", id: replaceId, item })
      } else if (this.#mode === "single-image") {
        const empty = loaderReducer(this.state, { type: "clear" })
        const replacement = loaderReducer(empty, { type: "add", item })
        this.#dispatch({ type: "replace", state: this.#stateForMode(replacement) })
      } else {
        this.#dispatch({ type: "add", item })
      }
      this.#selectedId = item.id
      this.#status = replaceId
        ? `${file.name} replaced the existing reference.`
        : this.#mode === "single-image"
          ? ""
          : addedDisabled
            ? `${file.name} added with its IMAGE output disabled by two-image mode.`
            : `${file.name} added.`
      await this.#loadRuntime(item)
    } catch (error) {
      if (!this.#isStateRequestCurrent(epoch, stateController)) return
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.#status = `${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`
      }
    } finally {
      if (this.#pending.get(id)?.objectUrl === objectUrl) this.#pending.delete(id)
      URL.revokeObjectURL(objectUrl)
      if (this.#isStateRequestCurrent(epoch, stateController)) this.render()
    }
  }

  async #loadRuntime(item: MediaItem, options: RuntimeLoadOptions = {}): Promise<void> {
    if (this.#destroyed) return
    const epoch = this.#runtimeEpoch
    const stateController = this.#stateController
    const sequence = ++this.#runtimeSequence
    this.#runtimeSequences.set(item.id, sequence)
    const current = this.#runtime.get(item.id) ?? { loading: true }
    const { error: _previousError, ...withoutError } = current
    this.#runtime.set(item.id, { ...withoutError, loading: true })
    if (options.renderStart !== false) this.render()
    const release = await this.#runtimeLimiter.acquire(stateController.signal)
    if (!release) return
    try {
      if (
        !this.#isStateRequestCurrent(epoch, stateController) ||
        this.#runtimeSequences.get(item.id) !== sequence ||
        !this.state.items[item.id]
      )
        return
      const metadataPromise = this.#api.metadata(item.source, stateController.signal)
      const proxyPromise =
        item.kind === "image" || item.kind === "video"
          ? this.#api.imageProxy(
              item.source,
              this.state.ui.previewMaxPixels,
              stateController.signal,
            )
          : undefined
      const [metadata, proxy] = await Promise.all([metadataPromise, proxyPromise])
      if (
        !this.#isStateRequestCurrent(epoch, stateController) ||
        this.#runtimeSequences.get(item.id) !== sequence ||
        !this.state.items[item.id]
      )
        return
      if (item.kind === "video" && metadata.hasAudio === false)
        this.#disableSilentVideoAudio(item.id)
      const waveform =
        item.kind === "audio" || (item.kind === "video" && metadata.hasAudio !== false)
          ? await this.#api.waveform(
              item.source,
              this.state.ui.waveformPeaks,
              item.crop,
              stateController.signal,
            )
          : undefined
      if (
        !this.#isStateRequestCurrent(epoch, stateController) ||
        this.#runtimeSequences.get(item.id) !== sequence ||
        !this.state.items[item.id]
      )
        return
      const runtimeMetadata =
        metadata.duration === undefined && waveform?.duration !== undefined
          ? { ...metadata, duration: waveform.duration }
          : metadata
      this.#runtime.set(item.id, {
        loading: false,
        metadata: runtimeMetadata,
        ...(proxy ? { previewUrl: proxy.url } : {}),
        ...(waveform ? { waveform: waveform.pairs } : {}),
      })
      this.#publishRuntimeUpdate()
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      if (
        !this.#isStateRequestCurrent(epoch, stateController) ||
        this.#runtimeSequences.get(item.id) !== sequence ||
        !this.state.items[item.id]
      )
        return
      this.#runtime.set(item.id, {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Preview failed.",
      })
      this.#publishRuntimeUpdate()
    } finally {
      release()
    }
    if (options.completionRender === "scheduled") this.#scheduleRender()
    else this.render()
  }

  async #editItem(id: string, channel?: LoaderChannel): Promise<void> {
    const item = this.state.items[id]
    if (!item || this.#runtime.get(id)?.applyingEdit) return
    this.#audioPreview.stop()
    this.#videoPreview.stop()
    this.#modalController?.abort()
    const modalController = new AbortController()
    this.#modalController = modalController
    const runtime = this.#runtime.get(id)
    try {
      if (item.kind === "image") {
        const imageMetadata = runtime?.metadata
        const editorResult = await openImageEditor({
          item,
          signal: modalController.signal,
          showCaption: this.#mode !== "single-image",
          ...(runtime?.previewUrl ? { previewUrl: runtime.previewUrl } : {}),
          ...(imageMetadata?.width !== undefined ? { imageWidth: imageMetadata.width } : {}),
          ...(imageMetadata?.height !== undefined ? { imageHeight: imageMetadata.height } : {}),
          ...(imageMetadata?.width === undefined || imageMetadata.height === undefined
            ? { imageMetadata: (signal: AbortSignal) => this.#api.metadata(item.source, signal) }
            : {}),
          backgroundPreview: async (signal) =>
            (await this.#api.backgroundPreview(item.source, signal)).url,
        })
        if (!editorResult) return
        if (!this.#isEditCurrent(id, item, modalController)) return
        if (editorResult.action === "restore-original") {
          this.#invalidateRuntime(id)
          this.#runtime.set(id, { loading: true })
          this.#dispatch({
            type: "restore-image-original",
            id,
            caption: editorResult.caption,
          })
          this.render(true)
          const restored = this.state.items[id]
          if (restored) await this.#loadRuntime(restored)
          return
        }
        this.#runtime.set(id, { ...runtime, loading: true, applyingEdit: true })
        this.render(true)
        this.#node.setDirtyCanvas(true, true)
        let edit = editorResult.edit
        if (editorResult.maskFile) {
          const uploadedMask = await this.#api.upload(editorResult.maskFile, modalController.signal)
          if (!this.#isEditCurrent(id, item, modalController)) return
          if (uploadedMask.kind !== "image")
            throw new Error("The uploaded mask was not recognized as an image.")
          edit = { ...edit, mask: uploadedMask.source, maskMode: "keep" }
        }
        const result = await this.#api.applyEdit(item.source, edit, modalController.signal)
        if (!this.#isEditCurrent(id, item, modalController)) return
        let configuredPreview: { url: string } | undefined
        const configuredPreviewPixels = this.state.ui.previewMaxPixels
        try {
          configuredPreview = await this.#api.imageProxy(
            result.source,
            configuredPreviewPixels,
            modalController.signal,
          )
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error
        }
        if (!this.#isEditCurrent(id, item, modalController)) return
        const configuredPreviewIsCurrent =
          configuredPreviewPixels === this.state.ui.previewMaxPixels
        this.#invalidateRuntime(id)
        const canonicalEdit =
          edit.mask && !result.edit.mask
            ? { ...result.edit, mask: edit.mask, maskMode: "keep" as const }
            : result.edit
        this.#dispatch({
          type: "apply-image-edit",
          id,
          edit: canonicalEdit,
          source: result.source,
          caption: editorResult.caption,
        })
        this.#runtime.set(id, {
          loading: false,
          ...(configuredPreviewIsCurrent && configuredPreview?.url
            ? { previewUrl: configuredPreview.url }
            : result.proxyUrl
              ? { previewUrl: result.proxyUrl }
              : runtime?.previewUrl
                ? { previewUrl: runtime.previewUrl }
                : {}),
          ...(result.metadata
            ? { metadata: result.metadata }
            : runtime?.metadata
              ? { metadata: runtime.metadata }
              : {}),
        })
        this.#publishRuntimeUpdate()
        this.render(true)
        // The proxy URL arrives after the graph-backed edit state has already
        // dirtied the canvas. Notify ComfyUI again after replacing the card DOM
        // so its DOM-widget draw pass observes the new thumbnail immediately.
        this.#node.setDirtyCanvas(true, true)
        if (!configuredPreviewIsCurrent) {
          const updated = this.state.items[id]
          if (updated) await this.#loadRuntime(updated)
        }
      } else {
        let metadata = runtime?.metadata
        if (metadata?.duration === undefined)
          metadata = await this.#api.metadata(item.source, modalController.signal)
        if (!this.#isEditCurrent(id, item, modalController)) return
        let editorWaveform = runtime?.waveform
        if (item.crop && (item.kind === "audio" || metadata?.hasAudio !== false)) {
          editorWaveform = (
            await this.#api.waveform(
              item.source,
              this.state.ui.waveformPeaks,
              undefined,
              modalController.signal,
            )
          ).pairs
        }
        if (!this.#isEditCurrent(id, item, modalController)) return
        const caption =
          item.kind === "video" && channel === "audio"
            ? (item.audioCaptionOverride ?? item.caption)
            : item.caption
        const editorResult = await openTrimEditor({
          kind: item.kind,
          filename: itemFilename(item),
          duration: metadata?.duration ?? item.crop?.end ?? 1,
          caption,
          signal: modalController.signal,
          ...(item.kind === "video"
            ? {
                video: {
                  owner: `editor:${id}`,
                  url: this.#api.videoPreviewUrl(item.source),
                  hasAudio: metadata?.hasAudio !== false,
                  muted: channel !== "audio" && !item.videoAudioEnabled,
                },
              }
            : {
                playback: {
                  player: this.#audioPreview,
                  owner: `editor:${id}`,
                  url: this.#api.audioPreviewUrl(item.source),
                  enabled: true,
                },
              }),
          ...(item.crop ? { crop: item.crop } : {}),
          ...(editorWaveform ? { waveform: editorWaveform } : {}),
        })
        if (!editorResult) return
        if (!this.#isEditCurrent(id, item, modalController)) return
        this.#dispatch({
          type: "apply-time-range",
          id,
          crop: editorResult.crop,
          caption: editorResult.caption,
          ...(channel ? { channel } : {}),
        })
        this.render(true)
        const updated = this.state.items[id]
        if (updated) await this.#loadRuntime(updated)
      }
    } catch (error) {
      if (!this.#isEditCurrent(id, item, modalController)) return
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.#runtime.set(id, {
          ...runtime,
          loading: false,
          error: error instanceof Error ? error.message : "Edit failed.",
        })
        this.#publishRuntimeUpdate()
        this.render()
      }
    } finally {
      if (this.#modalController === modalController) this.#modalController = undefined
    }
  }

  #isEditCurrent(id: string, original: MediaItem, controller: AbortController): boolean {
    if (this.#destroyed || controller.signal.aborted || this.#modalController !== controller)
      return false
    const current = this.state.items[id]
    return Boolean(
      current &&
      current.kind === original.kind &&
      current.source.path === original.source.path &&
      current.source.sha256 === original.source.sha256 &&
      current.source.revision === original.source.revision,
    )
  }

  #isStateRequestCurrent(epoch: number, controller: AbortController): boolean {
    return (
      !this.#destroyed &&
      !controller.signal.aborted &&
      this.#stateController === controller &&
      this.#runtimeEpoch === epoch
    )
  }

  #invalidateRuntime(id: string): void {
    this.#runtimeSequences.set(id, ++this.#runtimeSequence)
  }

  #dispatch(
    action: LoaderAction,
    options: LoaderDispatchOptions & { render?: boolean } = {},
  ): boolean {
    if (this.#destroyed) return false
    if (!this.#store.hasChange(action)) return false
    let changed = false
    this.#recordGraphChange(() => {
      changed = this.#store.dispatch(action, { mergeKey: options.mergeKey })
    })
    if (changed) {
      this.#finishStateChange()
      if (options.render !== false) this.render()
    }
    return changed
  }

  #activeImageCount(): number {
    return this.state.imageOrder.reduce((count, id) => {
      const item = this.state.items[id]
      return count + (item?.kind === "image" && item.imageEnabled ? 1 : 0)
    }, 0)
  }

  #toggleOutput(id: string, channel: LoaderChannel): void {
    const item = this.state.items[id]
    if (
      channel === "image" &&
      item?.kind === "image" &&
      !item.imageEnabled &&
      twoImageModeProperty(this.#node) &&
      this.#activeImageCount() >= 2
    ) {
      this.#status = "Two-image mode permits at most two enabled Images."
      this.render()
      return
    }
    this.#dispatch({ type: "toggle", id, channel })
  }

  #toggleVideoAudio(id: string): void {
    const item = this.state.items[id]
    if (!item || item.kind !== "video" || this.#runtime.get(id)?.metadata?.hasAudio === false)
      return
    this.#dispatch({ type: "toggle-video-audio", id })
    const next = this.state.items[id]
    if (next?.kind === "video") this.#videoPreview.setMuted(`grid:${id}`, !next.videoAudioEnabled)
  }

  #recordGraphChange(change: () => void): void {
    const graph = this.#node.graph
    this.#changeEvents.beforeChange?.()
    graph?.beforeChange?.()
    try {
      change()
    } finally {
      graph?.afterChange?.()
      this.#changeEvents.afterChange?.()
    }
  }

  #changed(reloadRuntime = false): void {
    if (this.#destroyed) return
    this.#finishStateChange()
    this.render()
    if (reloadRuntime) {
      for (const item of Object.values(this.state.items)) void this.#loadRuntime(item)
    }
  }

  #finishStateChange(): void {
    if (this.#destroyed) return
    if (this.#selectedId && !this.state.items[this.#selectedId]) this.#selectedId = undefined
    if (this.#h3Editor?.mediaId) {
      const itemId = this.#h3Editor.mediaId.endsWith(":audio")
        ? this.#h3Editor.mediaId.slice(0, -6)
        : this.#h3Editor.mediaId
      const item = this.state.items[itemId]
      if (!item || !canUseAsH3Guide(item, this.#h3Editor.channel)) this.#h3Editor = undefined
    }
    for (const id of this.#runtime.keys()) {
      if (!this.state.items[id]) {
        this.#runtime.delete(id)
        this.#invalidateRuntime(id)
        this.#runtimeSequences.delete(id)
      }
    }
    this.#node.setDirtyCanvas(true, true)
    this.#syncPromptReferences()
    this.#publishView()
  }
}

function labelForCaption(channel: LoaderChannel): string {
  return channel === "image" ? "Image" : channel === "video" ? "Video" : "Audio"
}

function isChannelOutputEnabled(channel: LoaderChannel, item: MediaItem): boolean {
  if (channel === "image") return item.kind === "image" && item.imageEnabled
  if (channel === "video") return item.kind === "video" && item.videoEnabled
  return isAudioItem(item) && item.audioEnabled
}
