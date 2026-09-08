import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { createPromptDefinitionsReact } from "../src/reference-loader/components/prompt-definitions-react.tsx"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import { createPromptReact } from "../src/reference-loader/components/prompt-react.tsx"
import type { PromptReference } from "../src/reference-loader/prompt-state.ts"
import {
  createEmptyPromptDocument,
  serializePromptDocument,
} from "../src/reference-loader/prompt-state.ts"

const node: ComfyNode = {
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

function imageReference(): PromptReference {
  return {
    referenceId: "image-a",
    itemId: "image-a",
    mediaKind: "image",
    ordinal: 1,
    tag: "<Picture 1>",
    label: "image1",
    filename: "fighter.png",
    previewUrl: "/fighter.webp",
  }
}

function placeCaretAtEnd(element: HTMLElement): void {
  element.focus()
  const selection = getSelection()
  const range = document.createRange()
  const last = element.lastChild
  if (last?.nodeType === Node.TEXT_NODE) range.setStart(last, last.textContent?.length ?? 0)
  else {
    range.selectNodeContents(element)
    range.collapse(false)
  }
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function inputText(element: HTMLElement, value: string, data: string | null): void {
  element.textContent = value
  placeCaretAtEnd(element)
  flushSync(() =>
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data }),
    ),
  )
}

function press(element: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  flushSync(() => element.dispatchEvent(event))
  return event
}

afterEach(() => {
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
})

