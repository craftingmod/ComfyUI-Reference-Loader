import { cloneElement, useId, type HTMLAttributes, type ReactElement, type ReactNode } from "react"

export interface FieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactElement
}

type FieldControlProps = {
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean | "true" | "false"
}

export function Field({
  label,
  description,
  error,
  htmlFor,
  className,
  children,
  ...props
}: FieldProps): ReactElement {
  const generatedId = `rl-field-${useId().replaceAll(":", "")}`
  const childProps = children.props as {
    id?: string
    "aria-describedby"?: string
    "aria-invalid"?: boolean | "true" | "false"
  }
  const controlId = childProps.id ?? htmlFor ?? generatedId
  const descriptionId = description ? `${controlId}-description` : undefined
  const hasError = error !== undefined && error !== null && error !== false
  const errorId = hasError ? `${controlId}-error` : undefined
  const describedBy = [childProps["aria-describedby"], descriptionId, errorId]
    .filter(Boolean)
    .join(" ")
  const control = cloneElement(children as ReactElement<FieldControlProps>, {
    id: controlId,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(hasError ? { "aria-invalid": "true" } : {}),
  })
  const classes = ["rl-field", className].filter(Boolean).join(" ")

  return (
    <div {...props} className={classes}>
      <label className="rl-field__label" htmlFor={htmlFor ?? controlId}>
        {label}
      </label>
      {control}
      {description ? (
        <small className="rl-field__description" id={descriptionId}>
          {description}
        </small>
      ) : null}
      {hasError ? (
        <p className="rl-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
