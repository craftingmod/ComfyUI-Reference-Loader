import type { ComfyNode } from "../../comfyui.ts"
import { ReferenceLoaderApi } from "../api.ts"
import { AudioPreviewPlayer } from "../audio-preview-player.ts"
import { openImageEditor } from "../editors/image-editor.ts"
import { openTrimEditor } from "../editors/trim-editor.ts"
import {
  cloneH3Timeline,
  guideUsesMedia,
  canUseAsH3Guide,
  mediaHasGuide,
  mediaGuideEnabled,
  setMediaGuideEnabled,
  pruneDisabledGuideMedia,
  referenceEnabled,
  timelineMediaId,
  validateH3Timeline,
  type H3GuideChannel,
  type H3TimelinePlacement,
} from "../h3-media-guides.ts"
import { LoaderStore, type LoaderDispatchOptions } from "../loader-store.ts"
import type { PromptReference, PromptShot } from "../prompt-v6.ts"
import { loaderReducer, type LoaderAction, type LoaderChannel } from "../reducer.ts"
import { deserializeLoaderState, serializeLoaderState } from "../serialization.ts"
import {
  createEmptyH3Timeline,
  createMediaItem,
  H3_OUTPUT_MAX_FPS,
  H3_OUTPUT_MAX_TOTAL_FRAMES,
  H3_OUTPUT_MIN_FPS,
  H3_OUTPUT_MIN_TOTAL_FRAMES,
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
  type H3WorkspaceView,
  type LoaderViewSnapshot,
} from "../view-model.ts"
import { isSilentWaveform } from "../waveform.ts"
import type { H3GuidePosition } from "./h3-guide-editor.tsx"
import { createH3WorkspaceReact, type H3WorkspaceReactMount } from "./h3-workspace-react.tsx"
import {
  clearFileDropFeedback,
  createLoaderReact,
  mediaDropKinds,
  setFileDropFeedback,
  transferFiles,
  type LoaderReactActions,
  type LoaderReactMount,
} from "./loader-react.tsx"

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

interface LoaderDragPayload {
  scope: string
  id: string
  channel: LoaderChannel
}

function isLoaderChannel(value: unknown): value is LoaderChannel {
  return value === "image" || value === "video" || value === "audio"
}

function loaderDragRaw(dataTransfer: DataTransfer | null): string | undefined {
  try {
    const raw = dataTransfer?.getData(DRAG_MIME)
    return raw || undefined
  } catch {
    return undefined
  }
}

function hasLoaderDragType(dataTransfer: DataTransfer | null): boolean {
  try {
    return Boolean(dataTransfer && [...dataTransfer.types].includes(DRAG_MIME))
  } catch {
    return false
  }
}

function readLoaderDragPayload(dataTransfer: DataTransfer | null): LoaderDragPayload | undefined {
  const raw = loaderDragRaw(dataTransfer)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as {
      scope?: unknown
      id?: unknown
      channel?: unknown
    }
    if (
      typeof parsed.scope !== "string" ||
      typeof parsed.id !== "string" ||
      !isLoaderChannel(parsed.channel)
    )
      return undefined
    return { scope: parsed.scope, id: parsed.id, channel: parsed.channel }
  } catch {
    return undefined
  }
}

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

function isSingleImageCandidate(file: File): boolean {
  const kind = fileMediaKind(file)
  return kind === undefined || kind === "image"
}

function hasFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return dataTransfer.files.length > 0 || [...dataTransfer.types].includes("Files")
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

