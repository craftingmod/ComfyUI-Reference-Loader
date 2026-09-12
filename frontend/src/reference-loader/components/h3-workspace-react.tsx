import { useEffect, useId, useRef, useState, type ChangeEvent, type ReactNode } from "react"

import {
  guideUsesMedia,
  h3Placements,
  timelineMediaId,
  type H3GuideChannel,
  type H3TimelinePlacement,
} from "../h3-media-guides.ts"
import type { MediaItem } from "../types.ts"
import type { H3WorkspaceView, LoaderViewSnapshot } from "../view-model.ts"
import { H3GuideInspector, type H3GuideEditorProps } from "./h3-guide-editor.tsx"
import {
  H3FrameControl,
  H3TimelineReact,
  type H3TimelineReactActions,
} from "./h3-timeline-react.tsx"
import {
  nativeToTimelineFrame,
  timelineFrameInputToNative,
  timelineMarks,
  timelineToNativeFrame,
} from "./h3-timeline.ts"
export interface H3WorkspaceActions extends H3TimelineReactActions {
  h3Toggle(): void
  h3ToggleCollapsed(): void
  h3OpenMedia(mediaId: string, channel: H3GuideChannel, guideId?: string): void
  h3ToggleGuide(id: string, channel: H3GuideChannel): void
  h3SelectPlacement(placement: H3TimelinePlacement, channel: "visual" | "audio"): void
  h3ChangeGuideSource(id: string, channel: H3GuideChannel, mediaId: string | null): void
  h3AddPlacement(position: "start" | "guide" | "end", frame: string): void
  h3RemovePlacement(id: string): void
  h3Apply(): void
  h3Cancel(): void
}

export interface H3WorkspaceReactProps {
  snapshot: LoaderViewSnapshot
  actions: H3WorkspaceActions
}

function itemForMediaId(snapshot: LoaderViewSnapshot, mediaId: string): MediaItem | undefined {
  const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
  return snapshot.state.items[itemId]
}

function itemLabel(item: MediaItem | undefined): string {
  return (
    item?.sourceFilename ||
    item?.source.path.split("/").pop() ||
    item?.source.path ||
    "Missing source"
  )
}

