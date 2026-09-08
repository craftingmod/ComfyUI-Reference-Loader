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
  sectionColor,
  subjectColor,
} from "./prompt-dom.ts"

// Card builders only read the supplied state and return detached DOM.
// The controller owns events, document changes and graph transactions.
export interface PromptCardContext {
  readonly prompt: PromptDocument
  readonly references: readonly PromptReference[]
  readonly preset: PromptPreset
  readonly locale: PromptLocale
}

export function makePromptDefinitions(
  context: PromptCardContext,
  draftDocument?: PromptDocument,
): HTMLElement {
  const section = document.createElement("section")
  section.className = "rl-prompt-definitions"
  section.dataset.promptDefinitions = ""
  const header = document.createElement("header")
  header.className = "rl-prompt-definitions__header"
  const title = document.createElement("strong")
  title.textContent = "Subjects & Shots"
  const detail = document.createElement("small")
  detail.textContent = "Definitions keep #tags; indexes are generated only in compiled output."
  header.append(title, detail)
  section.append(header)
  if (draftDocument) {
    const draft = document.createElement("div")
    draft.className = "rl-prompt-definitions__draft"
    draft.setAttribute("role", "status")
    draft.textContent = "Shot timing is unsaved. Apply or Cancel."
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.dataset.promptAction = "cancel-shot-draft"
    cancel.textContent = "Cancel"
    const apply = document.createElement("button")
    apply.type = "button"
    apply.dataset.promptAction = "apply-shot-draft"
    apply.textContent = "Apply"
    draft.append(cancel, apply)
    section.append(draft)
  }
  const documentForView = draftDocument ?? context.prompt
  const subjectHeading = document.createElement("div")
  subjectHeading.className = "rl-prompt-definitions__subheader"
  subjectHeading.innerHTML = "<strong>Subjects</strong>"
  const addSubject = document.createElement("button")
  addSubject.type = "button"
  addSubject.dataset.promptAction = "add-subject"
  addSubject.disabled = Boolean(draftDocument)
  addSubject.textContent = "+ Subject"
  subjectHeading.append(addSubject)
  section.append(subjectHeading)
  const subjectStack = document.createElement("div")
  subjectStack.className = "rl-prompt-definition-stack"
  documentForView.subjects.forEach((subject) =>
    subjectStack.append(makeDefinitionCard(context, draftDocument, "subject", subject)),
  )
  section.append(subjectStack)
  const shotHeading = document.createElement("div")
  shotHeading.className = "rl-prompt-definitions__subheader"
  shotHeading.innerHTML = `<strong>Shots <small>${documentForView.shots.length}</small></strong>`
  const addShot = document.createElement("button")
  addShot.type = "button"
  addShot.dataset.promptAction = "add-shot"
  addShot.disabled = Boolean(draftDocument)
  addShot.textContent = "+ Shot"
  shotHeading.append(addShot)
  section.append(shotHeading)
  const shotStack = document.createElement("div")
  shotStack.className = "rl-prompt-definition-stack"
  documentForView.shots.forEach((shot) =>
    shotStack.append(makeDefinitionCard(context, draftDocument, "shot", shot)),
  )
  section.append(shotStack)
  return section
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

function makeDefinitionCard(
  context: PromptCardContext,
  draftDocument: PromptDocument | undefined,
  kind: "subject" | "shot",
  definition: PromptDocument["subjects"][number] | PromptDocument["shots"][number],
): HTMLElement {
  const definitionTag =
    definition.tag ??
    ("label" in definition ? definition.label : undefined) ??
    ("subjectId" in definition ? definition.subjectId : undefined) ??
    `${kind}_unknown`
  const card = document.createElement("article")
  card.className = `rl-prompt-definition rl-prompt-definition--${kind}`
  card.dataset.promptDefinition = kind
  card.dataset.promptDefinitionTag = definitionTag
  if (kind === "subject") {
    const ordinal = context.prompt.subjects.findIndex(
      (subject) => (subject.tag ?? subject.label ?? subject.subjectId) === definitionTag,
    )
    const color = subjectColor(ordinal + 1)
    if (color) card.style.setProperty("--rl-prompt-subject-color", color)
  }
  const toolbar = document.createElement("div")
  toolbar.className = "rl-prompt-definition__toolbar"
  const identity = document.createElement("div")
  identity.className = "rl-prompt-definition__identity"
  const ordinal =
    (kind === "subject" ? context.prompt.subjects : context.prompt.shots).findIndex(
      (candidate) => candidate.tag === definitionTag,
    ) + 1
  const ordinalBadge = document.createElement("span")
  ordinalBadge.className = "rl-prompt-definition__ordinal"
  ordinalBadge.textContent = `${kind === "subject" ? "S" : "SH"}${Math.max(1, ordinal)}`
  ordinalBadge.setAttribute("aria-hidden", "true")
  identity.append(ordinalBadge)
  const tag = document.createElement("input")
  tag.type = "text"
  tag.className = "rl-prompt-definition__tag"
  tag.value = `#${definitionTag}`
  tag.size = Math.max(8, tag.value.length + 1)
  tag.dataset.promptDefinitionTagInput = ""
  tag.setAttribute("aria-label", `${kind} tag`)
  if (draftDocument) tag.disabled = true
  identity.append(tag)
  if (kind === "shot") {
    const shot = definition as PromptDocument["shots"][number]
    const frame = document.createElement("input")
    frame.type = "number"
    frame.className = "rl-prompt-definition__frame"
    frame.min = "0"
    frame.step = "1"
    frame.value = String(shot.frameIndex)
    frame.dataset.promptShotFrame = ""
    frame.setAttribute("aria-label", "Shot frame")
    identity.append(frame)
    const seconds = document.createElement("small")
    seconds.textContent = `${shot.frameIndex}f · ${(shot.frameIndex / 24).toFixed(3)}s`
    seconds.dataset.promptShotSeconds = ""
    identity.append(seconds)
  }
  if (draftDocument && kind === "shot") {
    const frame = toolbar.querySelector<HTMLInputElement>("[data-prompt-shot-frame]")
    if (frame) frame.disabled = true
  }
  const actions = document.createElement("div")
  actions.className = "rl-prompt-definition__actions"
  for (const [action, label] of [
    ["definition-up", "↑"],
    ["definition-down", "↓"],
    ["remove-definition", "×"],
  ] as const) {
    const button = document.createElement("button")
    button.type = "button"
    button.dataset.promptAction = action
    button.dataset.promptDefinitionTag = definitionTag
    button.dataset.promptDefinitionKind = kind
    button.disabled = Boolean(draftDocument)
    button.textContent = label
    button.title = action === "remove-definition" ? `Delete ${kind}` : "Reorder"
    actions.append(button)
  }
  toolbar.append(identity, actions)
  const body = makePromptDefinitionBody(context, kind, definition, Boolean(draftDocument))
  card.append(toolbar, body)
  return card
}

export function makePromptSectionCard(
  context: PromptCardContext,
  section: { title: string; parts: readonly PromptSectionPart[] },
  references: ReadonlyMap<string, PromptReference>,
  subjects: ReadonlyMap<string, { subject: PromptSubject; ordinal: number }>,
): HTMLElement {
  const card = document.createElement("section")
  card.className = "rl-prompt-section"
  card.dataset.promptSection = section.title
  const accent = sectionColor(section.title)
  card.dataset.promptSectionColorIndex = String(accent.index)
  card.style.setProperty("--rl-prompt-section-color", accent.color)
  const header = document.createElement("header")
  header.className = "rl-prompt-section__header"
  const title = document.createElement("code")
  title.textContent = `${section.title}:`
  const drag = document.createElement("button")
  drag.type = "button"
  drag.className = "rl-prompt-section__drag"
  drag.dataset.promptSectionDragHandle = section.title
  drag.draggable = true
  drag.title =
    context.locale === "ko" ? `${section.title} 섹션 순서 이동` : `Reorder ${section.title} section`
  drag.setAttribute(
    "aria-label",
    context.locale === "ko"
      ? `${section.title} 섹션 순서 이동. Alt와 위아래 화살표도 사용할 수 있습니다.`
      : `Reorder ${section.title} section. You can also use Alt plus Up or Down.`,
  )
  drag.textContent = "⠿"
  const remove = document.createElement("button")
  remove.type = "button"
  remove.dataset.promptAction = "remove-section"
  remove.dataset.promptSectionTitle = section.title
  remove.title = context.locale === "ko" ? `${section.title} 제거` : `Remove ${section.title}`
  remove.setAttribute(
    "aria-label",
    context.locale === "ko" ? `${section.title} 섹션 제거` : `Remove ${section.title} section`,
  )
  remove.textContent = "×"
  header.append(drag, title, remove)
  const body = makePromptSectionBody(context, section, references, subjects)
  card.append(header, body)
  return card
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
