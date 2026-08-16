export const PROMPT_STATE_VERSION = 1 as const
export const MAX_PROMPT_STATE_CHARACTERS = 250_000
export const MAX_PROMPT_TEXT_CHARACTERS = 100_000

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

export type PromptPart = PromptTextPart | PromptDialoguePart | PromptMentionPart

export interface PromptDocument {
  version: typeof PROMPT_STATE_VERSION
  view: PromptViewMode
  parts: PromptPart[]
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
  return { version: PROMPT_STATE_VERSION, view: "structured", parts: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function mergeTextParts(parts: PromptPart[]): PromptPart[] {
  const merged: PromptPart[] = []
  for (const part of parts) {
    if (part.type === "text" && !part.text) continue
    const previous = merged.at(-1)
    if (part.type === "text" && previous?.type === "text") previous.text += part.text
    else merged.push(part)
  }
  return merged
}

export function validatePromptDocument(value: unknown): PromptValidationResult {
  if (!isRecord(value) || value.version !== PROMPT_STATE_VERSION || !Array.isArray(value.parts)) {
    return { document: createEmptyPromptDocument(), issues: ["Prompt state was invalid."] }
  }
  const issues: string[] = []
  const parts: PromptPart[] = []
  let textLength = 0
  for (const [index, rawPart] of value.parts.entries()) {
    if (!isRecord(rawPart)) {
      issues.push(`Prompt part ${index} was discarded.`)
      continue
    }
    if (rawPart.type === "text" || rawPart.type === "dialogue") {
      if (typeof rawPart.text !== "string") {
        issues.push(`Prompt part ${index} was discarded.`)
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
    if (
      rawPart.type === "mention" &&
      typeof rawPart.referenceId === "string" &&
      rawPart.referenceId.length > 0 &&
      rawPart.referenceId.length <= 160 &&
      !/\s/.test(rawPart.referenceId) &&
      (rawPart.mediaKind === "image" ||
        rawPart.mediaKind === "video" ||
        rawPart.mediaKind === "audio")
    ) {
      parts.push({
        type: "mention",
        referenceId: rawPart.referenceId,
        mediaKind: rawPart.mediaKind,
        label: typeof rawPart.label === "string" ? rawPart.label.slice(0, 255) : "",
      })
    } else {
      issues.push(`Prompt part ${index} was discarded.`)
    }
  }
  return {
    document: {
      version: PROMPT_STATE_VERSION,
      view: value.view === "raw" ? "raw" : "structured",
      parts: mergeTextParts(parts),
    },
    issues,
  }
}

export function serializePromptDocument(document: PromptDocument): string {
  return JSON.stringify(validatePromptDocument(document).document)
}

export function deserializePromptDocument(value: unknown): PromptValidationResult {
  if (typeof value !== "string" || value.trim() === "") return validatePromptDocument(value)
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
        parts: text ? [{ type: "text", text }] : [],
      },
      issues: [],
    }
  }
}

function mentionFallback(part: PromptMentionPart): string {
  return `@${part.label || part.referenceId}`
}

export function compilePromptDocument(
  document: PromptDocument,
  references: readonly PromptReference[],
): string {
  const active = new Map(
    references.map((reference) => [`${reference.mediaKind}:${reference.referenceId}`, reference]),
  )
  return document.parts
    .map((part) => {
      if (part.type === "text") return part.text
      if (part.type === "dialogue") return `<d>${part.text}</d>`
      return active.get(`${part.mediaKind}:${part.referenceId}`)?.tag ?? mentionFallback(part)
    })
    .join("")
}

function officialTagMatch(
  value: string,
  cursor: number,
): { raw: string; mediaKind: PromptMediaKind; ordinal: number } | undefined {
  const match = value.slice(cursor).match(/^<\s*(picture|video|audio)\s+(\d+)\s*>/i)
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

export function parseRawPrompt(
  value: string,
  references: readonly PromptReference[],
  view: PromptViewMode = "raw",
): PromptDocument {
  const text = value.slice(0, MAX_PROMPT_TEXT_CHARACTERS)
  const parts: PromptPart[] = []
  const pushText = (chunk: string): void => {
    if (!chunk) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += chunk
    else parts.push({ type: "text", text: chunk })
  }
  let plainStart = 0
  let cursor = 0
  while (cursor < text.length) {
    const dialogue = text.slice(cursor).match(/^<d>([\s\S]*?)<\/d>/i)
    const tag = officialTagMatch(text, cursor)
    if (!dialogue && !tag) {
      cursor += 1
      continue
    }
    if (plainStart < cursor) pushText(text.slice(plainStart, cursor))
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
      } else {
        pushText(tag.raw)
      }
      cursor += tag.raw.length
    }
    plainStart = cursor
  }
  if (plainStart < text.length) pushText(text.slice(plainStart))
  return { version: PROMPT_STATE_VERSION, view, parts }
}
