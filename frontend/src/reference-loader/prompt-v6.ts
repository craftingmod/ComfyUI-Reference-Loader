import type {
  PromptDocument as PromptDocumentV5,
  PromptMediaKind,
  PromptReference,
  PromptSectionPart as PromptSectionPartV5,
} from "./prompt-state.ts"

/** The persisted Prompt document contract. Lexical JSON never crosses this boundary. */
export const PROMPT_DOCUMENT_VERSION = 6 as const

export type PromptPartMediaKind = PromptMediaKind

export interface PromptTextPartV6 {
  type: "text"
  text: string
}

export interface PromptMentionPartV6 {
  type: "mention"
  referenceId: string
  mediaKind: PromptPartMediaKind
  /** Last known alias, used only when the reference is unavailable. */
  label: string
}

export interface PromptDefinitionRefPartV6 {
  type: "definition-ref"
  definitionId: string
}

export type PromptPartV6 = PromptTextPartV6 | PromptMentionPartV6 | PromptDefinitionRefPartV6

export interface PromptSectionV6 {
  id: string
  title: string
  parts: PromptPartV6[]
}

export interface PromptSubjectV6 {
  id: string
  tag: string
  parts: PromptPartV6[]
}

export interface PromptShotV6 {
  id: string
  tag: string
  frameIndex: number
  parts: PromptPartV6[]
}

export interface PromptDocumentV6 {
  version: typeof PROMPT_DOCUMENT_VERSION
  view: "structured" | "raw"
  subjects: PromptSubjectV6[]
  shots: PromptShotV6[]
  sections: PromptSectionV6[]
}

export function createEmptyPromptDocumentV6(
  view: PromptDocumentV6["view"] = "structured",
): PromptDocumentV6 {
  return {
    version: PROMPT_DOCUMENT_VERSION,
    view,
    subjects: [],
    shots: [],
    sections: [],
  }
}

export interface PromptV6ValidationResult {
  document?: PromptDocumentV6
  issues: string[]
}

export class PromptV6ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PromptV6ValidationError"
  }
}

export function isPromptDocumentV6(value: unknown): value is PromptDocumentV6 {
  return isRecord(value) && value.version === PROMPT_DOCUMENT_VERSION
}

let fallbackIdCounter = 0

