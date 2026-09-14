import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import {
  guideUsesMedia,
  timelineMediaId,
  type H3GuideChannel,
  type H3TimelinePlacement,
} from "../h3-media-guides.ts"
import { translateRaw, useI18n } from "../i18n.ts"
import type { MediaItem } from "../types.ts"
import { Button } from "../ui/button.tsx"
import { StatusMessage } from "../ui/status-message.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"
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
  type H3TimelineSnapMode,
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

export interface H3WorkspaceReactOptions {
  container: HTMLElement
  subscribe(listener: () => void): () => void
  getSnapshot(): LoaderViewSnapshot
  actions: H3WorkspaceActions
}

export interface H3WorkspaceReactMount {
  destroy(): void
}

function itemForMediaId(snapshot: LoaderViewSnapshot, mediaId: string): MediaItem | undefined {
  const itemId = mediaId.endsWith(":audio") ? mediaId.slice(0, -6) : mediaId
  return snapshot.state.items[itemId]
}

function itemLabel(item: MediaItem | undefined, missingLabel = "Missing source"): string {
  return (
    item?.sourceFilename || item?.source.path.split("/").pop() || item?.source.path || missingLabel
  )
}

function frameLabel(frame: number, fps: number, unspecified: string): string {
  return Number.isSafeInteger(frame) && frame >= 0
    ? `${frame}f · ${(frame / fps).toFixed(3)}s`
    : unspecified
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
  noneLabel: string,
  missingLabel: string,
): string {
  if (!mediaId) return noneLabel
  return itemLabel(itemForMediaId(snapshot, channel === "audio" ? mediaId : mediaId), missingLabel)
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
  const { t } = useI18n()
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
  if (marks.length === 0) return <p className="rl-h3-workspace__empty">{t("noGuides")}</p>

  const selectedGuideId = h3.selection?.kind === "guide" ? h3.selection.guideId : undefined

  const selectMark = (mark: (typeof marks)[number]): void => {
    if (mark.shotId) actions.selectShot(mark.shotId)
    else
      actions.h3SelectPlacement(mark.placement, mark.channel === "shot" ? "visual" : mark.channel)
  }

  return (
    <div className="rl-h3-workspace__list" data-h3-list="">
      {marks.map((mark) => {
        const selectedGuide =
          Boolean(mark.placement.guideId) &&
          mark.placement.guideId === selectedGuideId &&
          (h3.selection?.kind === "guide" || h3.selection?.kind === "source")
        const role =
          mark.placement.kind === "start" || mark.placement.kind === "end"
            ? mark.placement.kind
            : undefined
        const selected =
          h3.selection?.kind === "shot"
            ? h3.selection.id === mark.shotId
            : role !== undefined
              ? h3.selection?.kind === role
              : selectedGuide
        const key = `${mark.placement.guideId ?? mark.placement.kind}:${mark.channel}:${mark.shotId ?? mark.shotTag ?? mark.label}`
        const shotControl = selected && Boolean(mark.shotId)
        return (
          <div
            key={key}
            className={`rl-h3-workspace__list-row${selected ? " is-selected" : ""}${mark.incomplete ? " is-incomplete" : ""}`}
            data-h3-list-item=""
          >
            <Button
              type="button"
              className="rl-h3-workspace__list-select"
              aria-pressed={Boolean(selected)}
              onClick={(event) => {
                event.stopPropagation()
                const select = event.currentTarget
                selectMark(mark)
                if (mark.placement.kind === "start" || mark.placement.kind === "end")
                  select.focus({ preventScroll: true })
              }}
            >
              <span className={`rl-h3-workspace__list-icon is-${mark.channel}`} aria-hidden="true">
                {mark.shotTag ? "#" : mark.channel === "audio" ? "♫" : "▧"}
              </span>
              <span className="rl-h3-workspace__list-copy">
                <strong>
                  {mark.shotTag
                    ? `${t("shot")} #${mark.shotTag}`
                    : mark.placement.kind === "start"
                      ? t("start")
                      : mark.placement.kind === "end"
                        ? t("end")
                        : `${t("guide")} ${mark.placement.guideId ?? ""}`}
                </strong>
                <small>
                  {mark.placement.kind === "end"
                    ? t("finalOutputFrame")
                    : frameLabel(mark.frame, fps, t("frameUnspecified"))}
                  {mark.disabled ? ` · ${t("paused")}` : ""}
                  {mark.incomplete ? ` · ${t("missingSource")}` : ""}
                </small>
              </span>
              <span className="rl-h3-workspace__list-source">
                {mark.shotTag
                  ? mark.label
                  : mark.channel === "audio"
                    ? sourceLabel(
                        snapshot,
                        mark.placement.audioId,
                        "audio",
                        t("none"),
                        t("missingSource"),
                      )
                    : sourceLabel(
                        snapshot,
                        mark.placement.visualId,
                        "visual",
                        t("none"),
                        t("missingSource"),
                      )}
              </span>
            </Button>
            {shotControl ? (
              <H3FrameControl
                id={mark.shotId!}
                frameIndex={mark.frame}
                label={`${t("shot")} #${mark.shotTag}`}
                removeLabel={`${t("remove")} ${t("shot")}`}
                frameAriaLabel={t("shotFrame")}
                fps={fps}
                shortcuts={[
                  { label: t("start"), frame: 0 },
                  { label: t("end"), frame: Math.max(0, snapshot.display.h3TotalFrames - 1) },
                ]}
                compact
                onInput={() => undefined}
                onCommit={(value) => {
                  const frame = Number(value.trim())
                  if (Number.isSafeInteger(frame) && frame >= 0)
                    actions.changeShot(mark.shotId!, timelineToNativeFrame(frame, fps))
                }}
                onRemove={() => actions.removeShot(mark.shotId!)}
              />
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
  noneLabel: string,
  missingLabel: string,
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
          ? sourceLabel(
              snapshot,
              pairedId,
              editor.channel === "visual" ? "audio" : "visual",
              noneLabel,
              missingLabel,
            )
          : undefined,
      }
    })
  return {
    sourceLabel: itemLabel(item, missingLabel),
    sourcePreviewUrl:
      editor.channel === "visual" ? snapshot.runtime.get(item.id)?.previewUrl : undefined,
    sourceKind: editor.channel === "visual" ? "image" : "audio",
    channel: editor.channel,
    fps,
    start: editor.channel === "visual" && h3.timeline.startImageId === mediaId,
    end: editor.channel === "visual" && h3.timeline.endImageId === mediaId,
    selectedRole:
      editor.channel === "visual" &&
      h3.selection?.kind === "start" &&
      h3.timeline.startImageId === mediaId
        ? "start"
        : editor.channel === "visual" &&
            h3.selection?.kind === "end" &&
            h3.timeline.endImageId === mediaId
          ? "end"
          : undefined,
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
  const { t } = useI18n()
  const props = guideEditorProps(snapshot, h3, actions, fps, t("none"), t("missingSource"))
  if (!props) return <p className="rl-h3-workspace__empty">{t("selectedSourceUnavailable")}</p>
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
  const { locale, t } = useI18n()
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
  if (!guide) return <p className="rl-h3-workspace__empty">{t("noIncompleteGuide")}</p>
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
      aria-label={t("recoverIncompleteGuide")}
    >
      <header className="rl-h3-editor__header">
        <strong className="rl-h3-editor__title">{t("recoverIncompleteGuideTitle")}</strong>
      </header>
      <p className="rl-h3-editor__hint">{t("recoverIncompleteGuideHint")}</p>
      <label className="rl-h3-guide-details__frame">
        <span>{t("frame")}</span>
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
        <span>{t("visualSource")}</span>
        <select
          data-h3-draft-field="visual"
          data-h3-guide-id={guide.id}
          value={guide.visualId ?? ""}
          onChange={(event) => selectSource("visual", event)}
        >
          <option value="">{t("none")}</option>
          {images.map((item) => (
            <option key={item.id} value={item.id}>
              {t("image")} · {itemLabel(item, t("missingSource"))}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("audioSource")}</span>
        <select
          data-h3-draft-field="audio"
          data-h3-guide-id={guide.id}
          value={guide.audioId ?? ""}
          onChange={(event) => selectSource("audio", event)}
        >
          <option value="">{t("none")}</option>
          {audio.map((item) => (
            <option key={item.id} value={timelineMediaId(item, "audio")}>
              {t("audio")} · {itemLabel(item, t("missingSource"))}
            </option>
          ))}
        </select>
      </label>
      {h3.issue ? (
        <StatusMessage status="error" className="rl-h3-editor__error">
          {translateRaw(locale, h3.issue)}
        </StatusMessage>
      ) : null}
      <Button
        type="button"
        className="rl-h3-guide-details__remove"
        onClick={() => actions.h3RemovePlacement(guide.id)}
      >
        {t("deleteIncompleteGuide")}
      </Button>
    </section>
  )
}

export function H3WorkspaceReact({ snapshot, actions }: H3WorkspaceReactProps): ReactNode {
  const { locale, t } = useI18n()
  const h3 = snapshot.h3
  const [mode, setMode] = useState<"timeline" | "list">("timeline")
  const [snapMode, setSnapMode] = useState<H3TimelineSnapMode>("off")
  const pageId = useId()

  if (!h3) return null
  const fps = snapshot.display.h3Fps
  const frameCount = snapshot.display.h3TotalFrames
  const count = Object.keys(snapshot.state.items).length
  const status = h3.issue
    ? translateRaw(locale, h3.issue)
    : h3.shotDirty
      ? t("shotTimingUnsaved")
      : h3.dirty
        ? t("unsavedChanges")
        : h3.timeline.enabled
          ? t("ready")
          : t("guidesOff")
  return (
    <div className="rl-h3-workspace-container">
      <section
        className={`rl-h3-workspace${h3.collapsed ? " is-collapsed" : ""}`}
        data-h3-root=""
        data-h3-workspace=""
        data-h3-react-surface=""
        aria-label={t("h3Workspace")}
      >
        <header className="rl-h3-workspace__header">
          <Button
            type="button"
            className="rl-h3-workspace__heading"
            data-h3-action="collapse"
            aria-label={h3.collapsed ? t("expandTimeline") : t("collapseTimeline")}
            title={h3.collapsed ? t("expandTimeline") : t("collapseTimeline")}
            aria-expanded={!h3.collapsed}
            aria-controls={pageId}
            onClick={(event) => {
              event.stopPropagation()
              actions.h3ToggleCollapsed()
            }}
          >
            <strong>{t("timelineGuides")}</strong>
            <small
              className={!h3.collapsed ? "rl-h3-workspace__summary" : undefined}
              title={h3.collapsed ? t("openTimelineTitle") : `${fps} FPS · ${frameCount} frames`}
            >
              {h3.collapsed
                ? t("h3Subtitle")
                : `${t("mediaTitle")} (${t("image")}/${t("video")}/${t("audio")}) · ${count} media ~ ${frameCount} frames · ${fps} FPS`}
            </small>
          </Button>
          <div className="rl-h3-workspace__tools">
            <span
              className="rl-h3-workspace__snap-control"
              data-h3-snap-mode={snapMode}
              hidden={h3.collapsed}
            >
              <span className="rl-h3-workspace__snap-label">{t("snap")}</span>
              <ToggleGroup
                className="rl-h3-workspace__view-group rl-h3-workspace__snap-group"
                value={snapMode}
                items={[
                  { value: "off", label: t("snapOff") },
                  { value: "half-second", label: t("snapHalfSecond") },
                ]}
                onValueChange={setSnapMode}
                ariaLabel={t("snapMode")}
              />
            </span>
            <span hidden={h3.collapsed}>
              <ToggleGroup
                value={mode}
                items={[
                  { value: "timeline", label: t("openTimeline") },
                  { value: "list", label: t("listView") },
                ]}
                onValueChange={setMode}
                ariaLabel={t("timelineView")}
                className="rl-h3-workspace__view-group"
              />
            </span>
            <Button
              type="button"
              className={`rl-h3-workspace__status${h3.timeline.enabled ? " is-on" : ""}`}
              data-h3-action="toggle"
              aria-label={t("toggleGuideUsage")}
              title={t("toggleGuideUsage")}
              aria-pressed={h3.timeline.enabled}
              onClick={(event) => {
                event.stopPropagation()
                actions.h3Toggle()
              }}
            >
              {h3.timeline.enabled ? t("on") : t("off")}
            </Button>
          </div>
        </header>
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
                zoom={1}
                snapMode={snapMode}
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
        <footer
          className={`rl-h3-workspace__footer${h3.issue ? " has-issue" : ""}`}
          hidden={h3.collapsed}
          role="status"
          aria-live="polite"
        >
          <span title={status}>{status}</span>
          <Button
            type="button"
            data-h3-action="cancel-editor"
            disabled={!h3.editor && !h3.dirty}
            onClick={() => actions.h3Cancel()}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="rl-primary"
            data-h3-action="apply-editor"
            disabled={!h3.canApply}
            onClick={() => actions.h3Apply()}
          >
            {t("apply")}
          </Button>
        </footer>
      </section>
    </div>
  )
}

function H3WorkspaceReactRoot({
  subscribe,
  getSnapshot,
  actions,
}: Pick<H3WorkspaceReactOptions, "subscribe" | "getSnapshot" | "actions">): ReactNode {
  const subscribeView = useCallback(subscribe, [subscribe])
  const readSnapshot = useCallback(getSnapshot, [getSnapshot])
  const snapshot = useSyncExternalStore(subscribeView, readSnapshot, readSnapshot)
  return <H3WorkspaceReact snapshot={snapshot} actions={actions} />
}

export function createH3WorkspaceReact(options: H3WorkspaceReactOptions): H3WorkspaceReactMount {
  const root: Root = createRoot(options.container)
  let destroyed = false
  flushSync(() =>
    root.render(
      <H3WorkspaceReactRoot
        subscribe={options.subscribe}
        getSnapshot={options.getSnapshot}
        actions={options.actions}
      />,
    ),
  )
  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      root.unmount()
      options.container.replaceChildren()
    },
  }
}

export const H3Workspace = H3WorkspaceReact
