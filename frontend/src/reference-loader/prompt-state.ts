import {
  compilePromptDocumentV6,
  deserializePromptDocumentV6,
  isPromptDocumentV6,
  renderAuthoringPromptV6,
  rebindPromptMentionsByOrderV6,
  serializePromptDocumentV6,
  validatePromptDocumentV6,
  type PromptDocumentV6,
} from "./prompt-v6.ts"

export const PROMPT_STATE_VERSION = 5 as const
export const MAX_PROMPT_STATE_CHARACTERS = 250_000
export const MAX_PROMPT_TEXT_CHARACTERS = 100_000
export const MAX_PROMPT_SECTION_TITLE_CHARACTERS = 64
export const MAX_PROMPT_DEFINITION_TAG_CHARACTERS = 64
export const MAX_PROMPT_SUBJECT_LABEL_CHARACTERS = MAX_PROMPT_DEFINITION_TAG_CHARACTERS

export type PromptMediaKind = "image" | "video" | "audio"
export type PromptViewMode = "structured" | "raw"

export interface PromptTextPart {
  type: "text"
  text: string
}
export interface PromptMentionPart {
  type: "mention"
  referenceId: string
  mediaKind: PromptMediaKind
  label: string
}
/** v4 input only. New documents store #tag in text parts. */
export interface PromptSubjectPart {
  type: "subject"
  subjectId: string
  label: string
}
export type PromptSectionPart = PromptTextPart | PromptMentionPart | PromptSubjectPart
export type PromptAuthoringPart = PromptTextPart | PromptMentionPart

export interface PromptSubject {
  tag?: string
  parts?: PromptSectionPart[]
  subjectId?: string
  label?: string
}
export interface PromptShot {
  tag: string
  frameIndex: number
  parts: PromptSectionPart[]
}
export interface PromptSection {
  title: string
  parts: PromptSectionPart[]
}
export interface PromptDocument {
  version: typeof PROMPT_STATE_VERSION
  view: PromptViewMode
  subjects: PromptSubject[]
  shots: PromptShot[]
  sections: PromptSection[]
}
interface LegacyPromptSubject {
  subjectId: string
  label: string
}
interface LegacyPromptDocument {
  version: number
  view?: PromptViewMode
  subjects: LegacyPromptSubject[]
  shots?: PromptShot[]
  sections: { title: string; parts: PromptSectionPart[] }[]
}
type PromptDocumentInput = PromptDocument | LegacyPromptDocument
export interface PromptReference {
  referenceId: string
  itemId: string
  mediaKind: PromptMediaKind
  ordinal: number
  tag: string
  label: string
  filename: string
  previewUrl?: string
}
export interface PromptValidationResult {
  document: PromptDocument
  issues: string[]
  recoveredFromVersion?: number
}

export const PROMPT_TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u
const PROMPT_TAG_CHARACTER_PATTERN = /[\p{L}\p{N}_-]/u