/** IDs are created only at explicit creation/migration boundaries. */
export function createPromptDefinitionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === "function") return randomUUID.call(globalThis.crypto)
  // Happy-dom versions without Web Crypto still need a stable per-session ID.
  return `prompt-${Date.now().toString(36)}-${(++fallbackIdCounter).toString(36)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function deserializePromptDocumentV6(value: unknown): PromptV6ValidationResult {
  if (value === undefined || value === null || value === "")
    return { document: createEmptyPromptDocumentV6(), issues: [] }
  if (typeof value === "string") {
    try {
      return validatePromptDocumentV6(JSON.parse(value) as unknown)
    } catch {
      return { issues: ["Prompt v6 state was not valid JSON."] }
    }
  }
  return validatePromptDocumentV6(value)
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 160 &&
    !/\s/u.test(value) &&
    !/["'\\]/u.test(value)
  )
}

function isMediaKind(value: unknown): value is PromptPartMediaKind {
  return value === "image" || value === "video" || value === "audio"
}

function isTag(value: unknown): value is string {
  return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(value)
}

function isSectionTitle(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
}

export function normalizePromptPartsV6(parts: readonly PromptPartV6[]): PromptPartV6[] {
  const normalized: PromptPartV6[] = []
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.text) continue
      const previous = normalized.at(-1)
      if (previous?.type === "text") previous.text += part.text
      else normalized.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "mention") {
      normalized.push({
        type: "mention",
        referenceId: part.referenceId,
        mediaKind: part.mediaKind,
        label: part.label,
      })
      continue
    }
    normalized.push({ type: "definition-ref", definitionId: part.definitionId })
  }
  return normalized
}

export function isPromptPartV6(value: unknown): value is PromptPartV6 {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "text") return typeof value.text === "string"
  if (value.type === "definition-ref") return isIdentity(value.definitionId)
  return (
    value.type === "mention" &&
    isIdentity(value.referenceId) &&
    isMediaKind(value.mediaKind) &&
    typeof value.label === "string" &&
    value.label.length <= 255
  )
}

export function promptPartsV6Equal(
  left: readonly PromptPartV6[],
  right: readonly PromptPartV6[],
): boolean {
  if (left.length !== right.length) return false
  return left.every((part, index) => {
    const other = right[index]
    return (
      other?.type === part.type &&
      (part.type === "text"
        ? other.type === "text" && other.text === part.text
        : part.type === "mention"
          ? other.type === "mention" &&
            other.referenceId === part.referenceId &&
            other.mediaKind === part.mediaKind &&
            other.label === part.label
          : other.type === "definition-ref" && other.definitionId === part.definitionId)
    )
  })
}

function validateParts(
  value: unknown,
  path: string,
  definitionIds: ReadonlySet<string>,
): PromptPartV6[] {
  if (!Array.isArray(value)) throw new PromptV6ValidationError(`${path} must be an array.`)
  const parts: PromptPartV6[] = []
  value.forEach((raw, index) => {
    const partPath = `${path}[${index}]`
    if (!isRecord(raw)) throw new PromptV6ValidationError(`${partPath} must be an object.`)
    if (raw.type === "text") {
      if (typeof raw.text !== "string")
        throw new PromptV6ValidationError(`${partPath}.text must be a string.`)
      parts.push({ type: "text", text: raw.text })
    } else if (raw.type === "mention") {
      if (!isIdentity(raw.referenceId))
        throw new PromptV6ValidationError(`${partPath}.referenceId is invalid.`)
      if (!isMediaKind(raw.mediaKind))
        throw new PromptV6ValidationError(`${partPath}.mediaKind is invalid.`)
      if (typeof raw.label !== "string" || raw.label.length > 255)
        throw new PromptV6ValidationError(`${partPath}.label is invalid.`)
      parts.push({
        type: "mention",
        referenceId: raw.referenceId,
        mediaKind: raw.mediaKind,
        label: raw.label,
      })
    } else if (raw.type === "definition-ref") {
      if (!isIdentity(raw.definitionId) || !definitionIds.has(raw.definitionId))
        throw new PromptV6ValidationError(`${partPath}.definitionId does not exist.`)
      parts.push({ type: "definition-ref", definitionId: raw.definitionId })
    } else {
      throw new PromptV6ValidationError(`${partPath}.type is invalid.`)
    }
  })
  return normalizePromptPartsV6(parts)
}

function validateV6(value: unknown): PromptDocumentV6 {
  if (!isRecord(value) || value.version !== PROMPT_DOCUMENT_VERSION)
    throw new PromptV6ValidationError("Prompt document version must be 6.")
  if (value.view !== "structured" && value.view !== "raw")
    throw new PromptV6ValidationError("Prompt document view is invalid.")
  if (
    !Array.isArray(value.subjects) ||
    !Array.isArray(value.shots) ||
    !Array.isArray(value.sections)
  )
    throw new PromptV6ValidationError("Prompt document collections must be arrays.")

  const ids = new Set<string>()
  const addId = (valueToCheck: unknown, path: string): string => {
    if (!isIdentity(valueToCheck)) throw new PromptV6ValidationError(`${path} is invalid.`)
    if (ids.has(valueToCheck)) throw new PromptV6ValidationError(`${path} is duplicated.`)
    ids.add(valueToCheck)
    return valueToCheck
  }
  const tags = new Set<string>()
  const addTag = (valueToCheck: unknown, path: string): string => {
    if (!isTag(valueToCheck)) throw new PromptV6ValidationError(`${path} is invalid.`)
    if (tags.has(valueToCheck)) throw new PromptV6ValidationError(`${path} is duplicated.`)
    tags.add(valueToCheck)
    return valueToCheck
  }

  const subjects = value.subjects.map((raw, index) => {
    if (!isRecord(raw)) throw new PromptV6ValidationError(`subjects[${index}] is invalid.`)
    return {
      id: addId(raw.id, `subjects[${index}].id`),
      tag: addTag(raw.tag, `subjects[${index}].tag`),
      raw,
    }
  })
  const shots = value.shots.map((raw, index) => {
    if (!isRecord(raw)) throw new PromptV6ValidationError(`shots[${index}] is invalid.`)
    const frameIndex = raw.frameIndex
    if (typeof frameIndex !== "number" || !Number.isSafeInteger(frameIndex) || frameIndex < 0)
      throw new PromptV6ValidationError(`shots[${index}].frameIndex is invalid.`)
    return {
      id: addId(raw.id, `shots[${index}].id`),
      tag: addTag(raw.tag, `shots[${index}].tag`),
      frameIndex,
      raw,
    }
  })
  const sections = value.sections.map((raw, index) => {
    if (!isRecord(raw)) throw new PromptV6ValidationError(`sections[${index}] is invalid.`)
    const title = raw.title
    if (!isSectionTitle(title))
      throw new PromptV6ValidationError(`sections[${index}].title is invalid.`)
    return { id: addId(raw.id, `sections[${index}].id`), title, raw }
  })
  const sectionTitles = new Set<string>()
  for (const [index, section] of sections.entries()) {
    if (sectionTitles.has(section.title))
      throw new PromptV6ValidationError(`sections[${index}].title is duplicated.`)
    sectionTitles.add(section.title)
  }
  const definitionIds = new Set([...subjects, ...shots].map((definition) => definition.id))
  const normalizedSubjects = subjects.map(({ id, tag, raw }, index) => ({
    id,
    tag,
    parts: validateParts(raw.parts, `subjects[${index}].parts`, definitionIds),
  }))
  const normalizedShots = shots.map(({ id, tag, frameIndex, raw }, index) => ({
    id,
    tag,
    frameIndex,
    parts: validateParts(raw.parts, `shots[${index}].parts`, definitionIds),
  }))
  const normalizedSections = sections.map(({ id, title, raw }, index) => ({
    id,
    title,
    parts: validateParts(raw.parts, `sections[${index}].parts`, definitionIds),
  }))
  const textLength = [...normalizedSubjects, ...normalizedShots, ...normalizedSections]
    .flatMap((owner) => owner.parts)
    .reduce((total, part) => total + (part.type === "text" ? part.text.length : 0), 0)
  if (textLength > 100_000)
    throw new PromptV6ValidationError("Prompt text exceeded 100000 characters.")
  return {
    version: PROMPT_DOCUMENT_VERSION,
    view: value.view,
    subjects: normalizedSubjects,
    shots: normalizedShots,
    sections: normalizedSections,
  }
}

export function validatePromptDocumentV6(value: unknown): PromptV6ValidationResult {
  try {
    return { document: validateV6(value), issues: [] }
  } catch (error) {
    return {
      issues: [error instanceof Error ? error.message : "Prompt document is invalid."],
    }
  }
}

export function assertPromptDocumentV6(value: unknown): PromptDocumentV6 {
  return validateV6(value)
}

export function serializePromptDocumentV6(document: PromptDocumentV6): string {
  return JSON.stringify(assertPromptDocumentV6(document))
}

function definitionMap(
  document: PromptDocumentV6,
): Map<string, { kind: "subject" | "shot"; tag: string; ordinal: number }> {
  const map = new Map<string, { kind: "subject" | "shot"; tag: string; ordinal: number }>()
  document.subjects.forEach((subject, index) =>
    map.set(subject.id, { kind: "subject", tag: subject.tag, ordinal: index + 1 }),
  )
  const orderedShots = [...document.shots].sort(
    (left, right) =>
      left.frameIndex - right.frameIndex ||
      document.shots.indexOf(left) - document.shots.indexOf(right),
  )
  orderedShots.forEach((shot, index) =>
    map.set(shot.id, { kind: "shot", tag: shot.tag, ordinal: index + 1 }),
  )
  return map
}

function mentionSource(part: PromptMentionPartV6, references: readonly PromptReference[]): string {
  const reference = references.find(
    (candidate) =>
      candidate.mediaKind === part.mediaKind && candidate.referenceId === part.referenceId,
  )
  return `@${reference?.label ?? part.label ?? part.referenceId}`
}

function renderSourceParts(
  parts: readonly PromptPartV6[],
  definitions: ReadonlyMap<string, { kind: "subject" | "shot"; tag: string; ordinal: number }>,
  references: readonly PromptReference[],
): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "mention") return mentionSource(part, references)
      return `#${definitions.get(part.definitionId)?.tag ?? part.definitionId}`
    })
    .join("")
}

