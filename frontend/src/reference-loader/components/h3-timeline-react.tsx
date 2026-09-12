import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactNode,
} from "react"

import type { H3TimelinePlacement } from "../h3-media-guides.ts"
import { H3_TIMELINE_NATIVE_FPS, type ItemRuntime, type LoaderState } from "../types.ts"
import type { H3WorkspaceView, LoaderViewChannel } from "../view-model.ts"
import {
  draggedFrame,
  nativeToTimelineFrame,
  timelineExtent,
  timelineFrameInputToNative,
  timelineMarks,
  timelineSeconds,
  timelineToNativeFrame,
  type TimelineMark,
} from "./h3-timeline.ts"

export const H3_TIMELINE_FPS = H3_TIMELINE_NATIVE_FPS

export interface H3TimelineReactActions {
  selectPlacement(placement: H3TimelinePlacement, channel: "visual" | "audio"): void
  movePlacement(id: string, frame: number): void
  removePlacement(id: string): void
  h3InputFrame(id: string, value: string): void
  h3CommitFrame(id: string, value: string): void
  h3RemoveRole(role: "start" | "end"): void
  selectShot(tag: string): void
  changeShot(tag: string, frame: number): void
  removeShot(tag: string): void
  canDrop(channel: "visual" | "audio", dataTransfer: DataTransfer | null): boolean
  drop(channel: "visual" | "audio", frame: number, dataTransfer: DataTransfer | null): void
}

export interface H3TimelineReactProps {
  state: LoaderState
  runtime: ReadonlyMap<string, Readonly<ItemRuntime>>
  h3: H3WorkspaceView
  actions: H3TimelineReactActions
  fps: number
  frameCount: number
  zoom: number
  fitToken: number
}

type TimelineChannel = "visual" | "audio" | "shot"

interface Gesture {
  id: string
  shotTag?: string
  channel: TimelineChannel
  pointerId: number
  clientX: number
  startRect: DOMRect
  frame: number
  next: number
  moved: boolean
  target: HTMLElement
}

const CHANNELS: readonly TimelineChannel[] = ["visual", "audio", "shot"]
const MIN_TRACK_WIDTH = 280

function timing(frame: number, fps: number): string {
  return `${frame}f · ${timelineSeconds(frame, fps)}s`
}

function frameInputValue(frameIndex: number): string {
  return Number.isSafeInteger(frameIndex) && frameIndex >= 0 ? String(frameIndex) : ""
}

function parseFrameInput(value: string): number {
  const raw = value.trim()
  if (raw === "") return Number.NaN
  const frameIndex = Number(raw)
  return Number.isSafeInteger(frameIndex) && frameIndex >= 0 ? frameIndex : Number.NaN
}

export interface H3FrameControlProps {
  id: string
  frameIndex: number
  label: string
  removeLabel: string
  frameAriaLabel: string
  onInput(value: string): void
  onCommit(value: string): void
  onRemove(): void
  compact?: boolean
  fps?: number
}

export function H3FrameControl({
  id,
  frameIndex,
  label,
  removeLabel,
  frameAriaLabel,
  onInput,
  onCommit,
  onRemove,
  compact = false,
  fps = H3_TIMELINE_FPS,
}: H3FrameControlProps): ReactNode {
  const externalFrame = frameInputValue(frameIndex)
  const previousExternalFrame = useRef(externalFrame)
  const [frame, setFrame] = useState(externalFrame)
  const committed = useRef(externalFrame)

  useLayoutEffect(() => {
    if (externalFrame === previousExternalFrame.current) return
    const previous = parseFrameInput(previousExternalFrame.current)
    const local = parseFrameInput(frame)
    previousExternalFrame.current = externalFrame
    if (local === previous || (Number.isNaN(local) && Number.isNaN(previous))) {
      setFrame(externalFrame)
      committed.current = externalFrame
    }
  }, [externalFrame, frame])

  const commit = (value: string): void => {
    if (committed.current === value) return
    committed.current = value
    onCommit(value)
  }

  return (
    <div
      className={`rl-h3-element-controls${compact ? " is-compact" : ""}`}
      data-h3-element-controls=""
      data-h3-element-id={id}
    >
      <label className="rl-h3-element-controls__frame">
        <span>Frame</span>
        <input
          type="number"
          min="0"
          step="1"
          value={frame}
          data-h3-inline-frame=""
          data-h3-draft-field="frame"
          data-h3-guide-id={id}
          aria-label={frameAriaLabel}
          onInput={(event) => {
            const value = event.currentTarget.value
            setFrame(value)
            onInput(value)
          }}
          ref={(input) => {
            if (!input) return
            const commitEvent = (event: Event): void => {
              event.stopPropagation()
              commit(input.value)
            }
            input.addEventListener("change", commitEvent)
            input.addEventListener("blur", commitEvent)
            return () => {
              input.removeEventListener("change", commitEvent)
              input.removeEventListener("blur", commitEvent)
            }
          }}
        />
        <small>
          {Number.isSafeInteger(frameIndex) ? `${timelineSeconds(frameIndex, fps)}s` : ""}
        </small>
      </label>
      <button
        type="button"
        data-h3-element-remove=""
        data-h3-guide-id={id}
        aria-label={removeLabel}
        title={removeLabel}
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
      >
        Remove
      </button>
      <strong className="rl-h3-element-controls__label">{label}</strong>
    </div>
  )
}

