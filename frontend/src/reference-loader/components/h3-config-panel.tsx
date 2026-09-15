import { useEffect, useState, type ReactNode } from "react"

import { useI18n } from "../i18n.ts"
import {
  H3_OUTPUT_MAX_FRAME_MODULO,
  H3_OUTPUT_MAX_RESOLUTION_MULTIPLE,
  H3_OUTPUT_MIN_FRAME_MODULO,
  H3_OUTPUT_MIN_RESOLUTION_MULTIPLE,
  type H3OutputSettings,
} from "../types.ts"

type H3ConfigField = "resolutionMultiple" | "frameModulo" | "frameRemainder"

function normalizedValue(field: H3ConfigField, value: string, output: H3OutputSettings): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return output[field]
  if (field === "resolutionMultiple")
    return Math.min(
      H3_OUTPUT_MAX_RESOLUTION_MULTIPLE,
      Math.max(H3_OUTPUT_MIN_RESOLUTION_MULTIPLE, Math.round(parsed)),
    )
  if (field === "frameModulo")
    return Math.min(
      H3_OUTPUT_MAX_FRAME_MODULO,
      Math.max(H3_OUTPUT_MIN_FRAME_MODULO, Math.round(parsed)),
    )
  return Math.min(output.frameModulo - 1, Math.max(0, Math.round(parsed)))
}

export function H3ConfigPanel({
  output,
  onChange,
}: {
  output: H3OutputSettings
  onChange(values: Partial<H3OutputSettings>): void
}): ReactNode {
  const { t } = useI18n()
  const [draftResolutionMultiple, setDraftResolutionMultiple] = useState(
    String(output.resolutionMultiple),
  )
  const [draftFrameModulo, setDraftFrameModulo] = useState(String(output.frameModulo))
  const [draftFrameRemainder, setDraftFrameRemainder] = useState(String(output.frameRemainder))

  useEffect(
    () => setDraftResolutionMultiple(String(output.resolutionMultiple)),
    [output.resolutionMultiple],
  )
  useEffect(() => setDraftFrameModulo(String(output.frameModulo)), [output.frameModulo])
  useEffect(() => setDraftFrameRemainder(String(output.frameRemainder)), [output.frameRemainder])

  const commit = (field: H3ConfigField, value: string): void => {
    const normalized = normalizedValue(field, value, output)
    if (field === "resolutionMultiple") {
      setDraftResolutionMultiple(String(normalized))
      if (normalized !== output.resolutionMultiple) onChange({ resolutionMultiple: normalized })
      return
    }
    if (field === "frameModulo") {
      setDraftFrameModulo(String(normalized))
      const remainder = Math.min(output.frameRemainder, normalized - 1)
      setDraftFrameRemainder(String(remainder))
      if (normalized !== output.frameModulo || remainder !== output.frameRemainder)
        onChange({ frameModulo: normalized, frameRemainder: remainder })
      return
    }
    setDraftFrameRemainder(String(normalized))
    if (normalized !== output.frameRemainder) onChange({ frameRemainder: normalized })
  }

  return (
    <div className="rl-h3-config-panel" data-h3-config-panel="">
      <div className="rl-h3-config-panel__fields">
        <label>
          <span>{t("resolutionMultiple")}</span>
          <input
            type="number"
            min={H3_OUTPUT_MIN_RESOLUTION_MULTIPLE}
            max={H3_OUTPUT_MAX_RESOLUTION_MULTIPLE}
            step="1"
            inputMode="numeric"
            value={draftResolutionMultiple}
            data-h3-config-field="resolutionMultiple"
            onChange={(event) => setDraftResolutionMultiple(event.currentTarget.value)}
            onBlur={() => commit("resolutionMultiple", draftResolutionMultiple)}
          />
        </label>
        <label>
          <span>{t("frameModulo")}</span>
          <input
            type="number"
            min={H3_OUTPUT_MIN_FRAME_MODULO}
            max={H3_OUTPUT_MAX_FRAME_MODULO}
            step="1"
            inputMode="numeric"
            value={draftFrameModulo}
            data-h3-config-field="frameModulo"
            onChange={(event) => setDraftFrameModulo(event.currentTarget.value)}
            onBlur={() => commit("frameModulo", draftFrameModulo)}
          />
        </label>
        <label>
          <span>{t("frameRemainder")}</span>
          <input
            type="number"
            min="0"
            max={Math.max(0, output.frameModulo - 1)}
            step="1"
            inputMode="numeric"
            value={draftFrameRemainder}
            data-h3-config-field="frameRemainder"
            onChange={(event) => setDraftFrameRemainder(event.currentTarget.value)}
            onBlur={() => commit("frameRemainder", draftFrameRemainder)}
          />
        </label>
      </div>
      <small className="rl-h3-config-panel__hint">
        {t("resolutionConfigHint", { multiple: output.resolutionMultiple })}
      </small>
      <div className="rl-h3-config-panel__formula">
        <span>{t("frameFormula")}</span>
        <strong>
          {output.frameModulo}n + {output.frameRemainder}
        </strong>
      </div>
    </div>
  )
}
