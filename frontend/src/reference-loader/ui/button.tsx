import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react"

export type ButtonVariant = "primary" | "secondary" | "danger"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  busy?: boolean
  busyLabel?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", busy = false, busyLabel, className, children, disabled, ...props },
  ref,
) {
  const classes = ["rl-button", `rl-button--${variant}`, className].filter(Boolean).join(" ")
  return (
    <button
      {...props}
      ref={ref}
      className={classes}
      data-state={busy ? "busy" : undefined}
      data-variant={variant}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
})
