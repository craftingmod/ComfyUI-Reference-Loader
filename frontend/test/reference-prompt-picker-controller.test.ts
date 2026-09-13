import { afterEach, describe, expect, test } from "bun:test"

import {
  PromptPickerController,
  type PromptPickerControllerOptions,
} from "../src/reference-loader/prompt-picker-controller.ts"
import type { PromptPreset } from "../src/reference-loader/prompt-presets.ts"
import {
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  type PromptDocumentV6,
  type PromptReference,
} from "../src/reference-loader/prompt-v6.ts"

const preset: PromptPreset = {
  id: "test",
  label: { en: "Test", ko: "Test" },
  description: { en: "Test", ko: "Test" },
  defaultSectionTitle: "scene",
  subjectMode: "anywhere",
  aliases: [
    {
      command: "style",
      title: "visual_style",
      label: { en: "Style", ko: "스타일" },
      description: { en: "Style section", ko: "스타일 섹션" },
      icon: "S",
    },
  ],
}

const references: PromptReference[] = [
  {
    referenceId: "image-a",
    itemId: "image-a",
    mediaKind: "image",
    ordinal: 1,
    tag: "<Picture 1>",
    label: "alpha",
    filename: "alpha.png",
  },
  {
    referenceId: "image-b",
    itemId: "image-b",
    mediaKind: "image",
    ordinal: 2,
    tag: "<Picture 2>",
    label: "beta",
    filename: "beta.png",
  },
]

function createPicker(promptDocument: PromptDocumentV6 = createEmptyPromptDocumentV6()) {
  const inserted: unknown[] = []
  const aliases: string[] = []
  const listeners: string[] = []
  const editor = globalThis.document.createElement("div")
  const target = { type: "section" as const, id: "scene" }
  const options: PromptPickerControllerOptions = {
    references: () => references,
    document: () => promptDocument,
    preset: () => preset,
    locale: () => "en",
    resolveEditorElement: () => editor,
    insertPart: (bodyTarget, part, replaceTextLength) => {
      inserted.push(bodyTarget, part, replaceTextLength)
      return true
    },
    createSubject: (label) => {
      const id = createPromptDefinitionId()
      promptDocument.subjects = [...promptDocument.subjects, { id, tag: label, parts: [] }]
      return id
    },
    activateAlias: (alias) => aliases.push(alias.title),
  }
  const picker = new PromptPickerController(options)
  picker.subscribe(() => listeners.push(picker.snapshot.mode ?? "closed"))
  return { picker, target, editor, inserted, aliases, listeners }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe("PromptPickerController", () => {
  test("keeps query ordering and active index per instance", () => {
    const first = createPicker()
    const second = createPicker()
    const trigger = { trigger: "@" as const, query: "", replaceTextLength: 1 }

    first.picker.handleBodyTrigger(first.target, trigger)
    second.picker.handleBodyTrigger(second.target, trigger)
    expect(first.picker.snapshot.options.map((option) => option.kind)).toEqual([
      "reference",
      "reference",
    ])
    first.picker.move(1)
    expect(first.picker.snapshot.activeIndex).toBe(1)
    expect(second.picker.snapshot.activeIndex).toBe(0)
  })

  test("does not activate an empty, disabled, or invalid target", () => {
    const context = createPicker()
    context.picker.updateReferenceQuery("missing")
    expect(context.picker.activate(0)).toBe(false)
    expect(context.inserted).toEqual([])

    context.picker.updateReferenceQuery("")
    expect(context.picker.activate(99)).toBe(false)
    expect(context.inserted).toEqual([])

    const noTarget = createPicker()
    noTarget.picker.updateReferenceQuery("")
    expect(noTarget.picker.activate(0)).toBe(false)
    expect(noTarget.inserted).toEqual([])
  })

  test("routes @, #, and / activation to their typed boundaries", () => {
    const subjectId = createPromptDefinitionId()
    const context = createPicker({
      ...createEmptyPromptDocumentV6(),
      subjects: [{ id: subjectId, tag: "hero", parts: [] }],
      sections: [{ id: "scene", title: "scene", parts: [] }],
    })
    const entry = document.createElement("input")
    document.body.append(entry)
    entry.focus()

    context.picker.handleBodyTrigger(context.target, {
      trigger: "@",
      query: "alpha",
      replaceTextLength: 6,
    })
    expect(context.picker.activate(0)).toBe(true)
    expect(context.inserted[1]).toMatchObject({ type: "mention", referenceId: "image-a" })

    context.picker.handleBodyTrigger(context.target, {
      trigger: "#",
      query: "hero",
      replaceTextLength: 5,
    })
    expect(context.picker.activate(0)).toBe(true)
    expect(context.inserted[4]).toEqual({ type: "definition-ref", definitionId: subjectId })

    context.picker.updateSectionEntryQuery("/sty", entry)
    expect(context.picker.activate(0)).toBe(true)
    expect(context.aliases).toEqual(["visual_style"])
  })

  test("stops late updates after destroy", () => {
    const context = createPicker()
    const beforeDestroy = context.listeners.length
    context.picker.destroy()
    context.picker.updateReferenceQuery("")
    context.picker.close()
    expect(context.listeners.length).toBe(beforeDestroy)
  })
})
