import { describe, expect, test } from "bun:test"

import { PromptStore } from "../src/reference-loader/prompt-store.ts"
import {
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  serializePromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

describe("PromptStore", () => {
  test("owns one immutable document and keeps pure projections in sync", () => {
    const sectionId = createPromptDefinitionId()
    const initial = {
      ...createEmptyPromptDocumentV6(),
      sections: [
        { id: sectionId, title: "scene", parts: [{ type: "text" as const, text: "Use " }] },
      ],
    }
    const store = new PromptStore(() => [], serializePromptDocumentV6(initial))
    const initialSnapshot = store.snapshot
    let notifications = 0
    const release = store.subscribe(() => {
      notifications += 1
    })

    expect(store.document).toBe(initialSnapshot.document)
    expect(store.sourceText).toBe("scene:\nUse")
    expect(store.compiledText).toBe("scene:\nUse")
    expect(Object.isFrozen(store.document)).toBe(true)
    expect(Object.isFrozen(store.document.sections)).toBe(true)

    expect(
      store.replace({
        ...store.document,
        sections: [{ ...store.document.sections[0]!, parts: [{ type: "text", text: "Updated" }] }],
      }),
    ).toBe(true)
    expect(store.document.sections[0]?.parts).toEqual([{ type: "text", text: "Updated" }])
    expect(store.serialize()).toBe(serializePromptDocumentV6(store.document))
    expect(notifications).toBe(2)

    expect(store.replace(store.document)).toBe(false)
    expect(notifications).toBe(2)
    release()
    store.destroy()
  })

  test("preserves v6 restore rejection and definition commands", () => {
    const subjectId = createPromptDefinitionId()
    const store = new PromptStore(
      () => [],
      serializePromptDocumentV6({
        ...createEmptyPromptDocumentV6(),
        subjects: [{ id: subjectId, tag: "hero", parts: [] }],
      }),
    )

    expect(store.renameDefinition(subjectId, "lead")).toBe(true)
    expect(store.document.subjects[0]?.tag).toBe("lead")
    expect(store.removeDefinition(subjectId)).toBe(true)
    expect(store.document.subjects).toHaveLength(0)

    const beforeInvalidRestore = store.serialize()
    const result = store.restore('{"version":5}')
    expect(result.document).toBeUndefined()
    expect(result.changed).toBe(false)
    expect(store.serialize()).toBe(beforeInvalidRestore)

    const restored = store.restore(
      serializePromptDocumentV6({
        ...createEmptyPromptDocumentV6(),
        sections: [{ id: "restored-section", title: "scene", parts: [] }],
      }),
    )
    expect(restored.document).toBeDefined()
    expect(restored.changed).toBe(true)
    expect(store.document.sections[0]?.id).toBe("restored-section")

    const same = store.restore(store.serialize())
    expect(same.document).toBeDefined()
    expect(same.changed).toBe(false)
  })

  test("refreshes reference-dependent projections without changing the document", () => {
    let references: readonly [
      {
        referenceId: string
        itemId: string
        mediaKind: "image"
        ordinal: number
        tag: string
        label: string
        filename: string
      },
    ] = [
      {
        referenceId: "image-a",
        itemId: "image-a",
        mediaKind: "image",
        ordinal: 1,
        tag: "<Picture 1>",
        label: "image1",
        filename: "hero.png",
      },
    ]
    const store = new PromptStore(
      () => references,
      serializePromptDocumentV6({
        ...createEmptyPromptDocumentV6(),
        sections: [
          {
            id: "section-reference",
            title: "scene",
            parts: [
              { type: "mention", referenceId: "image-a", mediaKind: "image", label: "image1" },
            ],
          },
        ],
      }),
    )
    const serialized = store.serialize()
    expect(store.compiledText).toContain("<Picture 1>")
    references = [{ ...references[0]!, ordinal: 2 }]
    store.refresh()

    expect(store.serialize()).toBe(serialized)
    expect(store.compiledText).toContain("<Picture 2>")
  })
})
