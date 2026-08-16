export const PROMPT_STATE_VERSION = 3 as const
export const MAX_PROMPT_STATE_CHARACTERS = 250_000
export const MAX_PROMPT_TEXT_CHARACTERS = 100_000
export const MAX_PROMPT_SECTION_TITLE_CHARACTERS = 64

export type PromptMediaKind = "image" | "video" | "audio"
export type PromptViewMode = "structured" | "raw"

export interface PromptTextPart {
  type: "text"
  text: string
}

export interface PromptDialoguePart {
  type: "dialogue"
  text: string
}

export interface PromptMentionPart {
  type: "mention"
  referenceId: string
  mediaKind: PromptMediaKind
  label: string
}

export type PromptSectionPart = PromptTextPart | PromptDialoguePart | PromptMentionPart

export interface PromptSection {
  title: string
  parts: PromptSectionPart[]
}

export interface PromptDocument {
  version: typeof PROMPT_STATE_VERSION
  view: PromptViewMode
  sections: PromptSection[]
}

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
}

export function createEmptyPromptDocument(): PromptDocument {
  return { version: PROMPT_STATE_VERSION, view: "structured", sections: [] }
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

function mergeTextParts(parts: PromptSectionPart[]): PromptSectionPart[] {
  const merged: PromptSectionPart[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.text) continue
    const previous = merged.at(-1)
    if (part.type === "text" && previous?.type === "text") previous.text += part.text
    else merged.push(part)
  }
  return merged
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

export function validatePromptDocument(value: unknown): PromptValidationResult {
  if (
    !isRecord(value) ||
    value.version !== PROMPT_STATE_VERSION ||
    !Array.isArray(value.sections)
  ) {
    return { document: createEmptyPromptDocument(), issues: ["Prompt state was invalid."] }
  }
  const issues: string[] = []
  const sections: PromptSection[] = []
  const sectionByTitle = new Map<string, PromptSection>()
  let textLength = 0

  for (const [sectionIndex, rawSection] of value.sections.entries()) {
    if (!isRecord(rawSection) || !isPromptSectionTitle(rawSection.title)) {
      issues.push(`Prompt section ${sectionIndex} was discarded.`)
      continue
    }
    if (!Array.isArray(rawSection.parts)) {
      issues.push(`Prompt section ${sectionIndex} was discarded.`)
      continue
    }
    const parts: PromptSectionPart[] = []
    for (const [partIndex, rawPart] of rawSection.parts.entries()) {
      const path = `Prompt section ${sectionIndex} part ${partIndex}`
      if (!isRecord(rawPart)) {
        issues.push(`${path} was discarded.`)
        continue
      }
      if (rawPart.type === "text" || rawPart.type === "dialogue") {
        if (typeof rawPart.text !== "string") {
          issues.push(`${path} was discarded.`)
          continue
        }
        const remaining = Math.max(0, MAX_PROMPT_TEXT_CHARACTERS - textLength)
        const text = rawPart.text.slice(0, remaining)
        textLength += text.length
        parts.push({ type: rawPart.type, text })
        if (text.length !== rawPart.text.length)
          issues.push(
            `Prompt text exceeded ${MAX_PROMPT_TEXT_CHARACTERS} characters and was truncated.`,
          )
        continue
      }
      if (rawPart.type === "mention") {
        const mention = validateMention(rawPart, path, issues)
        if (mention) parts.push(mention)
        continue
      }
      issues.push(`${path} was discarded.`)
    }

    const title = rawSection.title
    const existing = sectionByTitle.get(title)
    if (existing) {
      if (existing.parts.length > 0 && parts.length > 0)
        existing.parts.push({ type: "text", text: "\n\n" })
      existing.parts = mergeTextParts([...existing.parts, ...parts])
      issues.push(`Duplicate prompt section ${title} was merged.`)
    } else {
      const section = { title, parts: mergeTextParts(parts) }
      sections.push(section)
      sectionByTitle.set(title, section)
    }
  }

  return {
    document: {
      version: PROMPT_STATE_VERSION,
      view: value.view === "raw" ? "raw" : "structured",
      sections,
    },
    issues,
  }
}

export function serializePromptDocument(document: PromptDocument): string {
  return JSON.stringify(validatePromptDocument(document).document)
}

export function deserializePromptDocument(value: unknown): PromptValidationResult {
  if (value === undefined || value === null || value === "")
    return { document: createEmptyPromptDocument(), issues: [] }
  if (typeof value !== "string") return validatePromptDocument(value)
  if (value.length > MAX_PROMPT_STATE_CHARACTERS) {
    return {
      document: createEmptyPromptDocument(),
      issues: ["Prompt state exceeded the 250,000-character limit."],
    }
  }
  try {
    return validatePromptDocument(JSON.parse(value) as unknown)
  } catch {
    const text = value.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
    return {
      document: {
        version: PROMPT_STATE_VERSION,
        view: "structured",
        sections: text ? [{ title: "scene", parts: [{ type: "text", text }] }] : [],
      },
      issues: [],
    }
  }
}

function mentionFallback(part: PromptMentionPart): string {
  return `@${part.label || part.referenceId}`
}

function compileSectionParts(
  parts: readonly PromptSectionPart[],
  active: ReadonlyMap<string, PromptReference>,
): string {
  return parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "dialogue") return `<d>${part.text}</d>`
      return active.get(`${part.mediaKind}:${part.referenceId}`)?.tag ?? mentionFallback(part)
    })
    .join("")
    .trim()
}

