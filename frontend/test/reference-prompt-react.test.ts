import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { createPromptDefinitionsReact } from "../src/reference-loader/components/prompt-definitions-react.tsx"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import { createPromptReact } from "../src/reference-loader/components/prompt-react.tsx"
import { PromptReferenceNode } from "../src/reference-loader/components/prompt-reference-node.tsx"
import type { PromptDocumentV6, PromptReference } from "../src/reference-loader/prompt-v6.ts"
import {
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  serializePromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

const node: ComfyNode = {
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

const createEmptyPromptDocument = createEmptyPromptDocumentV6

function serializePromptDocument(value: any): string {
  const document: PromptDocumentV6 = {
    version: 6,
    view: value.view ?? "structured",
    subjects: (value.subjects ?? []).map((subject: any) => ({
      ...subject,
      id: subject.id ?? createPromptDefinitionId(),
    })),
    shots: (value.shots ?? []).map((shot: any) => ({
      ...shot,
      id: shot.id ?? createPromptDefinitionId(),
    })),
    sections: (value.sections ?? []).map((section: any) => ({
      ...section,
      id: section.id ?? createPromptDefinitionId(),
    })),
  }
  return serializePromptDocumentV6(document)
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

function inputText(element: HTMLInputElement, value: string, data: string | null): void {
  element.value = value
  element.focus()
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
    const controller = new ReferencePromptController(node, () => [], serialized)
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
    expect(
      workspace?.querySelector('[data-prompt-editor][data-capture-wheel="true"]'),
    ).not.toBeNull()
    expect(
      workspace?.querySelector('[data-prompt-section-body="scene"][data-capture-wheel="true"]'),
    ).not.toBeNull()

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

  test("preserves media mention IDs across Raw and Structured", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [
        {
          referenceId: "image-a",
          itemId: "image-a",
          mediaKind: "image",
          ordinal: 1,
          tag: "<Picture 1>",
          label: "image1",
          filename: "hero.png",
        },
      ],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [
          {
            title: "scene",
            parts: [
              { type: "text", text: "Use " },
              { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
              { type: "text", text: "." },
            ],
          },
        ],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const toggle = () =>
      root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click()

    flushSync(toggle)
    expect(controller.document.view).toBe("raw")
    expect(root.querySelector<HTMLTextAreaElement>("[data-prompt-raw-editor]")?.value).toBe(
      "scene:\nUse @image1.",
    )

    flushSync(toggle)
    expect(controller.document.view).toBe("structured")
    expect(controller.document.sections[0]?.parts).toEqual([
      { type: "text", text: "Use " },
      { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
      { type: "text", text: "." },
    ])
    expect(root.querySelector(".rl-prompt-lexical-reference")).not.toBeNull()

    mount.destroy()
    controller.destroy()
  })

  test("keeps definitions in their separate React widget host", () => {
    const root = document.createElement("div")
    const definitions = document.createElement("div")
    document.body.append(root, definitions)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ tag: "hero", parts: [] }],
        shots: [{ tag: "opening", frameIndex: 0, parts: [] }],
      }),
      {},
    )
    const mount = createPromptReact({ container: root, controller })

    flushSync(() => controller.mountDefinitions(definitions))
    const definitionsMount = createPromptDefinitionsReact({
      container: definitions,
      controller,
    })
    const definitionsHeader = definitions.querySelector<HTMLElement>(".rl-prompt-toolbar")!
    expect(definitionsHeader.querySelector(".rl-prompt-toolbar__copy strong")?.textContent).toBe(
      "Subjects & Shots",
    )
    expect(definitionsHeader.querySelector(".rl-prompt-toolbar__copy small")?.textContent).toBe(
      "Definitions keep #tags; indexes are generated only in compiled output.",
    )
    expect(definitionsHeader.querySelector('[data-prompt-action="add-subject"]')).not.toBeNull()
    expect(definitionsHeader.querySelector('[data-prompt-action="add-shot"]')).not.toBeNull()
    expect(definitions.querySelectorAll(".rl-channel")).toHaveLength(2)
    expect(
      definitions.querySelector('[data-prompt-definition-category="subject"] strong')?.textContent,
    ).toBe("Subjects")
    expect(
      definitions.querySelector('[data-prompt-definition-category="shot"] strong')?.textContent,
    ).toBe("Shots")
    expect(root.querySelector(".rl-prompt-definitions")).toBeNull()
    expect(definitions.querySelector(".rl-prompt-definitions")).not.toBeNull()
    expect(definitions.querySelector("[data-prompt-definition-body-host]")).toBeNull()
    expect(
      definitions.querySelector("[data-prompt-definition-body][data-prompt-react-editor]"),
    ).not.toBeNull()
    expect(
      definitions.querySelector('[data-prompt-definition="subject"] [data-prompt-editor-hint]'),
    ).not.toBeNull()
    expect(
      definitions.querySelector('[data-prompt-definition="shot"] [data-prompt-editor-hint]'),
    ).not.toBeNull()
    const emptySubjectBody = definitions.querySelector<HTMLElement>(
      '[data-prompt-definition="subject"] [data-prompt-definition-body]',
    )
    expect(emptySubjectBody?.getAttribute("data-placeholder")).toBeNull()
    expect(emptySubjectBody?.textContent).toBe("")
    expect(
      root.querySelector<HTMLElement>("[data-prompt-panel]")?.dataset.promptDefinitionsMounted,
    ).toBe("true")

    const subjectIdentity = controller.getDefinitionsSnapshot().subjects[0]!.identity
    const shotIdentity = controller.getDefinitionsSnapshot().shots[0]!.identity
    const subjectSnapshot = controller.getPromptBodySnapshot({
      type: "definition",
      id: subjectIdentity,
    })!
    flushSync(() =>
      expect(
        controller.applyPromptBodyEdit({
          target: subjectSnapshot.target,
          baseRevision: subjectSnapshot.revision,
          epoch: subjectSnapshot.epoch,
          parts: [{ type: "text", text: "red coat" }],
          editId: "definition-helper-subject-add",
          composing: false,
        }),
      ).toMatchObject({ ok: true }),
    )
    expect(
      definitions.querySelector('[data-prompt-definition="subject"] [data-prompt-editor-hint]'),
    ).toBeNull()

    const shotSnapshot = controller.getPromptBodySnapshot({
      type: "definition",
      id: shotIdentity,
    })!
    flushSync(() =>
      expect(
        controller.applyPromptBodyEdit({
          target: shotSnapshot.target,
          baseRevision: shotSnapshot.revision,
          epoch: shotSnapshot.epoch,
          parts: [{ type: "text", text: "wide shot" }],
          editId: "definition-helper-shot-add",
          composing: false,
        }),
      ).toMatchObject({ ok: true }),
    )
    expect(
      definitions.querySelector('[data-prompt-definition="shot"] [data-prompt-editor-hint]'),
    ).toBeNull()

    const subjectFilledSnapshot = controller.getPromptBodySnapshot({
      type: "definition",
      id: subjectIdentity,
    })!
    flushSync(() =>
      expect(
        controller.applyPromptBodyEdit({
          target: subjectFilledSnapshot.target,
          baseRevision: subjectFilledSnapshot.revision,
          epoch: subjectFilledSnapshot.epoch,
          parts: [],
          editId: "definition-helper-subject-clear",
          composing: false,
        }),
      ).toMatchObject({ ok: true }),
    )
    expect(
      definitions.querySelector('[data-prompt-definition="subject"] [data-prompt-editor-hint]'),
    ).not.toBeNull()

    const shotFilledSnapshot = controller.getPromptBodySnapshot({
      type: "definition",
      id: shotIdentity,
    })!
    flushSync(() =>
      expect(
        controller.applyPromptBodyEdit({
          target: shotFilledSnapshot.target,
          baseRevision: shotFilledSnapshot.revision,
          epoch: shotFilledSnapshot.epoch,
          parts: [],
          editId: "definition-helper-shot-clear",
          composing: false,
        }),
      ).toMatchObject({ ok: true }),
    )
    expect(
      definitions.querySelector('[data-prompt-definition="shot"] [data-prompt-editor-hint]'),
    ).not.toBeNull()

    definitionsMount.destroy()
    mount.destroy()
    controller.destroy()
  })

  test("publishes stable snapshots and clears workspace and picker mounts on replacement", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
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
    controller.mountPromptWorkspace(workspace)
    expect(notifications).toBeGreaterThan(0)
    const afterMount = controller.getViewSnapshot()
    expect(afterMount).not.toBe(first)

    controller.unmountPromptWorkspace()
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

  test("puts empty-section instructions in a helper and removes them after editing", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [] }],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const section = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const editor = section.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!

    expect(section.querySelector<HTMLElement>("[data-prompt-editor-hint]")?.textContent).toBe(
      "Write this section. Type @ for media or # for subjects.",
    )
    expect(editor.textContent).toBe("")
    expect(editor.querySelector(":scope > p")).not.toBeNull()

    const sectionId = controller.document.sections[0]!.id
    const snapshot = controller.getPromptBodySnapshot({ type: "section", id: sectionId })!
    flushSync(() =>
      controller.applyPromptBodyEdit({
        target: snapshot.target,
        baseRevision: snapshot.revision,
        epoch: snapshot.epoch,
        parts: [{ type: "text", text: "Describe the scene" }],
        editId: "edit-helper-test",
        composing: false,
      }),
    )
    expect(section.querySelector("[data-prompt-editor-hint]")).toBeNull()
    expect(editor.textContent).toBe("Describe the scene")

    mount.destroy()
    controller.destroy()
  })

  test("keeps prompt undo and redo local to the focused rich editor", async () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [
          { title: "scene", parts: [] },
          { title: "camera_direction", parts: [{ type: "text", text: "camera" }] },
        ],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const siblingEditor = root.querySelector<HTMLElement>(
      '[data-prompt-section-body="camera_direction"]',
    )!
    let graphUndoCount = 0
    root.addEventListener("keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key.toLowerCase() === "z") graphUndoCount += 1
    })
    const paste = async (text: string): Promise<void> => {
      placeCaretAtEnd(editor)
      const event = new Event("paste", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "clipboardData", {
        value: {
          getData: () => text,
          setData: () => undefined,
        },
      })
      flushSync(() => editor.dispatchEvent(event))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    await paste("first")
    await paste("updated")
    expect(controller.document.sections[0]?.parts).toEqual([{ type: "text", text: "firstupdated" }])

    const undo = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    flushSync(() => editor.dispatchEvent(undo))
    expect(undo.defaultPrevented).toBe(true)
    expect(graphUndoCount).toBe(0)
    expect(controller.document.sections[0]?.parts).toEqual([{ type: "text", text: "first" }])
    expect(editor.textContent).toBe("first")
    expect(getSelection()?.anchorOffset).toBe(5)
    expect(root.querySelector<HTMLElement>('[data-prompt-section-body="camera_direction"]')).toBe(
      siblingEditor,
    )

    const redo = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    flushSync(() => editor.dispatchEvent(redo))
    expect(redo.defaultPrevented).toBe(true)
    expect(graphUndoCount).toBe(0)
    expect(controller.document.sections[0]?.parts).toEqual([{ type: "text", text: "firstupdated" }])
    expect(editor.textContent).toBe("firstupdated")
    expect(root.querySelector<HTMLElement>('[data-prompt-section-body="camera_direction"]')).toBe(
      siblingEditor,
    )

    mount.destroy()
    controller.destroy()
  })

  test("renders inserted definition references with their tag instead of the UUID", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const subjectId = createPromptDefinitionId()
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ id: subjectId, tag: "hero", parts: [] }],
        sections: [{ title: "scene", parts: [] }],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const sectionId = controller.document.sections[0]!.id
    const snapshot = controller.getPromptBodySnapshot({ type: "section", id: sectionId })!

    flushSync(() =>
      controller.applyPromptBodyEdit({
        target: snapshot.target,
        baseRevision: snapshot.revision,
        epoch: snapshot.epoch,
        parts: [{ type: "definition-ref", definitionId: subjectId }],
        editId: "edit-definition-label-test",
        composing: false,
      }),
    )
    expect(editor.querySelector(".rl-prompt-mention__label")?.textContent).toBe("#hero")
    expect(editor.textContent).not.toContain(subjectId)
    const chip = editor.querySelector<HTMLElement>(".rl-prompt-subject")
    expect(chip).not.toBeNull()
    expect(chip?.querySelector(".rl-prompt-subject-icon")?.textContent).toBe("S1")
    expect(chip?.style.getPropertyValue("--rl-prompt-subject-color")).not.toBe("")

    mount.destroy()
    controller.destroy()
  })

  test("renders an available media preview on mention chips", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [
        {
          referenceId: "image-a",
          itemId: "image-a",
          mediaKind: "image",
          ordinal: 1,
          tag: "<Picture 1>",
          label: "image1",
          filename: "hero.png",
          previewUrl: "/hero.webp",
        },
      ],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [
          {
            title: "scene",
            parts: [
              { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
            ],
          },
        ],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const chip = editor.querySelector<HTMLElement>(".rl-prompt-lexical-reference")
    expect(chip?.classList.contains("is-stale")).toBe(false)
    expect(chip?.querySelector("img")?.getAttribute("src")).toBe("/hero.webp")
    expect(chip?.querySelector(".rl-prompt-mention__label")?.textContent).toBe("@image1")

    mount.destroy()
    controller.destroy()
  })

  test("refreshes a restored mention chip when its runtime preview becomes available", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const references: PromptReference[] = [
      {
        referenceId: "image-a",
        itemId: "image-a",
        mediaKind: "image" as const,
        ordinal: 1,
        tag: "<Picture 1>",
        label: "image1",
        filename: "hero.png",
      },
    ]
    const controller = new ReferencePromptController(
      node,
      () => references,
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [
          {
            title: "scene",
            parts: [
              { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
            ],
          },
        ],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    expect(editor.querySelector(".rl-prompt-lexical-reference img")).toBeNull()

    references[0]!.previewUrl = "/hero.webp"
    flushSync(() => controller.refreshReferences())

    expect(editor.querySelector(".rl-prompt-lexical-reference img")?.getAttribute("src")).toBe(
      "/hero.webp",
    )

    mount.destroy()
    controller.destroy()
  })

  test("copies visible definition and media chips as authoring tags", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const subjectId = createPromptDefinitionId()
    const references = [
      {
        referenceId: "image-a",
        itemId: "image-a",
        mediaKind: "image" as const,
        ordinal: 1,
        tag: "<Picture 1>",
        label: "image1",
        filename: "hero.png",
      },
    ]
    const controller = new ReferencePromptController(
      node,
      () => references,
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ id: subjectId, tag: "hero", parts: [] }],
        sections: [
          {
            title: "scene",
            parts: [
              { type: "text", text: "이와 함께 " },
              { type: "definition-ref", definitionId: subjectId },
              { type: "text", text: " 를 " },
              { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
            ],
          },
        ],
      }),
      { locale: "ko" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const copied = new Map<string, string>()
    const event = new Event("copy", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "clipboardData", {
      value: {
        setData(type: string, value: string) {
          copied.set(type, value)
        },
        getData(type: string) {
          return copied.get(type) ?? ""
        },
      },
    })

    flushSync(() => editor.dispatchEvent(event))

    expect(copied.get("text/plain")).toBe("이와 함께 #hero 를 @image1")
    expect(event.defaultPrevented).toBe(true)

    mount.destroy()
    controller.destroy()
  })

  test("keeps Prompt paste from reaching the ComfyUI canvas", () => {
    const outer = document.createElement("div")
    const root = document.createElement("div")
    outer.append(root)
    document.body.append(outer)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [] }],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    let canvasPaste = false
    outer.addEventListener("paste", () => {
      canvasPaste = true
    })
    const event = new Event("paste", { bubbles: true, cancelable: true })
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: () => "pasted text",
        setData: () => undefined,
      },
    })

    flushSync(() => editor.dispatchEvent(event))

    expect(canvasPaste).toBe(false)

    mount.destroy()
    controller.destroy()
  })

  test("keeps inline reference chips on the surrounding text-caret path", () => {
    expect(PromptReferenceNode.prototype.isInline()).toBe(true)
    expect(PromptReferenceNode.prototype.isKeyboardSelectable()).toBe(false)
  })

  test("commits @ and # picker choices with Enter before the picker element mounts", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const subjectId = createPromptDefinitionId()
    const controller = new ReferencePromptController(
      node,
      () => [
        {
          referenceId: "image-a",
          itemId: "image-a",
          mediaKind: "image",
          ordinal: 1,
          tag: "<Picture 1>",
          label: "image1",
          filename: "hero.png",
        },
      ],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ id: subjectId, tag: "hero", parts: [] }],
        sections: [{ title: "scene", parts: [{ type: "text", text: "Write " }] }],
      }),
      { locale: "en" },
    )
    const mount = createPromptReact({ container: root, controller })
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    const sectionId = controller.document.sections[0]!.id
    const inserted: unknown[] = []
    const release = controller.registerPromptBodyEditor(
      { type: "section", id: sectionId },
      {
        focus: () => undefined,
        flushAcceptedModel: () => undefined,
        cancelTransientSession: () => undefined,
        insertParts: (parts, replaceTextLength) => inserted.push(parts, replaceTextLength),
      },
    )

    controller.unmountPickerElement()
    controller.handlePromptBodyTrigger(
      { type: "section", id: sectionId },
      { trigger: "@", query: "", replaceTextLength: 1 },
    )
    expect(press(editor, "Enter").defaultPrevented).toBe(true)
    expect(inserted).toEqual([
      [
        {
          type: "mention",
          referenceId: "image-a",
          mediaKind: "image",
          label: "image1",
        },
      ],
      1,
    ])

    inserted.length = 0
    controller.handlePromptBodyTrigger(
      { type: "section", id: sectionId },
      { trigger: "#", query: "", replaceTextLength: 1 },
    )
    expect(press(editor, "Enter").defaultPrevented).toBe(true)
    expect(inserted).toEqual([[{ type: "definition-ref", definitionId: subjectId }], 1])

    release()
    mount.destroy()
    controller.destroy()
  })

  test("routes section entry, drag/drop, and keyboard reorder through React actions", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
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
    const entry = root.querySelector<HTMLInputElement>("[data-prompt-section-entry]")!
    inputText(entry, "/style", "/")
    expect(root.querySelectorAll("[data-prompt-alias-index]").length).toBeGreaterThan(0)
    expect(entry.getAttribute("placeholder")).toBeNull()
    inputText(entry, "", null)
    expect(entry.value).toBe("")
    expect(entry.getAttribute("placeholder")).toBe("Add section: title_tag: or /alias")
    inputText(entry, "/style", "/")
    expect(press(entry, "Enter").defaultPrevented).toBe(true)
    expect(entry.value).toBe("")
    expect(root.querySelector('[data-prompt-section="visual_style"]')).not.toBeNull()
    expect(root.querySelectorAll("[data-prompt-section-body-host]")).toHaveLength(0)

    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    const sceneHeader = scene.querySelector<HTMLElement>(".rl-prompt-section__header")!
    const removeButton = scene.querySelector<HTMLButtonElement>(
      '[data-prompt-action="remove-section"]',
    )!
    expect(sceneHeader.getAttribute("draggable")).toBe("true")
    expect(removeButton.getAttribute("draggable")).toBe("false")
    Object.defineProperty(camera, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, height: 100 }),
    })
    flushSync(() => {
      sceneHeader.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
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
})