function channelLabel(channel: TimelineChannel): string {
  return channel === "visual" ? "Image" : channel === "audio" ? "Audio" : "Shot"
}

function isSelectedMark(mark: TimelineMark, h3: H3WorkspaceView): boolean {
  const selection = h3.selection
  if (!selection) return false
  if (selection.kind === "shot") return mark.shotTag === selection.tag
  if (selection.kind === "guide") return mark.placement.guideId === selection.guideId
  if (selection.kind === "source") {
    const id = selection.channel === "visual" ? mark.placement.visualId : mark.placement.audioId
    return mark.channel === selection.channel && id === selection.mediaId
  }
  return selection.kind === mark.placement.kind
}

function displayFrame(
  mark: TimelineMark,
  preview: { id: string; frame: number } | undefined,
): number {
  return preview && preview.id === mark.placement.guideId ? preview.frame : mark.frame
}

function markerTitle(mark: TimelineMark, frame: number, fps: number): string {
  const position =
    mark.placement.kind === "start"
      ? "Start"
      : mark.placement.kind === "end"
        ? "End · final output frame"
        : mark.shotTag
          ? `Shot #${mark.shotTag}`
          : "Guide"
  const duration =
    mark.channel === "audio"
      ? mark.frames === undefined
        ? " · duration unknown"
        : ` · ${timelineSeconds(mark.frames, fps)}s source span`
      : ""
  const state = `${mark.disabled ? " · paused" : ""}${mark.incomplete ? " · incomplete" : ""}${mark.warning ? ` · ${mark.warning}` : ""}`
  return `${position} · ${mark.label} · ${mark.placement.kind === "end" ? "time unknown" : timing(frame, fps)}${duration}${state}`
}

function sourceLabel(
  state: LoaderState,
  id: string | null | undefined,
  channel: "visual" | "audio",
): string {
  if (!id) return "None"
  const itemId = channel === "audio" && id.endsWith(":audio") ? id.slice(0, -6) : id
  const item = state.items[itemId]
  if (!item) return "Missing source"
  return item.sourceFilename || item.source.path.split("/").pop() || item.source.path
}

function selectedGuideId(h3: H3WorkspaceView): string | undefined {
  return (
    h3.editor?.selectedGuideId ??
    (h3.selection?.kind === "guide" ? h3.selection.guideId : undefined)
  )
}

