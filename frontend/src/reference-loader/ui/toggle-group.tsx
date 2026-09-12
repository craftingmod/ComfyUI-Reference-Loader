import { type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react"

import { Button } from "./button.tsx"

export interface ToggleGroupItem<T extends string = string> {
  value: T
  label: ReactNode
  ref?: Ref<HTMLButtonElement>
  action?: string
  ariaLabel?: string
  disabled?: boolean
  title?: string
}

export interface ToggleGroupProps<T extends string = string> {
  value: T
  items: readonly ToggleGroupItem<T>[]
  onValueChange?: (value: T) => void
  legend?: ReactNode
  ariaLabel?: string
  className?: string
  disabled?: boolean
}

function moveFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  const key = event.key
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return
  const buttons = Array.from(event.currentTarget.parentElement?.children ?? []).filter(
    (element): element is HTMLButtonElement =>
      element.tagName === "BUTTON" &&
      element.hasAttribute("data-rl-toggle-item") &&
      !(element as HTMLButtonElement).disabled,
  )
  if (buttons.length === 0) return
  event.preventDefault()
  const currentIndex = buttons.indexOf(event.currentTarget)
  const nextIndex =
    key === "Home"
      ? 0
      : key === "End"
        ? buttons.length - 1
        : (currentIndex + (key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length
  buttons[nextIndex]?.focus()
}

export function ToggleGroup<T extends string>({
  value,
  items,
  onValueChange,
  legend,
  ariaLabel,
  className,
  disabled = false,
}: ToggleGroupProps<T>): ReactElement {
  const classes = ["rl-toggle-group", className].filter(Boolean).join(" ")
  return (
    <fieldset className={classes} data-orientation="horizontal" aria-label={ariaLabel}>
      {legend ? <legend>{legend}</legend> : null}
      {items.map((item) => (
        <Button
          key={item.value}
          ref={item.ref}
          type="button"
          data-rl-toggle-item=""
          data-action={item.action}
          data-value={item.value}
          aria-label={item.ariaLabel}
          aria-pressed={value === item.value}
          disabled={disabled || item.disabled}
          title={item.title}
          onClick={() => onValueChange?.(item.value)}
          onKeyDown={moveFocus}
        >
          {item.label}
        </Button>
      ))}
    </fieldset>
  )
}
