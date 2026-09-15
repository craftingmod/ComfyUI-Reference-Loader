import { useEffect, useState, type ReactNode } from "react"

import { useI18n } from "../i18n.ts"
import {
  H3_OUTPUT_DEFAULT_HEIGHT,
  H3_OUTPUT_DEFAULT_WIDTH,
  H3_OUTPUT_MAX_MEGAPIXELS,
  H3_OUTPUT_MIN_MEGAPIXELS,
  normalizeH3OutputDimension,
  type H3OutputAspectId,
  type H3OutputMode,
  type H3OutputSettings,
  type MediaItem,
} from "../types.ts"
import { Button } from "../ui/button.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"
import type { LoaderViewSnapshot } from "../view-model.ts"
import {
  H3AspectPicker,
  type H3AspectPickerOption,
  type H3AspectPickerOrientation,
} from "./h3-aspect-picker.tsx"
import { H3ImageRatioPicker, type H3ImageRatioOption } from "./h3-image-ratio-picker.tsx"

const H3_OUTPUT_PRESETS = [
  { id: "5:4", ratio: { width: 5, height: 4 } },
  { id: "4:3", ratio: { width: 4, height: 3 } },
  { id: "3:2", ratio: { width: 3, height: 2 } },
  { id: "16:9", ratio: { width: 16, height: 9 } },
  { id: "2:1", ratio: { width: 2, height: 1 } },
  { id: "1:1", ratio: { width: 1, height: 1 } },
  { id: "1:2", ratio: { width: 1, height: 2 } },
  { id: "9:16", ratio: { width: 9, height: 16 } },
  { id: "2:3", ratio: { width: 2, height: 3 } },
  { id: "3:4", ratio: { width: 3, height: 4 } },
  { id: "4:5", ratio: { width: 4, height: 5 } },
] as const

const H3_OUTPUT_MEGAPIXEL_PRESETS = [0.5, 1, 2, 4] as const
const H3_OUTPUT_ORIENTATIONS = [
  { id: "horizontal", label: "horizontal", ratio: { width: 16, height: 9 } },
  { id: "square", label: "square", ratio: { width: 1, height: 1 } },
  { id: "vertical", label: "vertical", ratio: { width: 9, height: 16 } },
] as const

type H3OutputOrientation = (typeof H3_OUTPUT_ORIENTATIONS)[number]["id"]
type H3OutputRatio = { width: number; height: number }
type H3OutputDimension = "width" | "height"

function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000
}

function formatMegapixels(value: number): string {
  return value.toFixed(value >= 10 ? 1 : 2).replace(/\.?0+$/u, "")
}

export function h3OutputAspect(output: H3OutputSettings): string {
  return (
    H3_OUTPUT_PRESETS.find((preset) => {
      const left = output.width * preset.ratio.height
      const right = output.height * preset.ratio.width
      return Math.abs(left - right) / Math.max(left, right) < 0.02
    })?.id ?? "custom"
  )
}

function orientationForRatio(ratio: H3OutputRatio): H3OutputOrientation {
  if (ratio.width === ratio.height) return "square"
  return ratio.width > ratio.height ? "horizontal" : "vertical"
}

function dimensionsForRatio(
  ratio: H3OutputRatio,
  targetMegapixels: number,
  resolutionMultiple: number,
): Pick<H3OutputSettings, "width" | "height"> {
  const scale = Math.sqrt((targetMegapixels * 1_000_000) / (ratio.width * ratio.height))
  return {
    width: normalizeH3OutputDimension(
      ratio.width * scale,
      H3_OUTPUT_DEFAULT_WIDTH,
      resolutionMultiple,
    ),
    height: normalizeH3OutputDimension(
      ratio.height * scale,
      H3_OUTPUT_DEFAULT_HEIGHT,
      resolutionMultiple,
    ),
  }
}

export function outputResolutionLabel(width: number, height: number): string {
  return `${width}×${height}`
}

