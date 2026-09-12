import { forwardRef, type HTMLAttributes, type ReactNode } from "react"

export type StatusMessageStatus = "error" | "warning" | "loading" | "success"

export interface StatusMessageProps extends HTMLAttributes<HTMLParagraphElement> {
  status: StatusMessageStatus
  children?: ReactNode
}

export const StatusMessage = forwardRef<HTMLParagraphElement, StatusMessageProps>(
  function StatusMessage({ status, className, role, ...props }, ref) {
    const classes = ["rl-status-message", `rl-status-message--${status}`, className]
      .filter(Boolean)
      .join(" ")
    return (
      <p
        {...props}
        ref={ref}
        className={classes}
        data-status={status}
        role={role ?? (status === "error" || status === "warning" ? "alert" : "status")}
        aria-live={props["aria-live"] ?? (status === "error" ? "assertive" : "polite")}
      />
    )
  },
)
