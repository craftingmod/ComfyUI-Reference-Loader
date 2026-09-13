import { SHOT_COLOR, sectionColor, subjectColor } from "./components/prompt-dom.ts"
import type {
  PromptBodySnapshot,
  PromptEditorTargetV6,
} from "./components/prompt-editor-contract.ts"
import type {
  PromptDefinitionSnapshot,
  PromptDefinitionsSnapshot,
  PromptDefinitionKind,
  PromptSectionSnapshot,
  PromptSectionsSnapshot,
} from "./components/prompt-editor.ts"
import type { PromptReferenceVisual } from "./components/prompt-reference-node.tsx"
import { PROMPT_MESSAGES, localize } from "./prompt-i18n.ts"
import type { PromptPickerOption, PromptPickerSnapshot } from "./prompt-picker-controller.ts"
import type { PromptAlias, PromptLocale, PromptPreset } from "./prompt-presets.ts"
import {
  type PromptDocumentV6,
  type PromptPartV6,
  type PromptReference,
  type PromptSubjectV6,
} from "./prompt-v6.ts"

export function promptPartLabel(
  part: PromptPartV6,
  references: readonly PromptReference[],
  document: PromptDocumentV6,
): string | undefined {
  if (part.type === "text") return undefined
  if (part.type === "mention")
    return (
      references.find(
        (reference) =>
          reference.referenceId === part.referenceId && reference.mediaKind === part.mediaKind,
      )?.label ?? part.label
    )
  return findDefinition(document, part.definitionId)?.tag
}

export function promptPartVisual(
  part: PromptPartV6,
  references: readonly PromptReference[],
  document: PromptDocumentV6,
): PromptReferenceVisual | undefined {
  if (part.type === "text") return undefined
  if (part.type === "mention") {
    const reference = references.find(
      (candidate) =>
        candidate.referenceId === part.referenceId && candidate.mediaKind === part.mediaKind,
    )
    return reference ? { previewUrl: reference.previewUrl, ordinal: reference.ordinal } : undefined
  }
  const subjectIndex = document.subjects.findIndex((subject) => subject.id === part.definitionId)
  if (subjectIndex >= 0)
    return {
      definitionKind: "subject",
      ordinal: subjectIndex + 1,
      color: subjectColor(document.subjects[subjectIndex]?.id),
    }
  const shotIndex = document.shots.findIndex((shot) => shot.id === part.definitionId)
  return shotIndex >= 0
    ? { definitionKind: "shot", ordinal: shotIndex + 1, color: SHOT_COLOR }
    : undefined
}

export function projectPromptDefinitions(options: {
  readonly document: PromptDocumentV6
  readonly draft: boolean
  readonly mounted: boolean
  readonly preset: PromptPreset
  readonly locale: PromptLocale
  readonly bodySnapshot: (target: PromptEditorTargetV6) => PromptBodySnapshot | undefined
}): PromptDefinitionsSnapshot {
  const placeholder = localize(
    options.preset.subjectMode === "disabled"
      ? PROMPT_MESSAGES.bodyPlaceholder
      : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
    options.locale,
  )
  const record = (
    kind: PromptDefinitionKind,
    definition: PromptDocumentV6["subjects"][number] | PromptDocumentV6["shots"][number],
    ordinal: number,
  ): PromptDefinitionSnapshot => ({
    kind,
    tag: definition.tag,
    identity: definition.id,
    definitionId: definition.id,
    ordinal,
    frameIndex: "frameIndex" in definition ? definition.frameIndex : undefined,
    parts: definition.parts,
    bodySnapshot: options.bodySnapshot({ type: "definition", id: definition.id })!,
    placeholder,
  })
  const subjects = options.document.subjects.map((subject, index) =>
    record("subject", subject, index + 1),
  )
  const shots = options.document.shots.map((shot, index) => record("shot", shot, index + 1))
  return { subjects, shots, draft: options.draft, mounted: options.mounted }
}