export function renderAuthoringPromptV6(
  document: PromptDocumentV6,
  references: readonly PromptReference[],
): string {
  const definitions = definitionMap(document)
  return document.sections
    .map((section) => {
      const content = renderSourceParts(section.parts, definitions, references).trim()
      return content ? `${section.title}:\n${content}` : `${section.title}:`
    })
    .join("\n\n")
}

function mentionCompiled(
  part: PromptMentionPartV6,
  references: readonly PromptReference[],
): string {
  const reference = references.find(
    (candidate) =>
      candidate.mediaKind === part.mediaKind && candidate.referenceId === part.referenceId,
  )
  if (!reference) return `@${part.label || part.referenceId}`
  const name =
    reference.mediaKind === "image"
      ? "Picture"
      : reference.mediaKind[0]!.toUpperCase() + reference.mediaKind.slice(1)
  return `<${name} ${reference.ordinal}>`
}

export function compilePromptDocumentV6(
  document: PromptDocumentV6,
  references: readonly PromptReference[],
): string {
  const validated = assertPromptDocumentV6(document)
  const definitions = definitionMap(validated)
  const render = (parts: readonly PromptPartV6[]): string =>
    parts
      .map((part) => {
        if (part.type === "text") return part.text
        if (part.type === "mention") return mentionCompiled(part, references)
        const definition = definitions.get(part.definitionId)
        return definition
          ? definition.kind === "subject"
            ? `<Subject ${definition.ordinal}>`
            : `[Shot ${definition.ordinal}]`
          : `#${part.definitionId}`
      })
      .join("")
      .trim()
  const subjects = validated.subjects
    .map((subject, index) => `<Subject ${index + 1}>: ${render(subject.parts)}`.trimEnd())
    .join("\n\n")
  const orderedShots = [...validated.shots].sort(
    (left, right) =>
      left.frameIndex - right.frameIndex ||
      validated.shots.indexOf(left) - validated.shots.indexOf(right),
  )
  const shots = orderedShots
    .map((shot, index) =>
      `[Shot ${index + 1}]\nAt ${(Math.floor((shot.frameIndex * 1000) / 24 + 0.5) / 1000).toFixed(3)} seconds: ${render(shot.parts)}`.trimEnd(),
    )
    .join("\n\n")
  const compiled = validated.sections.map((section): [string, string] => {
    let content = render(section.parts)
    if (section.title === "subject_definitions" && subjects)
      content = [content, subjects].filter(Boolean).join("\n\n")
    if (section.title === "timeline_direction" && shots)
      content = [content, shots].filter(Boolean).join("\n\n")
    return [section.title, content]
  })
  if (subjects && !compiled.some(([title]) => title === "subject_definitions"))
    compiled.unshift(["subject_definitions", subjects])
  if (shots && !compiled.some(([title]) => title === "timeline_direction"))
    compiled.push(["timeline_direction", shots])
  return compiled
    .map(([title, content]) => (content ? `${title}:\n${content}` : `${title}:`))
    .join("\n\n")
}

