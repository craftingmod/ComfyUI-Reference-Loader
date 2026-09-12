import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import { Button } from "../src/reference-loader/ui/button.tsx"
import { EditorFooter } from "../src/reference-loader/ui/editor-footer.tsx"
import { Field } from "../src/reference-loader/ui/field.tsx"
import { StatusMessage } from "../src/reference-loader/ui/status-message.tsx"
import { ToggleGroup } from "../src/reference-loader/ui/toggle-group.tsx"

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function mount(node: React.ReactNode): HTMLElement {
  const container = document.createElement("div")
  document.body.append(container)
  const root: Root = createRoot(container)
  flushSync(() => root.render(node))
  cleanups.push(() => {
    root.unmount()
    container.remove()
  })
  return container
}

describe("Reference Loader UI primitives", () => {
  test("renders button variants and busy state without losing native button behavior", () => {
    const container = mount(
      <Button variant="danger" busy busyLabel="Saving" className="extra">
        Save
      </Button>,
    )
    const button = container.querySelector<HTMLButtonElement>("button")!
    expect(button.className).toContain("rl-button")
    expect(button.className).toContain("rl-button--danger")
    expect(button.className).toContain("extra")
    expect(button.dataset.variant).toBe("danger")
    expect(button.dataset.state).toBe("busy")
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.disabled).toBe(true)
    expect(button.textContent).toBe("Saving")
  })

  test("connects field labels and validation messages to their control", () => {
    const container = mount(
      <Field label="Caption" description="Shown to the model." error="Caption is required.">
        <textarea />
      </Field>,
    )
    const control = container.querySelector<HTMLTextAreaElement>("textarea")!
    const label = container.querySelector<HTMLLabelElement>("label")!
    const description = container.querySelector<HTMLElement>(".rl-field__description")!
    const error = container.querySelector<HTMLElement>(".rl-field__error")!
    expect(control.id).toBeTruthy()
    expect(label.htmlFor).toBe(control.id)
    expect(control.getAttribute("aria-describedby")).toBe(`${description.id} ${error.id}`)
    expect(control.getAttribute("aria-invalid")).toBe("true")
    expect(error.getAttribute("role")).toBe("alert")
  })

  test("uses the child control id when htmlFor and child id differ", () => {
    const container = mount(
      <Field label="Caption" htmlFor="legacy-caption">
        <textarea id="caption" />
      </Field>,
    )
    const control = container.querySelector<HTMLTextAreaElement>("textarea")!
    const label = container.querySelector<HTMLLabelElement>("label")!
    expect(control.id).toBe("caption")
    expect(label.htmlFor).toBe("caption")
  })

  test("keeps toggle values pressed and moves focus with arrow keys", () => {
    const values: string[] = []
    const container = mount(
      <ToggleGroup
        legend="Mode"
        value="crop"
        items={[
          { value: "view", label: "View" },
          { value: "crop", label: "Crop" },
          { value: "mask", label: "Mask" },
        ]}
        onValueChange={(value) => values.push(value)}
      />,
    )
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("false")
    expect(buttons[1]?.getAttribute("aria-pressed")).toBe("true")
    buttons[0]?.click()
    expect(values).toEqual(["view"])
    buttons[0]?.focus()
    buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(buttons[1])
  })

  test("does not include unrelated legend buttons in keyboard navigation", () => {
    const container = mount(
      <ToggleGroup
        legend={<button type="button">Help</button>}
        value="view"
        items={[
          { value: "view", label: "View" },
          { value: "crop", label: "Crop" },
        ]}
      />,
    )
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
    const view = buttons.find((button) => button.textContent === "View")!
    const crop = buttons.find((button) => button.textContent === "Crop")!
    view.focus()
    view.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))
    expect(document.activeElement).toBe(view)
    view.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(document.activeElement).toBe(crop)
  })

  test("provides semantic status and shared editor actions", () => {
    const events: string[] = []
    const container = mount(
      <>
        <StatusMessage status="warning">Preview is still loading.</StatusMessage>
        <EditorFooter
          history={<Button data-action="undo">Undo</Button>}
          onCancel={() => events.push("cancel")}
          onApply={() => events.push("apply")}
        />
      </>,
    )
    const status = container.querySelector<HTMLElement>(".rl-status-message")!
    expect(status.dataset.status).toBe("warning")
    expect(status.getAttribute("role")).toBe("alert")
    container.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click()
    container.querySelector<HTMLButtonElement>('[data-action="apply"]')?.click()
    expect(container.querySelector(".rl-editor-history")).not.toBeNull()
    expect(events).toEqual(["cancel", "apply"])
  })
})
