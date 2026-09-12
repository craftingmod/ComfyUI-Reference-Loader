import { createElement } from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import type { AudioPreviewPlayer, AudioPreviewSnapshot } from "../audio-preview-player.ts"
import { LocalHistory } from "../history.ts"
import type { TimeRange } from "../types.ts"
import { VideoPreviewPlayer, type VideoPreviewSnapshot } from "../video-preview-player.ts"
import { isSilentWaveform } from "../waveform.ts"
import {
  TrimEditorDialog,
  type TrimEditorReactActions,
  type TrimEditorReactState,
  type TrimEditorTransportRef,
} from "./trim-editor-react.tsx"

export interface TrimEditorOptions {
  kind: "audio" | "video"
  filename: string
  duration: number
  caption: string
  crop?: TimeRange
  waveform?: ReadonlyArray<readonly [number, number]>
  playback?: {
    player: AudioPreviewPlayer
    owner: string
    url: string
    enabled: boolean
  }
  video?: {
    owner: string
    url: string
    hasAudio: boolean
    muted?: boolean
  }
  signal?: AbortSignal
}

export interface TrimEditorResult {
  crop: TimeRange
  caption: string
}

const MIN_RANGE_SECONDS = 0.01
const VIDEO_SEEK_INTERVAL_MS = 100

function drawWaveform(
  canvas: HTMLCanvasElement,
  pairs: ReadonlyArray<readonly [number, number]>,
  compact: boolean,
): void {
  const width = 900
  const height = compact ? 90 : 180
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) return
  context.clearRect(0, 0, width, height)
  context.fillStyle = "#141821"
  context.fillRect(0, 0, width, height)
  if (isSilentWaveform(pairs)) {
    context.strokeStyle = "#596273"
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(0, height / 2)
    context.lineTo(width, height / 2)
    context.stroke()
    return
  }
  context.strokeStyle = "#8eb9ff"
  context.lineWidth = 1
  context.beginPath()
  pairs.forEach(([minimum, maximum], index) => {
    const x = (index / Math.max(1, pairs.length - 1)) * width
    context.moveTo(x, height / 2 - maximum * height * 0.45)
    context.lineTo(x, height / 2 - minimum * height * 0.45)
  })
  context.stroke()
}

function sameRange(left: TimeRange, right: TimeRange): boolean {
  return left.start === right.start && left.end === right.end
}

function clampSeekPosition(range: TimeRange, value: number): number {
  return Math.max(range.start, Math.min(range.end, value))
}

function sliderRange(
  current: TimeRange,
  field: "start" | "end",
  value: number,
  duration: number,
): TimeRange {
  if (field === "start") {
    return { ...current, start: Math.max(0, Math.min(current.end - MIN_RANGE_SECONDS, value)) }
  }
  return { ...current, end: Math.min(duration, Math.max(current.start + MIN_RANGE_SECONDS, value)) }
}