export function createEmptyPromptDocument(): PromptDocument {
  return {
    version: PROMPT_STATE_VERSION,
    view: "structured",
    subjects: [],
    shots: [],
    sections: [],
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function isPromptSectionTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_PROMPT_SECTION_TITLE_CHARACTERS &&
    /^[a-z][a-z0-9_]*$/u.test(value)
  )
}
export function normalizePromptSectionTitle(value: string): string | undefined {
  const title = value.trim().replace(/:$/u, "").toLocaleLowerCase()
  return isPromptSectionTitle(title) ? title : undefined
}
export function normalizePromptTag(value: string): string | undefined {
  const tag = value.trim()
  return PROMPT_TAG_PATTERN.test(tag) ? tag : undefined
}
function mergeTextParts<T extends PromptSectionPart | PromptAuthoringPart>(parts: T[]): T[] {
  const merged: T[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.text) continue
    const previous = merged.at(-1)
    if (part.type === "text" && previous?.type === "text") previous.text += part.text
    else merged.push(part)
  }
  return merged
}
function normalizeDocumentInput(value: PromptDocumentInput): PromptDocument {
  if (value.subjects.some((subject) => !("tag" in subject) || !subject.tag))
    return migrateV4(value as unknown as Record<string, unknown>).document
  const document = value as PromptDocument
  return { ...document, shots: document.shots ?? [] }
}
function validateMention(
  value: Record<string, unknown>,
  path: string,
  issues: string[],
): PromptMentionPart | undefined {
  const referenceId = value.referenceId
  const mediaKind = value.mediaKind
  if (
    typeof referenceId !== "string" ||
    referenceId.length === 0 ||
    referenceId.length > 160 ||
    /\s/u.test(referenceId) ||
    (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio")
  ) {
    issues.push(`${path} was discarded.`)
    return undefined
  }
  return {
    type: "mention",
    referenceId,
    mediaKind,
    label: typeof value.label === "string" ? value.label.slice(0, 255) : "",
  }
}
function validTag(value: unknown): value is string {
  return typeof value === "string" && normalizePromptTag(value) === value
}
function validatePart(
  value: unknown,
  path: string,
  issues: string[],
): PromptAuthoringPart | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} was discarded.`)
    return undefined
  }
  if (value.type === "text") {
    if (typeof value.text !== "string") {
      issues.push(`${path} was discarded.`)
      return undefined
    }
    return { type: "text", text: value.text }
  }
  if (value.type === "mention") return validateMention(value, path, issues)
  issues.push(`${path} was discarded.`)
  return undefined
}
function validateParts(value: unknown, path: string, issues: string[]): PromptAuthoringPart[] {
  if (!Array.isArray(value)) {
    issues.push(`${path} was discarded.`)
    return []
  }
  return mergeTextParts(
    value.flatMap((part, index) => {
      const validated = validatePart(part, `${path}[${index}]`, issues)
      return validated ? [validated] : []
    }),
  )
}
function validFrame(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function recoverPromptText(value: string): PromptDocument {
  const text = value.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
  return {
    version: PROMPT_STATE_VERSION,
    view: "raw",
    subjects: [],
    shots: [],
    sections: text ? [{ title: "scene", parts: [{ type: "text", text }] }] : [],
  }
}

export function validatePromptDocument(value: unknown): PromptValidationResult {
  if (isPromptDocumentV6(value)) {
    const result = validatePromptDocumentV6(value)
    return {
      document: result.document
        ? (result.document as unknown as PromptDocument)
        : recoverPromptText(JSON.stringify(value)),
      issues: result.issues,
    }
  }
  if (!isRecord(value) || value.version !== PROMPT_STATE_VERSION || !Array.isArray(value.sections))
    return { document: createEmptyPromptDocument(), issues: ["Prompt state was invalid."] }
  const issues: string[] = []
  const subjects: PromptSubject[] = []
  const shots: PromptShot[] = []
  const tags = new Set<string>()
  const addTag = (tag: unknown, path: string): string | undefined => {
    if (!validTag(tag)) {
      issues.push(`${path} was discarded.`)
      return undefined
    }
    if (tags.has(tag)) {
      issues.push(`${path} was discarded because its tag was duplicated.`)
      return undefined
    }
    tags.add(tag)
    return tag
  }
  if (!Array.isArray(value.subjects)) issues.push("Prompt subjects were reset.")
  else
    for (const [index, raw] of value.subjects.entries()) {
      if (!isRecord(raw)) {
        issues.push(`Prompt subject ${index} was discarded.`)
        continue
      }
      const tag = addTag(raw.tag, `Prompt subject ${index}.tag`)
      if (tag)
        subjects.push({
          tag,
          parts: validateParts(raw.parts, `Prompt subject ${index}.parts`, issues),
        })
    }
  if (!Array.isArray(value.shots)) issues.push("Prompt shots were reset.")
  else
    for (const [index, raw] of value.shots.entries()) {
      if (!isRecord(raw)) {
        issues.push(`Prompt shot ${index} was discarded.`)
        continue
      }
      const tag = addTag(raw.tag, `Prompt shot ${index}.tag`)
      if (!validFrame(raw.frameIndex)) {
        issues.push(`Prompt shot ${index}.frameIndex was discarded.`)
        if (tag) tags.delete(tag)
        continue
      }
      if (tag)
        shots.push({
          tag,
          frameIndex: raw.frameIndex,
          parts: validateParts(raw.parts, `Prompt shot ${index}.parts`, issues),
        })
    }
  const sections: PromptSection[] = []
  const titles = new Set<string>()
  for (const [index, raw] of value.sections.entries()) {
    if (!isRecord(raw) || !isPromptSectionTitle(raw.title) || titles.has(raw.title)) {
      issues.push(`Prompt section ${index} was discarded.`)
      continue
    }
    titles.add(raw.title)
    sections.push({
      title: raw.title,
      parts: validateParts(raw.parts, `Prompt section ${index}.parts`, issues),
    })
  }
  const textLength = [
    ...subjects.flatMap((subject) => subject.parts),
    ...shots.flatMap((shot) => shot.parts),
    ...sections.flatMap((section) => section.parts),
  ]
    .filter((part): part is PromptTextPart => part !== undefined && part.type === "text")
    .reduce((length, part) => length + part.text.length, 0)
  if (textLength > MAX_PROMPT_TEXT_CHARACTERS)
    issues.push(`Prompt text exceeded ${MAX_PROMPT_TEXT_CHARACTERS} characters.`)
  return {
    document: {
      version: PROMPT_STATE_VERSION,
      view: value.view === "raw" ? "raw" : "structured",
      subjects,
      shots,
      sections,
    },
    issues,
  }
}
export function serializePromptDocument(documentInput: unknown): string {
  if (isPromptDocumentV6(documentInput)) return serializePromptDocumentV6(documentInput)
  const document = normalizeDocumentInput(documentInput as PromptDocumentInput)
  return JSON.stringify(validatePromptDocument(document).document)
}

function legacyPartToAuthoring(
  rawPart: unknown,
  subjects: readonly { subjectId: string; label: string }[],
  issues: string[],
): PromptAuthoringPart | undefined {
  if (!isRecord(rawPart)) {
    issues.push("Legacy prompt part was discarded.")
    return undefined
  }
  if (rawPart.type === "text" && typeof rawPart.text === "string")
    return { type: "text", text: rawPart.text }
  if (rawPart.type === "mention") return validateMention(rawPart, "Legacy prompt mention", issues)
  if (rawPart.type === "subject") {
    const subjectId = typeof rawPart.subjectId === "string" ? rawPart.subjectId : ""
    const subject = subjects.find((candidate) => candidate.subjectId === subjectId)
    const label = subject?.label ?? (typeof rawPart.label === "string" ? rawPart.label : subjectId)
    return label ? { type: "text", text: `#${label}` } : undefined
  }
  if (rawPart.type === "dialogue" && typeof rawPart.text === "string")
    return { type: "text", text: `<d>${rawPart.text}</d>` }
  if (rawPart.type === "directive" && (rawPart.kind === "audio" || rawPart.kind === "style")) {
    const nested = Array.isArray(rawPart.parts)
      ? rawPart.parts
      : typeof rawPart.text === "string"
        ? [{ type: "text", text: rawPart.text }]
        : []
    return {
      type: "text",
      text: `<${rawPart.kind}>${nested.map((part) => legacyPartToText(part, subjects, issues)).join("")}</${rawPart.kind}>`,
    }
  }
  issues.push("Legacy prompt part was preserved as text.")
  return { type: "text", text: JSON.stringify(rawPart) ?? "" }
}

