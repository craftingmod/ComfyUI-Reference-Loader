import type { ReactNode } from "react"

import { Button } from "../ui/button.tsx"
import { AspectRatioSwatch, type H3AspectRatio } from "./h3-aspect-picker.tsx"

export interface H3ImageRatioOption {
  id: string
  label: string
  ratio?: H3AspectRatio
  detail?: ReactNode
  previewUrl?: string
  disabled?: boolean
  title?: string
}

export function H3ImageRatioPicker({
  value,
  options,
  emptyLabel,
  label,
  onValueChange,
}: {
  value: string
  options: readonly H3ImageRatioOption[]
  emptyLabel: string
  label: string
  onValueChange(value: string): void
}): ReactNode {
  if (options.length === 0) {
    return <p className="rl-h3-output-panel__image-empty">{emptyLabel}</p>
  }
  return (
    <div
      className="rl-h3-output-panel__image-options"
      role="group"
      aria-label={label}
      data-capture-wheel="true"
    >
      {options.map((option) => (
        <Button
          key={option.id}
          type="button"
          className="rl-h3-output-panel__image-option"
          aria-pressed={value === option.id}
          data-h3-output-image={option.id}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onValueChange(option.id)}
        >
          <span className="rl-h3-output-panel__image-preview" aria-hidden="true">
            {option.previewUrl ? (
              <img src={option.previewUrl} alt="" />
            ) : (
              <AspectRatioSwatch ratio={option.ratio} />
            )}
          </span>
          <span className="rl-h3-output-panel__image-copy">
            <strong>{option.label}</strong>
            {option.detail ? <small>{option.detail}</small> : null}
          </span>
        </Button>
      ))}
    </div>
  )
}
