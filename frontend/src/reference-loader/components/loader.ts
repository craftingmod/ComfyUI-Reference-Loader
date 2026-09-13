import type { ComfyNode } from "../../comfyui.ts"
import { ReferenceLoaderApi, type UploadedReference } from "../api.ts"
import { openImageEditor } from "../editors/image-editor.ts"
import { openTrimEditor } from "../editors/trim-editor.ts"
import { canUseAsH3Guide, type H3GuideChannel } from "../h3-media-guides.ts"
import { H3TimelineSession, type H3TimelineFocus } from "../h3-timeline-session.ts"
import { LoaderStore, type LoaderDispatchOptions } from "../loader-store.ts"
import { MediaRuntimeCoordinator, type MediaRuntimeHost } from "../media-runtime-coordinator.ts"
import { PreviewSurfaceBridge, type PreviewSurfaceHost } from "../preview-surface-bridge.ts"
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
  type H3TimelineState,
  type LoaderState,
  type MediaItem,
} from "../types.ts"
import { LoaderViewBridge } from "../view-bridge.ts"
import {
  projectPromptReferences,
  promptReferenceSourceKey,
  samePromptReferences,
  type LoaderDisplayState,
  type LoaderViewSnapshot,
} from "../view-model.ts"
import type { H3WorkspaceReactMount } from "./h3-workspace-react.tsx"
import {
  clearFileDropFeedback,
  mediaDropKinds,
  setFileDropFeedback,
  transferFiles,
  type LoaderReactActions,
} from "./loader-react.tsx"