export function rebindPromptMentionsByOrderV6(
  document: PromptDocumentV6,
  references: readonly PromptReference[],
): PromptDocumentV6 {
  const mapParts = (parts: readonly PromptPartV6[]): PromptPartV6[] =>
    parts.map((part) => {
      if (part.type !== "mention") return { ...part }
      const match = new RegExp(`^${part.mediaKind}([1-9]\\d*)$`, "u").exec(part.label)
      if (!match) return { ...part }
      const reference = references.find(
        (candidate) =>
          candidate.mediaKind === part.mediaKind && candidate.ordinal === Number(match[1]),
      )
      return reference
        ? {
            type: "mention" as const,
            referenceId: reference.referenceId,
            mediaKind: reference.mediaKind,
            label: reference.label,
          }
        : { ...part }
    })
  return assertPromptDocumentV6({
    ...document,
    subjects: document.subjects.map((subject) => ({ ...subject, parts: mapParts(subject.parts) })),
    shots: document.shots.map((shot) => ({ ...shot, parts: mapParts(shot.parts) })),
    sections: document.sections.map((section) => ({ ...section, parts: mapParts(section.parts) })),
  })
}

export function renamePromptDefinitionV6(
  document: PromptDocumentV6,
  definitionId: string,
  tag: string,
): PromptDocumentV6 {
  if (!isTag(tag)) throw new PromptV6ValidationError("Definition tag is invalid.")
  if (
    [...document.subjects, ...document.shots].some(
      (definition) => definition.tag === tag && definition.id !== definitionId,
    )
  )
    throw new PromptV6ValidationError("Subject and Shot tags must be unique.")
  const subjects = document.subjects.map((subject) =>
    subject.id === definitionId ? { ...subject, tag } : subject,
  )
  const shots = document.shots.map((shot) => (shot.id === definitionId ? { ...shot, tag } : shot))
  return assertPromptDocumentV6({ ...document, subjects, shots })
}

