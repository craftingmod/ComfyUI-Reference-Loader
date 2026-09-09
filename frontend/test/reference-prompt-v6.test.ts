import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { createPromptDefinitionsReact } from "../src/reference-loader/components/prompt-definitions-react.tsx"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import { createPromptReact } from "../src/reference-loader/components/prompt-react.tsx"
import {
  compilePromptDocumentV6,
  createPromptDefinitionId,
  migratePromptDocumentV5,
  parsePromptPartsV6,
  renamePromptDefinitionV6,
  serializePromptDocumentV6,
  validatePromptDocumentV6,
  type PromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

const node: ComfyNode = {
  addDOMWidget: () => ({ name: "unused", value: null }),
  setDirtyCanvas: () => undefined,
}

function documentV6(): PromptDocumentV6 {
  const subjectId = createPromptDefinitionId()
  const shotId = createPromptDefinitionId()
  return {
    version: 6,
    view: "structured",
    subjects: [
      {
        id: subjectId,
        tag: "hero",
        parts: [{ type: "text", text: "red coat" }],
      },
    ],
    shots: [
      {
        id: shotId,
        tag: "opening",
        frameIndex: 24,
        parts: [{ type: "definition-ref", definitionId: subjectId }],
      },
    ],
    sections: [
      {
        id: createPromptDefinitionId(),
        title: "scene",
        parts: [
          { type: "text", text: "Meet " },
          { type: "definition-ref", definitionId: subjectId },
          { type: "text", text: " at " },
          {
            type: "mention",
            referenceId: "image-a",
            mediaKind: "image",
            label: "image1",
          },
        ],
      },
    ],
  }
}

afterEach(() => {
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
})

describe("Reference Prompt v6 AST", () => {
  test("starts new Prompt state in v6 without converting existing v5 state", () => {
    const controller = new ReferencePromptController(node, () => [], undefined)
    expect(controller.usesPromptDocumentV6).toBe(true)
    expect(JSON.parse(controller.serialize()).version).toBe(6)

    controller.restore(
      JSON.stringify({
        version: 5,
        view: "structured",
        subjects: [],
        shots: [],
        sections: [],
      }),
    )
    expect(controller.usesPromptDocumentV6).toBe(false)
    expect(JSON.parse(controller.serialize()).version).toBe(5)
    controller.destroy()
  })

  test("validates, serializes, compiles, and renames by stable definition ID", () => {
    const value = documentV6()
    const parsed = validatePromptDocumentV6(JSON.parse(serializePromptDocumentV6(value)))
    expect(parsed.issues).toEqual([])
    expect(parsed.document).toEqual(value)
    expect(
      compilePromptDocumentV6(value, [
        {
          referenceId: "image-a",
          itemId: "image-a",
          mediaKind: "image",
          ordinal: 1,
          tag: "<Picture 1>",
          label: "image1",
          filename: "hero.png",
        },
      ]),
    ).toContain("Meet <Subject 1> at <Picture 1>")

    const subjectId = value.subjects[0]!.id
    const renamed = renamePromptDefinitionV6(value, subjectId, "lead")
    expect(renamed.subjects[0]?.tag).toBe("lead")
    expect(renamed.sections[0]?.parts[1]).toEqual({
      type: "definition-ref",
      definitionId: subjectId,
    })
  })

  test("does not promote text while compiling and migrates registered v5 tags once", () => {
    const value = documentV6()
    expect(compilePromptDocumentV6(value, [])).toContain("Meet <Subject 1>")
    expect(
      compilePromptDocumentV6(
        {
          ...value,
          sections: [
            {
              ...value.sections[0]!,
              parts: [{ type: "text", text: "#hero \\#hero" }],
            },
          ],
        },
        [],
      ),
    ).toContain("#hero \\#hero")
    const migrated = migratePromptDocumentV5(
      {
        version: 5,
        view: "structured",
        subjects: [{ tag: "hero", parts: [{ type: "text", text: "red" }] }],
        shots: [],
        sections: [
          {
            title: "scene",
            parts: [{ type: "text", text: "#hero \\#hero" }],
          },
        ],
      },
      (() => {
        let index = 0
        return () => `id-${++index}`
      })(),
    )
    expect(migrated.sections[0]?.parts).toEqual([
      { type: "definition-ref", definitionId: "id-1" },
      { type: "text", text: " \\#hero" },
    ])
    expect(parsePromptPartsV6("#hero \\#hero", [], migrated)).toEqual(migrated.sections[0]?.parts)
  })

  test("rejects duplicate section titles in the v6 contract", () => {
    const value = documentV6()
    const result = validatePromptDocumentV6({
      ...value,
      sections: [value.sections[0]!, { ...value.sections[0]!, id: createPromptDefinitionId() }],
    })
    expect(result.document).toBeUndefined()
    expect(result.issues[0]).toContain("sections[1].title is duplicated")
  })

  test("uses the v6 body command without reading editor DOM and rejects stale edits", () => {
    const value = documentV6()
    const sectionId = value.sections[0]!.id
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocumentV6(value),
    )
    expect(controller.usesPromptDocumentV6).toBe(true)
    const snapshot = controller.getPromptBodySnapshot({ type: "section", id: sectionId })!
    const accepted = controller.applyPromptBodyEdit({
      target: snapshot.target,
      baseRevision: snapshot.revision,
      epoch: snapshot.epoch,
      parts: [{ type: "text", text: "changed" }],
      editId: "edit-1",
      composing: false,
    })
    expect(accepted).toEqual({ ok: true, revision: 1, editId: "edit-1" })
    expect(
      controller.applyPromptBodyEdit({
        target: snapshot.target,
        baseRevision: snapshot.revision,
        epoch: snapshot.epoch,
        parts: [{ type: "text", text: "stale" }],
        editId: "edit-2",
        composing: false,
      }),
    ).toEqual({ ok: false, reason: "stale" })
    expect(JSON.parse(controller.serialize()).sections[0].parts).toEqual([
      { type: "text", text: "changed" },
    ])
    controller.destroy()
  })

  test("routes v6 picker selection to the active body editor handle", () => {
    const value = documentV6()
    const sectionId = value.sections[0]!.id
    const inserted: unknown[] = []
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
      serializePromptDocumentV6(value),
    )
    const release = controller.registerPromptBodyEditor(
      { type: "section", id: sectionId },
      {
        focus: () => undefined,
        flushAcceptedModel: () => undefined,
        cancelTransientSession: () => undefined,
        insertParts: (parts, replaceTextLength) => inserted.push(parts, replaceTextLength),
      },
    )
    controller.handlePromptBodyTrigger(
      { type: "section", id: sectionId },
      { trigger: "@", query: "image", replaceTextLength: 6 },
    )
    controller.activatePickerOption(0)
    expect(inserted).toEqual([
      [
        {
          type: "mention",
          referenceId: "image-a",
          mediaKind: "image",
          label: "image1",
        },
      ],
      6,
    ])
    release()
    controller.destroy()
  })

  test("mounts v6 section bodies through the Lexical adapter and keeps IDs on restore", () => {
    const value = documentV6()
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocumentV6(value),
    )
    const mount = createPromptReact({ container: root, controller })
    flushSync(() => undefined)
    expect(
      root.querySelector('[data-prompt-section="scene"] [data-prompt-react-editor]'),
    ).not.toBeNull()
    expect(root.querySelector("[data-prompt-lexical-reference]")).not.toBeNull()
    const serialized = controller.serialize()
    controller.restore(serialized)
    expect(JSON.parse(controller.serialize()).sections[0].id).toBe(value.sections[0]!.id)
    expect(JSON.parse(controller.serialize()).subjects[0].id).toBe(value.subjects[0]!.id)
    mount.destroy()
    controller.destroy()
  })

  test("refreshes definition chip labels without replacing the body editor", () => {
    const value = documentV6()
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocumentV6(value),
    )
    const mount = createPromptReact({ container: root, controller })
    flushSync(() => undefined)
    const editor = root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')!
    controller.renameDefinition("subject", value.subjects[0]!.id, "#lead")
    flushSync(() => undefined)
    expect(root.querySelector<HTMLElement>('[data-prompt-section-body="scene"]')).toBe(editor)
    expect(editor.textContent).toContain("#lead")
    mount.destroy()
    controller.destroy()
  })

  test("publishes a new body epoch when restore keeps text but changes IDs", () => {
    const value = documentV6()
    const root = document.createElement("div")
    document.body.append(root)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocumentV6(value),
    )
    const mount = createPromptReact({ container: root, controller })
    flushSync(() => undefined)
    const originalSectionId = value.sections[0]!.id
    const nextSectionId = createPromptDefinitionId()
    controller.restore(
      serializePromptDocumentV6({
        ...value,
        sections: [{ ...value.sections[0]!, id: nextSectionId }],
      }),
    )
    expect(
      controller.getPromptBodySnapshot({ type: "section", id: originalSectionId }),
    ).toBeUndefined()
    const snapshot = controller.getPromptBodySnapshot({ type: "section", id: nextSectionId })!
    expect(snapshot.epoch).toBe(1)
    expect(
      root.querySelector(`[data-prompt-section="scene"] [data-prompt-section-body="scene"]`),
    ).not.toBeNull()
    expect(JSON.parse(controller.serialize()).sections[0].id).toBe(nextSectionId)
    mount.destroy()
    controller.destroy()
  })

  test("reorders v6 sections and definitions through drag/drop without changing IDs", () => {
    const value = documentV6()
    const secondSubjectId = createPromptDefinitionId()
    const secondSectionId = createPromptDefinitionId()
    const expanded: PromptDocumentV6 = {
      ...value,
      subjects: [...value.subjects, { id: secondSubjectId, tag: "sidekick", parts: [] }],
      sections: [...value.sections, { id: secondSectionId, title: "camera_direction", parts: [] }],
    }
    const root = document.createElement("div")
    const definitionsRoot = document.createElement("div")
    document.body.append(root, definitionsRoot)
    const controller = new ReferencePromptController(
      node,
      () => [],
      serializePromptDocumentV6(expanded),
    )
    controller.mountDefinitions(definitionsRoot)
    const promptMount = createPromptReact({ container: root, controller })
    const definitionsMount = createPromptDefinitionsReact({
      container: definitionsRoot,
      controller,
    })
    flushSync(() => undefined)

    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    Object.defineProperty(camera, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, height: 100 }),
    })
    flushSync(() => {
      scene
        .querySelector<HTMLElement>("[data-prompt-section-drag-handle]")!
        .dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
      const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true })
      Object.defineProperty(dragover, "clientY", { value: 80 })
      camera.dispatchEvent(dragover)
      camera.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }))
    })
    const afterSectionDrag = JSON.parse(controller.serialize()) as PromptDocumentV6
    expect(afterSectionDrag.sections.map((section) => section.title)).toEqual([
      "camera_direction",
      "scene",
    ])
    expect(afterSectionDrag.sections.find((section) => section.title === "scene")?.id).toBe(
      value.sections[0]!.id,
    )

    const hero = definitionsRoot.querySelector<HTMLElement>(
      '[data-prompt-definition="subject"][data-prompt-definition-tag="hero"]',
    )!
    const sidekick = definitionsRoot.querySelector<HTMLElement>(
      '[data-prompt-definition="subject"][data-prompt-definition-tag="sidekick"]',
    )!
    Object.defineProperty(sidekick, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ top: 0, height: 100 }),
    })
    flushSync(() => {
      hero
        .querySelector<HTMLElement>("[data-prompt-definition-drag-handle]")!
        .dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }))
      const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true })
      Object.defineProperty(dragover, "clientY", { value: 80 })
      sidekick.dispatchEvent(dragover)
      sidekick.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }))
    })
    const afterDefinitionDrag = JSON.parse(controller.serialize()) as PromptDocumentV6
    expect(afterDefinitionDrag.subjects.map((subject) => subject.tag)).toEqual(["sidekick", "hero"])
    expect(afterDefinitionDrag.subjects.map((subject) => subject.id)).toEqual([
      secondSubjectId,
      value.subjects[0]!.id,
    ])

    definitionsMount.destroy()
    promptMount.destroy()
    controller.destroy()
  })
})