export function projectPromptSections(options: {
  readonly document: PromptDocumentV6
  readonly references: readonly PromptReference[]
  readonly preset: PromptPreset
  readonly locale: PromptLocale
  readonly mounted: boolean
  readonly bodySnapshot: (target: PromptEditorTargetV6) => PromptBodySnapshot | undefined
}): PromptSectionsSnapshot {
  const placeholder = localize(
    options.preset.subjectMode === "disabled"
      ? PROMPT_MESSAGES.bodyPlaceholder
      : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
    options.locale,
  )
  const sections: PromptSectionSnapshot[] = options.document.sections.map((section) => {
    const accent = sectionColor(section.title)
    return {
      title: section.title,
      id: section.id,
      color: accent.color,
      colorIndex: accent.index,
      isVirtual: false,
      editor: "lexical",
      text: section.parts
        .map((part) => {
          if (part.type === "text") return part.text
          const label = promptPartLabel(part, options.references, options.document)
          return part.type === "mention"
            ? `@${label ?? part.label}`
            : `#${label ?? part.definitionId}`
        })
        .join(""),
      parts: section.parts,
      bodySnapshot: options.bodySnapshot({ type: "section", id: section.id })!,
      placeholder,
      dragTitle:
        options.locale === "ko"
          ? `${section.title} 섹션 순서 이동`
          : `Reorder ${section.title} section`,
      dragAria:
        options.locale === "ko"
          ? `${section.title} 섹션 순서 이동. Alt와 위아래 화살표도 사용할 수 있습니다.`
          : `Reorder ${section.title} section. You can also use Alt plus Up or Down.`,
      removeTitle: options.locale === "ko" ? `${section.title} 제거` : `Remove ${section.title}`,
      removeAria:
        options.locale === "ko" ? `${section.title} 섹션 제거` : `Remove ${section.title} section`,
    }
  })
  return { view: options.document.view, sections, mounted: options.mounted }
}

export function projectPromptPicker(options: {
  readonly mode: PromptPickerSnapshot["mode"]
  readonly activeIndex: number
  readonly references: readonly PromptReference[]
  readonly subjects: readonly PromptSubjectV6[]
  readonly shots: readonly PromptDocumentV6["shots"][number][]
  readonly createSubject: string | undefined
  readonly aliases: readonly PromptAlias[]
  readonly document: PromptDocumentV6
  readonly locale: PromptLocale
  readonly target: HTMLElement | undefined
}): PromptPickerSnapshot {
  const createSubjectLabel = options.createSubject
    ? localize(PROMPT_MESSAGES.createSubject, options.locale).replace(
        "{label}",
        options.createSubject,
      )
    : ""
  const pickerOptions: PromptPickerOption[] =
    options.mode === "reference"
      ? options.references.map((reference) => ({ kind: "reference", reference }))
      : options.mode === "subject"
        ? [
            ...options.subjects.map((subject) => ({
              kind: "subject" as const,
              subject,
              ordinal:
                options.document.subjects.findIndex((candidate) => candidate.id === subject.id) + 1,
            })),
            ...options.shots.map((shot) => ({
              kind: "shot" as const,
              shot,
              ordinal:
                options.document.shots.findIndex((candidate) => candidate.id === shot.id) + 1,
            })),
            ...(options.createSubject
              ? [
                  {
                    kind: "create-subject" as const,
                    label: options.createSubject,
                    createLabel: createSubjectLabel,
                    createDetail: localize(PROMPT_MESSAGES.createSubjectDetail, options.locale),
                  },
                ]
              : []),
          ]
        : options.mode === "alias"
          ? options.aliases.map((alias) => ({
              kind: "alias" as const,
              alias,
              label: localize(alias.label, options.locale),
              description: localize(alias.description, options.locale),
            }))
          : []
  const emptyMessage =
    options.mode === "alias"
      ? localize(PROMPT_MESSAGES.noAliases, options.locale)
      : options.mode === "subject"
        ? localize(PROMPT_MESSAGES.noSubjects, options.locale)
        : localize(PROMPT_MESSAGES.noReferences, options.locale)
  return {
    visible: options.mode !== undefined,
    mode: options.mode,
    activeIndex: options.activeIndex,
    options: pickerOptions,
    emptyMessage,
    createSubjectLabel,
    createSubjectDetail: localize(PROMPT_MESSAGES.createSubjectDetail, options.locale),
    target: options.target,
  }
}

function findDefinition(document: PromptDocumentV6, id: string) {
  return (
    document.subjects.find((subject) => subject.id === id) ??
    document.shots.find((shot) => shot.id === id)
  )
}
