import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { createPromptDefinitionsReact } from "../src/reference-loader/components/prompt-definitions-react.tsx"
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
    expect(() => mount.destroy()).not.toThrow()
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

  test("moves definition cards to React while preserving native body hosts and identity", () => {
    const promptRoot = document.createElement("div")
    const definitionsRoot = document.createElement("div")
    document.body.append(promptRoot, definitionsRoot)
    const initial = {
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [{ type: "text" as const, text: "red coat" }] }],
      shots: [
        { tag: "opening", frameIndex: 0, parts: [{ type: "text" as const, text: "enters" }] },
      ],
    }
    const controller = new ReferencePromptController(
      promptRoot,
      node,
      () => [],
      serializePromptDocument(initial),
      { legacyShell: false },
    )
    const promptMount = createPromptReact({ container: promptRoot, controller })
    controller.mountDefinitions(definitionsRoot)
    const definitionsMount = createPromptDefinitionsReact({
      container: definitionsRoot,
      controller,
    })

    const subject = definitionsRoot.querySelector<HTMLElement>('[data-prompt-definition="subject"]')
    const subjectIdentity = subject?.dataset.promptDefinitionIdentity
    const subjectBody = subject?.querySelector<HTMLElement>("[data-prompt-definition-body]")
    expect(definitionsRoot.querySelector("[data-prompt-definitions-react]")).not.toBeNull()
    expect(subjectBody?.contentEditable).toBe("true")

    flushSync(() => controller.renameDefinition("subject", subjectIdentity ?? "", "#lead"))
    const renamed = definitionsRoot.querySelector<HTMLElement>('[data-prompt-definition="subject"]')
    expect(renamed?.dataset.promptDefinitionTag).toBe("lead")
    expect(renamed?.dataset.promptDefinitionIdentity).toBe(subjectIdentity)
    expect(renamed?.querySelector("[data-prompt-definition-body]")).toBe(subjectBody)
    expect(renamed?.querySelector("[data-prompt-definition-body]")?.textContent).toBe("red coat")

    const shotIdentity =
      definitionsRoot.querySelector<HTMLElement>('[data-prompt-definition="shot"]')?.dataset
        .promptDefinitionIdentity ?? ""
    flushSync(() => controller.setShotFrameByIdentity(shotIdentity, 49))
    expect(controller.getDefinitionsSnapshot().shots[0]?.frameIndex).toBe(49)
    expect(JSON.parse(controller.serialize()).shots[0].frameIndex).toBe(49)

    flushSync(() => controller.setShotFrameDraft("opening", 72))
    expect(definitionsRoot.querySelector('[data-prompt-action="apply-shot-draft"]')).not.toBeNull()
    expect(
      definitionsRoot.querySelector<HTMLInputElement>("[data-prompt-shot-frame]")?.disabled,
    ).toBe(true)
    flushSync(() =>
      definitionsRoot
        .querySelector<HTMLButtonElement>('[data-prompt-action="cancel-shot-draft"]')
        ?.click(),
    )
    expect(JSON.parse(controller.serialize()).shots[0].frameIndex).toBe(49)

    definitionsMount.destroy()
    expect(definitionsRoot.childElementCount).toBe(0)
    promptMount.destroy()
    controller.destroy()
  })
})
