import { afterEach, describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { timelineMarks } from "../src/reference-loader/components/h3-timeline.ts"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import {
  compilePromptDocument,
  createEmptyPromptDocument,
  renamePromptTag,
  scanPromptTags,
  serializePromptDocument,
} from "../src/reference-loader/prompt-state.ts"
import { createEmptyLoaderState } from "../src/reference-loader/types.ts"

function node(transactions: string[]): ComfyNode {
  return {
    addDOMWidget: () => ({ name: "unused", value: null }),
    graph: {
      beforeChange: () => transactions.push("before"),
      afterChange: () => transactions.push("after"),
    },
    setDirtyCanvas: () => undefined,
  }
}

afterEach(() => {
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
})

describe("Reference Prompt v5 authoring", () => {
  test("keeps tags in source data and compiles both definition kinds", () => {
    const document = {
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [{ type: "text" as const, text: "red coat" }] }],
      shots: [
        {
          tag: "opening",
          frameIndex: 49,
          parts: [{ type: "text" as const, text: "#hero enters" }],
        },
      ],
      sections: [{ title: "scene", parts: [{ type: "text" as const, text: "#hero waits" }] }],
    }

    expect(JSON.parse(serializePromptDocument(document))).toMatchObject({
      version: 5,
      subjects: [{ tag: "hero" }],
      shots: [{ tag: "opening", frameIndex: 49 }],
    })
    expect(compilePromptDocument(document, [])).toBe(
      "subject_definitions:\n<Subject 1>: red coat\n\nscene:\n<Subject 1> waits\n\ntimeline_direction:\n[Shot 1]\nAt 2.042 seconds: <Subject 1> enters",
    )
  })

  test("scans exact tags, escaped tags, and unresolved tags without substring matches", () => {
    const tokens = scanPromptTags("#hero #heroine #한글 \\#hero foo#hero")
    expect(tokens.map((token) => [token.tag, token.escaped])).toEqual([
      ["hero", false],
      ["heroine", false],
      ["한글", false],
      ["hero", true],
    ])
    const document = {
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [] }],
      sections: [
        {
          title: "scene",
          parts: [{ type: "text" as const, text: "#hero #heroine \\#hero foo#hero" }],
        },
      ],
    }
    expect(compilePromptDocument(document, [])).toBe(
      "subject_definitions:\n<Subject 1>:\n\nscene:\n<Subject 1> #heroine #hero foo#hero",
    )
  })

  test("renames definitions and all exact references in one pure document change", () => {
    const document = {
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [{ type: "text" as const, text: "#heroine \\#hero" }] }],
      shots: [{ tag: "opening", frameIndex: 0, parts: [{ type: "text" as const, text: "#hero" }] }],
      sections: [{ title: "scene", parts: [{ type: "text" as const, text: "#hero #heroine" }] }],
    }
    const renamed = renamePromptTag(document, "hero", "lead")
    expect(renamed.subjects[0]?.tag).toBe("lead")
    expect(renamed.subjects[0]?.parts?.[0]).toEqual({ type: "text", text: "#heroine \\#hero" })
    expect(renamed.shots[0]?.parts[0]).toEqual({ type: "text", text: "#lead" })
    expect(renamed.sections[0]?.parts[0]).toEqual({ type: "text", text: "#lead #heroine" })
  })

  test("keeps Shot timing in a Prompt draft until Apply or Cancel", () => {
    const transactions: string[] = []
    const root = document.createElement("div")
    document.body.append(root)
    const initial = {
      ...createEmptyPromptDocument(),
      shots: [{ tag: "opening", frameIndex: 0, parts: [] }],
      sections: [{ title: "scene", parts: [{ type: "text" as const, text: "#opening" }] }],
    }
    const controller = new ReferencePromptController(
      root,
      node(transactions),
      () => [],
      serializePromptDocument(initial),
    )

    expect(controller.setShotFrame("opening", 24)).toBe(true)
    expect(controller.shots[0]?.frameIndex).toBe(24)
    expect(JSON.parse(controller.serialize()).shots[0].frameIndex).toBe(0)
    expect(root.querySelector('[data-prompt-action="apply-shot-draft"]')).not.toBeNull()
    expect(transactions).toEqual([])

    expect(controller.applyShotDraft()).toBe(true)
    expect(JSON.parse(controller.serialize()).shots[0].frameIndex).toBe(24)
    expect(transactions).toEqual(["before", "after"])

    controller.setShotFrame("opening", 48)
    expect(controller.cancelShotDraft()).toBe(true)
    expect(JSON.parse(controller.serialize()).shots[0].frameIndex).toBe(24)
    controller.destroy()
  })

  test("projects Shots into their own Timeline lane without changing Guide state", () => {
    const state = createEmptyLoaderState()
    state.h3Timeline = {
      ...state.h3Timeline,
      enabled: false,
    }
    const marks = timelineMarks(state, new Map(), [{ tag: "opening", frameIndex: 49 }])
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({
      channel: "shot",
      shotTag: "opening",
      frame: 49,
      disabled: false,
    })
    expect(state.h3Timeline.guides).toEqual([])
  })

  test("keeps same-frame Shots visible without treating them as Guide overlaps", () => {
    const state = createEmptyLoaderState()
    const marks = timelineMarks(state, new Map(), [
      { tag: "first", frameIndex: 24 },
      { tag: "second", frameIndex: 24 },
    ])
    expect(marks.map((mark) => mark.shotTag)).toEqual(["first", "second"])
    expect(marks.every((mark) => !mark.warning)).toBe(true)
  })
})
