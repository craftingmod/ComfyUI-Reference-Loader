import { useLayoutEffect, useRef, type ReactNode } from "react"

import type { AudioPreviewSnapshot } from "../audio-preview-player.ts"
import { useI18n } from "../i18n.ts"
import type { TimeRange } from "../types.ts"
import { Button } from "../ui/button.tsx"
import { EditorFooter } from "../ui/editor-footer.tsx"
import { Field } from "../ui/field.tsx"
import { StatusMessage } from "../ui/status-message.tsx"
import type { VideoPreviewSnapshot } from "../video-preview-player.ts"

export interface TrimEditorReactState {
  kind: "audio" | "video"
  filename: string
  duration: number
  caption: string
  range: TimeRange
  seekPosition: number
  seekTouched: boolean
  waveformStatus?: string
  historyCanUndo: boolean
  historyCanRedo: boolean
  rangeError?: string
  playbackError?: string
  playbackEnabled: boolean
  playback?: AudioPreviewSnapshot | VideoPreviewSnapshot
  videoElement?: HTMLVideoElement
}

export interface TrimEditorTransportState {
  duration: number
  range: TimeRange
  seekPosition: number
  seekTouched: boolean
  playbackEnabled: boolean
  playback?: AudioPreviewSnapshot | VideoPreviewSnapshot
  playbackError?: string
}

export interface TrimEditorTransportRef {
  update(state: TrimEditorTransportState): void
}

export interface TrimEditorReactActions {
  onCanvas(canvas: HTMLCanvasElement | null): void
  onTransportRef(ref: TrimEditorTransportRef | null): void
  onRangeInput(field: "start" | "end", value: number): void
  onRangeChange(field: "start" | "end"): void
  onNumberInput(field: "start" | "end", value: number): void
  onNumberChange(field: "start" | "end", value: number): void
  onSeekInput(value: number): void
  onSeekChange(value: number): void
  onCaptionChange(value: string): void
  onPlaybackToggle(): void
  onStop(): void
  onUndo(): void
  onRedo(): void
  onCancel(): void
  onApply(caption: string): void
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const minutes = Math.floor(safe / 60)
  return `${minutes}:${(safe % 60).toFixed(2).padStart(5, "0")}`
}