export function removePromptDefinitionV6(
  document: PromptDocumentV6,
  definitionId: string,
): PromptDocumentV6 {
  const referenced: string[] = []
  for (const owner of [...document.subjects, ...document.shots, ...document.sections]) {
    if ("id" in owner && owner.id === definitionId) continue
    owner.parts.forEach((part, index) => {
      if (part.type === "definition-ref" && part.definitionId === definitionId)
        referenced.push(`${"title" in owner ? owner.title : owner.tag}[${index}]`)
    })
  }
  if (referenced.length)
    throw new PromptV6ValidationError(`Definition is referenced at ${referenced.join(", ")}.`)
  return assertPromptDocumentV6({
    ...document,
    subjects: document.subjects.filter((subject) => subject.id !== definitionId),
    shots: document.shots.filter((shot) => shot.id !== definitionId),
  })
}

function promptTagBoundary(value: string, index: number): boolean {
  return index === 0 || !/[\p{L}\p{N}_-]/u.test(value[index - 1] ?? "")
}

function sourcePartsV6(
  value: string,
  definitions: ReadonlyMap<string, string>,
  references: readonly PromptReference[],
): PromptPartV6[] {
  const parts: PromptPartV6[] = []
  const appendText = (text: string): void => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += text
    else parts.push({ type: "text", text })
  }
  const aliases = new Map<string, PromptReference>()
  for (const reference of references) {
    aliases.set(`${reference.mediaKind}:${reference.label}`, reference)
    aliases.set(`${reference.mediaKind}:${reference.tag}`, reference)
    aliases.set(`${reference.mediaKind}:${reference.mediaKind}${reference.ordinal}`, reference)
  }
  let textStart = 0
  let cursor = 0
  while (cursor < value.length) {
    if (value[cursor] === "#" && promptTagBoundary(value, cursor) && value[cursor - 1] !== "\\") {
      let end = cursor + 1
      while (end < value.length && /[\p{L}\p{N}_-]/u.test(value[end] ?? "")) end += 1
      const tag = value.slice(cursor + 1, end)
      const id = definitions.get(tag)
      if (id) {
        appendText(value.slice(textStart, cursor))
        parts.push({ type: "definition-ref", definitionId: id })
        cursor = end
        textStart = cursor
        continue
      }
    }
    if (value[cursor] === "@" && (cursor === 0 || /\s/u.test(value[cursor - 1] ?? ""))) {
      let end = cursor + 1
      while (end < value.length && !/\s|@/u.test(value[end] ?? "")) end += 1
      const alias = value.slice(cursor + 1, end)
      const reference = references.find(
        (candidate) =>
          aliases.get(`${candidate.mediaKind}:${alias}`)?.referenceId === candidate.referenceId,
      )
      if (reference) {
        appendText(value.slice(textStart, cursor))
        parts.push({
          type: "mention",
          referenceId: reference.referenceId,
          mediaKind: reference.mediaKind,
          label: reference.label,
        })
        cursor = end
        textStart = cursor
        continue
      }
    }
    cursor += 1
  }
  appendText(value.slice(textStart))
  return normalizePromptPartsV6(parts)
}

export function parsePromptPartsV6(
  value: string,
  references: readonly PromptReference[],
  currentDocument: PromptDocumentV6,
): PromptPartV6[] {
  const definitions = new Map<string, string>()
  for (const definition of [...currentDocument.subjects, ...currentDocument.shots])
    definitions.set(definition.tag, definition.id)
  return sourcePartsV6(value.slice(0, 100_000), definitions, references)
}

