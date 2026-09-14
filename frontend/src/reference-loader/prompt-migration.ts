import {
  assertPromptDocumentV6,
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  deserializePromptDocumentV6,
  MAX_PROMPT_STATE_CHARACTERS,
  MAX_PROMPT_TEXT_CHARACTERS,
  normalizePromptPartsV6,
  normalizePromptSectionTitle,
  normalizePromptTag,
  type PromptDocumentV6,
  type PromptPartV6,
} from "./prompt-v6.ts"

export interface PromptDocumentMigrationResult {
  readonly document?: PromptDocumentV6
  readonly issues: string[]
  readonly recoveredFromVersion?: number
}

interface LegacyDefinition {
  readonly id: string
  readonly tag: string
  readonly legacyId?: string
  readonly raw?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

function legacySubjectOrdinalText(value: string, subjects: readonly LegacyDefinition[]): string {
  return value.replace(/<\s*subject\s+(\d+)\s*>/giu, (raw, ordinal: string) => {
    const subject = subjects[Number(ordinal) - 1]
    return subject ? `#${subject.tag}` : raw
  })
}

function legacyPartToParts(
  raw: unknown,
  subjects: readonly LegacyDefinition[],
  subjectByLegacyId: ReadonlyMap<string, LegacyDefinition>,
  issues: string[],
): PromptPartV6[] {
  if (!isRecord(raw)) {
    issues.push("Legacy prompt part was preserved as text.")
    return [{ type: "text", text: jsonText(raw) }]
  }
  if (raw.type === "text" && typeof raw.text === "string")
    return [{ type: "text", text: legacySubjectOrdinalText(raw.text, subjects) }]
  if (
    raw.type === "mention" &&
    typeof raw.referenceId === "string" &&
    raw.referenceId.length > 0 &&
    raw.referenceId.length <= 160 &&
    !/\s/u.test(raw.referenceId) &&
    (raw.mediaKind === "image" || raw.mediaKind === "video" || raw.mediaKind === "audio")
  )
    return [
      {
        type: "mention",
        referenceId: raw.referenceId,
        mediaKind: raw.mediaKind,
        label: typeof raw.label === "string" ? raw.label.slice(0, 255) : "",
      },
    ]
  if (raw.type === "subject") {
    const legacyId = typeof raw.subjectId === "string" ? raw.subjectId : ""
    const subject = subjectByLegacyId.get(legacyId)
    const label = subject?.tag ?? (typeof raw.label === "string" ? raw.label : legacyId)
    return label ? [{ type: "text", text: `#${label}` }] : [{ type: "text", text: jsonText(raw) }]
  }
  if (raw.type === "dialogue" && typeof raw.text === "string")
    return [{ type: "text", text: `<d>${raw.text}</d>` }]
  if (raw.type === "directive" && (raw.kind === "audio" || raw.kind === "style")) {
    const nested: PromptPartV6[] = Array.isArray(raw.parts)
      ? raw.parts.flatMap((part) => legacyPartToParts(part, subjects, subjectByLegacyId, issues))
      : typeof raw.text === "string"
        ? [{ type: "text", text: raw.text }]
        : []
    return normalizePromptPartsV6([
      { type: "text", text: `<${raw.kind}>` },
      ...nested,
      { type: "text", text: `</${raw.kind}>` },
    ])
  }
  if (raw.type === "definition-ref" && typeof raw.definitionId === "string")
    return [{ type: "text", text: `#${raw.definitionId}` }]
  issues.push("Legacy prompt part was preserved as text.")
  return [{ type: "text", text: jsonText(raw) }]
}

function legacyParts(
  value: unknown,
  subjects: readonly LegacyDefinition[],
  subjectByLegacyId: ReadonlyMap<string, LegacyDefinition>,
  issues: string[],
): PromptPartV6[] {
  if (!Array.isArray(value))
    return value === undefined ? [] : [{ type: "text", text: jsonText(value) }]
  return normalizePromptPartsV6(
    value.flatMap((part) => legacyPartToParts(part, subjects, subjectByLegacyId, issues)),
  )
}

function recoveredRawText(text: string): PromptDocumentMigrationResult {
  const bounded = text.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
  return {
    document: {
      ...createEmptyPromptDocumentV6("raw"),
      sections: bounded
        ? [
            {
              id: createPromptDefinitionId(),
              title: "scene",
              parts: [{ type: "text", text: bounded }],
            },
          ]
        : [],
    },
    issues: [],
  }
}

function migrateLegacyPromptDocument(
  value: Record<string, unknown>,
  version: number,
): PromptDocumentMigrationResult {
  const issues: string[] = []
  const tags = new Set<string>()
  const subjects: LegacyDefinition[] = []
  const subjectByLegacyId = new Map<string, LegacyDefinition>()
  const rawSubjects = Array.isArray(value.subjects) ? value.subjects : []
  for (const raw of rawSubjects) {
    if (!isRecord(raw)) continue
    const tag = normalizePromptTag(
      typeof raw.tag === "string" ? raw.tag : typeof raw.label === "string" ? raw.label : "",
    )
    if (!tag || tags.has(tag)) {
      issues.push(
        "A legacy Prompt subject was discarded because its tag was invalid or duplicated.",
      )
      continue
    }
    const subject = {
      id: createPromptDefinitionId(),
      tag,
      ...(typeof raw.subjectId === "string" ? { legacyId: raw.subjectId } : {}),
      raw,
    }
    subjects.push(subject)
    tags.add(tag)
    if (subject.legacyId) subjectByLegacyId.set(subject.legacyId, subject)
  }

  const shots: Array<LegacyDefinition & { frameIndex: number; raw: Record<string, unknown> }> = []
  const rawShots = Array.isArray(value.shots) ? value.shots : []
  for (const raw of rawShots) {
    if (!isRecord(raw)) continue
    const tag = normalizePromptTag(typeof raw.tag === "string" ? raw.tag : "")
    const frameIndex = raw.frameIndex
    if (
      !tag ||
      tags.has(tag) ||
      typeof frameIndex !== "number" ||
      !Number.isSafeInteger(frameIndex) ||
      frameIndex < 0
    ) {
      issues.push("A legacy Prompt Shot was discarded because its tag or frame was invalid.")
      continue
    }
    shots.push({ id: createPromptDefinitionId(), tag, frameIndex, raw })
    tags.add(tag)
  }

  const subjectValues = subjects.map(({ id, tag }) => ({ id, tag, parts: [] as PromptPartV6[] }))
  const shotValues = shots.map(({ id, tag, frameIndex }) => ({
    id,
    tag,
    frameIndex,
    parts: [] as PromptPartV6[],
  }))
  subjects.forEach((subject, index) => {
    subjectValues[index]!.parts = legacyParts(
      subject.raw?.parts,
      subjects,
      subjectByLegacyId,
      issues,
    )
  })
  shots.forEach((shot, index) => {
    shotValues[index]!.parts = legacyParts(shot.raw.parts, subjects, subjectByLegacyId, issues)
  })

  const sections: PromptDocumentV6["sections"] = []
  const addSection = (title: string, parts: PromptPartV6[]): void => {
    const existing = sections.find((section) => section.title === title)
    if (existing) {
      if (existing.parts.length > 0 && parts.length > 0)
        existing.parts = normalizePromptPartsV6([
          ...existing.parts,
          { type: "text", text: "\n\n" },
          ...parts,
        ])
      else existing.parts = normalizePromptPartsV6([...existing.parts, ...parts])
      return
    }
    sections.push({ id: createPromptDefinitionId(), title, parts })
  }
  if (Array.isArray(value.sections)) {
    value.sections.forEach((raw) => {
      if (isRecord(raw)) {
        const title = normalizePromptSectionTitle(typeof raw.title === "string" ? raw.title : "")
        addSection(
          title ?? "legacy_prompt",
          legacyParts(raw.parts, subjects, subjectByLegacyId, issues),
        )
      } else addSection("legacy_prompt", legacyParts([raw], subjects, subjectByLegacyId, issues))
    })
  } else if (Array.isArray(value.parts)) {
    addSection("scene", legacyParts(value.parts, subjects, subjectByLegacyId, issues))
  } else {
    addSection("legacy_prompt", legacyParts([value], subjects, subjectByLegacyId, issues))
  }

  try {
    return {
      document: assertPromptDocumentV6({
        version: 6,
        view: "raw",
        subjects: subjectValues,
        shots: shotValues,
        sections,
      }),
      issues,
      recoveredFromVersion: version,
    }
  } catch (error) {
    return {
      issues: [error instanceof Error ? error.message : "Legacy Prompt state is invalid."],
    }
  }
}

function migrateParsedPrompt(value: unknown): PromptDocumentMigrationResult {
  if (isRecord(value) && typeof value.version === "number") {
    if (value.version >= 1 && value.version < 6)
      return migrateLegacyPromptDocument(value, value.version)
    return deserializePromptDocumentV6(value)
  }
  return deserializePromptDocumentV6(value)
}

export function deserializePromptDocumentWithMigration(
  value: unknown,
): PromptDocumentMigrationResult {
  if (value === undefined || value === null || value === "")
    return { document: createEmptyPromptDocumentV6(), issues: [] }
  if (typeof value !== "string") return migrateParsedPrompt(value)
  if (value.length > MAX_PROMPT_STATE_CHARACTERS)
    return { issues: ["Prompt state exceeded the 250,000-character limit."] }
  try {
    return migrateParsedPrompt(JSON.parse(value) as unknown)
  } catch {
    return recoveredRawText(value)
  }
}
