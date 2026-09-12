import { type HTMLAttributes, type ReactElement, type ReactNode, type Ref } from "react"

import { Button } from "./button.tsx"

export interface EditorFooterProps extends HTMLAttributes<HTMLElement> {
  history?: ReactNode
  historyLabel?: string
  leading?: ReactNode
  onCancel: () => void
  onApply: () => void
  applyRef?: Ref<HTMLButtonElement>
  applyDisabled?: boolean
  applyBusy?: boolean
  applyLabel?: ReactNode
  applyBusyLabel?: ReactNode
  cancelLabel?: ReactNode
}

export function EditorFooter({
  history,
  historyLabel = "Editor history",
  leading,
  onCancel,
  onApply,
  applyRef,
  applyDisabled = false,
  applyBusy = false,
  applyLabel = "Apply",
  applyBusyLabel,
  cancelLabel = "Cancel",
  className,
  ...props
}: EditorFooterProps): ReactElement {
  const classes = ["rl-editor-footer", className].filter(Boolean).join(" ")
  return (
    <footer {...props} className={classes}>
      {leading}
      {history ? (
        <div className="rl-editor-history" aria-label={historyLabel}>
          {history}
        </div>
      ) : null}
      <Button type="button" data-action="cancel" onClick={onCancel}>
        {cancelLabel}
      </Button>
      <Button
        ref={applyRef}
        type="button"
        variant="primary"
        data-action="apply"
        disabled={applyDisabled}
        busy={applyBusy}
        busyLabel={applyBusyLabel}
        onClick={onApply}
      >
        {applyLabel}
      </Button>
    </footer>
  )
}