export interface LoaderChangeEvents {
  beforeChange?(): void
  afterChange?(): void
  recordGraphChange?(change: () => void): void
  markDirty?(): void
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

export class ReferenceLoaderController {
  readonly root: HTMLElement
  #viewBridge!: LoaderViewBridge
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
    movePlacement: (id, frame) => this.#timelineSession.movePlacement(id, frame),
    selectPlacement: (placement, channel, focusGuide) =>
      this.#timelineSession.selectPlacement(placement, channel, focusGuide),
    removePlacement: (id) => this.#timelineSession.removePlacement(id),
    selectShot: (tag) => this.#timelineSession.selectShot(tag),
    changeShot: (tag, frame) => this.#timelineSession.changeShot(tag, frame),
    removeShot: (tag) => this.#timelineSession.removeShot(tag),
    canDrop: (channel, dataTransfer) => {
      if (this.#timelineSession.promptShotDirty) return false
      if (this.#timelineSession.canDrop(channel, dataTransfer)) return true
      // Browsers keep custom drag data unreadable during dragover. The type is
      // still exposed, so accept the event and validate the source on drop.
      return hasLoaderDragType(dataTransfer) && !loaderDragRaw(dataTransfer)
    },
    drop: (channel, frame, dataTransfer) =>
      this.#timelineSession.dropGuide(channel, frame, dataTransfer),
    h3Toggle: () => this.#timelineSession.toggle(),
    h3ToggleCollapsed: () => this.#timelineSession.collapse(),
    h3OpenMedia: (mediaId, channel, guideId) =>
      this.#timelineSession.openForMedia(mediaId, channel, guideId),
    h3ToggleGuide: (id, channel) => this.#timelineSession.toggleGuide(id, channel),
    h3SelectPlacement: (placement, channel) =>
      this.#timelineSession.selectPlacement(placement, channel),
    h3InputFrame: (id, value) => this.#timelineSession.inputFrame(id, value),
    h3CommitFrame: (id, value) => this.#timelineSession.commitFrame(id, value),
    h3ChangeGuideSource: (id, channel, mediaId) =>
      this.#timelineSession.changeGuideSource(id, channel, mediaId),
    h3AddPlacement: (position, frame) => this.#timelineSession.addPlacement(position, frame),
    h3RemoveRole: (role) => this.#timelineSession.removeRole(role),
    h3RemovePlacement: (id) => this.#timelineSession.deletePlacement(id),
    h3Apply: () => this.#timelineSession.apply(),
    h3Cancel: () => this.#timelineSession.cancel(),
    reorder: (id, channel, toIndex) => this.reorderItem(id, channel, toIndex),
    edit: (id, channel) => this.editItem(id, channel),
    acceptsFileDrop: (dataTransfer) => this.acceptsFileDrop(dataTransfer),
    flushDeferredPreviews: () => this.flushDeferredPreviews(),
  }
  #node: ComfyNode
  #api: ReferenceLoaderApi
  #store: LoaderStore
  #mediaRuntime: MediaRuntimeCoordinator
  #previewSurface!: PreviewSurfaceBridge
  #selectedId: string | undefined
  #status = "Drop image, audio, or video files to begin."
  #deferPreviews = false
  #destroyController = new AbortController()
  #modalController: AbortController | undefined
  #dragScope =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  #destroyed = false
  #changeEvents: LoaderChangeEvents
  #mode: ReferenceLoaderMode
  #referenceListeners = new Set<() => void>()
  #promptReferences: PromptReference[] = []
  #promptReferenceSourceKey = ""
  #timelineSession: H3TimelineSession

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
    const runtimeHost: MediaRuntimeHost = {
      getState: () => this.state,
      getApi: () => this.#api,
      getPreviewMaxPixels: () => this.state.ui.previewMaxPixels,
      getWaveformPeaks: () => this.state.ui.waveformPeaks,
      isDestroyed: () => this.#destroyed,
      setStatus: (message) => {
        this.#status = message
      },
      render: () => this.render(),
      scheduleRender: () => this.#viewBridge.scheduleRender(),
      publishRuntimeUpdate: () => this.#publishRuntimeUpdate(),
      commitUploadedMedia: (uploaded, replaceId, filename) =>
        this.#commitUploadedMedia(uploaded, replaceId, filename),
      commitRuntimeCapabilityChange: (id) => this.#disableSilentVideoAudio(id),
      onRuntimePreviewUpdated: () => {
        if (this.#hasFocusedCaption()) this.#deferPreviews = true
      },
    }
    this.#mediaRuntime = new MediaRuntimeCoordinator(runtimeHost)
    this.#installRootDropEvents()
    const parsed = deserializeLoaderState(serialized)
    this.#store = new LoaderStore(this.#stateForMode(parsed.state))
    this.#timelineSession = new H3TimelineSession({
      host: {
        getState: () => this.state,
        dispatch: (action) => this.#dispatch(action),
        setStatus: (message) => {
          this.#status = message
        },
        requestRender: (force, focus) => this.#requestH3Render(force, focus),
        publishView: () => this.#viewBridge.publish(),
        selectMedia: (id) => {
          this.#selectedId = id
        },
        resolveGuideDrop: (channel, dataTransfer) => this.#h3GuideDragSource(channel, dataTransfer),
      },
    })
    this.#viewBridge = new LoaderViewBridge({
      root: this.root,
      mode: this.#mode,
      dragScope: this.#dragScope,
      getViewInput: () => ({
        state: this.state,
        display: this.#displayState(),
        runtime: this.#mediaRuntime.runtime,
        pending: [...this.#mediaRuntime.pending.values()].map((pending) => ({
          id: pending.id,
          filename: pending.file.name,
        })),
        selectedId: this.#selectedId,
        status: this.#status,
        deferPreviews: this.#deferPreviews,
        canUndo: this.#store.canUndo,
        canRedo: this.#store.canRedo,
        h3: this.#timelineSession.view,
      }),
      actions: this.#reactActions,
      onReactCommit: () => this.#previewSurface.syncAfterRender(),
      requestRender: () => this.render(),
    })
    const previewHost: PreviewSurfaceHost = {
      getRoot: () => this.root,
      getItem: (id) => this.state.items[id],
      getRuntime: (id) => this.#mediaRuntime.getRuntime(id),
      getAudioPreviewUrl: (item) => this.#api.audioPreviewUrl(item.source),
      getVideoPreviewUrl: (item) => this.#api.videoPreviewUrl(item.source),
      isDestroyed: () => this.#destroyed,
      setStatus: (message) => {
        this.#status = message
      },
      requestRender: () => this.render(),
    }
    this.#previewSurface = new PreviewSurfaceBridge(previewHost)
    if (parsed.issues.length > 0) this.#status = parsed.issues.join(" ")
    else if (this.#mode === "single-image") this.#status = ""
    this.#promptReferences = projectPromptReferences(this.state, this.#mediaRuntime.runtime)
    this.#promptReferenceSourceKey = promptReferenceSourceKey(this.state)
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
    return this.#viewBridge.getSnapshot()
  }

  subscribeView(listener: () => void): () => void {
    return this.#viewBridge.subscribe(listener)
  }

  mountH3Workspace(container: HTMLElement): H3WorkspaceReactMount {
    return this.#viewBridge.mountH3Workspace(container)
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
    this.#timelineSession.setPromptShots(
      shots,
      { change: onChange, select: onSelect, remove: onRemove, apply: onApply, cancel: onCancel },
      dirty,
    )
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
    this.#timelineSession.editGuidesForShot(tag)
  }

  removeItem(id: string): void {
    if (this.#destroyed || !this.state.items[id]) return
    this.#previewSurface.stopForItem(id)
    this.#mediaRuntime.remove(id)
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
    this.#markDirty()
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
    this.#previewSurface.previewAudio(id)
  }

  previewVideo(id: string): void {
    if (this.#destroyed) return
    this.#previewSurface.previewVideo(id)
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
        this.#markDirty()
        this.render()
      }
    }
    if (values.horizontalCards !== undefined) {
      const horizontalCards = Boolean(values.horizontalCards)
      if (horizontalCards !== horizontalCardsProperty(this.#node)) {
        this.#recordGraphChange(() => setHorizontalCardsProperty(this.#node, horizontalCards))
        this.#markDirty()
        this.render()
      }
    }
  }

  restore(serialized: unknown): void {
    if (this.#destroyed) return
    this.#previewSurface.stopAll()
    this.#modalController?.abort()
    this.#mediaRuntime.resetForStateChange()
    const parsed = deserializeLoaderState(serialized)
    this.#store.restore(this.#stateForMode(parsed.state))
    this.#selectedId = undefined
    this.#deferPreviews = false
    this.#timelineSession.reset()
    this.#status =
      parsed.issues.length > 0
        ? parsed.issues.join(" ")
        : this.#mode === "single-image"
          ? ""
          : "Workflow state restored."
    this.#syncPromptReferences()
    this.#viewBridge.cancelScheduledRender()
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
    this.#viewBridge.cancelScheduledRender()
    this.#modalController?.abort()
    this.#destroyController.abort()
    this.#previewSurface.destroy()
    this.#mediaRuntime.destroy()
    this.#referenceListeners.clear()
    this.#timelineSession.destroy()
    this.#viewBridge.destroy()
  }

  render(force = false): void {
    if (this.#destroyed) return
    if (this.#deferPreviews && !this.#hasFocusedCaption()) this.#deferPreviews = false
    this.#viewBridge.cancelScheduledRender()
    const state = this.state
    this.root.style.setProperty("--rl-card-aspect", state.ui.cardAspectRatio)
    this.root.style.setProperty(
      "--rl-grid-columns",
      String(this.#mode === "single-image" ? 1 : state.ui.gridColumns),
    )
    this.root.style.setProperty("--rl-preview-fit", state.ui.previewFit)
    void force
    this.#viewBridge.render()
  }

  #hydrateRestoredRuntime(force = false): void {
    const items = Object.values(this.state.items)
    this.#mediaRuntime.hydrate(items, {
      renderStart: false,
      completionRender: "scheduled",
    })
    this.render(force)
  }

  #syncPromptReferences(notify = true): boolean {
    const next = projectPromptReferences(this.state, this.#mediaRuntime.runtime)
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

  #publishRuntimeUpdate(): void {
    this.#viewBridge.publish()
    this.#syncPromptReferences()
  }

  #h3GuideDragSource(
    channel: H3GuideChannel,
    dataTransfer: DataTransfer | null,
  ): { id: string; item: MediaItem } | undefined {
    const source = readLoaderDragPayload(dataTransfer)
    if (!source || source.scope !== this.#dragScope) return undefined
    const item = this.state.items[source.id]
    const expectedChannel =
      source.channel === "image" ? "visual" : source.channel === "audio" ? "audio" : undefined
    if (!item || expectedChannel !== channel || !canUseAsH3Guide(item, channel)) return undefined
    return { id: source.id, item }
  }

  #requestH3Render(force = false, focus?: H3TimelineFocus): void {
    if (focus?.kind === "preserve-editor-focus") {
      this.#renderH3PreservingFocus(focus.guideId)
      return
    }
    this.render(force)
    if (!focus) return
    const surface = this.#viewBridge.interactionRoot ?? this.root
    if (focus.kind === "editor-guide") {
      this.#focusH3EditorGuide(focus.guideId)
      return
    }
    if (focus.kind === "workspace") {
      this.#focusH3Workspace()
      return
    }
    if (focus.kind === "timeline-guide") {
      const marker = [...surface.querySelectorAll<HTMLButtonElement>("[data-timeline-guide]")].find(
        (button) => button.dataset.timelineGuide === focus.guideId,
      )
      if (marker) {
        marker.focus({ preventScroll: true })
        return
      }
      surface
        .querySelector<HTMLButtonElement>(
          '[data-h3-action="select-placement"][data-h3-guide-id="' + focus.guideId + '"]',
        )
        ?.focus()
      return
    }
    if (focus.kind === "timeline-shot") {
      const mark = [...surface.querySelectorAll<HTMLButtonElement>("[data-timeline-shot]")].find(
        (button) => button.dataset.timelineShot === focus.tag,
      )
      if (focus.scroll) mark?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
      mark?.focus({ preventScroll: true })
      return
    }
    const parentId = focus.mediaId.endsWith(":audio") ? focus.mediaId.slice(0, -6) : focus.mediaId
    const action = focus.control === "toggle" ? "toggle-h3-guide" : "edit-h3-guide"
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      if (
        button.dataset.action === action &&
        button.dataset.id === parentId &&
        button.dataset.h3Channel === focus.channel
      ) {
        button.focus()
        return
      }
    }
  }

  #focusH3EditorGuide(guideId: string): void {
    for (const row of (this.#viewBridge.interactionRoot ?? this.root).querySelectorAll<HTMLElement>(
      "[data-h3-editor] [data-h3-guide-id]",
    )) {
      if (row.dataset.h3GuideId !== guideId) continue
      row.scrollIntoView?.({ block: "nearest" })
      row.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.focus()
      return
    }
  }

  #focusH3Workspace(): void {
    const workspace = (this.#viewBridge.interactionRoot ?? this.root).querySelector<HTMLElement>(
      "[data-h3-workspace]",
    )
    if (!workspace) return
    workspace.scrollIntoView?.({ block: "nearest" })
    workspace.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')?.focus({
      preventScroll: true,
    })
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
      for (const element of (this.#viewBridge.interactionRoot ?? this.root).querySelectorAll<
        HTMLInputElement | HTMLSelectElement
      >("[data-h3-draft-field]")) {
        if (element.dataset.h3DraftField === field && element.dataset.h3GuideId === guideId) {
          element.focus()
          return
        }
      }
    }
    if (focusGuideId) {
      for (const input of (
        this.#viewBridge.interactionRoot ?? this.root
      ).querySelectorAll<HTMLInputElement>('[data-h3-draft-field="frame"]')) {
        if (input.dataset.h3GuideId === focusGuideId) {
          input.focus()
          break
        }
      }
    }
  }
  #selectItem(id: string): void {
    this.#timelineSession.clearMediaSelection()
    this.#selectedId = id
    this.#viewBridge.publish()
    this.#viewBridge.update()
  }

  #clearAll(): void {
    const hadItems = Object.keys(this.state.items).length > 0
    const hadTimeline =
      this.state.h3Timeline.enabled ||
      this.state.h3Timeline.startImageId !== null ||
      this.state.h3Timeline.endImageId !== null ||
      this.state.h3Timeline.guides.length > 0
    if (!hadItems && !hadTimeline && this.#mediaRuntime.pending.size === 0) return
    this.#previewSurface.stopAll()
    this.#modalController?.abort()
    this.#mediaRuntime.resetForStateChange()
    this.#selectedId = undefined
    this.#deferPreviews = false
    this.#timelineSession.reset()
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
      if (this.#mediaRuntime.pending.size > 0) {
        this.#status = "Wait for the current image upload to finish."
        this.render()
        return
      }
      if (images.length > 1)
        this.#status = `${images.length - 1} additional image${images.length === 2 ? " was" : "s were"} skipped.`
      await this.#mediaRuntime.upload(images[0] as File, replaceId ?? this.state.imageOrder[0])
      return
    }
    if (replaceId && files.length === 1) {
      const target = this.state.items[replaceId]
      const kind = fileMediaKind(files[0] as File)
      if (target && kind === target.kind) {
        await this.#mediaRuntime.upload(files[0] as File, replaceId)
        return
      }
    }
    const counts = { image: 0, audio: 0, video: 0 }
    for (const item of Object.values(this.state.items)) counts[item.kind] += 1
    for (const pending of this.#mediaRuntime.pending.values()) {
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
    await Promise.allSettled(accepted.map((file) => this.#mediaRuntime.upload(file)))
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
      if (item) void this.#mediaRuntime.load(item)
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

  #commitUploadedMedia(
    uploaded: UploadedReference,
    replaceId?: string,
    uploadFilename = uploaded.source.path.split("/").pop() ?? "Media",
  ): MediaItem | undefined {
    if (this.#mode === "single-image" && uploaded.kind !== "image") {
      this.#status = `${uploadFilename}: the server did not recognize this as an image.`
      return undefined
    }
    const canonicalCount = Object.values(this.state.items).filter(
      (candidate) => candidate.kind === uploaded.kind,
    ).length
    const currentTarget = replaceId ? this.state.items[replaceId] : undefined
    if (replaceId && currentTarget?.kind !== uploaded.kind) {
      this.#status = `${uploadFilename}: the server identified a different media type, so the reference was not replaced.`
      return undefined
    }
    if (
      this.#mode !== "single-image" &&
      !replaceId &&
      canonicalCount >= MEDIA_LIMITS[uploaded.kind]
    ) {
      this.#status = `${uploadFilename}: the server identified this as ${uploaded.kind}, but that media limit is already full.`
      return undefined
    }
    const item = createMediaItem(uploaded.kind, uploaded.source, replaceId)
    if (replaceId) {
      this.#previewSurface.stopForItem(replaceId)
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
      ? `${uploadFilename} replaced the existing reference.`
      : this.#mode === "single-image"
        ? ""
        : `${uploadFilename} added.`
    return item
  }

  async #editItem(id: string, channel?: LoaderChannel): Promise<void> {
    const item = this.state.items[id]
    if (!item || this.#mediaRuntime.getRuntime(id)?.applyingEdit) return
    this.#previewSurface.stopAll()
    this.#modalController?.abort()
    const modalController = new AbortController()
    this.#modalController = modalController
    const runtime = this.#mediaRuntime.getRuntime(id)
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
          this.#mediaRuntime.invalidate(id)
          this.#mediaRuntime.setRuntime(id, { loading: true })
          this.#dispatch({
            type: "restore-image-original",
            id,
            caption: editorResult.caption,
          })
          this.render(true)
          const restored = this.state.items[id]
          if (restored) await this.#mediaRuntime.load(restored)
          return
        }
        this.#mediaRuntime.setRuntime(id, { ...runtime, loading: true, applyingEdit: true })
        this.render(true)
        this.#markDirty()
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
        this.#mediaRuntime.invalidate(id)
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
        this.#mediaRuntime.setRuntime(id, {
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
        this.#markDirty()
        if (!configuredPreviewIsCurrent) {
          const updated = this.state.items[id]
          if (updated) await this.#mediaRuntime.load(updated)
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
                  player: this.#previewSurface.getAudioEditorPlayback(),
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
        if (updated) await this.#mediaRuntime.load(updated)
      }
    } catch (error) {
      if (!this.#isEditCurrent(id, item, modalController)) return
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.#mediaRuntime.setRuntime(id, {
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
    if (
      !item ||
      item.kind !== "video" ||
      this.#mediaRuntime.getRuntime(id)?.metadata?.hasAudio === false
    )
      return
    this.#dispatch({ type: "toggle-video-audio", id })
    const next = this.state.items[id]
    if (next?.kind === "video") this.#previewSurface.setVideoMuted(id, !next.videoAudioEnabled)
  }

  #recordGraphChange(change: () => void): void {
    if (this.#changeEvents.recordGraphChange) {
      this.#changeEvents.recordGraphChange(change)
      return
    }
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

  #markDirty(): void {
    if (this.#changeEvents.markDirty) {
      this.#changeEvents.markDirty()
      return
    }
    this.#node.setDirtyCanvas(true, true)
  }

  #changed(reloadRuntime = false): void {
    if (this.#destroyed) return
    this.#finishStateChange()
    this.render()
    if (reloadRuntime) {
      for (const item of Object.values(this.state.items)) void this.#mediaRuntime.load(item)
    }
  }

  #finishStateChange(): void {
    if (this.#destroyed) return
    if (this.#selectedId && !this.state.items[this.#selectedId]) this.#selectedId = undefined
    this.#timelineSession.reconcile()
    for (const id of this.#mediaRuntime.runtime.keys()) {
      if (!this.state.items[id]) {
        this.#mediaRuntime.remove(id)
      }
    }
    this.#markDirty()
    this.#syncPromptReferences()
    this.#viewBridge.publish()
  }
}