function legacyPartToText(
  rawPart: unknown,
  subjects: readonly { subjectId: string; label: string }[],
  issues: string[],
): string {
  const part = legacyPartToAuthoring(rawPart, subjects, issues)
  if (!part) return ""
  if (part.type === "text") return part.text
  const ordinal = /^(?:image|video|audio)([1-9]\d*)$/u.exec(part.label)?.[1]
  const name =
    part.mediaKind === "image"
      ? "Picture"
      : part.mediaKind[0]!.toUpperCase() + part.mediaKind.slice(1)
  return ordinal ? `<${name} ${ordinal}>` : `@${part.label || part.referenceId}`
}
function migrateV4(value: Record<string, unknown>): PromptValidationResult {
  const issues: string[] = []
  const legacySubjects: { subjectId: string; label: string }[] = (
    Array.isArray(value.subjects) ? value.subjects : []
  ).flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.subjectId !== "string" || typeof raw.label !== "string")
      return []
    const tag = normalizePromptTag(raw.label)
    return tag ? [{ subjectId: raw.subjectId, label: tag }] : []
  })
  const subjects: PromptSubject[] = []
  const tags = new Set<string>()
  for (const subject of legacySubjects)
    if (!tags.has(subject.label)) {
      tags.add(subject.label)
      subjects.push({ tag: subject.label, parts: [] })
    }
  const convertRawText = (text: string): string =>
    text.replace(/<\s*subject\s+(\d+)\s*>/giu, (raw, ordinal: string) =>
      subjects[Number(ordinal) - 1] ? `#${subjects[Number(ordinal) - 1]!.tag}` : raw,
    )
  const convertParts = (rawParts: unknown): PromptAuthoringPart[] => {
    if (!Array.isArray(rawParts)) return [{ type: "text", text: JSON.stringify(rawParts) ?? "" }]
    return mergeTextParts<PromptAuthoringPart>(
      rawParts.flatMap((part): PromptAuthoringPart[] => {
        const converted = legacyPartToAuthoring(part, legacySubjects, issues)
        return converted?.type === "text"
          ? [{ ...converted, text: convertRawText(converted.text) }]
          : converted
            ? [converted]
            : []
      }),
    )
  }
  const sections: PromptSection[] = []
  if (Array.isArray(value.sections))
    for (const raw of value.sections) {
      if (isRecord(raw) && isPromptSectionTitle(raw.title))
        sections.push({ title: raw.title, parts: convertParts(raw.parts) })
      else sections.push({ title: "legacy_prompt", parts: convertParts([raw]) })
    }
  else if (Array.isArray(value.parts))
    sections.push({ title: "scene", parts: convertParts(value.parts) })
  else sections.push({ title: "legacy_prompt", parts: convertParts([value]) })
  return {
    document: { version: PROMPT_STATE_VERSION, view: "raw", subjects, shots: [], sections },
    issues,
    recoveredFromVersion: 4,
  }
}
function recoverLegacyPromptDocument(
  value: Record<string, unknown>,
  version: number,
): PromptValidationResult {
  return { ...migrateV4({ ...value, version: 4 }), recoveredFromVersion: version }
}
export function deserializePromptDocument(value: unknown): PromptValidationResult {
  if (value === undefined || value === null || value === "")
    return { document: createEmptyPromptDocument(), issues: [] }
  if (typeof value !== "string") {
    if (isRecord(value) && value.version === 4) return migrateV4(value)
    if (
      isRecord(value) &&
      typeof value.version === "number" &&
      value.version > 0 &&
      value.version < 4
    )
      return recoverLegacyPromptDocument(value, value.version)
    return validatePromptDocument(value)
  }
  if (value.length > MAX_PROMPT_STATE_CHARACTERS)
    return {
      document: createEmptyPromptDocument(),
      issues: ["Prompt state exceeded the 250,000-character limit."],
    }
  try {
    const parsed = JSON.parse(value) as unknown
    if (isPromptDocumentV6(parsed)) {
      const result = deserializePromptDocumentV6(parsed)
      return {
        document: result.document
          ? (result.document as unknown as PromptDocument)
          : recoverPromptText(value),
        issues: result.issues,
      }
    }
    if (isRecord(parsed) && parsed.version === 4) return migrateV4(parsed)
    if (
      isRecord(parsed) &&
      typeof parsed.version === "number" &&
      parsed.version > 0 &&
      parsed.version < 4
    )
      return recoverLegacyPromptDocument(parsed, parsed.version)
    return validatePromptDocument(parsed)
  } catch {
    const text = value.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
    return {
      document: {
        version: PROMPT_STATE_VERSION,
        view: "structured",
        subjects: [],
        shots: [],
        sections: text ? [{ title: "scene", parts: [{ type: "text", text }] }] : [],
      },
      issues: [],
    }
  }
}