export function migratePromptDocumentV5(
  document: PromptDocumentV5,
  createId: () => string = createPromptDefinitionId,
): PromptDocumentV6 {
  const subjects = document.subjects.map((subject) => ({
    id: createId(),
    tag: subject.tag ?? subject.label ?? subject.subjectId ?? "subject",
    parts: [] as PromptPartV6[],
  }))
  const shots = document.shots.map((shot) => ({
    id: createId(),
    tag: shot.tag,
    frameIndex: shot.frameIndex,
    parts: [] as PromptPartV6[],
  }))
  const definitions = new Map<string, string>()
  const legacySubjectIds = new Map<string, string>()
  document.subjects.forEach((subject, index) => {
    const migrated = subjects[index]
    if (!migrated) return
    const tag = subject.tag ?? subject.label ?? subject.subjectId ?? migrated.tag
    definitions.set(tag, migrated.id)
    if (subject.subjectId) legacySubjectIds.set(subject.subjectId, migrated.id)
  })
  document.shots.forEach((shot, index) => {
    const migrated = shots[index]
    if (migrated) definitions.set(shot.tag, migrated.id)
  })
  const migrateParts = (parts: readonly PromptSectionPartV5[]): PromptPartV6[] =>
    normalizePromptPartsV6(
      parts.flatMap((part): PromptPartV6[] => {
        if (part.type === "text") return sourcePartsV6(part.text, definitions, [])
        if (part.type === "mention") return [{ ...part }]
        const definitionId =
          legacySubjectIds.get(part.subjectId) ?? definitions.get(part.label) ?? part.subjectId
        return definitionId && isIdentity(definitionId)
          ? [{ type: "definition-ref", definitionId }]
          : [{ type: "text", text: `#${part.label || part.subjectId}` }]
      }),
    )
  subjects.forEach((subject, index) => {
    subject.parts = migrateParts(document.subjects[index]?.parts ?? [])
  })
  shots.forEach((shot, index) => {
    shot.parts = migrateParts(document.shots[index]?.parts ?? [])
  })
  const sections = document.sections.map((section) => ({
    id: createId(),
    title: section.title,
    parts: migrateParts(section.parts),
  }))
  return assertPromptDocumentV6({
    version: PROMPT_DOCUMENT_VERSION,
    view: document.view,
    subjects,
    shots,
    sections,
  })
}

/** Parse the human-readable source projection without changing definitions. */
export function parseAuthoringPromptV6(
  value: string,
  references: readonly PromptReference[],
  currentDocument: PromptDocumentV6,
): PromptDocumentV6 {
  const text = value.slice(0, 100_000)
  const definitions = new Map<string, string>()
  for (const definition of [...currentDocument.subjects, ...currentDocument.shots])
    definitions.set(definition.tag, definition.id)
  const headerPattern = /^([a-z][a-z0-9_]{0,63}):[ \t]*(?:\r?\n|$)/gmu
  const headers = Array.from(text.matchAll(headerPattern))
  const parsedSections: { title: string; parts: PromptPartV6[] }[] = []
  const addSection = (title: string, content: string): void => {
    const next = { title, parts: sourcePartsV6(content.trim(), definitions, references) }
    const existing = parsedSections.find((section) => section.title === title)
    if (!existing) parsedSections.push(next)
    else {
      const separator =
        existing.parts.length > 0 && next.parts.length > 0
          ? [{ type: "text", text: "\n\n" } satisfies PromptTextPartV6]
          : []
      existing.parts = normalizePromptPartsV6([...existing.parts, ...separator, ...next.parts])
    }
  }
  if (headers.length === 0) addSection("scene", text)
  else {
    const prefix = text.slice(0, headers[0]?.index ?? 0).trim()
    if (prefix) addSection("scene", prefix)
    headers.forEach((header, index) =>
      addSection(
        header[1] ?? "scene",
        text.slice(
          (header.index ?? 0) + header[0].length,
          headers[index + 1]?.index ?? text.length,
        ),
      ),
    )
  }
  const sections = parsedSections.map((section) => {
    const existing = currentDocument.sections.find((candidate) => candidate.title === section.title)
    return { ...section, id: existing?.id ?? createPromptDefinitionId() }
  })
  return assertPromptDocumentV6({
    ...currentDocument,
    view: "structured",
    sections,
  })
}