export function compilePromptDocument(
  document: PromptDocument,
  references: readonly PromptReference[],
): string {
  const active = new Map(
    references.map((reference) => [`${reference.mediaKind}:${reference.referenceId}`, reference]),
  )
  return document.sections
    .map((section) => {
      const content = compileSectionParts(section.parts, active)
      return content ? `${section.title}:\n${content}` : `${section.title}:`
    })
    .join("\n\n")
}

function officialTagMatch(
  value: string,
  cursor: number,
): { raw: string; mediaKind: PromptMediaKind; ordinal: number } | undefined {
  const match = value.slice(cursor).match(/^<\s*(picture|video|audio)\s+(\d+)\s*>/iu)
  if (!match) return undefined
  const mediaKind = match[1]?.toLowerCase() === "picture" ? "image" : match[1]?.toLowerCase()
  const ordinal = Number(match[2])
  if (
    (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") ||
    !Number.isInteger(ordinal) ||
    ordinal < 1
  )
    return undefined
  return { raw: match[0], mediaKind, ordinal }
}

function parseSectionParts(
  value: string,
  references: readonly PromptReference[],
): PromptSectionPart[] {
  const parts: PromptSectionPart[] = []
  const pushText = (chunk: string): void => {
    if (!chunk) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += chunk
    else parts.push({ type: "text", text: chunk })
  }
  let plainStart = 0
  let cursor = 0
  while (cursor < value.length) {
    const dialogue = value.slice(cursor).match(/^<d>([\s\S]*?)<\/d>/iu)
    const tag = officialTagMatch(value, cursor)
    if (!dialogue && !tag) {
      cursor += 1
      continue
    }
    if (plainStart < cursor) pushText(value.slice(plainStart, cursor))
    if (dialogue) {
      parts.push({ type: "dialogue", text: dialogue[1] ?? "" })
      cursor += dialogue[0].length
    } else if (tag) {
      const reference = references.find(
        (candidate) => candidate.mediaKind === tag.mediaKind && candidate.ordinal === tag.ordinal,
      )
      if (reference) {
        parts.push({
          type: "mention",
          referenceId: reference.referenceId,
          mediaKind: reference.mediaKind,
          label: reference.label,
        })
      } else pushText(tag.raw)
      cursor += tag.raw.length
    }
    plainStart = cursor
  }
  if (plainStart < value.length) pushText(value.slice(plainStart))
  return mergeTextParts(parts)
}

export function parseRawPrompt(
  value: string,
  references: readonly PromptReference[],
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
      return
    }
    const section = { title, parts }
    sections.push(section)
    byTitle.set(title, section)
  }

  const prefix = text.slice(0, headers[0]?.index ?? 0).trim()
  if (prefix) addSection("scene", prefix)
  headers.forEach((header, index) => {
    const title = header[1] ?? "scene"
    const start = (header.index ?? 0) + header[0].length
    const end = headers[index + 1]?.index ?? text.length
    addSection(title, text.slice(start, end))
  })
  return { version: PROMPT_STATE_VERSION, view, sections }
}