export interface PromptTagToken {
  start: number
  end: number
  tag: string
  escaped: boolean
}
const isTagBoundary = (value: string, index: number): boolean =>
  index === 0 || !PROMPT_TAG_CHARACTER_PATTERN.test(value[index - 1] ?? "")
/** Scan #tags with a safe boundary. `\\#tag` is literal and not replaced. */
export function scanPromptTags(value: string): PromptTagToken[] {
  const tokens: PromptTagToken[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "#" || !isTagBoundary(value, index)) continue
    let end = index + 1
    while (end < value.length && PROMPT_TAG_CHARACTER_PATTERN.test(value[end] ?? "")) end += 1
    const tag = value.slice(index + 1, end)
    if (!normalizePromptTag(tag)) continue
    const escaped = index > 0 && value[index - 1] === "\\"
    tokens.push({ start: escaped ? index - 1 : index, end, tag, escaped })
    index = end - 1
  }
  return tokens
}
export function replacePromptTag(value: string, from: string, to: string): string {
  let result = ""
  let cursor = 0
  for (const token of scanPromptTags(value).filter(
    (candidate) => !candidate.escaped && candidate.tag === from,
  )) {
    result += value.slice(cursor, token.start) + `#${to}`
    cursor = token.end
  }
  return result + value.slice(cursor)
}
function compileText(value: string, tokens: ReadonlyMap<string, string>): string {
  let result = ""
  let cursor = 0
  for (const token of scanPromptTags(value)) {
    result +=
      value.slice(cursor, token.start) +
      (token.escaped ? `#${token.tag}` : (tokens.get(token.tag) ?? `#${token.tag}`))
    cursor = token.end
  }
  return result + value.slice(cursor)
}
function mentionFallback(part: PromptMentionPart): string {
  return `@${part.label || part.referenceId}`
}
function renderParts(
  parts: readonly PromptAuthoringPart[] | readonly PromptSectionPart[],
  active: ReadonlyMap<string, PromptReference>,
  tokens?: ReadonlyMap<string, string>,
): string {
  return parts
    .map((part) =>
      part.type === "text"
        ? tokens
          ? compileText(part.text, tokens)
          : part.text
        : part.type === "subject"
          ? (tokens?.get(part.label) ?? `#${part.label || part.subjectId}`)
          : tokens
            ? (active.get(`${part.mediaKind}:${part.referenceId}`)?.tag ?? mentionFallback(part))
            : `@${active.get(`${part.mediaKind}:${part.referenceId}`)?.label ?? part.label ?? part.referenceId}`,
    )
    .join("")
}
function tokenMap(document: PromptDocument): Map<string, string> {
  const tokens = new Map<string, string>()
  document.subjects.forEach((subject, index) => {
    const tag = subject.tag ?? subject.label ?? subject.subjectId
    if (tag) tokens.set(tag, `<Subject ${index + 1}>`)
  })
  const shots = [...document.shots].sort(
    (left, right) =>
      left.frameIndex - right.frameIndex ||
      document.shots.indexOf(left) - document.shots.indexOf(right),
  )
  shots.forEach((shot, index) => tokens.set(shot.tag, `[Shot ${index + 1}]`))
  return tokens
}
function shotOrdinalMap(document: PromptDocument): Map<string, number> {
  const map = new Map<string, number>()
  ;[...document.shots]
    .sort(
      (left, right) =>
        left.frameIndex - right.frameIndex ||
        document.shots.indexOf(left) - document.shots.indexOf(right),
    )
    .forEach((shot, index) => map.set(shot.tag, index + 1))
  return map
}
function formatShotSeconds(frameIndex: number): string {
  return (Math.floor((frameIndex * 1000) / 24 + 0.5) / 1000).toFixed(3)
}
export function renderAuthoringPrompt(
  documentInput: PromptDocumentInput | PromptDocumentV6,
  references: readonly PromptReference[],
): string {
  if (isPromptDocumentV6(documentInput)) return renderAuthoringPromptV6(documentInput, references)
  const document = normalizeDocumentInput(documentInput)
  const active = new Map(
    references.map((reference) => [`${reference.mediaKind}:${reference.referenceId}`, reference]),
  )
  return document.sections
    .map((section) => {
      const content = renderParts(section.parts, active).trim()
      return content ? `${section.title}:\n${content}` : `${section.title}:`
    })
    .join("\n\n")
}
export function compilePromptSections(
  documentInput: PromptDocumentInput,
  references: readonly PromptReference[],
): Array<[string, string]> {
  const document = normalizeDocumentInput(documentInput)
  const active = new Map(
    references.map((reference) => [`${reference.mediaKind}:${reference.referenceId}`, reference]),
  )
  const tokens = tokenMap(document)
  const generatedSubjects = document.subjects
    .map((subject, index) =>
      `<Subject ${index + 1}>: ${renderParts(subject.parts ?? [], active, tokens)}`.trimEnd(),
    )
    .join("\n\n")
  const shotOrdinals = shotOrdinalMap(document)
  const generatedShots = [...document.shots]
    .sort(
      (left, right) =>
        left.frameIndex - right.frameIndex ||
        document.shots.indexOf(left) - document.shots.indexOf(right),
    )
    .map((shot) =>
      `[Shot ${shotOrdinals.get(shot.tag)}]\nAt ${formatShotSeconds(shot.frameIndex)} seconds: ${renderParts(shot.parts, active, tokens)}`.trimEnd(),
    )
    .join("\n\n")
  const compiled = document.sections.map((section): [string, string] => {
    let content = renderParts(section.parts, active, tokens).trim()
    if (section.title === "subject_definitions" && generatedSubjects)
      content = [content, generatedSubjects].filter(Boolean).join("\n\n")
    if (section.title === "timeline_direction" && generatedShots)
      content = [content, generatedShots].filter(Boolean).join("\n\n")
    return [section.title, content]
  })
  if (generatedSubjects && !compiled.some(([title]) => title === "subject_definitions"))
    compiled.unshift(["subject_definitions", generatedSubjects])
  if (generatedShots && !compiled.some(([title]) => title === "timeline_direction"))
    compiled.push(["timeline_direction", generatedShots])
  return compiled
}
export function compilePromptDocument(
  document: PromptDocumentInput | PromptDocumentV6,
  references: readonly PromptReference[],
): string {
  if (isPromptDocumentV6(document)) return compilePromptDocumentV6(document, references)
  return compilePromptSections(document, references)
    .map(([title, content]) => (content ? `${title}:\n${content}` : `${title}:`))
    .join("\n\n")
}

