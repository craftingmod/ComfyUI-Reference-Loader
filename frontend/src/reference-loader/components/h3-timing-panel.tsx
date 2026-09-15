import { useEffect, useState, type ReactNode } from "react"

import { useI18n } from "../i18n.ts"
import {
  H3_OUTPUT_MAX_FPS,
  H3_OUTPUT_MAX_TOTAL_FRAMES,
  H3_OUTPUT_MIN_FPS,
  H3_OUTPUT_MIN_TOTAL_FRAMES,
  normalizeH3OutputFrameCount,
  type H3OutputSettings,
} from "../types.ts"
import { Button } from "../ui/button.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"
import { H3ConfigPanel } from "./h3-config-panel.tsx"
import { timelineSeconds } from "./h3-timeline.ts"

type H3TimingField = "fps" | "totalFrames"
type H3TimingPanelTab = "timing" | "config"

function normalizeTimingValue(
  field: H3TimingField,
  value: string,
  fallback: number,
  output: Pick<H3OutputSettings, "frameModulo" | "frameRemainder">,
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  if (field === "fps")
    return Math.min(H3_OUTPUT_MAX_FPS, Math.max(H3_OUTPUT_MIN_FPS, Math.round(parsed)))
  return normalizeH3OutputFrameCount(parsed, fallback, {
    frameModulo: output.frameModulo,
    frameRemainder: output.frameRemainder,
  })
}

export function h3TimingDuration(totalFrames: number, fps: number): string {
  return `${timelineSeconds(totalFrames, fps)}s`
}

export function H3TimingPanel({
  id,
  output,
  onChange,
  onClose,
}: {
  id?: string
  output: H3OutputSettings
  onChange(values: Partial<H3OutputSettings>): void
  onClose(): void
}): ReactNode {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<H3TimingPanelTab>("timing")
  const [draftFps, setDraftFps] = useState(String(output.fps))
  const [draftTotalFrames, setDraftTotalFrames] = useState(String(output.totalFrames))

  useEffect(() => setDraftFps(String(output.fps)), [output.fps])
  useEffect(() => setDraftTotalFrames(String(output.totalFrames)), [output.totalFrames])

  const commit = (field: H3TimingField, value: string): void => {
    const normalized = normalizeTimingValue(field, value, output[field], output)
    if (field === "fps") {
      setDraftFps(String(normalized))
      if (normalized !== output.fps) onChange({ fps: normalized })
    } else {
      setDraftTotalFrames(String(normalized))
      if (normalized !== output.totalFrames) onChange({ totalFrames: normalized })
    }
  }

  return (
    <div
      id={id}
      className="rl-h3-timing-panel"
      data-h3-timing-panel=""
      role="dialog"
      aria-label={t("videoTimingSettings")}
    >
      <header className="rl-h3-timing-panel__header">
        <strong>{t("videoTiming")}</strong>
        <Button type="button" className="rl-h3-timing-panel__close" onClick={onClose}>
          {t("close")}
        </Button>
      </header>
      <ToggleGroup
        className="rl-h3-workspace__view-group rl-h3-timing-panel__tabs"
        value={activeTab}
        items={[
          { value: "timing", label: t("timing") },
          { value: "config", label: t("config") },
        ]}
        onValueChange={setActiveTab}
        ariaLabel={t("videoTiming")}
      />
      {activeTab === "timing" ? (
        <>
          <div className="rl-h3-timing-panel__fields">
            <label>
              <span>{t("fps")}</span>
              <input
                type="number"
                min={H3_OUTPUT_MIN_FPS}
                max={H3_OUTPUT_MAX_FPS}
                step="1"
                inputMode="numeric"
                value={draftFps}
                data-h3-timing-field="fps"
                onChange={(event) => setDraftFps(event.currentTarget.value)}
                onBlur={() => commit("fps", draftFps)}
              />
            </label>
            <label>
              <span>{t("totalFrames")}</span>
              <input
                type="number"
                min={H3_OUTPUT_MIN_TOTAL_FRAMES}
                max={H3_OUTPUT_MAX_TOTAL_FRAMES}
                step="1"
                inputMode="numeric"
                value={draftTotalFrames}
                data-h3-timing-field="totalFrames"
                onChange={(event) => setDraftTotalFrames(event.currentTarget.value)}
                onBlur={() => commit("totalFrames", draftTotalFrames)}
              />
            </label>
          </div>
          <div className="rl-h3-timing-panel__duration" data-h3-timing-duration="">
            <span>{t("duration")}</span>
            <strong>{h3TimingDuration(output.totalFrames, output.fps)}</strong>
          </div>
        </>
      ) : (
        <H3ConfigPanel output={output} onChange={onChange} />
      )}
    </div>
  )
}