function frameLabel(frame: number, fps: number): string {
  return Number.isSafeInteger(frame) && frame >= 0
    ? `${frame}f · ${(frame / fps).toFixed(3)}s`
    : "Unspecified frame"
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

function sourceLabel(
  snapshot: LoaderViewSnapshot,
  mediaId: string | null | undefined,
  channel: H3GuideChannel,
): string {
  if (!mediaId) return "None"
  return itemLabel(itemForMediaId(snapshot, channel === "audio" ? mediaId : mediaId))
}

function GuideList({
  snapshot,
  h3,
  actions,
  fps,
}: {
  snapshot: LoaderViewSnapshot
  h3: H3WorkspaceView
  actions: H3WorkspaceActions
  fps: number
}): ReactNode {
  const marks = timelineMarks(
    { ...snapshot.state, h3Timeline: h3.timeline },
    snapshot.runtime,
    h3.shots,
    fps,
  )
    .map((mark, index) => ({ mark, index }))
    .sort((left, right) => {
      const rank = (kind: H3TimelinePlacement["kind"]): number =>
        kind === "start" ? 0 : kind === "end" ? 2 : 1
      const rankDifference = rank(left.mark.placement.kind) - rank(right.mark.placement.kind)
      if (rankDifference !== 0) return rankDifference
      const frameDifference = left.mark.frame - right.mark.frame
      return frameDifference || left.index - right.index
    })
    .map(({ mark }) => mark)
  if (marks.length === 0)
    return <p className="rl-h3-workspace__empty">No Guides or Shots yet. Choose a Media source.</p>

  const selectedGuideId =
    h3.editor?.selectedGuideId ??
    (h3.selection?.kind === "guide" ? h3.selection.guideId : undefined)
  const selectedGuideChannel =
    h3.editor?.channel ?? (h3.selection?.kind === "guide" ? h3.selection.channel : undefined)

  const selectMark = (mark: (typeof marks)[number]): void => {
    if (mark.shotTag) actions.selectShot(mark.shotTag)
    else
      actions.h3SelectPlacement(mark.placement, mark.channel === "shot" ? "visual" : mark.channel)
  }

  return (
    <div className="rl-h3-workspace__list" data-h3-list="">
      {marks.map((mark) => {
        const selectedGuide =
          Boolean(mark.placement.guideId) &&
          mark.placement.guideId === selectedGuideId &&
          (h3.selection?.kind === "guide" || Boolean(h3.editor?.selectedGuideId))
        const selected =
          h3.selection?.kind === "shot" ? h3.selection.tag === mark.shotTag : selectedGuide
        const key = `${mark.placement.guideId ?? mark.placement.kind}:${mark.channel}:${mark.shotTag ?? mark.label}`
        const guideControl =
          selected &&
          Boolean(mark.placement.guideId) &&
          mark.channel === selectedGuideChannel &&
          mark.placement.guideId === selectedGuideId
        const shotControl = selected && Boolean(mark.shotTag)
        const roleControl =
          selected && (mark.placement.kind === "start" || mark.placement.kind === "end")
        return (
          <div
            key={key}
            className={`rl-h3-workspace__list-row${selected ? " is-selected" : ""}${mark.incomplete ? " is-incomplete" : ""}`}
            data-h3-list-item=""
          >
            <button
              type="button"
              className="rl-h3-workspace__list-select"
              aria-pressed={Boolean(selected)}
              onClick={(event) => {
                event.stopPropagation()
                selectMark(mark)
              }}
            >
              <span className={`rl-h3-workspace__list-icon is-${mark.channel}`} aria-hidden="true">
                {mark.shotTag ? "#" : mark.channel === "audio" ? "♫" : "▧"}
              </span>
              <span className="rl-h3-workspace__list-copy">
                <strong>
                  {mark.shotTag
                    ? `Shot #${mark.shotTag}`
                    : mark.placement.kind === "start"
                      ? "Start"
                      : mark.placement.kind === "end"
                        ? "End"
                        : `Guide ${mark.placement.guideId ?? ""}`}
                </strong>
                <small>
                  {mark.placement.kind === "end"
                    ? "final output frame"
                    : frameLabel(mark.frame, fps)}
                  {mark.disabled ? " · paused" : ""}
                  {mark.incomplete ? " · Missing source" : ""}
                </small>
              </span>
              <span className="rl-h3-workspace__list-source">
                {mark.shotTag
                  ? mark.label
                  : mark.channel === "audio"
                    ? sourceLabel(snapshot, mark.placement.audioId, "audio")
                    : sourceLabel(snapshot, mark.placement.visualId, "visual")}
              </span>
            </button>
            {guideControl ? (
              <H3FrameControl
                id={mark.placement.guideId!}
                frameIndex={mark.frame}
                label={`Guide ${mark.placement.guideId}`}
                removeLabel="Remove Guide"
                frameAriaLabel="Guide frame"
                fps={fps}
                compact
                onInput={(value) =>
                  actions.h3InputFrame(
                    mark.placement.guideId!,
                    timelineFrameInputToNative(value, fps),
                  )
                }
                onCommit={(value) =>
                  actions.h3CommitFrame(
                    mark.placement.guideId!,
                    timelineFrameInputToNative(value, fps),
                  )
                }
                onRemove={() => actions.h3RemovePlacement(mark.placement.guideId!)}
              />
            ) : null}
            {shotControl ? (
              <H3FrameControl
                id={mark.shotTag!}
                frameIndex={mark.frame}
                label={`Shot #${mark.shotTag}`}
                removeLabel="Remove Shot"
                frameAriaLabel="Shot frame"
                fps={fps}
                compact
                onInput={() => undefined}
                onCommit={(value) => {
                  const frame = Number(value.trim())
                  if (Number.isSafeInteger(frame) && frame >= 0)
                    actions.changeShot(mark.shotTag!, timelineToNativeFrame(frame, fps))
                }}
                onRemove={() => actions.removeShot(mark.shotTag!)}
              />
            ) : null}
            {roleControl ? (
              <div
                className="rl-h3-element-controls is-compact is-role"
                data-h3-element-controls=""
              >
                <button
                  type="button"
                  data-h3-element-remove=""
                  aria-label={`Remove ${mark.placement.kind === "start" ? "Start" : "End"}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    actions.h3RemoveRole(mark.placement.kind as "start" | "end")
                  }}
                >
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function guideEditorProps(
  snapshot: LoaderViewSnapshot,
  h3: H3WorkspaceView,
  actions: H3WorkspaceActions,
  fps: number,
): H3GuideEditorProps | undefined {
  const editor = h3.editor
  if (!editor?.mediaId) return undefined
  const mediaId = editor.mediaId
  const item = itemForMediaId(snapshot, mediaId)
  if (!item) return undefined
  const guides = h3.timeline.guides
    .filter((guide) => editor.ownedGuideIds.includes(guide.id))
    .filter((guide) => guideUsesMedia(guide, mediaId, editor.channel))
    .sort((left, right) => left.frameIndex - right.frameIndex)
    .map((guide) => {
      const pairedId = editor.channel === "visual" ? guide.audioId : guide.visualId
      return {
        id: guide.id,
        frameIndex: nativeToTimelineFrame(guide.frameIndex, fps),
        pairedLabel: pairedId
          ? sourceLabel(snapshot, pairedId, editor.channel === "visual" ? "audio" : "visual")
          : undefined,
      }
    })
  return {
    sourceLabel: itemLabel(item),
    sourcePreviewUrl:
      editor.channel === "visual" ? snapshot.runtime.get(item.id)?.previewUrl : undefined,
    sourceKind: editor.channel === "visual" ? "image" : "audio",
    channel: editor.channel,
    fps,
    start: editor.channel === "visual" && h3.timeline.startImageId === mediaId,
    end: editor.channel === "visual" && h3.timeline.endImageId === mediaId,
    guides,
    atGuideLimit: h3.timeline.guides.length >= 32,
    issue: h3.issue,
    addError: h3.draftError,
    onAdd: (position, frame) =>
      actions.h3AddPlacement(position, timelineFrameInputToNative(frame, fps)),
    onRemoveRole: actions.h3RemoveRole,
    onRemoveGuide: actions.h3RemovePlacement,
    onInputFrame: (id, value) => actions.h3InputFrame(id, timelineFrameInputToNative(value, fps)),
    onCommitFrame: (id, value) => actions.h3CommitFrame(id, timelineFrameInputToNative(value, fps)),
    onApply: actions.h3Apply,
    onCancel: actions.h3Cancel,
  }
}

function SourceInspector({
  snapshot,
  h3,
  actions,
  fps,
}: {
  snapshot: LoaderViewSnapshot
  h3: H3WorkspaceView
  actions: H3WorkspaceActions
  fps: number
}): ReactNode {
  const props = guideEditorProps(snapshot, h3, actions, fps)
  if (!props)
    return <p className="rl-h3-workspace__empty">The selected Media source is unavailable.</p>
  return (
    <H3GuideInspector
      key={`source:${h3.sessionId}`}
      props={props}
      showActions={false}
      positionMode="radio"
    />
  )
}

function RecoveryInspector({
  snapshot,
  h3,
  actions,
  fps,
}: {
  snapshot: LoaderViewSnapshot
  h3: H3WorkspaceView
  actions: H3WorkspaceActions
  fps: number
}): ReactNode {
  const editor = h3.editor
  const guideId = editor?.selectedGuideId ?? editor?.ownedGuideIds[0]
  const guide = guideId ? h3.timeline.guides.find((entry) => entry.id === guideId) : undefined
  const frameValue = frameInputValue(
    guide ? nativeToTimelineFrame(guide.frameIndex, fps) : Number.NaN,
  )
  const previousExternalFrame = useRef(frameValue)
  const [frame, setFrame] = useState(frameValue)
  const committed = useRef(frame)
  useEffect(() => {
    if (frameValue === previousExternalFrame.current) return
    const previous = parseFrameInput(previousExternalFrame.current)
    const localFrame = parseFrameInput(frame)
    previousExternalFrame.current = frameValue
    if (localFrame === previous || (Number.isNaN(localFrame) && Number.isNaN(previous))) {
      setFrame(frameValue)
      committed.current = frameValue
    }
  }, [frameValue, frame, guideId])
  if (!guide) return <p className="rl-h3-workspace__empty">No incomplete Guide selected.</p>
  const images = snapshot.state.imageOrder
    .map((id) => snapshot.state.items[id])
    .filter((item): item is Extract<MediaItem, { kind: "image" }> => item?.kind === "image")
  const audio = snapshot.state.audioOrder
    .map((id) => snapshot.state.items[id])
    .filter((item): item is Extract<MediaItem, { kind: "audio" }> => item?.kind === "audio")
  const commitFrame = (value: string): void => {
    if (committed.current === value) return
    committed.current = value
    actions.h3CommitFrame(guide.id, timelineFrameInputToNative(value, fps))
  }
  const selectSource = (channel: H3GuideChannel, event: ChangeEvent<HTMLSelectElement>): void => {
    actions.h3ChangeGuideSource(guide.id, channel, event.currentTarget.value || null)
  }
  return (
    <section
      className="rl-h3-editor rl-h3-editor--inspector rl-h3-editor--recovery"
      data-h3-editor=""
      data-h3-inspector=""
      data-h3-react-surface=""
      aria-label="Recover incomplete Timeline Guide"
    >
      <header className="rl-h3-editor__header">
        <strong className="rl-h3-editor__title">Recover incomplete Guide</strong>
      </header>
      <p className="rl-h3-editor__hint">
        Choose a missing Image or standalone Audio source, or remove the Guide.
      </p>
      <label className="rl-h3-guide-details__frame">
        <span>Frame</span>
        <input
          type="number"
          min="0"
          step="1"
          value={frame}
          data-h3-draft-field="frame"
          data-h3-guide-id={guide.id}
          onInput={(event) => {
            const value = event.currentTarget.value
            setFrame(value)
            actions.h3InputFrame(guide.id, timelineFrameInputToNative(value, fps))
          }}
          ref={(input) => {
            if (!input) return
            const commitEvent = (event: Event): void => {
              event.stopPropagation()
              commitFrame(input.value)
            }
            input.addEventListener("change", commitEvent)
            input.addEventListener("blur", commitEvent)
            return () => {
              input.removeEventListener("change", commitEvent)
              input.removeEventListener("blur", commitEvent)
            }
          }}
        />
      </label>
      <label>
        <span>Visual source</span>
        <select
          data-h3-draft-field="visual"
          data-h3-guide-id={guide.id}
          value={guide.visualId ?? ""}
          onChange={(event) => selectSource("visual", event)}
        >
          <option value="">None</option>
          {images.map((item) => (
            <option key={item.id} value={item.id}>
              Image · {itemLabel(item)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Audio source</span>
        <select
          data-h3-draft-field="audio"
          data-h3-guide-id={guide.id}
          value={guide.audioId ?? ""}
          onChange={(event) => selectSource("audio", event)}
        >
          <option value="">None</option>
          {audio.map((item) => (
            <option key={item.id} value={timelineMediaId(item, "audio")}>
              Audio · {itemLabel(item)}
            </option>
          ))}
        </select>
      </label>
      {h3.issue ? (
        <p className="rl-h3-editor__error" role="alert">
          {h3.issue}
        </p>
      ) : null}
      <button
        type="button"
        className="rl-h3-guide-details__remove"
        onClick={() => actions.h3RemovePlacement(guide.id)}
      >
        Delete incomplete Guide
      </button>
    </section>
  )
}

export function H3WorkspaceReact({ snapshot, actions }: H3WorkspaceReactProps): ReactNode {
  const h3 = snapshot.h3
  const [mode, setMode] = useState<"timeline" | "list">("timeline")
  const [zoom, setZoom] = useState(1)
  const [fitToken, setFitToken] = useState(0)
  const pageId = useId()

  if (!h3) return null
  const fps = snapshot.display.h3Fps
  const frameCount = snapshot.display.h3TotalFrames
  const placements = h3Placements(h3.timeline)
  const count = Object.keys(snapshot.state.items).length
  const status = h3.issue
    ? h3.issue
    : h3.dirty
      ? "Unsaved changes"
      : h3.timeline.enabled
        ? "Ready"
        : "Guides are off"
  const scope =
    h3.editScope === "shot"
      ? "Shot changes"
      : h3.shotDirty
        ? "Guide + Shot changes"
        : "Guide changes"
  return (
    <div className="rl-h3-workspace-container">
      <section
        className={`rl-h3-workspace rl-h3-media-guides${h3.collapsed ? " is-collapsed" : ""}`}
        data-h3-root=""
        data-h3-workspace=""
        data-h3-react-surface=""
        aria-label="H3 Guide Timeline workspace"
      >
        <header className="rl-h3-workspace__header">
          <button
            type="button"
            className="rl-h3-workspace__collapse"
            data-h3-action="collapse"
            aria-expanded={!h3.collapsed}
            aria-controls={pageId}
            onClick={(event) => {
              event.stopPropagation()
              actions.h3ToggleCollapsed()
            }}
          >
            <span aria-hidden="true">{h3.collapsed ? "▸" : "▾"}</span> H3 Timeline
          </button>
          <span className={`rl-h3-workspace__status${h3.timeline.enabled ? " is-on" : ""}`}>
            {h3.timeline.enabled ? "ON" : "OFF"}
          </span>
          <span
            className="rl-h3-workspace__summary"
            title={`${count} media · ${placements.length} placements · ${h3.shots.length} shots`}
          >
            {count} media · {placements.length} placements · {h3.shots.length} shots
          </span>
          <span
            className="rl-h3-workspace__output"
            aria-label="H3 output settings"
            title="Actual H3 output settings configured on Reference Loader"
          >
            {fps} FPS · {frameCount} frames
          </span>
          {h3.dirty ? (
            <span
              className="rl-h3-workspace__pending-dot"
              title="Unsaved changes"
              aria-label="Unsaved changes"
            >
              ●
            </span>
          ) : null}
          <button
            type="button"
            className={`rl-h3-workspace__toggle${h3.timeline.enabled ? " is-on" : ""}`}
            data-h3-action="toggle"
            aria-pressed={h3.timeline.enabled}
            onClick={(event) => {
              event.stopPropagation()
              actions.h3Toggle()
            }}
          >
            {h3.timeline.enabled ? "Guides On" : "Guides Off"}
          </button>
        </header>
        <div className="rl-h3-workspace__tools" hidden={h3.collapsed}>
          <div className="rl-h3-workspace__view-group" aria-label="Timeline view">
            <button
              type="button"
              aria-pressed={mode === "timeline"}
              onClick={() => setMode("timeline")}
            >
              Timeline
            </button>
            <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
              List
            </button>
          </div>
          <label className="rl-h3-workspace__zoom">
            Zoom
            <select
              aria-label="Timeline zoom"
              value={String(zoom)}
              onChange={(event) => setZoom(Number(event.currentTarget.value))}
            >
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              setZoom(1)
              setFitToken((value) => value + 1)
            }}
          >
            Fit
          </button>
        </div>
        <div id={pageId} className="rl-h3-workspace__body" hidden={h3.collapsed}>
          <div className="rl-h3-stage">
            {mode === "timeline" ? (
              <H3TimelineReact
                state={snapshot.state}
                runtime={snapshot.runtime}
                h3={h3}
                actions={actions}
                fps={fps}
                frameCount={frameCount}
                zoom={zoom}
                fitToken={fitToken}
              />
            ) : (
              <GuideList snapshot={snapshot} h3={h3} actions={actions} fps={fps} />
            )}
            {h3.editor?.mediaId ? (
              <div className="rl-h3-inline-editor" data-h3-inline-editor="">
                <SourceInspector snapshot={snapshot} h3={h3} actions={actions} fps={fps} />
              </div>
            ) : h3.editor?.recovery ? (
              <div className="rl-h3-inline-editor" data-h3-inline-editor="">
                <RecoveryInspector snapshot={snapshot} h3={h3} actions={actions} fps={fps} />
              </div>
            ) : null}
          </div>
        </div>
        <div
          className={`rl-h3-workspace__status-row${h3.issue ? " has-issue" : ""}`}
          hidden={h3.collapsed}
          role="status"
          aria-live="polite"
        >
          <span title={status}>{status}</span>
        </div>
        <footer className="rl-h3-workspace__footer" hidden={h3.collapsed}>
          <span>
            {scope}
            {h3.dirty ? " pending" : ""}
          </span>
          <button
            type="button"
            data-h3-action="cancel-editor"
            disabled={!h3.dirty}
            onClick={() => actions.h3Cancel()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rl-primary"
            data-h3-action="apply-editor"
            disabled={!h3.canApply}
            onClick={() => actions.h3Apply()}
          >
            Apply
          </button>
        </footer>
      </section>
    </div>
  )
}

export const H3Workspace = H3WorkspaceReact