function outputItemLabel(item: MediaItem | undefined, missingLabel: string): string {
  return (
    item?.sourceFilename || item?.source.path.split("/").pop() || item?.source.path || missingLabel
  )
}

export function outputImageOptions(
  snapshot: LoaderViewSnapshot,
  missingLabel: string,
): readonly H3ImageRatioOption[] {
  return snapshot.state.imageOrder
    .map((id): H3ImageRatioOption | undefined => {
      const item = snapshot.state.items[id]
      if (!item || item.kind !== "image") return undefined
      const metadata = snapshot.runtime.get(id)?.metadata
      const hasDimensions = Boolean(
        metadata?.width && metadata.height && metadata.width > 0 && metadata.height > 0,
      )
      return {
        id,
        label: outputItemLabel(item, missingLabel),
        ratio: hasDimensions ? { width: metadata!.width!, height: metadata!.height! } : undefined,
        detail: hasDimensions
          ? outputResolutionLabel(metadata!.width!, metadata!.height!)
          : undefined,
        previewUrl: snapshot.runtime.get(id)?.previewUrl,
        disabled: !hasDimensions,
        title: hasDimensions ? undefined : missingLabel,
      }
    })
    .filter((option): option is H3ImageRatioOption => Boolean(option))
}

export function H3OutputPanel({
  id,
  output,
  imageOptions,
  onChange,
  onClose,
}: {
  id?: string
  output: H3OutputSettings
  imageOptions: readonly H3ImageRatioOption[]
  onChange(values: Partial<H3OutputSettings>): void
  onClose(): void
}): ReactNode {
  const { t } = useI18n()
  const [draftWidth, setDraftWidth] = useState(String(output.width))
  const [draftHeight, setDraftHeight] = useState(String(output.height))
  const [mode, setMode] = useState<H3OutputMode>(() => output.mode)
  const [selectedImageId, setSelectedImageId] = useState(
    () => output.imageId ?? imageOptions[0]?.id ?? "",
  )
  const [activeAspect, setActiveAspect] = useState<H3OutputAspectId>(() => output.aspect)
  const [activeOrientation, setActiveOrientation] = useState<H3OutputOrientation>(() =>
    orientationForRatio(
      H3_OUTPUT_PRESETS.find((preset) => preset.id === output.aspect)?.ratio ?? {
        width: output.width,
        height: output.height,
      },
    ),
  )
  const [draftMegapixels, setDraftMegapixels] = useState(() => String(output.targetMegapixels))
  const selectedImage = imageOptions.find((image) => image.id === selectedImageId)
  const activeRatio =
    mode === "image"
      ? selectedImage?.ratio
      : H3_OUTPUT_PRESETS.find((preset) => preset.id === activeAspect)?.ratio

  useEffect(() => {
    setDraftWidth(String(output.width))
    setDraftHeight(String(output.height))
  }, [output.width, output.height])

  useEffect(() => {
    setMode(output.mode)
  }, [output.mode])

  useEffect(() => {
    setSelectedImageId(output.imageId ?? imageOptions[0]?.id ?? "")
  }, [imageOptions, output.imageId])

  useEffect(() => {
    setActiveAspect(output.aspect)
    const ratio = H3_OUTPUT_PRESETS.find((preset) => preset.id === output.aspect)?.ratio
    if (ratio) setActiveOrientation(orientationForRatio(ratio))
  }, [output.aspect])

  useEffect(() => {
    setDraftMegapixels(String(output.targetMegapixels))
  }, [output.targetMegapixels])

  useEffect(() => {
    if (imageOptions.some((image) => image.id === selectedImageId)) return
    setSelectedImageId(imageOptions[0]?.id ?? "")
  }, [imageOptions, selectedImageId])

  const chooseResolution = (
    width: number,
    height: number,
    values: Partial<H3OutputSettings> = {},
  ): void => {
    setDraftWidth(String(width))
    setDraftHeight(String(height))
    onChange({ width, height, ...values })
  }

  const currentTargetMegapixels = (): number => {
    const parsed = Number(draftMegapixels)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : output.targetMegapixels
  }

  const chooseAspect = (aspect: H3OutputAspectId): void => {
    const ratio = H3_OUTPUT_PRESETS.find((preset) => preset.id === aspect)?.ratio
    if (!ratio) return
    setActiveAspect(aspect)
    setActiveOrientation(orientationForRatio(ratio))
    const dimensions = dimensionsForRatio(
      ratio,
      currentTargetMegapixels(),
      output.resolutionMultiple,
    )
    chooseResolution(dimensions.width, dimensions.height, { mode: "aspect", aspect })
  }

  const chooseImage = (id: string): void => {
    const image = imageOptions.find((option) => option.id === id)
    if (!image?.ratio) return
    setSelectedImageId(id)
    const dimensions = dimensionsForRatio(
      image.ratio,
      currentTargetMegapixels(),
      output.resolutionMultiple,
    )
    chooseResolution(dimensions.width, dimensions.height, { mode: "image", imageId: id })
  }

  const selectOrientation = (orientation: H3OutputOrientation): void => {
    setActiveOrientation(orientation)
    const currentRatio = H3_OUTPUT_PRESETS.find((preset) => preset.id === activeAspect)?.ratio
    if (currentRatio && orientationForRatio(currentRatio) === orientation) return
    const firstPreset = H3_OUTPUT_PRESETS.find(
      (preset) => orientationForRatio(preset.ratio) === orientation,
    )
    if (firstPreset) chooseAspect(firstPreset.id)
  }

  const chooseMegapixels = (value: string): void => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0 || !activeRatio) return
    const target = Math.min(H3_OUTPUT_MAX_MEGAPIXELS, Math.max(H3_OUTPUT_MIN_MEGAPIXELS, parsed))
    const dimensions = dimensionsForRatio(activeRatio, target, output.resolutionMultiple)
    setDraftMegapixels(String(target))
    chooseResolution(dimensions.width, dimensions.height, { targetMegapixels: target })
  }

  const selectMode = (nextMode: H3OutputMode): void => {
    setMode(nextMode)
    onChange({ mode: nextMode })
    if (nextMode === "aspect") {
      setActiveAspect(output.aspect)
      const ratio = H3_OUTPUT_PRESETS.find((preset) => preset.id === output.aspect)?.ratio
      if (ratio) setActiveOrientation(orientationForRatio(ratio))
      return
    }
    if (nextMode === "image") {
      const image = imageOptions.find((option) => option.id === selectedImageId) ?? imageOptions[0]
      if (image) {
        setSelectedImageId(image.id)
        onChange({ mode: "image", imageId: image.id })
        if (image.ratio) {
          const dimensions = dimensionsForRatio(
            image.ratio,
            currentTargetMegapixels(),
            output.resolutionMultiple,
          )
          chooseResolution(dimensions.width, dimensions.height, {
            mode: "image",
            imageId: image.id,
          })
        }
      }
    }
  }

  const commitDimension = (dimension: H3OutputDimension, value: string): void => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed)) return
    const normalized = normalizeH3OutputDimension(
      parsed,
      output[dimension],
      output.resolutionMultiple,
    )
    if (dimension === "width") {
      setDraftWidth(String(normalized))
      onChange({ width: normalized })
    } else {
      setDraftHeight(String(normalized))
      onChange({ height: normalized })
    }
  }

  return (
    <div
      id={id}
      className="rl-h3-output-panel"
      data-h3-output-panel=""
      role="dialog"
      aria-label={t("videoOutputSettings")}
    >
      <header className="rl-h3-output-panel__header">
        <strong>{t("videoOutput")}</strong>
        <Button type="button" className="rl-h3-output-panel__close" onClick={onClose}>
          {t("close")}
        </Button>
      </header>
      <ToggleGroup
        className="rl-h3-workspace__view-group rl-h3-output-panel__mode-group"
        value={mode}
        items={[
          { value: "image", label: t("imageRatio") },
          { value: "aspect", label: t("aspect") },
          { value: "manual", label: t("manual") },
        ]}
        onValueChange={selectMode}
        ariaLabel={t("outputSizeMode")}
      />
      {mode === "image" ? (
        <fieldset className="rl-h3-output-panel__fieldset">
          <legend>{t("imageRatio")}</legend>
          <H3ImageRatioPicker
            value={selectedImageId}
            options={imageOptions}
            emptyLabel={t("noImagesForOutput")}
            label={t("imageRatio")}
            onValueChange={chooseImage}
          />
        </fieldset>
      ) : mode === "aspect" ? (
        <fieldset className="rl-h3-output-panel__fieldset">
          <legend>{t("aspect")}</legend>
          <H3AspectPicker
            value={activeAspect}
            label={activeAspect}
            ratio={activeRatio}
            orientation={activeOrientation}
            orientations={H3_OUTPUT_ORIENTATIONS.map((item): H3AspectPickerOrientation => ({
              id: item.id,
              label: t(item.label),
              ratio: item.ratio,
            }))}
            options={H3_OUTPUT_PRESETS.filter(
              (preset) => orientationForRatio(preset.ratio) === activeOrientation,
            ).map((preset): H3AspectPickerOption => ({
              id: preset.id,
              label: preset.id,
              ratio: preset.ratio,
            }))}
            aspectLabel={t("aspect")}
            orientationLabel={t("orientation")}
            onValueChange={chooseAspect}
            onOrientationChange={selectOrientation}
          />
        </fieldset>
      ) : (
        <fieldset className="rl-h3-output-panel__fieldset rl-h3-output-panel__custom">
          <legend>{t("manual")}</legend>
          <div className="rl-h3-output-panel__dimensions">
            <label>
              <span>{t("width")}</span>
              <input
                type="number"
                min="32"
                max="16384"
                step={output.resolutionMultiple}
                value={draftWidth}
                data-h3-output-dimension="width"
                onChange={(event) => setDraftWidth(event.currentTarget.value)}
                onBlur={() => commitDimension("width", draftWidth)}
              />
            </label>
            <label>
              <span>{t("height")}</span>
              <input
                type="number"
                min="32"
                max="16384"
                step={output.resolutionMultiple}
                value={draftHeight}
                data-h3-output-dimension="height"
                onChange={(event) => setDraftHeight(event.currentTarget.value)}
                onBlur={() => commitDimension("height", draftHeight)}
              />
            </label>
          </div>
          <small>{t("videoOutputDimensionHint", { multiple: output.resolutionMultiple })}</small>
        </fieldset>
      )}
      {mode !== "manual" ? (
        <fieldset className="rl-h3-output-panel__fieldset">
          <legend>{t("totalMegapixels")}</legend>
          <div className="rl-h3-output-panel__megapixels">
            {H3_OUTPUT_MEGAPIXEL_PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                aria-pressed={Number(draftMegapixels) === preset}
                data-h3-output-megapixels={preset}
                disabled={!activeRatio}
                onClick={() => chooseMegapixels(String(preset))}
              >
                {preset} MP
              </Button>
            ))}
            <label>
              <span>{t("custom")}</span>
              <input
                type="number"
                min="0.01"
                max={H3_OUTPUT_MAX_MEGAPIXELS}
                step="0.01"
                value={draftMegapixels}
                data-h3-output-megapixels-input=""
                disabled={!activeRatio}
                onChange={(event) => setDraftMegapixels(event.currentTarget.value)}
                onBlur={() => chooseMegapixels(draftMegapixels)}
              />
            </label>
          </div>
        </fieldset>
      ) : null}
      <div className="rl-h3-output-panel__result" aria-label={t("outputResult")}>
        <strong>{outputResolutionLabel(output.width, output.height)}</strong>
        <span>≈ {formatMegapixels(megapixels(output.width, output.height))} MP</span>
      </div>
    </div>
  )
}