export function TrimEditorDialog({
  state,
  actions,
}: {
  state: TrimEditorReactState
  actions: TrimEditorReactActions
}): ReactNode {
  const { t } = useI18n()
  const captionRef = useRef<HTMLTextAreaElement>(null)
  const videoHostRef = useRef<HTMLDivElement>(null)
  const rangeStartRef = useRef<HTMLInputElement>(null)
  const rangeEndRef = useRef<HTMLInputElement>(null)
  const seekRef = useRef<HTMLInputElement>(null)
  const startRef = useRef<HTMLInputElement>(null)
  const endRef = useRef<HTMLInputElement>(null)
  const playbackToggleRef = useRef<HTMLButtonElement>(null)
  const stopRef = useRef<HTMLButtonElement>(null)
  const outputRef = useRef<HTMLOutputElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const playbackErrorRef = useRef<HTMLParagraphElement>(null)

  useLayoutEffect(() => {
    const host = videoHostRef.current
    const video = state.videoElement
    if (host && video && video.parentElement !== host) host.append(video)
  }, [state.videoElement])

  useLayoutEffect(() => {
    const bindings: Array<[HTMLInputElement | null, () => void]> = [
      [rangeStartRef.current, () => actions.onRangeChange("start")],
      [rangeEndRef.current, () => actions.onRangeChange("end")],
      [seekRef.current, () => actions.onSeekChange(seekRef.current?.valueAsNumber ?? Number.NaN)],
      [
        startRef.current,
        () => actions.onNumberChange("start", startRef.current?.valueAsNumber ?? Number.NaN),
      ],
      [
        endRef.current,
        () => actions.onNumberChange("end", endRef.current?.valueAsNumber ?? Number.NaN),
      ],
    ]
    for (const [input, listener] of bindings) input?.addEventListener("change", listener)
    return () => {
      for (const [input, listener] of bindings) input?.removeEventListener("change", listener)
    }
  }, [actions])

  useLayoutEffect(() => {
    const transport: TrimEditorTransportRef = {
      update(next) {
        const playback = next.playback
        const ownsPlayback = playback !== undefined
        const playing = ownsPlayback && playback.status === "playing"
        const loading = ownsPlayback && playback.status === "loading"
        const paused = ownsPlayback && playback.status === "paused"
        const noun = state.kind === "video" ? "video" : "audio"
        if (seekRef.current) {
          seekRef.current.min = String(next.range.start)
          seekRef.current.max = String(next.range.end)
          seekRef.current.value = String(next.seekPosition)
          seekRef.current.disabled = !next.playbackEnabled
        }
        if (playbackToggleRef.current) {
          playbackToggleRef.current.disabled = !next.playbackEnabled || loading
          playbackToggleRef.current.textContent = loading
            ? "Loading…"
            : playing
              ? "Ⅱ Pause"
              : paused
                ? "▶ Resume"
                : "▶ Play"
          playbackToggleRef.current.setAttribute(
            "aria-label",
            loading
              ? `Loading ${noun} preview`
              : playing
                ? `Pause ${noun} preview`
                : paused
                  ? `Resume ${noun} preview`
                  : `Play ${noun} preview`,
          )
        }
        if (stopRef.current) stopRef.current.disabled = !(playing || loading || paused)
        if (outputRef.current)
          outputRef.current.textContent = `${formatTime(next.seekPosition)} / ${formatTime(next.range.end)}`
        if (playheadRef.current) {
          playheadRef.current.hidden = !(playing || loading || paused || next.seekTouched)
          playheadRef.current.style.left = `${(Math.max(0, Math.min(next.duration, next.seekPosition)) / next.duration) * 100}%`
        }
        if (playbackErrorRef.current) {
          playbackErrorRef.current.hidden = !next.playbackError
          playbackErrorRef.current.textContent = next.playbackError ?? ""
        }
      },
    }
    actions.onTransportRef(transport)
    return () => actions.onTransportRef(null)
  }, [actions, state.kind])

  const playback = state.playback
  const ownsPlayback = playback !== undefined
  const playing = ownsPlayback && playback.status === "playing"
  const loading = ownsPlayback && playback.status === "loading"
  const paused = ownsPlayback && playback.status === "paused"
  const playbackNoun =
    state.kind === "video" ? t("video").toLocaleLowerCase() : t("audio").toLocaleLowerCase()
  const current = state.seekPosition
  const showPlayhead = playing || loading || paused || state.seekTouched

  return (
    <form method="dialog" className="rl-modal__panel">
      <header>
        <div>
          <strong>{t("trim", { kind: state.kind === "video" ? t("video") : t("audio") })}</strong>
          <small>{t("trimSubtitle")}</small>
          <small className="rl-modal__filename">{t("file", { filename: state.filename })}</small>
        </div>
        <Button
          type="button"
          data-action="cancel"
          aria-label={t("close")}
          onClick={actions.onCancel}
        >
          ×
        </Button>
      </header>
      {state.kind === "video" ? (
        <div
          ref={videoHostRef}
          className="rl-trim-video-preview"
          aria-label={t("videoFramePreview")}
        />
      ) : null}
      <div className="rl-trim-timeline">
        <canvas
          ref={actions.onCanvas}
          aria-label={
            state.waveformStatus
              ? `${state.waveformStatus} ${t("waveformPreview")}`
              : t("waveformPreview")
          }
        />
        {state.waveformStatus ? (
          <span className="rl-waveform-status" aria-hidden="true">
            {state.waveformStatus}
          </span>
        ) : null}
        <div
          className="rl-trim-selection"
          aria-hidden="true"
          style={{
            left: `${(state.range.start / state.duration) * 100}%`,
            right: `${(1 - state.range.end / state.duration) * 100}%`,
          }}
        />
        <div
          ref={playheadRef}
          className="rl-trim-playhead"
          aria-hidden="true"
          hidden={!showPlayhead}
          style={{
            left: `${(Math.max(0, Math.min(state.duration, current)) / state.duration) * 100}%`,
          }}
        />
        <input
          ref={rangeStartRef}
          className="rl-trim-range rl-trim-range--start"
          data-field="range-start"
          type="range"
          min="0"
          max={state.duration}
          step="0.01"
          value={state.range.start}
          aria-label={t("trimStart")}
          onInput={(event) => actions.onRangeInput("start", event.currentTarget.valueAsNumber)}
        />
        <input
          ref={rangeEndRef}
          className="rl-trim-range rl-trim-range--end"
          data-field="range-end"
          type="range"
          min="0"
          max={state.duration}
          step="0.01"
          value={state.range.end}
          aria-label={t("trimEnd")}
          onInput={(event) => actions.onRangeInput("end", event.currentTarget.valueAsNumber)}
        />
      </div>
      <Field label={t("seek")} className="rl-trim-seekbar">
        <input
          ref={seekRef}
          data-field="seek"
          type="range"
          min={state.range.start}
          max={state.range.end}
          step="0.01"
          value={current}
          aria-label={t("playbackPosition", { kind: playbackNoun })}
          disabled={!state.playbackEnabled}
          onInput={(event) => actions.onSeekInput(event.currentTarget.valueAsNumber)}
        />
      </Field>
      <div className="rl-trim-transport" aria-label={t("previewControls", { kind: playbackNoun })}>
        <Button
          ref={playbackToggleRef}
          type="button"
          data-action="playback-toggle"
          aria-label={
            loading
              ? t("loadingPreview", { kind: playbackNoun })
              : playing
                ? t("pausePreview", { kind: playbackNoun })
                : paused
                  ? t("resumePreview", { kind: playbackNoun })
                  : t("playPreview", { kind: playbackNoun })
          }
          disabled={!state.playbackEnabled || loading}
          onClick={actions.onPlaybackToggle}
        >
          {loading
            ? `${t("loading")}…`
            : playing
              ? `Ⅱ ${t("pause")}`
              : paused
                ? `▶ ${t("resume")}`
                : `▶ ${t("play")}`}
        </Button>
        <Button
          ref={stopRef}
          type="button"
          data-action="stop"
          disabled={!(playing || loading || paused)}
          onClick={actions.onStop}
        >
          ■ {t("stop")}
        </Button>
        <output ref={outputRef} data-field="playback-time" aria-live="off">
          {formatTime(current)} / {formatTime(state.range.end)}
        </output>
      </div>
      <StatusMessage
        status="error"
        ref={playbackErrorRef}
        className="rl-playback-error"
        hidden={!state.playbackError}
      >
        {state.playbackError}
      </StatusMessage>
      <div className="rl-trim-fields">
        <Field label={t("startSeconds")}>
          <input
            ref={startRef}
            data-field="start"
            type="number"
            min="0"
            max={state.duration}
            step="0.01"
            value={state.range.start.toFixed(2)}
            onInput={(event) => actions.onNumberInput("start", event.currentTarget.valueAsNumber)}
          />
        </Field>
        <Field label={t("endSeconds")}>
          <input
            ref={endRef}
            data-field="end"
            type="number"
            min="0"
            max={state.duration}
            step="0.01"
            value={state.range.end.toFixed(2)}
            onInput={(event) => actions.onNumberInput("end", event.currentTarget.valueAsNumber)}
          />
        </Field>
      </div>
      <StatusMessage status="error" className="rl-modal__error" hidden={!state.rangeError}>
        {state.rangeError}
      </StatusMessage>
      <Field label="Caption" className="rl-modal__caption">
        <textarea
          ref={captionRef}
          data-field="caption"
          rows={2}
          maxLength={16384}
          placeholder={t("caption")}
          value={state.caption}
          onChange={(event) => actions.onCaptionChange(event.currentTarget.value)}
        />
      </Field>
      <EditorFooter
        className="rl-trim-footer"
        historyLabel={t("trimHistory")}
        history={
          <>
            <Button
              type="button"
              data-action="undo"
              title={t("undoTrim")}
              disabled={!state.historyCanUndo}
              onClick={actions.onUndo}
            >
              {t("undoTrim")}
            </Button>
            <Button
              type="button"
              data-action="redo"
              title={t("redoTrim")}
              disabled={!state.historyCanRedo}
              onClick={actions.onRedo}
            >
              {t("redoTrim")}
            </Button>
          </>
        }
        onCancel={actions.onCancel}
        onApply={() => actions.onApply(captionRef.current?.value ?? state.caption)}
        applyLabel={t("apply")}
        cancelLabel={t("cancel")}
      />
    </form>
  )
}
