import { describe, expect, test } from "bun:test"

import type { PromptPreset } from "../src/reference-loader/prompt-presets.ts"
import {
  projectPromptDefinitions,
  projectPromptPicker,
  projectPromptSections,
  promptPartLabel,
  promptPartVisual,
} from "../src/reference-loader/prompt-projections.ts"
import {
  createEmptyPromptDocumentV6,
  type PromptDocumentV6,
  type PromptReference,
} from "../src/reference-loader/prompt-v6.ts"

const preset: PromptPreset = {
  id: "test",
  label: { en: "Test", ko: "Test" },
  description: { en: "Test", ko: "Test" },
  defaultSectionTitle: "scene",
  subjectMode: "anywhere",
  aliases: [],
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
    previewUrl: "preview-a",
  },
]

function createDocument(): PromptDocumentV6 {
  return {
    ...createEmptyPromptDocumentV6(),
    subjects: [{ id: "subject-a", tag: "hero", parts: [] }],
    shots: [{ id: "shot-a", tag: "closeup", frameIndex: 12, parts: [] }],
    sections: [
      {
        id: "scene",
        title: "scene",
        parts: [
          { type: "text", text: "A " },
          { type: "mention", referenceId: "image-a", mediaKind: "image", label: "old" },
          { type: "text", text: " with " },
          { type: "definition-ref", definitionId: "subject-a" },
        ],
      },
    ],
  }
}

function bodySnapshot(target: { type: "section" | "definition"; id: string }) {
  return { target, parts: [], revision: 0, epoch: 0 } as const
}

describe("prompt projections", () => {
  test("produce deterministic section and definition snapshots from canonical input", () => {
    const document = createDocument()
    const sectionOptions = {
      document,
      references,
      preset,
      locale: "en" as const,
      mounted: true,
      bodySnapshot,
    }
    const definitionOptions = {
      document,
      draft: false,
      mounted: true,
      preset,
      locale: "en" as const,
      bodySnapshot,
    }

    expect(projectPromptSections(sectionOptions)).toEqual(projectPromptSections(sectionOptions))
    expect(projectPromptDefinitions(definitionOptions)).toEqual(
      projectPromptDefinitions(definitionOptions),
    )

    const sections = projectPromptSections(sectionOptions)
    expect(sections.sections[0]).toMatchObject({
      id: "scene",
      text: "A @alpha with #hero",
      editor: "lexical",
    })
    expect(projectPromptDefinitions(definitionOptions)).toMatchObject({
      subjects: [{ tag: "hero", ordinal: 1, bodySnapshot: { target: { id: "subject-a" } } }],
      shots: [{ tag: "closeup", ordinal: 1, frameIndex: 12 }],
      draft: false,
      mounted: true,
    })
  })

  test("localizes section action labels without branching on the locale", () => {
    const document = createDocument()
    const common = {
      document,
      references,
      preset,
      mounted: true,
      bodySnapshot,
    }

    expect(projectPromptSections({ ...common, locale: "en" }).sections[0]).toMatchObject({
      dragTitle: "Reorder scene section",
      dragAria: "Reorder scene section. You can also use Alt plus Up or Down.",
      removeTitle: "Remove scene",
      removeAria: "Remove scene section",
    })
    expect(projectPromptSections({ ...common, locale: "ko" }).sections[0]).toMatchObject({
      dragTitle: "scene 주제 순서 변경",
      dragAria: "scene 주제 순서 변경. Alt와 위아래 화살표도 사용할 수 있습니다.",
      removeTitle: "scene 제거",
      removeAria: "scene 주제 제거",
    })
  })

  test("projects labels and visuals without a DOM or controller", () => {
    const document = createDocument()
    const mention = document.sections[0]!.parts[1]!
    const subject = document.sections[0]!.parts[3]!
    const shot = { type: "definition-ref" as const, definitionId: "shot-a" }

    expect(promptPartLabel(mention, references, document)).toBe("alpha")
    expect(promptPartVisual(mention, references, document)).toEqual({
      previewUrl: "preview-a",
      ordinal: 1,
    })
    expect(promptPartLabel(subject, references, document)).toBe("hero")
    expect(promptPartVisual(subject, references, document)).toMatchObject({
      definitionKind: "subject",
      ordinal: 1,
    })
    expect(promptPartLabel(shot, references, document)).toBe("closeup")
    expect(promptPartVisual(shot, references, document)).toMatchObject({
      definitionKind: "shot",
      ordinal: 1,
    })
  })

  test("projects picker options from explicit state", () => {
    const document = createDocument()
    const subject = document.subjects[0]!
    const shot = document.shots[0]!
    const snapshot = projectPromptPicker({
      mode: "subject",
      activeIndex: 1,
      references,
      subjects: document.subjects,
      shots: document.shots,
      createSubject: "new_subject",
      aliases: [],
      document,
      locale: "en",
      target: undefined,
    })

    expect(snapshot).toMatchObject({ visible: true, mode: "subject", activeIndex: 1 })
    expect(snapshot.options).toEqual([
      { kind: "subject", subject, ordinal: 1 },
      { kind: "shot", shot, ordinal: 1 },
      expect.objectContaining({ kind: "create-subject", label: "new_subject" }),
    ])
  })
})
