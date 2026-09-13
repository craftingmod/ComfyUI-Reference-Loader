import { AudioPreviewPlayer } from "./audio-preview-player.ts"
import type { ItemRuntime, MediaItem } from "./types.ts"
import { isAudioItem } from "./types.ts"
import { VideoPreviewPlayer } from "./video-preview-player.ts"
import { isSilentWaveform } from "./waveform.ts"

export interface PreviewSurfaceHost {
  getRoot(): HTMLElement
  getItem(id: string): MediaItem | undefined
  getRuntime(id: string): ItemRuntime | undefined
  getAudioPreviewUrl(item: MediaItem): string
  getVideoPreviewUrl(item: MediaItem): string
  isDestroyed(): boolean
  setStatus(message: string): void
  requestRender(): void
}

function itemFilename(item: MediaItem): string {
  return item.sourceFilename || item.source.path.split("/").pop() || item.source.path
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

export class PreviewSurfaceBridge {
  readonly #host: PreviewSurfaceHost
  readonly #audioPreview = new AudioPreviewPlayer()
  readonly #videoPreview = new VideoPreviewPlayer()
  #waveformResizeObserver: ResizeObserver | undefined
  #unsubscribeAudioPreview: (() => void) | undefined
  #unsubscribeVideoPreview: (() => void) | undefined
  #destroyed = false

  constructor(host: PreviewSurfaceHost) {
    this.#host = host
    if (typeof ResizeObserver !== "undefined") {
      this.#waveformResizeObserver = new ResizeObserver(() => this.#drawWaveforms())
      this.#waveformResizeObserver.observe(host.getRoot())
    }
    this.#unsubscribeAudioPreview = this.#audioPreview.subscribe(() => this.#syncPlaybackUi())
    this.#unsubscribeVideoPreview = this.#videoPreview.subscribe(() => this.#syncPlaybackUi())
  }

  getAudioEditorPlayback(): AudioPreviewPlayer {
    return this.#audioPreview
  }

  syncAfterRender(): void {
    if (this.#destroyed) return
    this.#drawWaveforms()
    this.#syncPlaybackUi()
  }

  previewAudio(id: string): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    void this.#toggleAudioPreview(id)
  }

  previewVideo(id: string): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    void this.#toggleVideoPreview(id)
  }

  stopForItem(id: string): void {
    for (const owner of [`grid:${id}`, `editor:${id}`]) {
      this.#audioPreview.stop(owner)
      this.#videoPreview.stop(owner)
    }
  }

  stopAll(): void {
    if (this.#destroyed) return
    this.#audioPreview.stop()
    this.#videoPreview.stop()
  }

  setVideoMuted(id: string, muted: boolean): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    this.#videoPreview.setMuted(`grid:${id}`, muted)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#waveformResizeObserver?.disconnect()
    this.#waveformResizeObserver = undefined
    this.#unsubscribeAudioPreview?.()
    this.#unsubscribeVideoPreview?.()
    this.#unsubscribeAudioPreview = undefined
    this.#unsubscribeVideoPreview = undefined
    this.#audioPreview.destroy()
    this.#videoPreview.destroy()
  }

  #drawWaveforms(): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    for (const canvas of this.#host
      .getRoot()
      .querySelectorAll<HTMLCanvasElement>("canvas[data-waveform-id]")) {
      const id = canvas.dataset.waveformId
      if (id) drawWaveform(canvas, this.#host.getRuntime(id)?.waveform ?? [])
    }
  }

  #syncPlaybackUi(): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    const root = this.#host.getRoot()
    const audioSnapshot = this.#audioPreview.snapshot
    for (const button of root.querySelectorAll<HTMLButtonElement>(
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
    for (const button of root.querySelectorAll<HTMLButtonElement>(
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
      const item = id ? this.#host.getItem(id) : undefined
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
      for (const poster of root.querySelectorAll("img.is-video-poster-hidden")) {
        poster.classList.remove("is-video-poster-hidden")
      }
    }
  }

  async #toggleAudioPreview(id: string): Promise<void> {
    const item = this.#host.getItem(id)
    const runtime = this.#host.getRuntime(id)
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
          ? this.#host.getVideoPreviewUrl(item)
          : this.#host.getAudioPreviewUrl(item)
      await this.#audioPreview.play(owner, url, item.crop ?? { start: 0, end: duration })
    } catch (error) {
      if (this.#destroyed || this.#host.isDestroyed()) return
      this.#host.setStatus(
        `${itemFilename(item)}: ${error instanceof Error ? error.message : "Audio preview failed."}`,
      )
      this.#host.requestRender()
    }
  }

  async #toggleVideoPreview(id: string): Promise<void> {
    const item = this.#host.getItem(id)
    const runtime = this.#host.getRuntime(id)
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
        this.#host.getVideoPreviewUrl(item),
        item.crop ?? { start: 0, end: duration },
        undefined,
        { muted: !item.videoAudioEnabled },
      )
    } catch (error) {
      if (this.#destroyed || this.#host.isDestroyed()) return
      this.#host.setStatus(
        `${itemFilename(item)}: ${error instanceof Error ? error.message : "Video preview failed."}`,
      )
      this.#host.requestRender()
    }
  }
}
