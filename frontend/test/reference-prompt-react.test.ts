import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import { createPromptReact } from "../src/reference-loader/components/prompt-react.tsx"
import {
  createEmptyPromptDocument,
  serializePromptDocument,
} from "../src/reference-loader/prompt-state.ts"

const node: ComfyNode = {
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

afterEach(() => {
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
})

describe("Reference Prompt React shell", () => {
  test("owns one shell root while native editor actions stay in the Controller", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "scene", parts: [{ type: "text", text: "Keep this" }] }],
    })
    const controller = new ReferencePromptController(root, node, () => [], serialized, {
      legacyShell: false,
    })
    const mount = createPromptReact({ container: root, controller })
    const panel = root.querySelector<HTMLElement>("[data-prompt-panel]")
    const workspace = root.querySelector<HTMLElement>("[data-prompt-workspace]")

    expect(root.querySelectorAll("[data-prompt-panel]")).toHaveLength(1)
    expect(panel).not.toBeNull()
    expect(workspace?.querySelector('[data-prompt-section-body="scene"]')).not.toBeNull()
    expect(controller.getViewSnapshot()).toMatchObject({
      view: "structured",
      sourceText: "scene:\nKeep this",
      compiledText: "scene:\nKeep this",
      canClear: true,
      nativeHosts: { workspace: true, picker: true },
    })

    flushSync(() =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    expect(controller.document.view).toBe("raw")
    expect(root.querySelector<HTMLElement>("[data-prompt-panel]")).toBe(panel)
    expect(workspace?.querySelector("[data-prompt-editor]")).not.toBeNull()

    flushSync(() => root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')?.click())
    expect(controller.compiledPrompt).toBe("")
    expect(root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')?.disabled).toBe(
      true,
    )

    mount.destroy()
    expect(root.childElementCount).toBe(0)
    controller.destroy()
  })

  test("keeps definitions in their separate native widget host", () => {
    const root = document.createElement("div")
    const definitions = document.createElement("div")
    document.body.append(root, definitions)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument(createEmptyPromptDocument()),
      { legacyShell: false },
    )
    const mount = createPromptReact({ container: root, controller })

    flushSync(() => controller.mountDefinitions(definitions))
    expect(root.querySelector(".rl-prompt-definitions")).toBeNull()
    expect(definitions.querySelector(".rl-prompt-definitions")).not.toBeNull()
    expect(
      root.querySelector<HTMLElement>("[data-prompt-panel]")?.dataset.promptDefinitionsMounted,
    ).toBe("true")

    mount.destroy()
    controller.destroy()
  })

  test("publishes stable snapshots and removes host listeners on replacement", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument(createEmptyPromptDocument()),
      { legacyShell: false },
    )
    const first = controller.getViewSnapshot()
    expect(controller.getViewSnapshot()).toBe(first)
    let notifications = 0
    const unsubscribe = controller.subscribeView(() => notifications++)
    notifications = 0
    const workspace = document.createElement("div")
    const picker = document.createElement("div")
    controller.mountNativeHosts(workspace, picker)
    expect(notifications).toBeGreaterThan(0)
    const afterMount = controller.getViewSnapshot()
    expect(afterMount).not.toBe(first)

    controller.unmountNativeHosts()
    expect(controller.getViewSnapshot().nativeHosts).toEqual({
      workspace: false,
      picker: false,
      definitions: false,
    })
    unsubscribe()
    controller.destroy()
  })
})