function SelectedElementControls({
  h3,
  actions,
  preview,
  fps,
}: Pick<H3TimelineReactProps, "h3" | "actions"> & {
  preview?: { id: string; frame: number }
  fps: number
}): ReactNode {
  const previewGuide = preview
    ? h3.timeline.guides.find((entry) => entry.id === preview.id)
    : undefined
  const guideId = previewGuide?.id ?? selectedGuideId(h3)
  const guide = guideId ? h3.timeline.guides.find((entry) => entry.id === guideId) : undefined
  if (guide) {
    return (
      <H3FrameControl
        key={`guide:${guide.id}`}
        id={guide.id}
        frameIndex={
          previewGuide && preview ? preview.frame : nativeToTimelineFrame(guide.frameIndex, fps)
        }
        label={`Guide ${guide.id}`}
        removeLabel="Remove Guide"
        frameAriaLabel="Guide frame"
        fps={fps}
        onInput={(value) => actions.h3InputFrame(guide.id, timelineFrameInputToNative(value, fps))}
        onCommit={(value) =>
          actions.h3CommitFrame(guide.id, timelineFrameInputToNative(value, fps))
        }
        onRemove={() => actions.removePlacement(guide.id)}
      />
    )
  }

  const previewShotTag = preview?.id.startsWith("shot:") ? preview.id.slice(5) : undefined
  const shotTag = previewShotTag ?? (h3.selection?.kind === "shot" ? h3.selection.tag : undefined)
  const shot = shotTag ? h3.shots.find((entry) => entry.tag === shotTag) : undefined
  if (shot) {
    return (
      <H3FrameControl
        key={`shot:${shot.tag}`}
        id={shot.tag}
        frameIndex={
          previewShotTag && preview ? preview.frame : nativeToTimelineFrame(shot.frameIndex, fps)
        }
        label={`Shot #${shot.tag}`}
        removeLabel="Remove Shot"
        frameAriaLabel="Shot frame"
        fps={fps}
        onInput={() => undefined}
        onCommit={(value) => {
          const frame = parseFrameInput(value)
          if (!Number.isNaN(frame)) actions.changeShot(shot.tag, timelineToNativeFrame(frame, fps))
        }}
        onRemove={() => actions.removeShot(shot.tag)}
      />
    )
  }

  const role =
    h3.selection?.kind === "start" || h3.selection?.kind === "end" ? h3.selection.kind : undefined
  if (!role) return null
  const roleId = role === "start" ? h3.timeline.startImageId : h3.timeline.endImageId
  if (roleId === null) return null
  const label = role === "start" ? "Start" : "End"
  return (
    <div
      className="rl-h3-element-controls is-role"
      data-h3-element-controls=""
      data-h3-element-id={role}
    >
      <strong className="rl-h3-element-controls__label">{label}</strong>
      <small>{role === "start" ? "0f · 0.000s" : "final output frame"}</small>
      <button
        type="button"
        data-h3-element-remove=""
        aria-label={`Remove ${label}`}
        title={`Remove ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          actions.h3RemoveRole(role)
        }}
      >
        Remove
      </button>
    </div>
  )
}

function EndDock({
  state,
  runtime,
  h3,
  actions,
  preview,
  fps,
}: Pick<H3TimelineReactProps, "state" | "runtime" | "h3" | "actions"> & {
  preview?: { id: string; frame: number }
  fps: number
}): ReactNode {
  const id = h3.timeline.endImageId
  const selected = h3.selection?.kind === "end"
  const imagePreview = id ? runtime.get(id)?.previewUrl : undefined
  const placement: H3TimelinePlacement = { kind: "end", frameIndex: null, visualId: id }
  return (
    <div className="rl-h3-timeline__end-dock" data-h3-end-dock="">
      <span className="rl-h3-timeline__end-label">End image</span>
      <button
        type="button"
        className={`rl-h3-timeline__end-mark${selected ? " is-selected" : ""}${id ? "" : " is-empty"}`}
        aria-label={`End image: ${sourceLabel(state, id, "visual")}`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          actions.selectPlacement(placement, "visual")
        }}
      >
        {imagePreview ? (
          <img src={imagePreview} alt="" draggable={false} />
        ) : (
          <span aria-hidden="true">▧</span>
        )}
        <span>{sourceLabel(state, id, "visual")}</span>
      </button>
      <SelectedElementControls h3={h3} actions={actions} preview={preview} fps={fps} />
    </div>
  )
}

export function H3TimelineReact({
  state,
  runtime,
  h3,
  actions,
  fps,
  frameCount,
  zoom,
  fitToken,
}: H3TimelineReactProps) {
  const scroller = useRef<HTMLDivElement>(null)
  const trackRefs = useRef(new Map<TimelineChannel, HTMLDivElement>())
  const gestureRef = useRef<Gesture | undefined>(undefined)
  const suppressClick = useRef(false)
  const [gestureActive, setGestureActive] = useState(false)
  const [preview, setPreview] = useState<{ id: string; frame: number }>()
  const [drop, setDrop] = useState<{ channel: "visual" | "audio"; frame: number }>()
  const [trackWidth, setTrackWidth] = useState(0)
  const marks = useMemo(
    () => timelineMarks({ ...state, h3Timeline: h3.timeline }, runtime, h3.shots, fps),
    [fps, h3.shots, h3.timeline, runtime, state],
  )
  const extent = useMemo(() => timelineExtent(marks, frameCount, fps), [frameCount, fps, marks])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return undefined
    const updateWidth = (): void => {
      const width = element.clientWidth
      setTrackWidth((current) => (current === width ? current : width))
    }
    updateWidth()
    if (typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver(updateWidth)
    observer.observe(element)
    return () => observer.disconnect()
  }, [h3.collapsed])

  const cancelActiveGesture = useCallback((): void => {
    const gesture = gestureRef.current
    gestureRef.current = undefined
    if (!gesture) return
    suppressClick.current = false
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId))
        gesture.target.releasePointerCapture(gesture.pointerId)
    } catch {
      // Synthetic events and browsers without pointer capture can reach here.
    }
    setGestureActive(false)
    setPreview(undefined)
  }, [])

  useEffect(() => cancelActiveGesture, [cancelActiveGesture, h3.sessionId])

  useEffect(() => {
    if (fitToken === 0) return
    if (scroller.current) scroller.current.scrollLeft = 0
  }, [fitToken])

  useEffect(() => {
    if (!gestureActive) return undefined
    const finish = (cancel: boolean): void => {
      const gesture = gestureRef.current
      gestureRef.current = undefined
      setGestureActive(false)
      setPreview(undefined)
      if (!gesture) return
      try {
        if (gesture.target.hasPointerCapture(gesture.pointerId))
          gesture.target.releasePointerCapture(gesture.pointerId)
      } catch {
        // Synthetic events and browsers without pointer capture can reach here.
      }
      suppressClick.current = gesture.moved
      if (!cancel && gesture.moved && gesture.next !== gesture.frame) {
        const nativeFrame = timelineToNativeFrame(gesture.next, fps)
        if (gesture.shotTag) actions.changeShot(gesture.shotTag, nativeFrame)
        else actions.movePlacement(gesture.id, nativeFrame)
      }
    }
    const onMove = (event: globalThis.PointerEvent): void => {
      const gesture = gestureRef.current
      if (!gesture || event.pointerId !== gesture.pointerId) return
      if (!gesture.moved && Math.abs(event.clientX - gesture.clientX) < 3) return
      event.preventDefault()
      event.stopPropagation()
      const track = trackRefs.current.get(gesture.channel)
      const currentRect = track?.getBoundingClientRect() ?? gesture.startRect
      const deltaX = event.clientX - gesture.clientX + gesture.startRect.left - currentRect.left
      const next = draggedFrame(gesture.frame, deltaX, gesture.startRect.width, extent)
      gesture.moved = true
      gesture.next = next
      setPreview({ id: gesture.id, frame: next })
    }
    const onUp = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== gestureRef.current?.pointerId) return
      event.stopPropagation()
      finish(false)
    }
    const onCancel = (event: globalThis.PointerEvent): void => {
      if (event.pointerId !== gestureRef.current?.pointerId) return
      event.stopPropagation()
      finish(true)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      finish(true)
    }
    const onBlur = (): void => finish(true)
    document.addEventListener("pointermove", onMove, { capture: true })
    document.addEventListener("pointerup", onUp, { capture: true })
    document.addEventListener("pointercancel", onCancel, { capture: true })
    document.addEventListener("keydown", onKeyDown, { capture: true })
    globalThis.addEventListener("blur", onBlur)
    return () => {
      document.removeEventListener("pointermove", onMove, true)
      document.removeEventListener("pointerup", onUp, true)
      document.removeEventListener("pointercancel", onCancel, true)
      document.removeEventListener("keydown", onKeyDown, true)
      globalThis.removeEventListener("blur", onBlur)
    }
  }, [actions, extent, fps, gestureActive])

  const startGesture = (mark: TimelineMark, event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || event.isPrimary === false || mark.placement.kind === "end") return
    if (!mark.placement.guideId || !Number.isSafeInteger(mark.frame)) return
    const track = trackRefs.current.get(mark.channel)
    const rect = track?.getBoundingClientRect()
    if (!rect || !(rect.width > 0)) return
    event.stopPropagation()
    suppressClick.current = false
    const gesture: Gesture = {
      id: mark.placement.guideId,
      ...(mark.shotTag ? { shotTag: mark.shotTag } : {}),
      channel: mark.channel,
      pointerId: event.pointerId,
      clientX: event.clientX,
      startRect: rect,
      frame: mark.frame,
      next: mark.frame,
      moved: false,
      target: event.currentTarget,
    }
    gestureRef.current = gesture
    setPreview({ id: gesture.id, frame: gesture.frame })
    setGestureActive(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer capture is a progressive enhancement for synthetic/native events.
    }
  }

  const frameForDrop = (channel: "visual" | "audio", event: DragEvent<HTMLDivElement>): number => {
    const rect = trackRefs.current.get(channel)?.getBoundingClientRect()
    if (!rect || !(rect.width > 0)) return 0
    return Math.max(
      0,
      Math.min(extent - 1, Math.round(((event.clientX - rect.left) / rect.width) * extent)),
    )
  }

  const laneDragOver = (channel: "visual" | "audio", event: DragEvent<HTMLDivElement>): void => {
    if (!actions.canDrop(channel, event.dataTransfer)) {
      setDrop(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const frame = frameForDrop(channel, event)
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    setDrop({ channel, frame })
  }

  const laneDrop = (channel: "visual" | "audio", event: DragEvent<HTMLDivElement>): void => {
    const frame = frameForDrop(channel, event)
    setDrop(undefined)
    if (!actions.canDrop(channel, event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    actions.drop(channel, timelineToNativeFrame(frame, fps), event.dataTransfer)
  }

  const laneLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !event.currentTarget.contains(event.relatedTarget)
    )
      setDrop(undefined)
  }

  const selectedGuideId =
    h3.editor?.selectedGuideId ??
    (h3.selection?.kind === "guide" ? h3.selection.guideId : undefined)

  const markButton = (mark: TimelineMark, index: number): ReactNode => {
    const selected = selectedGuideId
      ? mark.placement.guideId === selectedGuideId
      : isSelectedMark(mark, h3)
    const frame = displayFrame(mark, preview)
    const draggable = mark.placement.kind !== "end" && Boolean(mark.placement.guideId)
    const title = markerTitle(mark, frame, fps)
    const key = `${mark.placement.guideId ?? mark.placement.kind}:${mark.channel}:${mark.shotTag ?? mark.label}`
    return (
      <button
        key={key}
        type="button"
        className={`rl-h3-timeline__mark${mark.disabled ? " is-paused" : ""}${mark.incomplete ? " is-incomplete" : ""}${mark.warning ? " is-warning" : ""}${selected ? " is-selected" : ""}${mark.channel === "audio" ? " is-audio" : ""}${mark.channel === "shot" ? " is-shot" : ""}${mark.frames === undefined ? " is-unknown" : ""}${preview?.id === mark.placement.guideId ? " is-dragging" : ""}`}
        data-timeline-mark={index}
        data-timeline-guide={mark.placement.guideId}
        data-timeline-shot={mark.shotTag}
        data-h3-channel={mark.channel}
        data-h3-frame={Number.isFinite(mark.frame) ? mark.frame : undefined}
        aria-label={title}
        aria-pressed={selected}
        title={title}
        draggable={false}
        onPointerDownCapture={(event) => startGesture(mark, event)}
        onClick={(event) => {
          event.stopPropagation()
          if (suppressClick.current) {
            suppressClick.current = false
            return
          }
          if (mark.shotTag) actions.selectShot(mark.shotTag)
          else
            actions.selectPlacement(
              mark.placement,
              mark.channel === "shot" ? "visual" : mark.channel,
            )
        }}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault()
            if (mark.shotTag) actions.removeShot(mark.shotTag)
            else if (mark.placement.guideId) actions.removePlacement(mark.placement.guideId)
            return
          }
          if (!draggable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return
          event.preventDefault()
          const next = Math.max(
            0,
            mark.frame + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? fps : 1),
          )
          const nativeFrame = timelineToNativeFrame(next, fps)
          if (mark.shotTag) actions.changeShot(mark.shotTag, nativeFrame)
          else if (mark.placement.guideId)
            actions.movePlacement(mark.placement.guideId, nativeFrame)
        }}
      >
        {mark.previewUrl ? <img src={mark.previewUrl} alt="" draggable={false} /> : null}
        <span>
          {mark.placement.kind === "start" ? "Start · " : ""}
          {mark.label}
        </span>
        <small data-timeline-time="">
          {mark.placement.kind === "end" ? "End · final output" : timing(frame, fps)}
        </small>
      </button>
    )
  }

  const layoutWidth =
    Math.max(MIN_TRACK_WIDTH, trackWidth || scroller.current?.clientWidth || 0) * zoom
  const tickFrames = Math.max(
    fps,
    Math.ceil(extent / Math.max(2, Math.floor(layoutWidth / 76)) / fps) * fps,
  )
  const ticks: ReactNode[] = []
  for (let frame = 0; frame <= extent; frame += tickFrames) {
    ticks.push(
      <span key={frame} style={{ left: `${(frame / extent) * 100}%` }}>
        {timelineSeconds(frame, fps)}s · {frame}f
      </span>,
    )
  }

  return (
    <div className="rl-h3-timeline-react" data-h3-timeline-react="">
      <div
        ref={scroller}
        className="rl-h3-timeline__track-scroll"
        tabIndex={0}
        aria-label="Guide and Shot timeline; scroll horizontally when zoomed"
      >
        <div
          className="rl-h3-timeline__track-surface"
          style={{ width: `${zoom * 100}%`, minWidth: `${zoom * MIN_TRACK_WIDTH}px` }}
          data-drop-frame={drop?.frame}
        >
          <div className="rl-h3-timeline__ruler">
            <span className="rl-h3-timeline__lane-label">Time</span>
            <div className="rl-h3-timeline__ruler-axis">{ticks}</div>
          </div>
          {CHANNELS.map((channel) => {
            const laneMarks = marks
              .filter((mark) => mark.channel === channel && mark.placement.kind !== "end")
              .sort((left, right) => {
                const leftFrame = displayFrame(left, preview)
                const rightFrame = displayFrame(right, preview)
                return (
                  (Number.isFinite(leftFrame) ? leftFrame : Number.POSITIVE_INFINITY) -
                  (Number.isFinite(rightFrame) ? rightFrame : Number.POSITIVE_INFINITY)
                )
              })
            const occupied: number[] = []
            const minMarkerFrames = Math.max(1, (extent * 88) / layoutWidth)
            const rows = laneMarks.map((mark) => {
              const frame = displayFrame(mark, preview)
              const visualWidth =
                channel === "audio" && mark.frames !== undefined
                  ? Math.max(mark.frames, minMarkerFrames)
                  : minMarkerFrames
              let row = occupied.findIndex((end) => end <= frame)
              if (row < 0) row = occupied.length
              occupied[row] = frame + visualWidth
              return { mark, row }
            })
            const laneHeight = Math.max(48, occupied.length * 40 + 4)
            return (
              <div className="rl-h3-timeline__lane-row" key={channel}>
                <div className="rl-h3-timeline__lane-label">{channelLabel(channel)}</div>
                <div
                  ref={(element) => {
                    if (element) trackRefs.current.set(channel, element)
                    else trackRefs.current.delete(channel)
                  }}
                  className={`rl-h3-timeline__lane${drop?.channel === channel ? " is-drop-target" : ""}`}
                  data-timeline-channel={channel}
                  aria-label={
                    channel === "shot" ? "Shot markers" : `${channelLabel(channel)} guides`
                  }
                  style={{ height: `${laneHeight}px` }}
                  onDragOver={
                    channel === "shot" ? undefined : (event) => laneDragOver(channel, event)
                  }
                  onDragLeave={channel === "shot" ? undefined : laneLeave}
                  onDrop={channel === "shot" ? undefined : (event) => laneDrop(channel, event)}
                >
                  {drop?.channel === channel ? (
                    <span
                      className="rl-h3-timeline__drop-caret"
                      style={{ left: `${(drop.frame / extent) * 100}%` }}
                      aria-hidden="true"
                    />
                  ) : null}
                  {rows.map(({ mark, row }) => {
                    const frame = displayFrame(mark, preview)
                    const width =
                      channel === "audio" && mark.frames !== undefined
                        ? `${
                            (Math.min(
                              Math.max(0, extent - frame),
                              Math.max(mark.frames, minMarkerFrames),
                            ) /
                              extent) *
                            100
                          }%`
                        : undefined
                    return (
                      <span
                        key={`${mark.placement.guideId ?? mark.placement.kind}:${mark.shotTag ?? mark.label}`}
                        className="rl-h3-timeline__mark-position"
                        style={{
                          left: `${(frame / extent) * 100}%`,
                          top: `${row * 40 + 4}px`,
                          ...(width ? { width } : {}),
                        }}
                      >
                        <span>{markButton(mark, marks.indexOf(mark))}</span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <EndDock
        state={state}
        runtime={runtime}
        h3={h3}
        actions={actions}
        preview={preview}
        fps={fps}
      />
    </div>
  )
}

export function h3TimelineSeconds(frame: number, fps = H3_TIMELINE_FPS): string {
  return timelineSeconds(frame, fps)
}

export type H3TimelineViewChannel = LoaderViewChannel