export function openTrimEditor(options: TrimEditorOptions): Promise<TrimEditorResult | null> {
  return new Promise((resolve) => {
    const duration = Math.max(MIN_RANGE_SECONDS, options.duration)
    const initialRange = options.crop ?? { start: 0, end: duration }
    const history = new LocalHistory(initialRange)
    let draft = history.value
    let seekPosition = draft.start
    let seekTouched = false
    let wasOwningPlayback = false
    const videoPlayer = options.video
      ? new VideoPreviewPlayer(document.createElement("video"), { retainSourceOnEnd: true })
      : undefined
    const playbackPlayer = videoPlayer ?? options.playback?.player
    const playbackOwner = options.video?.owner ?? options.playback?.owner
    const playbackUrl = options.video?.url ?? options.playback?.url
    const playbackEnabled = Boolean(videoPlayer) || options.playback?.enabled === true
    const noAudioTrack = options.kind === "video" && options.video?.hasAudio === false
    const silent = !noAudioTrack && isSilentWaveform(options.waveform)
    const waveformStatus = noAudioTrack ? "No audio track" : silent ? "Silent" : undefined
    const dialog = document.createElement("dialog")
    dialog.className = `rl-modal rl-trim-editor${options.kind === "video" ? " rl-video-trim-editor" : ""}`
    dialog.setAttribute("aria-label", `${options.kind} trim editor`)
    let caption = options.caption
    let rangeError: string | undefined
    let playbackError: string | undefined
    let root: Root | undefined
    let transportRef: TrimEditorTransportRef | undefined
    if (videoPlayer && options.video) {
      videoPlayer.element.setAttribute(
        "aria-label",
        options.video.muted
          ? "Muted video trim preview"
          : "Video trim preview with audio when available",
      )
      videoPlayer.element.addEventListener("loadedmetadata", () => {
        videoPlayer.seek(options.video?.owner ?? "", seekPosition)
      })
      videoPlayer.prepare(
        options.video.owner,
        options.video.url,
        initialRange,
        initialRange.start,
        {
          muted: options.video.muted,
        },
      )
    }
    let settled = false
    let pendingVideoSeek: number | undefined
    let videoSeekTimer: ReturnType<typeof setTimeout> | undefined
    let lastVideoSeekAt = Number.NEGATIVE_INFINITY

    const flushVideoSeek = (): void => {
      if (!videoPlayer || !playbackOwner || pendingVideoSeek === undefined) return
      const position = pendingVideoSeek
      pendingVideoSeek = undefined
      if (videoSeekTimer !== undefined) {
        clearTimeout(videoSeekTimer)
        videoSeekTimer = undefined
      }
      lastVideoSeekAt = globalThis.performance?.now?.() ?? Date.now()
      videoPlayer.seek(playbackOwner, position)
    }

    const scheduleVideoSeek = (position: number, immediate: boolean = false): void => {
      if (!videoPlayer) return
      pendingVideoSeek = position
      const now = globalThis.performance?.now?.() ?? Date.now()
      const remaining = VIDEO_SEEK_INTERVAL_MS - (now - lastVideoSeekAt)
      if (immediate || remaining <= 0) {
        flushVideoSeek()
      } else if (videoSeekTimer === undefined) {
        videoSeekTimer = setTimeout(flushVideoSeek, remaining)
      }
    }

    const renderTransport = (
      snapshot?: AudioPreviewSnapshot | VideoPreviewSnapshot,
      preferSeekPosition: boolean = false,
    ): void => {
      const ownsPlayback = snapshot?.owner === playbackOwner
      if (ownsPlayback && !preferSeekPosition) {
        seekPosition = clampSeekPosition(draft, snapshot?.currentTime ?? seekPosition)
      } else if (!ownsPlayback && wasOwningPlayback && snapshot?.status === "idle") {
        seekPosition = draft.start
        seekTouched = false
      }
      wasOwningPlayback = ownsPlayback
      if (ownsPlayback) playbackError = snapshot?.error
      transportRef?.update({
        duration,
        range: draft,
        seekPosition,
        seekTouched,
        playbackEnabled,
        playback: ownsPlayback ? snapshot : undefined,
        playbackError,
      })
    }

    const render = (preferSeekPosition: boolean = false): void => {
      seekPosition = clampSeekPosition(draft, seekPosition)
      renderTransport(playbackPlayer?.snapshot, preferSeekPosition)
      const snapshot = playbackPlayer?.snapshot
      const ownsPlayback = snapshot?.owner === playbackOwner
      const state: TrimEditorReactState = {
        kind: options.kind,
        filename: options.filename,
        duration,
        caption,
        range: draft,
        seekPosition,
        seekTouched,
        waveformStatus,
        historyCanUndo: history.canUndo,
        historyCanRedo: history.canRedo,
        rangeError,
        playbackError,
        playbackEnabled,
        playback: ownsPlayback ? snapshot : undefined,
        videoElement: videoPlayer?.element,
      }
      if (root) flushSync(() => root?.render(createElement(TrimEditorDialog, { state, actions })))
    }

    const unsubscribePlayback = playbackPlayer?.subscribe((snapshot) => {
      if (!settled) renderTransport(snapshot)
    })
    const finish = (value: TrimEditorResult | null): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener("abort", onAbort)
      unsubscribePlayback?.()
      if (videoSeekTimer !== undefined) clearTimeout(videoSeekTimer)
      if (videoPlayer) videoPlayer.destroy()
      else if (options.playback) options.playback.player.stop(options.playback.owner)
      root?.unmount()
      dialog.remove()
      resolve(value)
    }
    const onAbort = (): void => finish(null)
    const showRangeError = (): void => {
      rangeError = "The end must be at least 0.01 seconds after the start."
    }
    const clearRangeError = (): void => {
      rangeError = undefined
    }
    const commitDraft = (): void => {
      if (!sameRange(history.value, draft)) history.commit(draft)
      clearRangeError()
      render()
    }

    const actions: TrimEditorReactActions = {
      onCanvas(nextCanvas) {
        if (nextCanvas) drawWaveform(nextCanvas, options.waveform ?? [], options.kind === "video")
      },
      onTransportRef(ref) {
        transportRef = ref ?? undefined
      },
      onRangeInput(field, value) {
        if (!Number.isFinite(value)) return
        draft = sliderRange(draft, field, value, duration)
        seekPosition = clampSeekPosition(draft, seekPosition)
        if (playbackPlayer && playbackOwner) playbackPlayer.setRange(playbackOwner, draft)
        clearRangeError()
        render()
      },
      onRangeChange() {
        commitDraft()
      },
      onNumberInput(field, value) {
        if (!Number.isFinite(value)) return
        const next = field === "start" ? { ...draft, start: value } : { ...draft, end: value }
        if (next.end - next.start < MIN_RANGE_SECONDS) return
        draft = {
          start: Math.max(0, Math.min(duration, next.start)),
          end: Math.max(0, Math.min(duration, next.end)),
        }
        seekPosition = clampSeekPosition(draft, seekPosition)
        if (playbackPlayer && playbackOwner) playbackPlayer.setRange(playbackOwner, draft)
        clearRangeError()
        render()
      },
      onNumberChange(field, value) {
        if (!Number.isFinite(value)) return
        const next = field === "start" ? { ...draft, start: value } : { ...draft, end: value }
        if (next.end - next.start < MIN_RANGE_SECONDS) {
          showRangeError()
          render()
          return
        }
        draft = {
          start: Math.max(0, Math.min(duration, next.start)),
          end: Math.max(0, Math.min(duration, next.end)),
        }
        seekPosition = clampSeekPosition(draft, seekPosition)
        if (playbackPlayer && playbackOwner) playbackPlayer.setRange(playbackOwner, draft)
        commitDraft()
      },
      onSeekInput(value) {
        if (!Number.isFinite(value)) return
        seekPosition = clampSeekPosition(draft, value)
        seekTouched = true
        if (videoPlayer) scheduleVideoSeek(seekPosition)
        else if (options.playback)
          options.playback.player.seek(options.playback.owner, seekPosition)
        renderTransport(playbackPlayer?.snapshot, true)
      },
      onSeekChange(value) {
        if (Number.isFinite(value)) seekPosition = clampSeekPosition(draft, value)
        if (videoPlayer) scheduleVideoSeek(seekPosition, true)
      },
      onCaptionChange(value) {
        caption = value.slice(0, 16_384)
        render()
      },
      onPlaybackToggle() {
        if (!playbackEnabled || !playbackPlayer || !playbackOwner || !playbackUrl) return
        const snapshot = playbackPlayer.snapshot
        if (snapshot.owner === playbackOwner && snapshot.status === "playing") {
          playbackPlayer.pause(playbackOwner)
          return
        }
        playbackError = undefined
        render()
        void playbackPlayer
          .play(playbackOwner, playbackUrl, draft, seekPosition, { muted: options.video?.muted })
          .catch(() => undefined)
      },
      onStop() {
        seekPosition = draft.start
        seekTouched = false
        if (videoPlayer && playbackOwner) videoPlayer.reset(playbackOwner)
        else if (options.playback) options.playback.player.stop(options.playback.owner)
        render()
      },
      onUndo() {
        draft = history.undo()
        seekPosition = clampSeekPosition(draft, seekPosition)
        if (playbackPlayer && playbackOwner) playbackPlayer.setRange(playbackOwner, draft)
        render()
      },
      onRedo() {
        draft = history.redo()
        seekPosition = clampSeekPosition(draft, seekPosition)
        if (playbackPlayer && playbackOwner) playbackPlayer.setRange(playbackOwner, draft)
        render()
      },
      onCancel() {
        finish(null)
      },
      onApply(nextCaption) {
        finish({ crop: draft, caption: nextCaption.slice(0, 16_384) })
      },
    }

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !history.canUndo && !history.canRedo) finish(null)
    })
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault()
      finish(null)
    })
    options.signal?.addEventListener("abort", onAbort, { once: true })
    document.body.append(dialog)
    root = createRoot(dialog)
    render()
    if (typeof dialog.showModal === "function") dialog.showModal()
    else dialog.setAttribute("open", "")
    if (options.signal?.aborted) finish(null)
  })
}