function officialTagMatch(
  value: string,
  cursor: number,
): { raw: string; mediaKind: PromptMediaKind; ordinal: number } | undefined {
  const match = value.slice(cursor).match(/^<\s*(picture|video|audio)\s+(\d+)\s*>/iu)
  if (!match) return undefined
  const rawKind = match[1]?.toLowerCase()
  const mediaKind = rawKind === "picture" ? "image" : rawKind
  const ordinal = Number(match[2])
  return mediaKind &&
    ["image", "video", "audio"].includes(mediaKind) &&
    Number.isInteger(ordinal) &&
    ordinal > 0
    ? { raw: match[0], mediaKind: mediaKind as PromptMediaKind, ordinal }
    : undefined
}

function authoringMentionMatch(
  value: string,
  cursor: number,
  references: readonly PromptReference[],
): { raw: string; reference: PromptReference } | undefined {
  if (value[cursor] !== "@" || (cursor > 0 && !/\s/u.test(value[cursor - 1] ?? "")))
    return undefined
  let end = cursor + 1
  while (end < value.length && !/\s|@/u.test(value[end] ?? "")) end += 1
  const alias = value.slice(cursor + 1, end)
  if (!alias) return undefined
  const reference = references.find((candidate) =>
    [candidate.label, candidate.tag, `${candidate.mediaKind}${candidate.ordinal}`].includes(alias),
  )
  return reference ? { raw: value.slice(cursor, end), reference } : undefined
}

