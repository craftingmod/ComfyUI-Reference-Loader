import type { ComfyNode } from "../../comfyui.ts"
import { ReferenceLoaderApi } from "../api.ts"
import { AudioPreviewPlayer } from "../audio-preview-player.ts"
import { openImageEditor } from "../editors/image-editor.ts"
import { openTrimEditor } from "../editors/trim-editor.ts"
import {
  canRedo,
  canUndo,
  commitHistory,
  createHistory,
  redoHistory,
  undoHistory,
  type HistoryState,
} from "../history.ts"
import type { PromptReference } from "../prompt-state.ts"
import { loaderReducer, type LoaderAction, type LoaderChannel } from "../reducer.ts"
import { deserializeLoaderState, serializeLoaderState } from "../serialization.ts"
import {
  createMediaItem,
  isAudioItem,
  type LoaderState,
  type ItemRuntime,
  type MediaItem,
} from "../types.ts"
import { VideoPreviewPlayer } from "../video-preview-player.ts"
import { isSilentWaveform } from "../waveform.ts"

interface PendingUpload {
  id: string
  file: File
  objectUrl: string
}

interface RuntimeLoadOptions {
  renderStart?: boolean
  completionRender?: "immediate" | "scheduled"
}

export interface LoaderChangeEvents {
  beforeChange?(): void
  afterChange?(): void
}

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

