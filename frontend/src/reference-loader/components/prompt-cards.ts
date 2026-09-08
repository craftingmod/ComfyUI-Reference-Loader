import { PROMPT_MESSAGES, localize } from "../prompt-i18n.ts"
import type { PromptLocale, PromptPreset } from "../prompt-presets.ts"
import type {
  PromptDocument,
  PromptReference,
  PromptSectionPart,
  PromptSubject,
} from "../prompt-state.ts"
import {
  appendPromptText,
  createPromptTagVisuals,
  makeMentionChip,
  makeSubjectChip,
  referenceKey,
} from "./prompt-dom.ts"

// Body builders only read the supplied state and return detached DOM.
// React owns the surrounding cards and events; the controller owns document changes.
export interface PromptCardContext {
  readonly prompt: PromptDocument
  readonly references: readonly PromptReference[]
  readonly preset: PromptPreset
  readonly locale: PromptLocale
}

export function makePromptDefinitionBody(
  context: PromptCardContext,
  kind: "subject" | "shot",
  definition: PromptSubject | PromptDocument["shots"][number],
  disabled = false,
): HTMLElement {
  const definitionTag =
    definition.tag ??
    ("label" in definition ? definition.label : undefined) ??
    ("subjectId" in definition ? definition.subjectId : undefined) ??
    `${kind}_unknown`
  const body = document.createElement("div")
  body.className = "rl-prompt-definition__body"
  body.contentEditable = disabled ? "false" : "true"
  body.role = "textbox"
  body.ariaMultiLine = "true"
  body.dataset.promptDefinitionBody = ""
  body.dataset.promptDefinitionTag = definitionTag
  const references = new Map(
    context.references.map((reference) => [
      referenceKey(reference.mediaKind, reference.referenceId),
      reference,
    ]),
  )
  for (const part of definition.parts ?? []) {
    if (part.type === "text")
      appendPromptText(body, part.text, createPromptTagVisuals(context.prompt))
    else if (part.type === "mention")
      body.append(
        makeMentionChip(part, references.get(referenceKey(part.mediaKind, part.referenceId))),
      )
    else body.append(makeSubjectChip(part, undefined, undefined))
  }
  return body
}

export function makePromptSectionBody(
  context: PromptCardContext,
  section: { title: string; parts: readonly PromptSectionPart[] },
  references: ReadonlyMap<string, PromptReference>,
  subjects: ReadonlyMap<string, { subject: PromptSubject; ordinal: number }>,
): HTMLElement {
  const body = document.createElement("div")
  body.className = "rl-prompt-section__body"
  body.dataset.promptSectionBody = section.title
  body.contentEditable = "true"
  body.role = "textbox"
  body.ariaMultiLine = "true"
  body.spellcheck = true
  body.dataset.placeholder = localize(
    context.preset.subjectMode === "disabled"
      ? PROMPT_MESSAGES.bodyPlaceholder
      : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
    context.locale,
  )
  for (const part of section.parts) {
    if (part.type === "text")
      appendPromptText(body, part.text, createPromptTagVisuals(context.prompt))
    else if (part.type === "subject") {
      const resolved = subjects.get(part.subjectId)
      body.append(makeSubjectChip(part, resolved?.subject, resolved?.ordinal))
    } else
      body.append(
        makeMentionChip(part, references.get(referenceKey(part.mediaKind, part.referenceId))),
      )
  }
  return body
}
