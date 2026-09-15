import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import { Button } from "../ui/button.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"

export interface H3AspectRatio {
  width: number
  height: number
}

export interface H3AspectPickerOption {
  id: string
  label: ReactNode
  ratio?: H3AspectRatio
  disabled?: boolean
  title?: string
}

export interface H3AspectPickerOrientation {
  id: string
  label: ReactNode
  ratio: H3AspectRatio
}

export function AspectRatioSwatch({ ratio }: { ratio?: H3AspectRatio }): ReactNode {
  return (
    <span className="rl-h3-output-panel__ratio-swatch-frame" aria-hidden="true">
      {ratio ? (
        <span
          className="rl-h3-output-panel__ratio-swatch"
          style={
            {
              "--rl-ratio-width": ratio.width,
              "--rl-ratio-height": ratio.height,
            } as CSSProperties
          }
        />
      ) : null}
    </span>
  )
}

export function H3AspectOption({
  option,
  pressed,
  onClick,
}: {
  option: H3AspectPickerOption
  pressed: boolean
  onClick(): void
}): ReactNode {
  return (
    <Button
      type="button"
      aria-pressed={pressed}
      data-h3-output-aspect={option.id}
      disabled={option.disabled}
      title={option.title}
      onClick={onClick}
    >
      <AspectRatioSwatch ratio={option.ratio} />
      <span className={"rl-h3-output-panel__aspect-label"}>{option.label}</span>
    </Button>
  )
}

export function H3AspectPicker({
  value,
  label,
  ratio,
  orientation,
  options,
  orientations,
  aspectLabel,
  orientationLabel,
  onValueChange,
  onOrientationChange,
}: {
  value: string
  label: ReactNode
  ratio?: H3AspectRatio
  orientation: string
  options: readonly H3AspectPickerOption[]
  orientations: readonly H3AspectPickerOrientation[]
  aspectLabel: string
  orientationLabel: string
  onValueChange(value: string): void
  onOrientationChange(value: string): void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Node && !pickerRef.current?.contains(target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer, true)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer, true)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [open])

  return (
    <div className="rl-h3-output-panel__aspect-picker" ref={pickerRef}>
      <Button
        type="button"
        className="rl-h3-output-panel__aspect-trigger"
        data-h3-output-aspect-trigger=""
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <AspectRatioSwatch ratio={ratio} />
        <span>{label}</span>
        <span className="rl-h3-output-panel__aspect-chevron" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </Button>
      {open ? (
        <div className="rl-h3-output-panel__aspect-menu" role="dialog" aria-label={aspectLabel}>
          <fieldset className="rl-h3-output-panel__fieldset">
            <legend>{orientationLabel}</legend>
            <ToggleGroup
              className="rl-h3-output-panel__orientation-group"
              value={orientation}
              items={orientations.map((item) => ({
                value: item.id,
                label: (
                  <span className="rl-h3-output-panel__orientation-label">
                    <AspectRatioSwatch ratio={item.ratio} />
                    <span>{item.label}</span>
                  </span>
                ),
              }))}
              onValueChange={onOrientationChange}
              ariaLabel={orientationLabel}
            />
          </fieldset>
          <fieldset className="rl-h3-output-panel__fieldset">
            <legend>{aspectLabel}</legend>
            <div className="rl-h3-output-panel__aspect-group" role="group" aria-label={aspectLabel}>
              {options.map((option) => (
                <H3AspectOption
                  key={option.id}
                  option={option}
                  pressed={value === option.id}
                  onClick={() => {
                    setOpen(false)
                    onValueChange(option.id)
                  }}
                />
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  )
}