const DRAG_MIME = "application/x-reference-loader-item"
const NODE_PROPERTY_KEY = "referenceLoader"
const MEDIA_EXTENSIONS = {
  image: new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff"]),
  audio: new Set(["wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "mka"]),
  video: new Set(["mp4", "mkv", "webm", "mov", "avi"]),
} as const
const MEDIA_LIMITS = { image: 32, audio: 8, video: 4 } as const

function fileMediaKind(file: File): keyof typeof MEDIA_EXTENSIONS | undefined {
  const mimeMatch = /^(image|audio|video)\//.exec(file.type)
  if (mimeMatch) return mimeMatch[1] as keyof typeof MEDIA_EXTENSIONS
  const extension = file.name.split(".").pop()?.toLowerCase()
  if (!extension) return undefined
  for (const [kind, extensions] of Object.entries(MEDIA_EXTENSIONS)) {
    if ((extensions as ReadonlySet<string>).has(extension))
      return kind as keyof typeof MEDIA_EXTENSIONS
  }
  return undefined
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
  #history: HistoryState<LoaderState>
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
  #composing = false
  #renderPending = false
  #renderFrame: number | undefined
  #destroyed = false
  #changeEvents: LoaderChangeEvents
  #referenceListeners = new Set<() => void>()

  constructor(
    root: HTMLElement,
    node: ComfyNode,
    api: ReferenceLoaderApi,
    serialized: unknown,
    changeEvents: LoaderChangeEvents = {},
  ) {
    this.root = root
    this.#node = node
    this.#api = api
    this.#changeEvents = changeEvents
    const parsed = deserializeLoaderState(serialized)
    this.#history = createHistory(parsed.state)
    if (parsed.issues.length > 0) this.#status = parsed.issues.join(" ")
    this.#installEvents()
    this.#unsubscribeAudioPreview = this.#audioPreview.subscribe(() => this.#syncPlaybackUi())
    this.#unsubscribeVideoPreview = this.#videoPreview.subscribe(() => this.#syncPlaybackUi())
    this.#hydrateRestoredRuntime()
  }

  get state(): LoaderState {
    return this.#history.present
  }

  get displayState(): LoaderDisplayState {
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
    const references: PromptReference[] = []
    let ordinal = 0
    for (const id of this.state.imageOrder) {
      const item = this.state.items[id]
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
        ...(this.#runtime.get(id)?.previewUrl
          ? { previewUrl: this.#runtime.get(id)?.previewUrl }
          : {}),
      })
    }
    ordinal = 0
    for (const id of this.state.videoOrder) {
      const item = this.state.items[id]
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
        ...(this.#runtime.get(id)?.previewUrl
          ? { previewUrl: this.#runtime.get(id)?.previewUrl }
          : {}),
      })
    }
    ordinal = 0
    for (const id of this.state.audioOrder) {
      const item = this.state.items[id]
      if (!item || !isAudioItem(item) || !item.audioEnabled) continue
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

  subscribePromptReferences(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#referenceListeners.add(listener)
    listener()
    return () => this.#referenceListeners.delete(listener)
  }

  acceptsFileDrop(dataTransfer: DataTransfer | null): boolean {
    if (this.#destroyed || !hasFilePayload(dataTransfer)) return false
    const files = [...(dataTransfer?.files ?? [])]
    return files.length === 0 || files.some((file) => fileMediaKind(file) !== undefined)
  }

  async addDroppedFiles(files: Iterable<File>): Promise<boolean> {
    if (this.#destroyed) return false
    const dropped = [...files]
    if (!dropped.some((file) => fileMediaKind(file) !== undefined)) return false
    await this.#uploadFiles(dropped)
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
    this.#audioPreview.stop()
    this.#videoPreview.stop()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#stateController = new AbortController()
    this.#runtimeEpoch += 1
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    const parsed = deserializeLoaderState(serialized)
    this.#history = createHistory(parsed.state)
    this.#selectedId = undefined
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#runtimeSequence = 0
    this.#status = parsed.issues.length > 0 ? parsed.issues.join(" ") : "Workflow state restored."
    this.#cancelScheduledRender()
    this.#hydrateRestoredRuntime(true)
  }

  serialize(): string {
    return serializeLoaderState(this.state)
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
    this.#audioPreview.destroy()
    this.#videoPreview.destroy()
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#referenceListeners.clear()
    this.#dropTarget = undefined
    this.root.classList.remove("is-dragging", "is-file-dragging")
    this.root.replaceChildren()
  }

  render(force = false): void {
    if (this.#destroyed) return
    this.#cancelScheduledRender()
    const active = document.activeElement
    if (
      !force &&
      (this.#composing || (active instanceof HTMLTextAreaElement && this.root.contains(active)))
    ) {
      this.#renderPending = true
      return
    }
    this.#renderPending = false
    const state = this.state
    this.root.style.setProperty("--rl-card-aspect", state.ui.cardAspectRatio)
    this.root.style.setProperty("--rl-grid-columns", String(state.ui.gridColumns))
    this.root.style.setProperty("--rl-preview-fit", state.ui.previewFit)
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
          <label class="rl-primary rl-file-button">Add media<input type="file" accept="image/*,audio/*,video/*" multiple></label>
          <button type="button" data-action="undo" ${canUndo(this.#history) ? "" : "disabled"} title="Undo (Ctrl+Z)">↶ Undo</button>
          <button type="button" data-action="redo" ${canRedo(this.#history) ? "" : "disabled"} title="Redo (Ctrl+Shift+Z)">↷ Redo</button>
          <button type="button" class="rl-clear" data-action="clear" ${Object.keys(state.items).length > 0 || this.#pending.size > 0 ? "" : "disabled"} title="Clear all references (Undo available)">Clear</button>
        </section>
      </div>
      <p class="rl-status" role="status">${escapeHtml(this.#status)}</p>
      ${this.#pendingMarkup()}
      <div class="rl-channels">
        ${this.#channelMarkup("image", "Images", state.imageOrder)}
        ${this.#channelMarkup("video", "Videos", state.videoOrder)}
        ${this.#channelMarkup("audio", "Audio", state.audioOrder)}
      </div>`
    this.#drawWaveforms()
    this.#syncPlaybackUi()
    for (const listener of this.#referenceListeners) listener()
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

  #pendingMarkup(): string {
    if (this.#pending.size === 0) return ""
    return `<div class="rl-pending" aria-label="Pending uploads">${[...this.#pending.values()]
      .map(
        (pending) =>
          `<div><span class="rl-spinner" aria-hidden="true"></span><span>${escapeHtml(pending.file.name)}</span><small>Uploading…</small></div>`,
      )
      .join("")}</div>`
  }

  #channelMarkup(channel: LoaderChannel, label: string, order: string[]): string {
    let outputIndex = 0
    const cards = order
      .map((id) => {
        const item = this.state.items[id]
        const index = item && isChannelOutputEnabled(channel, item) ? ++outputIndex : undefined
        return this.#cardMarkup(channel, id, index)
      })
      .join("")
    const accepts: Record<LoaderChannel, string> = {
      image: "image/*",
      video: "video/*",
      audio: "audio/*",
    }
    const hasOpenCell = order.length > 0 && order.length % this.state.ui.gridColumns !== 0
    const addLabel = `Add ${label.toLowerCase()}`
    const addControl = `<label class="rl-grid-add ${hasOpenCell ? "is-tile" : "is-wide"}" title="${addLabel}">
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

  #cardMarkup(channel: LoaderChannel, id: string, outputIndex?: number): string {
    const item = this.state.items[id]
    if (!item) return ""
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
    const audioEnabled = isAudioItem(item) ? item.audioEnabled : false
    const outputEnabled = isChannelOutputEnabled(channel, item)
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
    return `<article class="rl-card${selected ? " is-selected" : ""}${runtime?.error ? " has-error" : ""}${outputEnabled ? "" : " is-output-disabled"}" data-id="${escapeHtml(id)}" data-channel="${channel}" data-output-enabled="${String(outputEnabled)}" tabindex="0" draggable="true" aria-selected="${String(selected)}">
      <div class="rl-card__media${channel === "image" && item.kind === "image" ? " is-transparent-preview" : ""}" title="Double-click to edit">${media}<div class="rl-media-badges"><span class="rl-kind rl-kind--${item.kind}">${item.kind}</span>${outputIndex === undefined ? "" : `<span class="rl-output-index" title="${labelForCaption(channel)} output #${outputIndex}">#${outputIndex}</span>`}${megapixels ? `<span class="rl-megapixels" title="Current source resolution: ${megapixels}">${megapixels}</span>` : ""}${duration ? `<span class="rl-duration">${duration}</span>` : ""}</div><span class="rl-media-filename" title="${escapeHtml(mediaFilename)}">${escapeHtml(mediaFilename)}</span><button type="button" class="rl-remove" data-action="remove" aria-label="Remove reference" title="Delete reference">×</button>${loading}</div>
      <div class="rl-card__body">
        ${showCaptionsProperty(this.#node) ? `<textarea data-field="caption" rows="2" maxlength="16384" placeholder="Caption" aria-label="${labelForCaption(channel)} caption">${escapeHtml(caption)}</textarea>` : ""}
        <div class="rl-card__actions">
        ${channel === "image" && item.kind === "image" ? `<button type="button" data-action="toggle-image" class="${imageEnabled ? "is-on" : ""}" aria-label="Toggle image output" aria-pressed="${String(imageEnabled)}">I</button>` : ""}
        ${channel === "video" && item.kind === "video" ? `<button type="button" data-action="toggle-video" class="${videoEnabled ? "is-on" : ""}" aria-label="Toggle video output" aria-pressed="${String(videoEnabled)}">V</button>` : ""}
        ${channel === "audio" && isAudioItem(item) ? `<button type="button" data-action="toggle-audio" class="${audioEnabled ? "is-on" : ""}" aria-label="Toggle audio output" aria-pressed="${String(audioEnabled)}"${silentVideo ? ' disabled title="No embedded audio track"' : ""}>A</button>` : ""}
        ${channel === "video" && item.kind === "video" ? `<button type="button" data-action="preview-video" data-playback-owner="${escapeHtml(playbackOwner)}" class="rl-preview-media${videoPlaybackActive ? " is-playing" : ""}" aria-label="${videoPlaybackActive ? "Stop" : "Play"} video preview with audio" title="${runtime?.loading || playbackDuration === undefined ? "Loading video preview" : videoPlaybackActive ? "Stop video preview" : "Play trimmed video preview with audio"}"${videoPlaybackDisabled ? " disabled" : ""}>${videoPlaybackActive ? "■" : "▶"}</button>` : ""}
        ${channel === "audio" && isAudioItem(item) ? `<button type="button" data-action="preview-audio" data-playback-owner="${escapeHtml(playbackOwner)}" class="rl-preview-media${audioPlaybackActive ? " is-playing" : ""}" aria-label="${audioPlaybackActive ? "Stop" : "Play"} audio preview" title="${silentVideo ? "No embedded audio track" : runtime?.loading || playbackDuration === undefined ? "Loading audio preview" : audioPlaybackActive ? "Stop audio preview" : "Play trimmed audio preview"}"${audioPlaybackDisabled ? " disabled" : ""}>${audioPlaybackActive ? "■" : "▶"}</button>` : ""}
        <button type="button" data-action="move-back" aria-label="Move earlier" title="Move earlier (Alt+ArrowLeft)">←</button><button type="button" data-action="move-forward" aria-label="Move later" title="Move later (Alt+ArrowRight)">→</button>
        <button type="button" class="rl-edit-button" data-action="edit" aria-label="Edit reference" title="Edit reference"${runtime?.applyingEdit ? " disabled" : ""}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13.5 6.5 4 4"></path></svg></button>
        </div>
        ${error}
      </div>
    </article>`
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
      button.setAttribute("aria-label", `${active ? "Stop" : "Play"} video preview with audio`)
      button.title = active ? "Stop video preview" : "Play trimmed video preview with audio"
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
          if (
            this.#renderPending &&
            !(
              document.activeElement instanceof HTMLTextAreaElement &&
              this.root.contains(document.activeElement)
            )
          ) {
            this.render()
          }
        }, 0)
      },
      { signal },
    )
    this.root.addEventListener("keydown", (event) => this.#onKeydown(event), { signal })
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
        }
      },
      { signal },
    )
    this.root.addEventListener("drop", (event) => this.#onDrop(event), { signal })
  }

  #onClick(event: MouseEvent): void {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]")
    if (!button) {
      const card = (event.target as Element).closest<HTMLElement>(".rl-card")
      if (card?.dataset.id && !(event.target instanceof HTMLTextAreaElement)) {
        this.#selectItem(card.dataset.id)
      }
      return
    }
    const card = button.closest<HTMLElement>(".rl-card")
    const id = card?.dataset.id
    const channel = card?.dataset.channel as LoaderChannel | undefined
    switch (button.dataset.action) {
      case "undo":
        this.#recordGraphChange(() => {
          this.#history = undoHistory(this.#history)
        })
        this.#changed(true)
        return
      case "redo":
        this.#recordGraphChange(() => {
          this.#history = redoHistory(this.#history)
        })
        this.#changed(true)
        return
      case "clear":
        this.#clearAll()
        return
      case "remove":
        if (id && this.#audioPreview.snapshot.owner === `grid:${id}`) this.#audioPreview.stop()
        if (id && this.#videoPreview.snapshot.owner === `grid:${id}`) this.#videoPreview.stop()
        if (id) this.#dispatch({ type: "remove", id })
        this.#runtime.delete(id ?? "")
        return
      case "toggle-image":
        if (id) this.#toggleOutput(id, "image")
        return
      case "toggle-video":
        if (id) this.#toggleOutput(id, "video")
        return
      case "toggle-audio":
        if (id) this.#toggleOutput(id, "audio")
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

  #onDoubleClick(event: MouseEvent): void {
    const target = event.target as Element
    if (target.closest("button, textarea, input, select, a, [contenteditable='true']")) return
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
  }

  #clearAll(): void {
    const hadItems = Object.keys(this.state.items).length > 0
    if (!hadItems && this.#pending.size === 0) return
    this.#audioPreview.stop()
    this.#videoPreview.stop()
    this.#modalController?.abort()
    this.#stateController.abort()
    this.#stateController = new AbortController()
    this.#runtimeEpoch += 1
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
    this.#selectedId = undefined
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#runtimeSequence = 0
    this.#status = hadItems
      ? "All references cleared. Undo is available."
      : "Pending uploads cleared."
    if (hadItems) this.#dispatch({ type: "clear" })
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
      )
    } catch (error) {
      if (this.#destroyed) return
      this.#status = `${itemFilename(item)}: ${error instanceof Error ? error.message : "Video preview failed."}`
      this.render()
    }
  }

  #onInput(event: Event): void {
    const textarea = event.target
    if (!(textarea instanceof HTMLTextAreaElement) || textarea.dataset.field !== "caption") return
    const card = textarea.closest<HTMLElement>(".rl-card")
    const id = card?.dataset.id
    const channel = card?.dataset.channel as LoaderChannel | undefined
    if (!id || !channel) return
    const next = loaderReducer(this.state, {
      type: "set-caption",
      id,
      caption: textarea.value,
      channel,
    })
    if (next === this.state) return
    this.#recordGraphChange(() => {
      this.#history = commitHistory(this.#history, next, {
        mergeKey: this.#composing ? `ime:${channel}:${id}` : `caption:${channel}:${id}`,
      })
    })
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
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.type !== "file") return
    const expectedKind = input.dataset.uploadKind
    const files = [...(input.files ?? [])].filter(
      (file) => !expectedKind || fileMediaKind(file) === expectedKind,
    )
    input.value = ""
    void this.#uploadFiles(files)
  }

  #onKeydown(event: KeyboardEvent): void {
    const card = (event.target as Element).closest<HTMLElement>(".rl-card")
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
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
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

  #onDrop(event: DragEvent): void {
    this.#clearDropTarget()
    this.root.classList.remove("is-file-dragging")
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length > 0) {
      if (!files.some((file) => fileMediaKind(file) !== undefined)) return
      event.preventDefault()
      void this.addDroppedFiles(files)
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

  async #uploadFiles(files: File[]): Promise<void> {
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
    const disable = (state: LoaderState): LoaderState => {
      const candidate = state.items[id]
      return candidate?.kind === "video" && candidate.audioEnabled
        ? loaderReducer(state, { type: "toggle", id, channel: "audio" })
        : state
    }
    const present = disable(this.#history.present)
    if (present === this.#history.present) return
    this.#recordGraphChange(() => {
      this.#history = {
        ...this.#history,
        past: this.#history.past.map(disable),
        present,
        future: this.#history.future.map(disable),
      }
    })
    this.#node.setDirtyCanvas(true, true)
  }

  async #uploadFile(file: File): Promise<void> {
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
      const canonicalCount = Object.values(this.state.items).filter(
        (candidate) => candidate.kind === uploaded.kind,
      ).length
      if (canonicalCount >= MEDIA_LIMITS[uploaded.kind]) {
        this.#status = `${file.name}: the server identified this as ${uploaded.kind}, but that media limit is already full.`
        return
      }
      let item = createMediaItem(uploaded.kind, uploaded.source)
      const addedDisabled =
        item.kind === "image" && twoImageModeProperty(this.#node) && this.#activeImageCount() >= 2
      if (addedDisabled && item.kind === "image") item = { ...item, imageEnabled: false }
      this.#runtime.set(item.id, { loading: true, metadata: uploaded.metadata })
      this.#dispatch({ type: "add", item })
      this.#selectedId = item.id
      this.#status = addedDisabled
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
          ...(result.proxyUrl
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
        this.render(true)
        // The proxy URL arrives after the graph-backed edit state has already
        // dirtied the canvas. Notify ComfyUI again after replacing the card DOM
        // so its DOM-widget draw pass observes the new thumbnail immediately.
        this.#node.setDirtyCanvas(true, true)
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

  #dispatch(action: LoaderAction): void {
    if (this.#destroyed) return
    const next = loaderReducer(this.state, action)
    if (next === this.state) return
    this.#recordGraphChange(() => {
      this.#history = commitHistory(this.#history, next)
    })
    this.#changed()
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
    if (this.#selectedId && !this.state.items[this.#selectedId]) this.#selectedId = undefined
    for (const id of this.#runtime.keys()) {
      if (!this.state.items[id]) {
        this.#runtime.delete(id)
        this.#invalidateRuntime(id)
        this.#runtimeSequences.delete(id)
      }
    }
    this.#node.setDirtyCanvas(true, true)
    this.render()
    if (reloadRuntime) {
      for (const item of Object.values(this.state.items)) void this.#loadRuntime(item)
    }
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
