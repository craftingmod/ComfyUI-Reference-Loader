import type { ReferenceLoaderApi, UploadedReference } from "./api.ts"
import type { ItemRuntime, LoaderState, MediaItem } from "./types.ts"

export interface PendingMediaUpload {
  readonly id: string
  readonly file: File
  readonly objectUrl: string
}

export interface MediaRuntimeLoadOptions {
  renderStart?: boolean
  completionRender?: "immediate" | "scheduled"
}

export interface MediaRuntimeHost {
  getState(): LoaderState
  getApi(): ReferenceLoaderApi
  getPreviewMaxPixels(): number
  getWaveformPeaks(): number
  isDestroyed(): boolean
  setStatus(message: string): void
  render(): void
  scheduleRender(): void
  publishRuntimeUpdate(): void
  commitUploadedMedia(
    uploaded: UploadedReference,
    replaceId?: string,
    filename?: string,
  ): MediaItem | undefined
  commitRuntimeCapabilityChange(id: string): void
  onRuntimePreviewUpdated(): void
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

export class MediaRuntimeCoordinator {
  readonly #host: MediaRuntimeHost
  readonly #runtime = new Map<string, ItemRuntime>()
  readonly #runtimeSequences = new Map<string, number>()
  readonly #pending = new Map<string, PendingMediaUpload>()
  readonly #runtimeLimiter = new RuntimeLoadLimiter(4)
  #stateController = new AbortController()
  #runtimeSequence = 0
  #runtimeEpoch = 0
  #destroyed = false

  constructor(host: MediaRuntimeHost) {
    this.#host = host
  }

  get runtime(): ReadonlyMap<string, ItemRuntime> {
    return this.#runtime
  }

  get pending(): ReadonlyMap<string, PendingMediaUpload> {
    return this.#pending
  }

  getRuntime(id: string): ItemRuntime | undefined {
    return this.#runtime.get(id)
  }

  setRuntime(id: string, runtime: ItemRuntime): void {
    if (this.#destroyed) return
    this.#runtime.set(id, runtime)
  }

  remove(id: string): void {
    this.#runtime.delete(id)
    this.#invalidate(id)
  }

  invalidate(id: string): void {
    this.#invalidate(id)
  }

  resetForStateChange(): void {
    if (this.#destroyed) return
    this.#stateController.abort()
    this.#stateController = new AbortController()
    this.#runtimeEpoch += 1
    this.#clearPending()
    this.#runtime.clear()
    this.#runtimeSequences.clear()
    this.#runtimeSequence = 0
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#stateController.abort()
    this.#clearPending()
    this.#runtime.clear()
    this.#runtimeSequences.clear()
  }

  hydrate(items: readonly MediaItem[], options: MediaRuntimeLoadOptions = {}): void {
    if (this.#destroyed) return
    for (const item of items) this.#runtime.set(item.id, { loading: true })
    for (const item of items) void this.load(item, options)
  }

  async upload(file: File, replaceId?: string): Promise<void> {
    if (this.#destroyed) return
    const epoch = this.#runtimeEpoch
    const stateController = this.#stateController
    const id = `pending-${globalThis.crypto?.randomUUID?.() ?? Math.random()}`
    const objectUrl = URL.createObjectURL(file)
    this.#pending.set(id, { id, file, objectUrl })
    this.#host.setStatus(`Uploading ${file.name}…`)
    this.#host.render()
    try {
      const uploaded = await this.#host.getApi().upload(file, stateController.signal)
      if (!this.#isStateRequestCurrent(epoch, stateController)) return
      const item = this.#host.commitUploadedMedia(uploaded, replaceId, file.name)
      if (!item) return
      this.#runtime.set(item.id, { loading: true, metadata: uploaded.metadata })
      await this.load(item)
    } catch (error) {
      if (!this.#isStateRequestCurrent(epoch, stateController)) return
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.#host.setStatus(
          `${file.name}: ${error instanceof Error ? error.message : "Upload failed."}`,
        )
      }
    } finally {
      if (this.#pending.get(id)?.objectUrl === objectUrl) {
        this.#pending.delete(id)
        URL.revokeObjectURL(objectUrl)
      }
      if (this.#isStateRequestCurrent(epoch, stateController)) this.#host.render()
    }
  }

  async load(item: MediaItem, options: MediaRuntimeLoadOptions = {}): Promise<void> {
    if (this.#destroyed || this.#host.isDestroyed()) return
    const epoch = this.#runtimeEpoch
    const stateController = this.#stateController
    const sequence = ++this.#runtimeSequence
    this.#runtimeSequences.set(item.id, sequence)
    const current = this.#runtime.get(item.id) ?? { loading: true }
    const { error: _previousError, ...withoutError } = current
    this.#runtime.set(item.id, { ...withoutError, loading: true })
    if (options.renderStart !== false) this.#host.render()
    const release = await this.#runtimeLimiter.acquire(stateController.signal)
    if (!release) return
    try {
      if (!this.#isCurrent(item.id, sequence, epoch, stateController)) return
      const metadataPromise = this.#host.getApi().metadata(item.source, stateController.signal)
      const proxyPromise =
        item.kind === "image" || item.kind === "video"
          ? this.#host
              .getApi()
              .imageProxy(item.source, this.#host.getPreviewMaxPixels(), stateController.signal)
          : undefined
      const [metadata, proxy] = await Promise.all([metadataPromise, proxyPromise])
      if (!this.#isCurrent(item.id, sequence, epoch, stateController)) return
      if (item.kind === "video" && metadata.hasAudio === false)
        this.#host.commitRuntimeCapabilityChange(item.id)
      const waveform =
        item.kind === "audio" || (item.kind === "video" && metadata.hasAudio !== false)
          ? await this.#host
              .getApi()
              .waveform(
                item.source,
                this.#host.getWaveformPeaks(),
                item.crop,
                stateController.signal,
              )
          : undefined
      if (!this.#isCurrent(item.id, sequence, epoch, stateController)) return
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
      this.#host.onRuntimePreviewUpdated()
      this.#host.publishRuntimeUpdate()
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      if (!this.#isCurrent(item.id, sequence, epoch, stateController)) return
      this.#runtime.set(item.id, {
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "Preview failed.",
      })
      this.#host.onRuntimePreviewUpdated()
      this.#host.publishRuntimeUpdate()
    } finally {
      release()
    }
    if (options.completionRender === "scheduled") this.#host.scheduleRender()
    else this.#host.render()
  }

  #isStateRequestCurrent(epoch: number, controller: AbortController): boolean {
    return (
      !this.#destroyed &&
      !this.#host.isDestroyed() &&
      !controller.signal.aborted &&
      this.#stateController === controller &&
      this.#runtimeEpoch === epoch
    )
  }

  #isCurrent(id: string, sequence: number, epoch: number, controller: AbortController): boolean {
    return (
      this.#isStateRequestCurrent(epoch, controller) &&
      this.#runtimeSequences.get(id) === sequence &&
      Boolean(this.#host.getState().items[id])
    )
  }

  #invalidate(id: string): void {
    this.#runtimeSequences.set(id, ++this.#runtimeSequence)
  }

  #clearPending(): void {
    for (const pending of this.#pending.values()) URL.revokeObjectURL(pending.objectUrl)
    this.#pending.clear()
  }
}