describe("Reference Prompt React shell", () => {
  test("owns one shell root while editor actions stay in the Controller", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "scene", parts: [{ type: "text", text: "Keep this" }] }],
    })
    const controller = new ReferencePromptController(root, node, () => [], serialized)
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

  test("keeps definitions in their separate React widget host", () => {
    const root = document.createElement("div")
    const definitions = document.createElement("div")
    document.body.append(root, definitions)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ tag: "hero", parts: [] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })

    flushSync(() => controller.mountDefinitions(definitions))
    const definitionsMount = createPromptDefinitionsReact({
      container: definitions,
      controller,
    })
    expect(root.querySelector(".rl-prompt-definitions")).toBeNull()
    expect(definitions.querySelector(".rl-prompt-definitions")).not.toBeNull()
    expect(definitions.querySelector("[data-prompt-definition-body-host]")).toBeNull()
    expect(
      definitions.querySelector("[data-prompt-definition-body][data-prompt-react-editor]"),
    ).not.toBeNull()
    expect(
      root.querySelector<HTMLElement>("[data-prompt-panel]")?.dataset.promptDefinitionsMounted,
    ).toBe("true")

    definitionsMount.destroy()
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
      {},
    )
    const first = controller.getViewSnapshot()
    expect(controller.getViewSnapshot()).toBe(first)
    let notifications = 0
    const unsubscribe = controller.subscribeView(() => notifications++)
    notifications = 0
    const workspace = document.createElement("div")
    controller.mountNativeHosts(workspace)
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

  test("renders every structured section body in React and preserves identity", () => {
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
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const sceneEditor = scene.querySelector<HTMLElement>("[data-prompt-react-editor]")!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    const cameraEditor = camera.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    expect(root.querySelectorAll("[data-prompt-section]")).toHaveLength(2)
    expect(scene.querySelector("[data-prompt-section-body-host]")).toBeNull()
    expect(camera.querySelector("[data-prompt-section-body-host]")).toBeNull()
    expect(sceneEditor.textContent).toBe("Keep scene")
    expect(cameraEditor.textContent).toBe("Keep camera")

    flushSync(() => controller.setPreset("minimax_h3_base"))
    expect(root.querySelector<HTMLElement>('[data-prompt-section="scene"]')).toBe(scene)
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section="scene"] [data-prompt-react-editor]'),
    ).toBe(sceneEditor)
    expect(
      root.querySelector<HTMLElement>(
        '[data-prompt-section="camera_direction"] [data-prompt-react-editor]',
      ),
    ).toBe(cameraEditor)

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

  test("keeps structured section editors uncontrolled while syncing canonical prompt state", () => {
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
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!
    expect(editor.dataset.promptSectionTitle).toBe("scene")
    expect(editor.contentEditable).toBe("true")
    expect(editor.dataset.placeholder).not.toBe("")
    expect(
      root.querySelector('[data-prompt-section="camera_direction"] [data-prompt-react-editor]'),
    ).not.toBeNull()

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

  test("owns the Raw editor in React and converts it through one canonical parse", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [{ type: "text", text: "old" }] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })

    flushSync(() =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    const raw = root.querySelector<HTMLElement>("[data-prompt-raw-editor]")!
    expect(raw.matches("[data-prompt-react-editor]")).toBe(true)
    expect(root.querySelector("[data-prompt-editor-host]")).toBeNull()
    inputText(raw, "scene:\nnew\n\ncamera_direction:\ntrack", null)
    expect(controller.document.view).toBe("raw")

    flushSync(() =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    expect(root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')?.textContent).toBe(
      "new",
    )
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section-body="camera_direction"]')?.textContent,
    ).toBe("track")

    flushSync(() =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click(),
    )
    const activeRaw = root.querySelector<HTMLElement>("[data-prompt-raw-editor]")!
    activeRaw.focus()
    const restored = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "scene", parts: [{ type: "text", text: "restored" }] }],
      view: "raw",
    })
    flushSync(() => controller.restore(restored))
    expect(root.querySelector<HTMLElement>("[data-prompt-raw-editor]")?.textContent).toContain(
      "restored",
    )

    mount.destroy()
    controller.destroy()
  })

  test("deletes React mention chips atomically and keeps the editor identity", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [imageReference()],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [{ type: "text", text: "Use " }] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    inputText(editor, "Use @", "@")
    press(editor, "Enter")
    const mentionEditor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    expect(mentionEditor.querySelector("[data-prompt-part='mention']")).not.toBeNull()
    placeCaretAtEnd(mentionEditor)
    const backspace = press(mentionEditor, "Backspace")
    expect(backspace.defaultPrevented).toBe(true)
    expect(mentionEditor.querySelector("[data-prompt-part='mention']")).toBeNull()
    expect(JSON.parse(controller.serialize()).sections[0].parts).toEqual([
      { type: "text", text: "Use " },
    ])

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
      {},
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

  test("routes React editor autocomplete and @ mention selection through the controller", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [imageReference()],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [{ type: "text", text: "Battle" }] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    inputText(editor, "Battle @", "@")

    const picker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    expect(picker.hidden).toBe(false)
    expect(picker.querySelectorAll("[data-prompt-reference-index]")).toHaveLength(1)
    expect(picker.parentElement?.hasAttribute("data-prompt-react-picker-slot")).toBe(true)

    const enter = press(editor, "Enter")
    expect(enter.defaultPrevented).toBe(true)
    expect(JSON.parse(controller.serialize()).sections[0].parts).toEqual([
      { type: "text", text: "Battle " },
      {
        type: "mention",
        referenceId: "image-a",
        mediaKind: "image",
        label: "image1",
      },
    ])
    expect(
      root.querySelector<HTMLElement>('[data-prompt-section="scene"] .rl-prompt-mention'),
    ).not.toBeNull()
    expect(root.querySelector<HTMLElement>("[data-prompt-picker]")?.hidden).toBe(true)

    mount.destroy()
    controller.destroy()
  })

  test("renders complete Shot and Subject icons in React # autocomplete", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ tag: "hero", parts: [] }],
        shots: [{ tag: "shot_entrance", frameIndex: 24, parts: [] }],
        sections: [{ title: "scene", parts: [] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    inputText(editor, "#shot", "#")

    const picker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    const shot = picker.querySelector<HTMLButtonElement>("[data-prompt-shot-index]")
    expect(shot?.querySelector(".rl-prompt-subject-icon")?.textContent).toBe("SH1")
    expect(shot?.querySelector("strong")?.textContent).toBe("#shot_entrance")
    expect(shot?.children).toHaveLength(2)
    expect(shot?.querySelector<HTMLElement>(".rl-prompt-subject-icon")?.style.background).not.toBe(
      "",
    )

    inputText(editor, "#", "#")

    const subject = picker.querySelector<HTMLButtonElement>("[data-prompt-subject-index]")
    expect(subject?.querySelector(".rl-prompt-subject-icon")?.textContent).toBe("S1")
    expect(
      subject?.querySelector<HTMLElement>(".rl-prompt-subject-icon")?.style.background,
    ).not.toBe("")

    mount.destroy()
    controller.destroy()
  })

  test("keeps React Subject autocomplete and two Prompt instances independent", () => {
    const firstRoot = document.createElement("div")
    const secondRoot = document.createElement("div")
    document.body.append(firstRoot, secondRoot)
    const first = new ReferencePromptController(
      firstRoot,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [] }],
      }),
      {},
    )
    const second = new ReferencePromptController(
      secondRoot,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [] }],
      }),
      {},
    )
    const firstMount = createPromptReact({ container: firstRoot, controller: first })
    const secondMount = createPromptReact({ container: secondRoot, controller: second })
    const firstEditor = firstRoot.querySelector<HTMLElement>("[data-prompt-react-editor]")!
    const secondEditor = secondRoot.querySelector<HTMLElement>("[data-prompt-react-editor]")!

    inputText(firstEditor, "Meet #woman", "#")
    expect(firstRoot.querySelector("[data-prompt-subject-create]")).not.toBeNull()
    expect(secondRoot.querySelector("[data-prompt-subject-create]")).toBeNull()

    expect(press(firstEditor, "Enter").defaultPrevented).toBe(true)
    expect(JSON.parse(first.serialize()).subjects).toEqual([{ tag: "woman", parts: [] }])
    expect(first.compiledPrompt).toContain("Meet <Subject 1>")
    expect(JSON.parse(second.serialize()).subjects).toEqual([])
    expect(secondEditor.textContent).toBe("")

    firstMount.destroy()
    secondMount.destroy()
    first.destroy()
    second.destroy()
  })

  test("routes section entry, drag/drop, and keyboard reorder through React actions", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      root,
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [
          { title: "scene", parts: [{ type: "text", text: "scene" }] },
          { title: "camera_direction", parts: [{ type: "text", text: "camera" }] },
        ],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })
    const entry = root.querySelector<HTMLElement>("[data-prompt-section-entry]")!
    inputText(entry, "/style", "/")
    expect(root.querySelectorAll("[data-prompt-alias-index]").length).toBeGreaterThan(0)
    expect(press(entry, "Enter").defaultPrevented).toBe(true)
    expect(root.querySelector('[data-prompt-section="visual_style"]')).not.toBeNull()
    expect(root.querySelectorAll("[data-prompt-section-body-host]")).toHaveLength(0)

    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    const sceneHandle = scene.querySelector<HTMLElement>("[data-prompt-section-drag-handle]")!
    Object.defineProperty(camera, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, height: 100 }),
    })
    flushSync(() => {
      sceneHandle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
      const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true })
      Object.defineProperty(dragover, "clientY", { value: 80 })
      camera.dispatchEvent(dragover)
      camera.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }))
    })
    expect(controller.document.sections.map((section) => section.title)).toEqual([
      "camera_direction",
      "scene",
      "visual_style",
    ])

    const movedHandle = root.querySelector<HTMLElement>(
      '[data-prompt-section="scene"] [data-prompt-section-drag-handle]',
    )!
    const keyboard = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
    flushSync(() => movedHandle.dispatchEvent(keyboard))
    expect(keyboard.defaultPrevented).toBe(true)
    expect(controller.document.sections.map((section) => section.title)).toEqual([
      "scene",
      "camera_direction",
      "visual_style",
    ])

    mount.destroy()
    controller.destroy()
  })

  test("moves definition cards and their bodies to React while preserving identity", () => {
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
      {},
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
    expect(subject?.querySelector("[data-prompt-definition-body-host]")).toBeNull()
    expect(subjectBody?.matches("[data-prompt-react-editor]")).toBe(true)
    expect(subjectBody?.contentEditable).toBe("true")

    const subjectTag = subject?.querySelector<HTMLInputElement>(
      "[data-prompt-definition-tag-input]",
    )!
    const shotTag = definitionsRoot.querySelector<HTMLInputElement>(
      '[data-prompt-definition="shot"] [data-prompt-definition-tag-input]',
    )!
    subjectTag.value = "#he#ro##"
    shotTag.value = "##open#ing"
    flushSync(() => {
      subjectTag.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
      shotTag.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    })
    expect(subjectTag.value).toBe("#hero")
    expect(shotTag.value).toBe("#opening")

    flushSync(() => controller.renameDefinition("subject", subjectIdentity ?? "", "##lead#"))
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

  test("persists edits from the React Prompt and Subject bodies", () => {
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
      {},
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
