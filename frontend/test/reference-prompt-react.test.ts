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

    flushSync(() =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    expect(controller.document.view).toBe("structured")
    expect(
      workspace?.querySelector("[data-prompt-editor][data-prompt-react-editor]"),
    ).not.toBeNull()
    expect(workspace?.querySelector('[data-prompt-section-body="scene"]')).not.toBeNull()

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

  test("renders section shells in React while preserving native body identity", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const initial = {
      ...createEmptyPromptDocument(),
      sections: [
        { title: "scene", parts: [{ type: "text" as const, text: "Keep scene" }] },
        { title: "camera_direction", parts: [{ type: "text" as const, text: "Keep camera" }] },
      ],
    }
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument(initial),
      { legacyShell: false },
    )
    const mount = createPromptReact({ container: root, controller })
    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const sceneEditor = scene.querySelector<HTMLElement>("[data-prompt-react-editor]")!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    const cameraBody = camera.querySelector<HTMLElement>("[data-prompt-section-body]")!

    expect(root.querySelectorAll("[data-prompt-section]")).toHaveLength(2)
    expect(scene.querySelector("[data-prompt-section-body-host]")).toBeNull()
    expect(sceneEditor.textContent).toBe("Keep scene")
    expect(camera.querySelector("[data-prompt-section-body-host]")).not.toBeNull()
    expect(cameraBody.textContent).toBe("Keep camera")

    flushSync(() => controller.setPreset("minimax_h3_base"))
    expect(root.querySelector<HTMLElement>('[data-prompt-section="scene"]')).toBe(scene)
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section="scene"] [data-prompt-react-editor]'),
    ).toBe(sceneEditor)

    flushSync(() => controller.moveSection("scene", 1))
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-prompt-section]")].map(
        (card) => card.dataset.promptSection,
      ),
    ).toEqual(["camera_direction", "scene"])
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section="scene"] [data-prompt-react-editor]'),
    ).toBe(sceneEditor)

    flushSync(() =>
      root
        .querySelector<HTMLButtonElement>(
          '[data-prompt-action="remove-section"][data-prompt-section-title="camera_direction"]',
        )
        ?.click(),
    )
    expect(
      JSON.parse(controller.serialize()).sections.map(
        (section: { title: string }) => section.title,
      ),
    ).toEqual(["scene"])
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section="scene"] [data-prompt-react-editor]'),
    ).toBe(sceneEditor)

    mount.destroy()
    controller.destroy()
  })

  test("keeps one plain text editor uncontrolled while syncing canonical prompt state", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const initial = {
      ...createEmptyPromptDocument(),
      sections: [
        { title: "scene", parts: [{ type: "text" as const, text: "old scene" }] },
        { title: "camera_direction", parts: [{ type: "text" as const, text: "native camera" }] },
      ],
    }
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument(initial),
      { legacyShell: false },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!
    expect(editor.dataset.promptSectionTitle).toBe("scene")
    expect(editor.contentEditable).toBe("true")
    expect(editor.dataset.placeholder).not.toBe("")
    expect(
      root.querySelector('[data-prompt-section="camera_direction"] [data-prompt-react-editor]'),
    ).toBeNull()

    editor.focus()
    flushSync(() => {
      editor.textContent = "new scene"
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "e" }))
    })
    expect(JSON.parse(controller.serialize()).sections).toEqual([
      { title: "scene", parts: [{ type: "text", text: "new scene" }] },
      { title: "camera_direction", parts: [{ type: "text", text: "native camera" }] },
    ])
    expect(root.querySelector<HTMLElement>("[data-prompt-react-editor]")).toBe(editor)

    flushSync(() => controller.setPreset("minimax_h3_base"))
    expect(root.querySelector<HTMLElement>("[data-prompt-react-editor]")).toBe(editor)
    expect(editor.textContent).toBe("new scene")

    editor.blur()
    flushSync(() =>
      controller.restore(
        serializePromptDocument({
          ...initial,
          sections: [
            { title: "scene", parts: [{ type: "text" as const, text: "restored scene" }] },
            initial.sections[1]!,
          ],
        }),
      ),
    )
    expect(root.querySelector<HTMLElement>("[data-prompt-react-editor]")).toBe(editor)
    expect(editor.textContent).toBe("restored scene")

    mount.destroy()
    controller.destroy()
  })

  test("defers canonical updates during IME composition until compositionend", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [{ type: "text", text: "before" }] }],
      }),
      { legacyShell: false },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    flushSync(() => {
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }))
      editor.textContent = "during composition"
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: "중" }))
    })
    expect(controller.getSectionsSnapshot().sections[0]?.text).toBe("before")

    flushSync(() => editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })))
    expect(controller.getSectionsSnapshot().sections[0]?.text).toBe("during composition")

    mount.destroy()
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

  test("persists edits from the React Prompt and Subject native bodies", () => {
    const promptRoot = document.createElement("div")
    const definitionsRoot = document.createElement("div")
    document.body.append(promptRoot, definitionsRoot)
    const initial = {
      ...createEmptyPromptDocument(),
      sections: [{ title: "scene", parts: [{ type: "text" as const, text: "old scene" }] }],
      subjects: [{ tag: "hero", parts: [{ type: "text" as const, text: "old subject" }] }],
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

    flushSync(() =>
      promptRoot.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    flushSync(() =>
      promptRoot.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    const promptBody = promptRoot.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const subjectBody = definitionsRoot.querySelector<HTMLElement>("[data-prompt-definition-body]")!
    promptBody.textContent = "new scene"
    promptBody.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    subjectBody.textContent = "new subject"
    subjectBody.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))

    expect(JSON.parse(controller.serialize())).toMatchObject({
      sections: [{ title: "scene", parts: [{ type: "text", text: "new scene" }] }],
      subjects: [{ tag: "hero", parts: [{ type: "text", text: "new subject" }] }],
    })

    definitionsMount.destroy()
    promptMount.destroy()
    controller.destroy()
  })
})