function horizontalCardsProperty(node: ComfyNode): boolean {
  const value = node.properties?.[NODE_PROPERTY_KEY]
  if (typeof value !== "object" || value === null) return false
  const horizontalCards = (value as Record<string, unknown>).horizontalCards
  return typeof horizontalCards === "boolean" ? horizontalCards : false
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

function setHorizontalCardsProperty(node: ComfyNode, horizontalCards: boolean): void {
  const current = node.properties?.[NODE_PROPERTY_KEY]
  const namespace =
    typeof current === "object" && current !== null ? (current as Record<string, unknown>) : {}
  node.properties = {
    ...node.properties,
    [NODE_PROPERTY_KEY]: { ...namespace, horizontalCards },
  }
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
  #reactHost: HTMLElement
  #reactMount: LoaderReactMount | undefined
  #h3WorkspaceRoot: HTMLElement | undefined
  #h3WorkspaceMount: H3WorkspaceReactMount | undefined
  #reactActions: LoaderReactActions = {
    addFiles: (files, replaceId) => this.uploadFiles(files, replaceId),
    saveSnapshot: () => this.saveSnapshot(),
    loadSnapshot: (file) => this.loadSnapshot(file),
    undo: () => this.undo(),
    redo: () => this.redo(),
    clear: () => this.clear(),
    select: (id) => this.selectItem(id),
    remove: (id) => this.removeItem(id),
    setCaption: (id, channel, caption, composing) =>
      this.setCaption(id, channel, caption, composing),
    toggleOutput: (id, channel) => this.toggleOutput(id, channel),
    toggleVideoAudio: (id) => this.toggleVideoAudio(id),
    previewAudio: (id) => this.previewAudio(id),
    previewVideo: (id) => this.previewVideo(id),
    move: (id, channel, delta) => this.moveItem(id, channel, delta),
    movePlacement: (id, frame) => this.#moveH3TimelineGuide(id, frame),
    selectPlacement: (placement, channel, focusGuide) =>
      this.#selectH3Placement(placement, channel, focusGuide),
    removePlacement: (id) => this.#removeH3TimelineGuide(id),
    selectShot: (tag) => this.#selectH3Shot(tag),
    changeShot: (tag, frame) => {
      this.#promptShotChange?.(tag, frame)
    },
    removeShot: (tag) => {
      this.#promptShotRemove?.(tag)
    },
    canDrop: (channel, dataTransfer) => {
      if (this.#promptShotDirty) return false
      if (this.#h3GuideDragSource(channel, dataTransfer)) return true
      // Browsers keep custom drag data unreadable during dragover. The type is
      // still exposed, so accept the event and validate the source on drop.
      return hasLoaderDragType(dataTransfer) && !loaderDragRaw(dataTransfer)
    },
    drop: (channel, frame, dataTransfer) => this.#addH3GuideFromDrop(channel, frame, dataTransfer),
    h3Toggle: () => this.#toggleH3Timeline(),
    h3ToggleCollapsed: () => {
      this.#h3Collapsed = !this.#h3Collapsed
      this.render(true)
    },
    h3OpenMedia: (mediaId, channel, guideId) =>
      this.#openH3EditorForMedia(mediaId, channel, guideId),
    h3ToggleGuide: (id, channel) => this.#toggleH3Guide(id, channel),
    h3SelectPlacement: (placement, channel) => this.#selectH3Placement(placement, channel),
    h3InputFrame: (id, value) => this.#inputH3DraftFrame(id, value),
    h3CommitFrame: (id, value) => this.#commitH3DraftFrame(id, value),
    h3ChangeGuideSource: (id, channel, mediaId) => this.#changeH3DraftSource(id, channel, mediaId),
    h3AddPlacement: (position, frame) => this.#addH3DraftPlacement(position, frame),
    h3RemoveRole: (role) => this.#removeH3DraftRole(role),
    h3RemovePlacement: (id) => this.#deleteH3DraftPlacement(id),
    h3Apply: () => this.#applyH3Workspace(),
    h3Cancel: () => this.#cancelH3Workspace(),
    reorder: (id, channel, toIndex) => this.reorderItem(id, channel, toIndex),
    edit: (id, channel) => this.editItem(id, channel),
    acceptsFileDrop: (dataTransfer) => this.acceptsFileDrop(dataTransfer),
    flushDeferredPreviews: () => this.flushDeferredPreviews(),
  }
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
  #waveformResizeObserver: ResizeObserver | undefined
  #unsubscribeAudioPreview: (() => void) | undefined
  #unsubscribeVideoPreview: (() => void) | undefined
  #pending = new Map<string, PendingUpload>()
  #selectedId: string | undefined
  #status = "Drop image, audio, or video files to begin."
  #deferPreviews = false
  #destroyController = new AbortController()
  #stateController = new AbortController()
  #modalController: AbortController | undefined
  #dragScope =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  #renderFrame: number | undefined
  #destroyed = false
  #changeEvents: LoaderChangeEvents
  #mode: ReferenceLoaderMode
  #referenceListeners = new Set<() => void>()
  #viewListeners = new Set<() => void>()
  #viewSnapshot: LoaderViewSnapshot | undefined
  #promptReferences: PromptReference[] = []
  #promptReferenceSourceKey = ""
  #h3Collapsed = true
  #h3Editor: H3EditorState | undefined
  #promptShots: readonly Pick<PromptShot, "tag" | "frameIndex">[] = []
  #promptShotChange: ((tag: string, frameIndex: number) => void) | undefined
  #promptShotRemove: ((tag: string) => void) | undefined
  #promptShotSelect: ((tag: string) => void) | undefined
  #promptShotApply: (() => void) | undefined
  #promptShotCancel: (() => void) | undefined
  #promptShotDirty = false
  #h3SelectedShot: string | undefined
  #h3SelectedRole: "start" | "end" | undefined
  #h3Session = 0

  constructor(
    root: HTMLElement,
    node: ComfyNode,
    api: ReferenceLoaderApi,
    serialized: unknown,
    changeEvents: LoaderChangeEvents = {},
    options: ReferenceLoaderControllerOptions = {},
  ) {
    this.root = root
    this.#reactHost = document.createElement("div")
    this.#reactHost.dataset.loaderReactRoot = ""
    this.root.replaceChildren(this.#reactHost)
    this.#node = node
    this.#api = api
    this.#changeEvents = changeEvents
    this.#mode = options.mode ?? "references"
    if (typeof ResizeObserver !== "undefined") {
      this.#waveformResizeObserver = new ResizeObserver(() => {
        if (!this.#destroyed) this.#drawWaveforms()
      })
      this.#waveformResizeObserver.observe(this.root)
    }
    this.#installRootDropEvents()
    const parsed = deserializeLoaderState(serialized)
    this.#store = new LoaderStore(this.#stateForMode(parsed.state))
    if (parsed.issues.length > 0) this.#status = parsed.issues.join(" ")
    else if (this.#mode === "single-image") this.#status = ""
    this.#promptReferences = projectPromptReferences(this.state, this.#runtime)
    this.#promptReferenceSourceKey = promptReferenceSourceKey(this.state)
    this.#viewSnapshot = this.#buildViewSnapshot()
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

  mountH3Workspace(container: HTMLElement): H3WorkspaceReactMount {
    this.#h3WorkspaceMount?.destroy()
    this.#h3WorkspaceRoot = container
    const mount = createH3WorkspaceReact({
      container,
      subscribe: (listener) => this.subscribeView(listener),
      getSnapshot: () => this.getViewSnapshot(),
      actions: this.#reactActions,
    })
    const managedMount = {
      destroy: () => {
        mount.destroy()
        if (this.#h3WorkspaceRoot === container) this.#h3WorkspaceRoot = undefined
        if (this.#h3WorkspaceMount === managedMount) this.#h3WorkspaceMount = undefined
      },
    }
    this.#h3WorkspaceMount = managedMount
    return managedMount
  }

  #displayState(): LoaderDisplayState {
    return {
      gridColumns: this.state.ui.gridColumns,
      h3Fps: this.state.h3Output.fps,
      h3TotalFrames: this.state.h3Output.totalFrames,
      previewPixels: this.state.ui.previewMaxPixels / 1_000_000,
      showCaptions: showCaptionsProperty(this.#node),
      horizontalCards: horizontalCardsProperty(this.#node),
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
    onApply?: () => void,
    onCancel?: () => void,
    dirty = false,
  ): void {
    if (this.#destroyed) return
    this.#promptShots = shots.map((shot) => ({ tag: shot.tag, frameIndex: shot.frameIndex }))
    this.#promptShotChange = onChange
    this.#promptShotSelect = onSelect
    this.#promptShotRemove = onRemove
    this.#promptShotApply = onApply
    this.#promptShotCancel = onCancel
    this.#promptShotDirty = dirty
    if (
      this.#h3SelectedShot &&
      !this.#promptShots.some((shot) => shot.tag === this.#h3SelectedShot)
    )
      this.#h3SelectedShot = undefined
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

  selectItem(id: string): void {
    if (this.#destroyed || !this.state.items[id]) return
    this.#selectItem(id)
  }

  editH3GuidesForShot(tag: string): void {
    if (this.#destroyed) return
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before editing a Guide."
      this.render(true)
      return
    }
    const shot = this.#promptShots.find((candidate) => candidate.tag === tag)
    if (!shot) return
    const guide = this.state.h3Timeline.guides.find(
      (candidate) => candidate.frameIndex === shot.frameIndex,
    )
    if (guide) {
      const channel: H3GuideChannel = guide.visualId !== null ? "visual" : "audio"
      const mediaId = channel === "visual" ? guide.visualId : guide.audioId
      if (mediaId) {
        this.#openH3EditorForMedia(mediaId, channel, guide.id)
      } else {
        this.#openH3EditorForGuide(guide.id)
      }
      return
    }
    this.#h3Collapsed = false
    this.#selectH3Shot(tag, true)
  }

  removeItem(id: string): void {
    if (this.#destroyed || !this.state.items[id]) return
    if (this.#audioPreview.snapshot.owner === `grid:${id}`) this.#audioPreview.stop()
    if (this.#videoPreview.snapshot.owner === `grid:${id}`) this.#videoPreview.stop()
    this.#runtime.delete(id)
    this.#dispatch({ type: "remove", id })
  }

  setCaption(id: string, channel: LoaderChannel, caption: string, composing = false): void {
    if (this.#destroyed) return
    const changed = this.#dispatch(
      { type: "set-caption", id, caption, channel },
      {
        mergeKey: composing ? `ime:${channel}:${id}` : `caption:${channel}:${id}`,
        render: false,
      },
    )
    if (!changed) return
    this.#syncCaptionFields(id)
    this.#node.setDirtyCanvas(true, true)
  }

  flushDeferredPreviews(): void {
    if (this.#destroyed || !this.#deferPreviews || this.#hasFocusedCaption()) return
    this.#deferPreviews = false
    this.render()
  }

  toggleOutput(id: string, channel: LoaderChannel): void {
    if (this.#destroyed) return
    this.#toggleOutput(id, channel)
  }

  toggleVideoAudio(id: string): void {
    if (this.#destroyed) return
    this.#toggleVideoAudio(id)
  }

  previewAudio(id: string): void {
    if (this.#destroyed) return
    void this.#toggleAudioPreview(id)
  }

  previewVideo(id: string): void {
    if (this.#destroyed) return
    void this.#toggleVideoPreview(id)
  }

  moveItem(id: string, channel: LoaderChannel, delta: -1 | 1): void {
    if (this.#destroyed) return
    this.#dispatch({ type: "move", id, channel, delta })
  }

  reorderItem(id: string, channel: LoaderChannel, toIndex: number): void {
    if (this.#destroyed) return
    this.#dispatch({ type: "reorder", id, channel, toIndex })
  }

  editItem(id: string, channel?: LoaderChannel): void {
    if (this.#destroyed) return
    void this.#editItem(id, channel)
  }

  undo(): void {
    if (this.#destroyed || !this.#store.canUndo) return
    this.#recordGraphChange(() => this.#store.undo())
    this.#changed(true)
  }

  redo(): void {
    if (this.#destroyed || !this.#store.canRedo) return
    this.#recordGraphChange(() => this.#store.redo())
    this.#changed(true)
  }

  clear(): void {
    if (this.#destroyed) return
    this.#clearAll()
  }

  saveSnapshot(): void {
    if (this.#destroyed) return
    try {
      this.#changeEvents.saveSnapshot?.()
      this.#status = "Snapshot saved."
    } catch (error) {
      this.#status = error instanceof Error ? error.message : "Snapshot could not be saved."
    }
    this.render(true)
  }

  async loadSnapshot(file: File): Promise<void> {
    if (this.#destroyed) return
    await this.#loadSnapshot(file)
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

  async uploadFiles(files: Iterable<File>, replaceId?: string): Promise<boolean> {
    if (this.#destroyed) return false
    const uploaded = [...files]
    await this.#uploadFiles(uploaded, replaceId)
    return uploaded.length > 0
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
    const h3Fps =
      values.h3Fps === undefined || !Number.isFinite(values.h3Fps)
        ? this.state.h3Output.fps
        : Math.min(H3_OUTPUT_MAX_FPS, Math.max(H3_OUTPUT_MIN_FPS, Math.round(values.h3Fps)))
    const h3TotalFrames =
      values.h3TotalFrames === undefined || !Number.isFinite(values.h3TotalFrames)
        ? this.state.h3Output.totalFrames
        : Math.min(
            H3_OUTPUT_MAX_TOTAL_FRAMES,
            Math.max(H3_OUTPUT_MIN_TOTAL_FRAMES, Math.round(values.h3TotalFrames)),
          )
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
    if (h3Fps !== this.state.h3Output.fps || h3TotalFrames !== this.state.h3Output.totalFrames) {
      this.#dispatch({ type: "set-h3-output", values: { fps: h3Fps, totalFrames: h3TotalFrames } })
    }
    if (values.showCaptions !== undefined) {
      const showCaptions = Boolean(values.showCaptions)
      if (showCaptions !== showCaptionsProperty(this.#node)) {
        this.#recordGraphChange(() => setShowCaptionsProperty(this.#node, showCaptions))
        this.#node.setDirtyCanvas(true, true)
        this.render()
      }
    }
    if (values.horizontalCards !== undefined) {
      const horizontalCards = Boolean(values.horizontalCards)
      if (horizontalCards !== horizontalCardsProperty(this.#node)) {
        this.#recordGraphChange(() => setHorizontalCardsProperty(this.#node, horizontalCards))
        this.#node.setDirtyCanvas(true, true)
        this.render()
      }
    }
  }

  restore(serialized: unknown): void {
    if (this.#destroyed) return
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
    this.#deferPreviews = false
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    this.#h3Editor = undefined
    this.#h3Session += 1
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
    display: Pick<LoaderDisplayState, "showCaptions" | "horizontalCards">,
  ): void {
    this.restore(serialized)
    setShowCaptionsProperty(this.#node, display.showCaptions)
    setHorizontalCardsProperty(this.#node, display.horizontalCards)
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
    this.#cancelScheduledRender()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#destroyController.abort()
    this.#unsubscribeAudioPreview?.()
    this.#unsubscribeVideoPreview?.()
    this.#waveformResizeObserver?.disconnect()
    this.#waveformResizeObserver = undefined
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
    this.#promptShotApply = undefined
    this.#promptShotCancel = undefined
    this.#promptShotDirty = false
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    this.#h3Editor = undefined
    this.#h3WorkspaceMount?.destroy()
    this.#h3WorkspaceMount = undefined
    this.#h3WorkspaceRoot = undefined
    this.#destroyReactMount()
    this.root.replaceChildren()
  }

  render(force = false): void {
    if (this.#destroyed) return
    if (this.#deferPreviews && !this.#hasFocusedCaption()) this.#deferPreviews = false
    this.#publishView()
    this.#cancelScheduledRender()
    const state = this.state
    this.root.style.setProperty("--rl-card-aspect", state.ui.cardAspectRatio)
    this.root.style.setProperty(
      "--rl-grid-columns",
      String(this.#mode === "single-image" ? 1 : state.ui.gridColumns),
    )
    this.root.style.setProperty("--rl-preview-fit", state.ui.previewFit)
    void force
    this.#renderReact()
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
      deferPreviews: this.#deferPreviews,
      canUndo: this.#store.canUndo,
      canRedo: this.#store.canRedo,
      h3: this.#buildH3View(),
    })
  }

  #buildH3View(): H3WorkspaceView {
    const editor = this.#h3Editor
    const timeline = editor
      ? this.#h3EditorTimeline(editor)
      : cloneH3Timeline(this.state.h3Timeline)
    const selectedGuide = editor?.selectedGuideId
      ? timeline.guides.find((guide) => guide.id === editor.selectedGuideId)
      : undefined
    const parentId = (id: string): string => (id.endsWith(":audio") ? id.slice(0, -6) : id)
    const recovery = Boolean(
      editor &&
      !editor.mediaId &&
      !editor.timelineEdit &&
      selectedGuide &&
      ((!selectedGuide.visualId && !selectedGuide.audioId) ||
        (selectedGuide.visualId !== null &&
          selectedGuide.visualId !== undefined &&
          !this.state.items[parentId(selectedGuide.visualId)]) ||
        (selectedGuide.audioId !== null &&
          selectedGuide.audioId !== undefined &&
          !this.state.items[parentId(selectedGuide.audioId)])),
    )
    const selection = this.#h3SelectedRole
      ? ({ kind: this.#h3SelectedRole } as const)
      : this.#h3SelectedShot
        ? ({ kind: "shot", tag: this.#h3SelectedShot } as const)
        : editor?.selectedGuideId
          ? ({ kind: "guide", guideId: editor.selectedGuideId, channel: editor.channel } as const)
          : editor?.mediaId
            ? ({ kind: "source", mediaId: editor.mediaId, channel: editor.channel } as const)
            : undefined
    const issue = editor ? this.#h3DraftIssue(editor) : undefined
    const guideDirty = this.#h3EditorDirty()
    return {
      collapsed: this.#h3Collapsed,
      selection,
      editScope: editor
        ? editor.mediaId
          ? "source"
          : "guide"
        : this.#promptShotDirty
          ? "shot"
          : "none",
      sessionId: this.#h3Session,
      dirty: guideDirty || this.#promptShotDirty,
      canApply: editor ? guideDirty && !issue : this.#promptShotDirty,
      shotDirty: this.#promptShotDirty,
      shotCanApply: this.#promptShotDirty,
      issue,
      draftError: editor?.draftError,
      timeline,
      editor: editor
        ? {
            mediaId: editor.mediaId,
            channel: editor.channel,
            selectedGuideId: editor.selectedGuideId,
            timelineEdit: Boolean(editor.timelineEdit),
            recovery,
            ownedGuideIds: [...editor.ownedGuideIds],
          }
        : undefined,
      shots: this.#promptShots,
    }
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

  #hasFocusedCaption(): boolean {
    const active = document.activeElement
    return (
      active instanceof HTMLTextAreaElement &&
      active.dataset.field === "caption" &&
      this.root.contains(active)
    )
  }

  #destroyReactMount(): void {
    this.#reactMount?.destroy()
    this.#reactMount = undefined
    this.root.classList.remove("is-dragging", "is-file-dragging")
    delete this.root.dataset.fileDropKinds
    delete this.root.dataset.fileDropTarget
  }

  #installRootDropEvents(): void {
    const signal = this.#destroyController.signal
    this.root.addEventListener(
      "dragover",
      (event) => {
        if (event.target !== this.root) return
        if (!hasFilePayload(event.dataTransfer) || !this.acceptsFileDrop(event.dataTransfer)) {
          clearFileDropFeedback(this.root)
          return
        }
        event.preventDefault()
        event.stopPropagation()
        setFileDropFeedback(this.root, undefined, mediaDropKinds(event.dataTransfer))
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
      },
      { signal },
    )
    this.root.addEventListener(
      "dragleave",
      (event) => {
        if (event.target !== this.root) return
        clearFileDropFeedback(this.root)
      },
      { signal },
    )
    this.root.addEventListener(
      "drop",
      (event) => {
        if (event.target !== this.root || !hasFilePayload(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        clearFileDropFeedback(this.root)
        const files = transferFiles(event.dataTransfer)
        if (files.length > 0) void this.uploadFiles(files)
      },
      { signal },
    )
  }

  #renderReact(): void {
    const options = {
      container: this.#reactHost,
      surface: this.root,
      mode: this.#mode,
      dragScope: this.#dragScope,
      subscribe: (listener: () => void) => this.subscribeView(listener),
      getSnapshot: () => this.getViewSnapshot(),
      actions: this.#reactActions,
      onCommit: () => {
        this.#drawWaveforms()
        this.#syncPlaybackUi()
      },
    }
    if (!this.#reactMount) this.#reactMount = createLoaderReact(options)
    else this.#reactMount.update()
  }

  #publishRuntimeUpdate(): void {
    this.#publishView()
    this.#syncPromptReferences()
  }

  #moveH3TimelineGuide(id: string, frameIndex: number): void {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) return
    let editor = this.#h3Editor
    if (!editor?.ownedGuideIds.has(id)) {
      if (editor) {
        const guide = editor.timeline.guides.find((candidate) => candidate.id === id)
        if (!guide) return
        editor.ownedGuideIds.add(id)
        if (!editor.originalGuideFrames.has(id))
          editor.originalGuideFrames.set(id, guide.frameIndex)
      } else {
        const timeline = cloneH3Timeline(this.state.h3Timeline)
        if (!timeline.guides.some((guide) => guide.id === id)) return
        editor = {
          mediaId: undefined,
          channel: "visual",
          timeline,
          initialTimeline: cloneH3Timeline(timeline),
          ownedGuideIds: new Set(timeline.guides.map((guide) => guide.id)),
          originalGuideFrames: new Map(
            timeline.guides.map((guide) => [guide.id, guide.frameIndex]),
          ),
          removedGuideIds: new Set(),
          allowTimelineOnly: true,
          timelineEdit: true,
          returnFocus: { guideId: id },
        }
        this.#h3Editor = editor
        this.#h3Session += 1
      }
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
    const mark = [
      ...(this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLButtonElement>(
        "[data-timeline-guide]",
      ),
    ].find((button) => button.dataset.timelineGuide === id)
    mark?.focus({ preventScroll: true })
  }

  #h3GuideDragSource(
    channel: H3GuideChannel,
    dataTransfer: DataTransfer | null,
  ): { id: string; item: MediaItem } | undefined {
    if (this.#promptShotDirty) return undefined
    const source = readLoaderDragPayload(dataTransfer)
    if (!source) return undefined
    if (source.scope !== this.#dragScope) return undefined
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
    this.#h3Session += 1
    this.#h3Collapsed = false
    return this.#h3Editor
  }

  #addH3GuideFromDrop(
    channel: H3GuideChannel,
    frameIndex: number,
    dataTransfer: DataTransfer | null,
  ): void {
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before editing a Guide."
      this.render(true)
      return
    }
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
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before editing a Guide."
      this.render(true)
      return
    }
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

  #h3MediaLabel(mediaId: string, channel: H3GuideChannel): string {
    const parentId =
      channel === "audio" && mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.state.items[parentId]
    if (!item) return "Media needed"
    const kind = channel === "audio" ? "Audio" : item.kind === "video" ? "Video" : "Image"
    return `${kind} · ${itemFilename(item)}`
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
    const candidate = this.#h3EditorTimeline(editor)
    const hasGuide = mediaHasGuide(candidate, editor.mediaId, editor.channel)
    if (editor.requireGuide && !hasGuide) return "Add a frame placement or select Start/End."
    return validateH3Timeline(this.state, candidate, { allowIncomplete: true })[0]
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
      const host =
        activeMedia.querySelector<HTMLElement>("[data-video-preview-host]") ?? activeMedia
      if (this.#videoPreview.element.parentElement !== host)
        host.prepend(this.#videoPreview.element)
    } else {
      this.#videoPreview.element.remove()
      for (const poster of this.root.querySelectorAll("img.is-video-poster-hidden")) {
        poster.classList.remove("is-video-poster-hidden")
      }
    }
  }

  #toggleH3Timeline(): void {
    if (this.#h3EditorDirty()) {
      this.#status = "Apply or cancel Guide changes before changing Timeline Guides."
      this.render(true)
      return
    }
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before changing Timeline Guides."
      this.render(true)
      return
    }
    this.#dispatch({ type: "toggle-h3-timeline", enabled: !this.state.h3Timeline.enabled })
  }

  #selectH3Placement(
    placement: H3TimelinePlacement,
    channel: "visual" | "audio",
    focusGuide = true,
  ): boolean {
    const sessionBefore = this.#h3Session
    if (placement.kind === "start" || placement.kind === "end") {
      if (placement.visualId) {
        this.#openH3EditorForMedia(
          placement.visualId,
          "visual",
          undefined,
          "edit",
          false,
          focusGuide,
          true,
          placement.kind,
          false,
        )
        return this.#h3Session !== sessionBefore
      }
      if (this.#h3Editor) {
        this.#h3Editor = undefined
        this.#h3Session += 1
      }
      this.#h3SelectedShot = undefined
      this.#h3SelectedRole = placement.kind
      this.#selectedId = undefined
      this.render(true)
      return this.#h3Session !== sessionBefore
    }
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    if (placement.kind === "guide" && placement.guideId) {
      const id = channel === "visual" ? placement.visualId : placement.audioId
      if (id)
        this.#openH3EditorForMedia(
          id,
          channel,
          placement.guideId,
          "edit",
          false,
          focusGuide,
          true,
          undefined,
          false,
        )
      else {
        this.#openH3EditorForGuide(placement.guideId, focusGuide)
        this.#selectedId = undefined
      }
      return this.#h3Session !== sessionBefore
    }
    const id = channel === "visual" ? placement.visualId : placement.audioId
    if (id)
      this.#openH3EditorForMedia(
        id,
        channel,
        placement.guideId,
        "edit",
        false,
        false,
        true,
        undefined,
        false,
      )
    else if (placement.guideId) {
      this.#openH3EditorForGuide(placement.guideId, focusGuide)
      this.#selectedId = undefined
    }
    return this.#h3Session !== sessionBefore
  }

  #changeH3DraftSource(id: string, channel: H3GuideChannel, mediaId: string | null): void {
    const editor = this.#h3Editor
    if (!editor) return
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === id
          ? channel === "visual"
            ? { ...guide, visualId: mediaId }
            : { ...guide, audioId: mediaId }
          : guide,
      ),
    }
    const changedGuide = editor.timeline.guides.find((guide) => guide.id === id)
    if (changedGuide && changedGuide.visualId === null && changedGuide.audioId === null)
      editor.removedGuideIds.add(id)
    else editor.removedGuideIds.delete(id)
    editor.draftError = undefined
    this.#renderH3PreservingFocus()
  }

  #applyH3Workspace(): void {
    if (this.#h3Editor) {
      this.#applyH3Editor()
      if (this.#h3Editor) return
    }
    if (this.#promptShotDirty) this.#promptShotApply?.()
  }

  #cancelH3Workspace(): void {
    if (this.#h3Editor) {
      this.#closeH3Editor()
    }
    if (this.#promptShotDirty) this.#promptShotCancel?.()
  }

  #selectH3Shot(tag: string, scroll = false): boolean {
    const sessionBefore = this.#h3Session
    const editor = this.#h3Editor
    if (editor && this.#h3EditorDirty()) {
      editor.mediaId = undefined
      editor.selectedGuideId = undefined
      editor.allowTimelineOnly = true
      editor.timelineEdit = true
      editor.ownedGuideIds = new Set(editor.timeline.guides.map((guide) => guide.id))
      this.#h3Session += 1
    } else if (editor) {
      this.#h3Editor = undefined
      this.#h3Session += 1
    }
    this.#h3SelectedShot = tag
    this.#h3SelectedRole = undefined
    this.#selectedId = undefined
    this.#promptShotSelect?.(tag)
    this.render(true)
    const mark = [
      ...(this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLButtonElement>(
        "[data-timeline-shot]",
      ),
    ].find((button) => button.dataset.timelineShot === tag)
    if (scroll) mark?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
    mark?.focus({ preventScroll: true })
    return this.#h3Session !== sessionBefore
  }

  #openH3EditorForMedia(
    mediaId: string,
    channel: H3GuideChannel,
    guideId?: string,
    control: "toggle" | "edit" = "edit",
    requireGuide = false,
    focusGuide = true,
    preserveDraft = false,
    selectedRole?: "start" | "end",
    selectCard = true,
  ): void {
    const wasCollapsed = this.#h3Collapsed
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    if (this.#promptShotDirty && !preserveDraft) {
      this.#status = "Apply or cancel Shot changes before editing a Guide."
      this.render(true)
      return
    }
    const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
    const item = this.state.items[itemId]
    if (!item || !canUseAsH3Guide(item, channel)) {
      this.#status = "The selected Timeline source is unavailable."
      this.render(true)
      return
    }
    this.#h3SelectedRole = selectedRole
    const editor = this.#h3Editor
    if (editor?.mediaId === mediaId && editor.channel === channel) {
      editor.selectedGuideId = guideId
      if (!selectCard) this.#selectedId = undefined
      this.#h3Collapsed = false
      this.render(true)
      if (guideId && focusGuide) this.#focusH3EditorGuide(guideId)
      else if (!guideId && wasCollapsed) this.#focusH3Workspace()
      return
    }
    if (preserveDraft && editor && this.#h3EditorDirty()) {
      for (const guide of editor.timeline.guides) {
        if (guideUsesMedia(guide, mediaId, channel)) editor.ownedGuideIds.add(guide.id)
      }
      if (guideId) editor.ownedGuideIds.add(guideId)
      editor.mediaId = mediaId
      editor.channel = channel
      editor.timelineEdit = true
      editor.allowTimelineOnly = true
      editor.selectedGuideId = guideId
      editor.returnFocus = { mediaId, channel, control }
      this.#h3Session += 1
      this.#selectedId = selectCard ? item.id : undefined
      this.#h3Collapsed = false
      this.render(true)
      if (guideId && focusGuide) this.#focusH3EditorGuide(guideId)
      else if (!guideId && wasCollapsed) this.#focusH3Workspace()
      return
    }
    if (!this.#canSwitchH3Editor(mediaId, channel)) return
    const timeline = cloneH3Timeline(this.state.h3Timeline)
    const ownedGuideIds = new Set(
      timeline.guides
        .filter((guide) => guideUsesMedia(guide, mediaId, channel))
        .map((guide) => guide.id),
    )
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
    this.#h3Session += 1
    this.#selectedId = selectCard ? item.id : undefined
    this.#h3Collapsed = false
    this.render(true)
    if (guideId && focusGuide) this.#focusH3EditorGuide(guideId)
    else if (wasCollapsed) this.#focusH3Workspace()
  }

  #openH3EditorForGuide(guideId: string, focusGuide = true): void {
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    const guide = this.state.h3Timeline.guides.find((candidate) => candidate.id === guideId)
    if (!guide) return
    const editor = this.#h3Editor
    if (editor && editor.mediaId === undefined && editor.selectedGuideId === guideId) {
      this.#h3Collapsed = false
      this.render(true)
      if (focusGuide) this.#focusH3EditorGuide(guideId)
      return
    }
    if (editor && this.#h3EditorDirty()) {
      editor.mediaId = undefined
      editor.channel = guide.visualId !== null ? "visual" : "audio"
      editor.allowTimelineOnly = true
      editor.timelineEdit = true
      editor.ownedGuideIds.add(guideId)
      editor.selectedGuideId = guideId
      editor.returnFocus = { guideId }
      this.#h3Session += 1
      this.#h3Collapsed = false
      this.render(true)
      if (focusGuide) this.#focusH3EditorGuide(guideId)
      return
    }
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
    this.#h3Session += 1
    this.#h3Collapsed = false
    this.render(true)
    if (focusGuide) this.#focusH3EditorGuide(guideId)
  }

  #focusH3EditorGuide(guideId: string): void {
    for (const row of (this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLElement>(
      "[data-h3-editor] [data-h3-guide-id]",
    )) {
      if (row.dataset.h3GuideId !== guideId) continue
      row.scrollIntoView?.({ block: "nearest" })
      row.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.focus()
      return
    }
  }

  #focusH3Workspace(): void {
    const workspace = (this.#h3WorkspaceRoot ?? this.root).querySelector<HTMLElement>(
      "[data-h3-workspace]",
    )
    if (!workspace) return
    workspace.scrollIntoView?.({ block: "nearest" })
    workspace.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')?.focus({
      preventScroll: true,
    })
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
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before changing Guide usage."
      this.render(true)
      return
    }
    if (this.#h3EditorDirty()) {
      this.#status = "Apply or cancel Guide changes before changing Guide usage."
      this.render(true)
      return
    }
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
    else if (!Number.isSafeInteger(frameIndex) || frameIndex < 0)
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
    if (this.#promptShotDirty) {
      this.#status = "Apply or cancel Shot changes before editing a Guide."
      this.render(true)
      return
    }
    const key = role === "start" ? "startImageId" : "endImageId"
    const current = this.#h3Editor ? this.#h3Editor.timeline[key] : this.state.h3Timeline[key]
    if (current === null) return
    const editor = this.#ensureH3TimelineEditor()
    if (!editor) return
    editor.timeline = { ...editor.timeline, [key]: null }
    this.#h3SelectedRole = role
    this.#status = `${role === "start" ? "Start" : "End"} removed from the Timeline draft. Apply to save.`
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
      for (const element of (this.#h3WorkspaceRoot ?? this.root).querySelectorAll<
        HTMLInputElement | HTMLSelectElement
      >("[data-h3-draft-field]")) {
        if (element.dataset.h3DraftField === field && element.dataset.h3GuideId === guideId) {
          element.focus()
          return
        }
      }
    }
    if (focusGuideId) {
      for (const input of (this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLInputElement>(
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
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    this.#h3Session += 1
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
        ...(this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLButtonElement>(
          "[data-timeline-guide]",
        ),
      ].find((button) => button.dataset.timelineGuide === focus.guideId)
      if (marker) {
        marker.focus({ preventScroll: true })
        return
      }
      for (const button of (this.#h3WorkspaceRoot ?? this.root).querySelectorAll<HTMLButtonElement>(
        '[data-h3-action="select-placement"]',
      )) {
        if (button.dataset.h3GuideId === focus.guideId) {
          button.focus()
          break
        }
      }
    }
  }

  #inputH3DraftFrame(guideId: string, value: string): void {
    const editor = this.#h3Editor
    if (!editor) return
    editor.selectedGuideId = guideId
    const frameIndex = value === "" ? Number.NaN : Number(value)
    editor.timeline = {
      ...editor.timeline,
      guides: editor.timeline.guides.map((guide) =>
        guide.id === guideId ? { ...guide, frameIndex } : guide,
      ),
    }
    this.#publishView()
  }

  #commitH3DraftFrame(guideId: string, value: string): void {
    const editor = this.#h3Editor
    if (!editor) return
    editor.selectedGuideId = guideId
    const rawFrame = value.trim()
    const frameIndex = rawFrame === "" ? Number.NaN : Number(rawFrame)
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
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
      if (editor.selectedGuideId) this.#focusH3EditorGuide(editor.selectedGuideId)
      return
    }
    const timeline = this.#h3EditorTimeline(editor)
    const mediaId = editor.mediaId
    if (!mediaId) {
      if (!editor.allowTimelineOnly) return
      this.#h3Editor = undefined
      this.#h3Session += 1
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
    this.#h3Session += 1
    this.#dispatch({
      type: "apply-h3-media-edit",
      mediaId,
      channel: editor.channel,
      referenceEnabled: referenceEnabled(item, editor.channel),
      timeline,
    })
    this.#status = `${itemFilename(item)} Guide settings applied.`
    this.render(true)
  }

  #selectItem(id: string): void {
    this.#h3SelectedShot = undefined
    this.#h3SelectedRole = undefined
    if (this.#h3Editor) this.#h3Editor.selectedGuideId = undefined
    this.#selectedId = id
    this.#publishView()
    this.#reactMount?.update()
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
    this.#deferPreviews = false
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

  async #loadSnapshot(file: File): Promise<void> {
    try {
      const result = await this.#changeEvents.loadSnapshot?.(file)
      this.#status = result === "cancelled" ? "Snapshot load cancelled." : "Snapshot loaded."
    } catch (error) {
      this.#status = error instanceof Error ? error.message : "Snapshot could not be loaded."
    }
    this.render(true)
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
      await this.#uploadFile(images[0] as File, replaceId ?? this.state.imageOrder[0])
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
      if (this.#hasFocusedCaption()) this.#deferPreviews = true
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
      if (this.#hasFocusedCaption()) this.#deferPreviews = true
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

  #toggleOutput(id: string, channel: LoaderChannel): void {
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
