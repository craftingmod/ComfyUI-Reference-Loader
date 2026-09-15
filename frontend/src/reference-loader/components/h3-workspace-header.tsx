import { type ReactNode, type Ref } from "react"

import { useI18n } from "../i18n.ts"
import { type H3OutputSettings } from "../types.ts"
import { Button } from "../ui/button.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"
import type { H3WorkspaceView } from "../view-model.ts"
import { h3OutputAspect, outputResolutionLabel } from "./h3-output-panel.tsx"
import { timelineSeconds, type H3TimelineSnapMode } from "./h3-timeline.ts"

export type H3WorkspacePanel = "output" | "timing" | null
export type H3WorkspaceMode = "timeline" | "list"

export interface H3WorkspaceHeaderProps {
  h3: H3WorkspaceView
  fps: number
  frameCount: number
  mediaCount: number
  activePanel: H3WorkspacePanel
  output: H3OutputSettings
  pageId: string
  panelId: string
  outputButtonRef: Ref<HTMLButtonElement>
  timingButtonRef: Ref<HTMLButtonElement>
  onToggleCollapsed(): void
  onToggleGuides(): void
  onPanelToggle(panel: Exclude<H3WorkspacePanel, null>): void
}

interface H3WorkspaceViewControlsProps {
  mode: H3WorkspaceMode
  snapMode: H3TimelineSnapMode
  onSnapModeChange(value: H3TimelineSnapMode): void
  onModeChange(value: H3WorkspaceMode): void
}

export function H3WorkspaceViewControls({
  mode,
  snapMode,
  onSnapModeChange,
  onModeChange,
}: H3WorkspaceViewControlsProps): ReactNode {
  const { t } = useI18n()
  return (
    <div className="rl-h3-workspace__view-controls">
      <span className="rl-h3-workspace__snap-control" data-h3-snap-mode={snapMode}>
        <span className="rl-h3-workspace__snap-label">{t("snap")}</span>
        <ToggleGroup
          className="rl-h3-workspace__view-group rl-h3-workspace__snap-group"
          value={snapMode}
          items={[
            { value: "off", label: t("snapOff") },
            { value: "half-second", label: t("snapHalfSecond") },
          ]}
          onValueChange={onSnapModeChange}
          ariaLabel={t("snapMode")}
        />
      </span>
      <ToggleGroup
        value={mode}
        items={[
          { value: "timeline", label: t("openTimeline") },
          { value: "list", label: t("listView") },
        ]}
        onValueChange={onModeChange}
        ariaLabel={t("timelineView")}
        className="rl-h3-workspace__view-group"
      />
    </div>
  )
}

export function H3WorkspaceHeader({
  h3,
  fps,
  frameCount,
  mediaCount,
  activePanel,
  output,
  pageId,
  panelId,
  outputButtonRef,
  timingButtonRef,
  onToggleCollapsed,
  onToggleGuides,
  onPanelToggle,
}: H3WorkspaceHeaderProps): ReactNode {
  const { t } = useI18n()
  const aspect = h3OutputAspect(output)
  const outputSummary = `${t("output")}: ${aspect} · ${outputResolutionLabel(output.width, output.height)}`
  const timingSummary = `${t("timing")}: ${fps} ${t("fps").toLocaleLowerCase()} · ${frameCount} ${t("frames")}`
  const outputButtonLabel = `${t("resolution")}: ${output.width}x${output.height}`
  const timingButtonLabel = `${t("frame")}: ${fps}x${timelineSeconds(frameCount, fps)}${t("secondsShort")}`

  return (
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
          onToggleCollapsed()
        }}
      >
        <strong>{t("timelineGuides")}</strong>
        <small
          className={!h3.collapsed ? "rl-h3-workspace__summary" : undefined}
          title={h3.collapsed ? t("openTimelineTitle") : `${fps} FPS · ${frameCount} frames`}
        >
          {h3.collapsed
            ? t("h3Subtitle")
            : `${t("mediaTitle")} (${t("image")}/${t("video")}/${t("audio")}) · ${mediaCount} media ~ ${frameCount} frames · ${fps} FPS`}
        </small>
      </Button>
      <div className="rl-h3-workspace__tools">
        <Button
          type="button"
          className={`rl-h3-workspace__status${h3.timeline.enabled ? " is-on" : ""}`}
          data-h3-action="toggle"
          aria-label={t("toggleGuideUsage")}
          title={t("toggleGuideUsage")}
          aria-pressed={h3.timeline.enabled}
          onClick={(event) => {
            event.stopPropagation()
            onToggleGuides()
          }}
        >
          {h3.timeline.enabled ? t("on") : t("off")}
        </Button>
        <Button
          type="button"
          className="rl-h3-workspace__panel-button rl-h3-workspace__output-button"
          ref={outputButtonRef}
          data-h3-action="output-settings"
          aria-haspopup="dialog"
          aria-expanded={activePanel === "output"}
          aria-controls={panelId}
          aria-label={outputSummary}
          title={outputSummary}
          onClick={(event) => {
            event.stopPropagation()
            onPanelToggle("output")
          }}
        >
          {outputButtonLabel}
        </Button>
        <Button
          type="button"
          className="rl-h3-workspace__panel-button rl-h3-workspace__timing-button"
          ref={timingButtonRef}
          data-h3-action="timing-settings"
          aria-haspopup="dialog"
          aria-expanded={activePanel === "timing"}
          aria-controls={panelId}
          aria-label={timingSummary}
          title={timingSummary}
          onClick={(event) => {
            event.stopPropagation()
            onPanelToggle("timing")
          }}
        >
          {timingButtonLabel}
        </Button>
      </div>
    </header>
  )
}