function parseSectionParts(
  value: string,
  references: readonly PromptReference[],
): PromptAuthoringPart[] {
  const parts: PromptAuthoringPart[] = []
  const pushText = (chunk: string): void => {
    if (!chunk) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += chunk
    else parts.push({ type: "text", text: chunk })
  }
  let plainStart = 0
  let cursor = 0
  while (cursor < value.length) {
    const tag = officialTagMatch(value, cursor)
    if (tag) {
      if (plainStart < cursor) pushText(value.slice(plainStart, cursor))
      const reference = references.find(
        (candidate) => candidate.mediaKind === tag.mediaKind && candidate.ordinal === tag.ordinal,
      )
      if (reference)
        parts.push({
          type: "mention",
          referenceId: reference.referenceId,
          mediaKind: reference.mediaKind,
          label: reference.label,
        })
      else pushText(tag.raw)
      cursor += tag.raw.length
      plainStart = cursor
      continue
    }
    const mention = authoringMentionMatch(value, cursor, references)
    if (!mention) {
      cursor += 1
      continue
    }
    if (plainStart < cursor) pushText(value.slice(plainStart, cursor))
    parts.push({
      type: "mention",
      referenceId: mention.reference.referenceId,
      mediaKind: mention.reference.mediaKind,
      label: mention.reference.label,
    })
    cursor += mention.raw.length
    plainStart = cursor
  }
  if (plainStart < value.length) pushText(value.slice(plainStart))
  return mergeTextParts(parts)
}
export function parseAuthoringPrompt(
  value: string,
  references: readonly PromptReference[],
  currentDocument: PromptDocument,
  view: PromptViewMode = "raw",
): PromptDocument {
  const text = value.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
  const headerPattern = /^([a-z][a-z0-9_]{0,63}):[ \t]*(?:\r?\n|$)/gmu
  const headers = Array.from(text.matchAll(headerPattern))
  if (headers.length === 0) {
    const content = text.trim()
    return {
      version: PROMPT_STATE_VERSION,
      view,
      subjects: currentDocument.subjects,
      shots: currentDocument.shots,
      sections: content ? [{ title: "scene", parts: parseSectionParts(content, references) }] : [],
    }
  }
  const sections: PromptSection[] = []
  const byTitle = new Map<string, PromptSection>()
  const addSection = (title: string, content: string): void => {
    const parts = parseSectionParts(content.trim(), references)
    const existing = byTitle.get(title)
    if (existing) {
      if (existing.parts.length > 0 && parts.length > 0)
        existing.parts.push({ type: "text", text: "\n\n" })
      existing.parts = mergeTextParts([...existing.parts, ...parts])
    } else {
      const section = { title, parts }
      sections.push(section)
      byTitle.set(title, section)
    }
  }
  const prefix = text.slice(0, headers[0]?.index ?? 0).trim()
  if (prefix) addSection("scene", prefix)
  headers.forEach((header, index) =>
    addSection(
      header[1] ?? "scene",
      text.slice((header.index ?? 0) + header[0].length, headers[index + 1]?.index ?? text.length),
    ),
  )
  return {
    version: PROMPT_STATE_VERSION,
    view,
    subjects: currentDocument.subjects,
    shots: currentDocument.shots,
    sections,
  }
}
/** Compatibility name retained for callers; Raw parsing is now authoring-only. */
export function parseRawPrompt(
  value: string,
  references: readonly PromptReference[],
  view: PromptViewMode = "raw",
  currentDocument:
    | PromptDocument
    | readonly PromptSubject[]
    | readonly LegacyPromptSubject[] = createEmptyPromptDocument(),
): PromptDocument {
  let document: PromptDocument
  if (Array.isArray(currentDocument))
    document = {
      ...createEmptyPromptDocument(),
      subjects: (currentDocument as readonly (PromptSubject | LegacyPromptSubject)[]).map(
        (subject) => ({ tag: "tag" in subject ? subject.tag : subject.label, parts: [] }),
      ),
    }
  else document = currentDocument as PromptDocument
  return parseAuthoringPrompt(value, references, document, view)
}
export function renamePromptTag(
  document: PromptDocument,
  from: string,
  to: string,
): PromptDocument {
  const updateParts = (parts: readonly PromptSectionPart[]): PromptSectionPart[] =>
    parts.map((part) =>
      part.type === "text" ? { ...part, text: replacePromptTag(part.text, from, to) } : { ...part },
    )
  return {
    ...document,
    subjects: document.subjects.map((subject) => ({
      ...subject,
      tag: subject.tag === from ? to : subject.tag,
      parts: updateParts(subject.parts ?? []),
    })),
    shots: document.shots.map((shot) => ({
      ...shot,
      tag: shot.tag === from ? to : shot.tag,
      parts: updateParts(shot.parts),
    })),
    sections: document.sections.map((section) => ({
      ...section,
      parts: updateParts(section.parts),
    })),
  }
}
export function rebindPromptMentionsByOrder(
  document: PromptDocument | PromptDocumentV6,
  references: readonly PromptReference[],
): PromptDocument | PromptDocumentV6 {
  if (isPromptDocumentV6(document)) return rebindPromptMentionsByOrderV6(document, references)
  const mapParts = (parts: readonly PromptSectionPart[]): PromptSectionPart[] =>
    parts.map((part) => {
      if (part.type !== "mention" || !/^(image|video|audio)[1-9]\d*$/u.test(part.label)) return part
      const match = /^(image|video|audio)([1-9]\d*)$/u.exec(part.label)
      const reference = references.find(
        (candidate) =>
          candidate.mediaKind === part.mediaKind && candidate.ordinal === Number(match?.[2]),
      )
      return reference
        ? { ...part, referenceId: reference.referenceId, label: reference.label }
        : part
    })
  return {
    ...document,
    subjects: document.subjects.map((subject) => ({
      ...subject,
      parts: mapParts(subject.parts ?? []),
    })),
    shots: document.shots.map((shot) => ({ ...shot, parts: mapParts(shot.parts) })),
    sections: document.sections.map((section) => ({ ...section, parts: mapParts(section.parts) })),
  }
}

// Prompt v6 is intentionally kept in a separate pure module while the legacy
// v5 surface remains available to existing workflow consumers.
export * from "./prompt-v6.ts"
