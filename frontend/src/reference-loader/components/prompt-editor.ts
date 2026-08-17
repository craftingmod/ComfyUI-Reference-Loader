import type { ComfyNode } from "../../comfyui.ts"
import { PROMPT_MESSAGES, detectPromptLocale, localize } from "../prompt-i18n.ts"
import {
  normalizePromptPresetCatalog,
  resolvePromptPreset,
  type PromptAlias,
  type PromptLocale,
  type PromptPreset,
  type PromptPresetCatalog,
} from "../prompt-presets.ts"
import {
  compilePromptDocument,
  deserializePromptDocument,
  normalizePromptSectionTitle,
  parseRawPrompt,
  serializePromptDocument,
  type PromptDocument,
  type PromptMentionPart,
  type PromptReference,
  type PromptSectionPart,
  type PromptSubject,
  type PromptSubjectPart,
} from "../prompt-state.ts"

type ReferenceProvider = () => readonly PromptReference[]

export interface ReferencePromptControllerOptions {
  presetId?: unknown
  presetCatalog?: unknown
  locale?: PromptLocale
}

const SECTION_COLOR_PALETTE = [
  "#6ea8fe",
  "#8f9cf4",
  "#aa8ee8",
  "#c787d5",
  "#d482b2",
  "#dc927d",
  "#d8aa66",
  "#c5b96b",
  "#6ebfd3",
  "#64b4bc",
  "#7ba7d7",
  "#9b94c9",
] as const

const NATIVE_LINE_BLOCKS = new Set(["DIV", "P"])
const PROMPT_SECTION_DRAG_MIME = "application/x-reference-loader-prompt-section"

function sectionColor(title: string): { color: string; index: number } {
  let hash = 0x811c9dc5
  for (let index = 0; index < title.length; index += 1) {
    hash ^= title.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const index = (hash >>> 0) % SECTION_COLOR_PALETTE.length
  return { color: SECTION_COLOR_PALETTE[index], index }
}

function textContentWithBreaks(container: Node): string {
  let value = ""
  const appendStructuralBreak = (): void => {
    if (value && !value.endsWith("\n")) value += "\n"
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === "BR") {
      value += "\n"
      return
    }
    visitChildren(node)
  }
  const visitChildren = (parent: Node): void => {
    const children = Array.from(parent.childNodes)
    children.forEach((child, index) => {
      const block = child instanceof HTMLElement && NATIVE_LINE_BLOCKS.has(child.tagName)
      if (block) appendStructuralBreak()
      visit(child)
      if (block && index < children.length - 1) appendStructuralBreak()
    })
  }
  visitChildren(container)
  return value
}

function referenceKey(mediaKind: string, referenceId: string): string {
  return `${mediaKind}:${referenceId}`
}

function findOrderedReference(
  mediaKind: string,
  label: string,
  references: readonly PromptReference[],
): PromptReference | undefined {
  const match = /^(image|video|audio)([1-9]\d*)$/u.exec(label)
  if (match?.[1] !== mediaKind) return undefined
  const ordinal = Number(match[2])
  return references.find(
    (reference) => reference.mediaKind === mediaKind && reference.ordinal === ordinal,
  )
}

function makeReferenceVisual(reference?: PromptReference): HTMLElement {
  if (reference?.previewUrl && reference.mediaKind !== "audio") {
    const image = document.createElement("img")
    image.src = reference.previewUrl
    image.alt = ""
    image.draggable = false
    return image
  }
  const icon = document.createElement("span")
  icon.className = `rl-prompt-reference-icon is-${reference?.mediaKind ?? "missing"}`
  icon.textContent =
    reference?.mediaKind === "image" ? "I" : reference?.mediaKind === "video" ? "V" : "A"
  icon.setAttribute("aria-hidden", "true")
  return icon
}

function makeMentionChip(part: PromptMentionPart, reference?: PromptReference): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.className = `rl-prompt-mention${reference ? "" : " is-stale"}`
  chip.contentEditable = "false"
  chip.dataset.promptPart = "mention"
  chip.dataset.referenceId = part.referenceId
  chip.dataset.mediaKind = part.mediaKind
  chip.dataset.label = reference?.label ?? part.label
  chip.title = reference
    ? `${reference.tag} · ${reference.filename}`
    : `Unavailable ${part.mediaKind} reference: ${part.label || part.referenceId}`
  chip.append(makeReferenceVisual(reference))
  const label = document.createElement("span")
  label.className = "rl-prompt-mention__label"
  label.textContent = `@${reference?.label ?? (part.label || part.referenceId)}`
  chip.append(label)
  return chip
}

function makeSubjectChip(
  part: PromptSubjectPart,
  subject: PromptSubject | undefined,
  ordinal: number | undefined,
): HTMLSpanElement {
  const label = (subject?.label ?? part.label) || part.subjectId
  const chip = document.createElement("span")
  chip.className = `rl-prompt-mention rl-prompt-subject${subject ? "" : " is-stale"}`
  chip.contentEditable = "false"
  chip.dataset.promptPart = "subject"
  chip.dataset.subjectId = part.subjectId
  chip.dataset.label = label
  chip.title = subject ? `<Subject ${ordinal}> · #${label}` : `Unavailable subject: ${label}`
  const icon = document.createElement("span")
  icon.className = "rl-prompt-subject-icon"
  icon.textContent = ordinal === undefined ? "S?" : `S${ordinal}`
  icon.setAttribute("aria-hidden", "true")
  const copy = document.createElement("span")
  copy.className = "rl-prompt-mention__label"
  copy.textContent = `#${label}`
  chip.append(icon, copy)
  return chip
}

function normalizeSubjectLabel(value: string): string | undefined {
  const label = value.trim()
  return label.length > 0 && label.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(label)
    ? label
    : undefined
}

function createSubjectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `subject-${uuid}` : `subject-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function sectionPartsFromContainer(container: Node): PromptSectionPart[] {
  const parts: PromptSectionPart[] = []
  const pushText = (value: string): void => {
    if (!value) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += value
    else parts.push({ type: "text", text: value })
  }
  const pushStructuralBreak = (): void => {
    if (parts.length === 0) return
    const previous = parts.at(-1)
    if (previous?.type !== "text" || !previous.text.endsWith("\n")) pushText("\n")
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "")
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.promptPart === "mention") {
      const mediaKind = node.dataset.mediaKind
      parts.push({
        type: "mention",
        referenceId: node.dataset.referenceId ?? "missing",
        mediaKind: mediaKind === "video" || mediaKind === "audio" ? mediaKind : "image",
        label: node.dataset.label ?? "reference",
      })
      return
    }
    if (node.dataset.promptPart === "subject") {
      parts.push({
        type: "subject",
        subjectId: node.dataset.subjectId ?? "missing",
        label: node.dataset.label ?? "subject",
      })
      return
    }
    if (node.tagName === "BR") {
      pushText("\n")
      return
    }
    visitChildren(node)
  }
  const visitChildren = (parent: Node): void => {
    const children = Array.from(parent.childNodes)
    children.forEach((child, index) => {
      const block = child instanceof HTMLElement && NATIVE_LINE_BLOCKS.has(child.tagName)
      if (block) pushStructuralBreak()
      visit(child)
      if (block && index < children.length - 1) pushStructuralBreak()
    })
  }
  visitChildren(container)
  return parts
}

function closestSectionBody(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const body = element?.closest<HTMLElement>("[data-prompt-section-body]")
  return body && root.contains(body) ? body : undefined
}

function placeCaretAtEnd(element: HTMLElement): void {
  element.focus()
  const selection = globalThis.getSelection?.()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export class ReferencePromptController {
  readonly root: HTMLElement
  #node: ComfyNode
  #references: ReferenceProvider
  #document: PromptDocument
  #destroyController = new AbortController()
  #pickerRange: Range | undefined
  #pickerMode: "reference" | "subject" | "alias" | undefined
  #pickerReferences: PromptReference[] = []
  #pickerSubjects: PromptSubject[] = []
  #pickerCreateSubject: string | undefined
  #pickerAliases: PromptAlias[] = []
  #pickerIndex = 0
  #pickerAnchor: HTMLElement | undefined
  #draggedSectionTitle: string | undefined
  #sectionDropTarget: HTMLElement | undefined
  #dropAfter = false
  #presetCatalog: PromptPresetCatalog
  #preset: PromptPreset
  #locale: PromptLocale
  #recoveredFromVersion: number | undefined
  #composing = false
  #destroyed = false

  constructor(
    root: HTMLElement,
    node: ComfyNode,
    references: ReferenceProvider,
    serialized: unknown,
    options: ReferencePromptControllerOptions = {},
  ) {
    this.root = root
    this.#node = node
    this.#references = references
    this.#presetCatalog = normalizePromptPresetCatalog(options.presetCatalog)
    this.#preset = resolvePromptPreset(options.presetId, this.#presetCatalog)
    this.#locale = options.locale ?? detectPromptLocale()
    const parsed = deserializePromptDocument(serialized)
    this.#document = parsed.document
    this.#document.subjects = this.#orderedSubjects(this.#document.sections)
    this.#recoveredFromVersion = parsed.recoveredFromVersion
    this.#mount(parsed.issues.join(" "))
  }

  get presetId(): string {
    return this.#preset.id
  }

  get document(): PromptDocument {
    this.#syncDocumentFromEditor()
    return this.#document
  }

  get compiledPrompt(): string {
    this.#syncDocumentFromEditor()
    return compilePromptDocument(this.#document, this.#references())
  }

  serialize(): string {
    this.#syncDocumentFromEditor()
    return serializePromptDocument(this.#document)
  }

  restore(serialized: unknown): void {
    if (this.#destroyed) return
    const parsed = deserializePromptDocument(serialized)
    this.#document = parsed.document
    this.#document.subjects = this.#orderedSubjects(this.#document.sections)
    this.#recoveredFromVersion = parsed.recoveredFromVersion
    this.#closePicker()
    this.#renderEditor()
    this.#setHint(parsed.issues.join(" "))
  }

  setPreset(value: unknown): void {
    if (this.#destroyed) return
    const preset = resolvePromptPreset(value, this.#presetCatalog)
    if (preset.id === this.#preset.id) return
    this.#syncDocumentFromEditor()
    this.#preset = preset
    this.#closePicker()
    this.#renderEditor()
  }

  refreshReferences(bindByOrder = false): void {
    if (this.#destroyed) return
    const currentReferences = this.#references()
    if (bindByOrder) {
      this.#document = {
        ...this.#document,
        sections: this.#document.sections.map((section) => ({
          ...section,
          parts: section.parts.map((part) => {
            if (part.type !== "mention") return part
            const reference = findOrderedReference(part.mediaKind, part.label, currentReferences)
            return reference
              ? {
                  ...part,
                  referenceId: reference.referenceId,
                  label: reference.label,
                }
              : part
          }),
        })),
      }
    }
    const raw = this.root.querySelector<HTMLElement>("[data-prompt-editor]")
    if (this.#document.view === "raw") {
      if (raw && document.activeElement !== raw)
        raw.textContent = compilePromptDocument(this.#document, currentReferences)
      return
    }
    const references = new Map(
      currentReferences.map((reference) => [
        referenceKey(reference.mediaKind, reference.referenceId),
        reference,
      ]),
    )
    for (const chip of this.root.querySelectorAll<HTMLElement>('[data-prompt-part="mention"]')) {
      const mediaKind = chip.dataset.mediaKind ?? ""
      const referenceId = chip.dataset.referenceId ?? ""
      const label = chip.dataset.label ?? referenceId
      const orderedReference = bindByOrder
        ? findOrderedReference(mediaKind, label, currentReferences)
        : undefined
      const reference = orderedReference ?? references.get(referenceKey(mediaKind, referenceId))
      chip.replaceWith(
        makeMentionChip(
          {
            type: "mention",
            referenceId: reference?.referenceId ?? referenceId,
            mediaKind: mediaKind === "video" || mediaKind === "audio" ? mediaKind : "image",
            label: reference?.label ?? label,
          },
          reference,
        ),
      )
    }
    if (this.#pickerMode === "reference") this.#updateReferencePicker()
    this.#setHint()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#destroyController.abort()
    this.#closePicker()
    this.root.replaceChildren()
  }

  get #picker(): HTMLElement {
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (!picker) throw new Error("Reference Prompt picker is not mounted.")
    return picker
  }

  get #entry(): HTMLElement | undefined {
    return this.root.querySelector<HTMLElement>("[data-prompt-section-entry]") ?? undefined
  }

  #mount(issue: string): void {
    this.root.innerHTML = `
      <section class="rl-prompt-panel" data-prompt-panel>
        <header class="rl-prompt-toolbar">
          <div class="rl-prompt-toolbar__copy">
            <span class="rl-prompt-toolbar__title">
              <strong data-prompt-title></strong>
              <span class="rl-prompt-preset" data-prompt-preset></span>
            </span>
            <small data-prompt-subtitle></small>
          </div>
          <div class="rl-prompt-toolbar__actions"><button type="button" data-prompt-action="copy"></button><button type="button" class="rl-clear" data-prompt-action="clear"></button><button type="button" data-prompt-action="toggle-view"></button></div>
        </header>
        <div data-prompt-workspace></div>
        <div class="rl-prompt-picker" data-prompt-picker role="listbox" hidden></div>
        <p class="rl-prompt-hint" data-prompt-hint></p>
      </section>`
    this.#installEvents()
    this.#renderEditor()
    this.#setHint(issue)
  }

  #installEvents(): void {
    const signal = this.#destroyController.signal
    this.root.addEventListener("input", (event) => this.#onInput(event), { signal })
    this.root.addEventListener("paste", (event) => event.stopPropagation(), { signal })
    this.root.addEventListener("keydown", (event) => this.#onKeydown(event), {
      capture: true,
      signal,
    })
    this.root.addEventListener("click", (event) => this.#onClick(event), { signal })
    this.root.addEventListener("dragstart", (event) => this.#onSectionDragStart(event), { signal })
    this.root.addEventListener("dragover", (event) => this.#onSectionDragOver(event), { signal })
    this.root.addEventListener("drop", (event) => this.#onSectionDrop(event), { signal })
    this.root.addEventListener(
      "dragend",
      () => {
        this.#clearSectionDrag()
      },
      { signal },
    )
    this.root.addEventListener("compositionstart", () => (this.#composing = true), { signal })
    this.root.addEventListener(
      "compositionend",
      () => {
        this.#composing = false
        this.#syncDocumentFromEditor()
        this.#updatePickerQuery()
      },
      { signal },
    )
    this.#picker.addEventListener("pointerdown", (event) => event.preventDefault(), { signal })
    document.addEventListener("wheel", (event) => this.#onPickerWheel(event), {
      capture: true,
      passive: false,
      signal,
    })
    this.root.addEventListener(
      "focusout",
      () => {
        globalThis.setTimeout(() => {
          if (!this.root.contains(document.activeElement)) this.#closePicker()
        }, 0)
      },
      { signal },
    )
  }

  #setHint(issue = ""): void {
    const hint = this.root.querySelector<HTMLElement>("[data-prompt-hint]")
    if (!hint) return
    const stale = this.root.querySelectorAll(".rl-prompt-mention.is-stale").length
    const recovery = this.#recoveredFromVersion
      ? localize(PROMPT_MESSAGES.legacyRecovered, this.#locale).replace(
          "{version}",
          String(this.#recoveredFromVersion),
        )
      : ""
    hint.textContent = issue || recovery || (stale ? `${stale} unavailable reference mention.` : "")
    hint.hidden = !hint.textContent
  }

  #renderEditor(): void {
    const panel = this.root.querySelector<HTMLElement>("[data-prompt-panel]")
    panel?.setAttribute("aria-label", localize(PROMPT_MESSAGES.editorAria, this.#locale))
    const title = this.root.querySelector<HTMLElement>("[data-prompt-title]")
    if (title) title.textContent = localize(PROMPT_MESSAGES.prompt, this.#locale)
    const subtitle = this.root.querySelector<HTMLElement>("[data-prompt-subtitle]")
    if (subtitle)
      subtitle.textContent = localize(
        this.#preset.subjectMode === "disabled"
          ? PROMPT_MESSAGES.subtitle
          : PROMPT_MESSAGES.subtitleWithSubjects,
        this.#locale,
      )
    const preset = this.root.querySelector<HTMLElement>("[data-prompt-preset]")
    if (preset) {
      const presetLabel = localize(this.#preset.label, this.#locale)
      preset.textContent = presetLabel
      preset.title = `${localize(PROMPT_MESSAGES.preset, this.#locale)}: ${presetLabel} · ${localize(this.#preset.description, this.#locale)}`
    }
    const workspace = this.root.querySelector<HTMLElement>("[data-prompt-workspace]")
    if (!workspace) return
    workspace.replaceChildren()
    if (this.#document.view === "raw") {
      const editor = document.createElement("div")
      editor.className = "rl-prompt-editor is-raw"
      editor.dataset.promptEditor = ""
      editor.contentEditable = "true"
      editor.role = "textbox"
      editor.ariaMultiLine = "true"
      editor.spellcheck = false
      editor.dataset.placeholder = localize(PROMPT_MESSAGES.rawPlaceholder, this.#locale)
      editor.textContent = compilePromptDocument(this.#document, this.#references())
      workspace.append(editor)
    } else {
      const stack = document.createElement("div")
      stack.className = "rl-prompt-stack"
      stack.dataset.promptStack = ""
      const sections =
        this.#document.sections.length > 0
          ? this.#document.sections
          : [{ title: this.#preset.defaultSectionTitle, parts: [] as PromptSectionPart[] }]
      const references = new Map(
        this.#references().map((reference) => [
          referenceKey(reference.mediaKind, reference.referenceId),
          reference,
        ]),
      )
      const subjects = new Map(
        this.#document.subjects.map((subject, index) => [
          subject.subjectId,
          { subject, ordinal: index + 1 },
        ]),
      )
      for (const section of sections)
        stack.append(this.#makeSectionCard(section, references, subjects))
      const entry = document.createElement("div")
      entry.className = "rl-prompt-section-entry"
      entry.dataset.promptSectionEntry = ""
      entry.contentEditable = "true"
      entry.role = "textbox"
      entry.spellcheck = false
      entry.dataset.placeholder = localize(PROMPT_MESSAGES.addSectionPlaceholder, this.#locale)
      entry.setAttribute("aria-label", localize(PROMPT_MESSAGES.addSectionAria, this.#locale))
      stack.append(entry)
      workspace.append(stack)
    }
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')
    if (button) {
      const raw = this.#document.view === "raw"
      button.textContent = localize(
        raw ? PROMPT_MESSAGES.structured : PROMPT_MESSAGES.raw,
        this.#locale,
      )
      button.title = localize(
        raw ? PROMPT_MESSAGES.backToStructured : PROMPT_MESSAGES.showRaw,
        this.#locale,
      )
      button.setAttribute("aria-label", localize(PROMPT_MESSAGES.toggleAria, this.#locale))
      button.setAttribute("aria-pressed", String(raw))
    }
    this.#syncClearButton()
    this.#syncCopyButton()
    this.#setHint()
  }

  #syncClearButton(): void {
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')
    if (!button) return
    button.textContent = localize(PROMPT_MESSAGES.clear, this.#locale)
    button.title = localize(PROMPT_MESSAGES.clearTitle, this.#locale)
    button.setAttribute("aria-label", localize(PROMPT_MESSAGES.clearAria, this.#locale))
    button.disabled = this.#document.sections.length === 0
  }

  #syncCopyButton(): void {
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="copy"]')
    if (!button) return
    button.textContent = localize(PROMPT_MESSAGES.copy, this.#locale)
    button.title = localize(PROMPT_MESSAGES.copyTitle, this.#locale)
    button.setAttribute("aria-label", localize(PROMPT_MESSAGES.copyAria, this.#locale))
    button.disabled = compilePromptDocument(this.#document, this.#references()).length === 0
  }

  #makeSectionCard(
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
      this.#locale === "ko" ? `${section.title} 섹션 순서 이동` : `Reorder ${section.title} section`
    drag.setAttribute(
      "aria-label",
      this.#locale === "ko"
        ? `${section.title} 섹션 순서 이동. Alt와 위아래 화살표도 사용할 수 있습니다.`
        : `Reorder ${section.title} section. You can also use Alt plus Up or Down.`,
    )
    drag.textContent = "⠿"
    const remove = document.createElement("button")
    remove.type = "button"
    remove.dataset.promptAction = "remove-section"
    remove.dataset.promptSectionTitle = section.title
    remove.title = this.#locale === "ko" ? `${section.title} 제거` : `Remove ${section.title}`
    remove.setAttribute(
      "aria-label",
      this.#locale === "ko" ? `${section.title} 섹션 제거` : `Remove ${section.title} section`,
    )
    remove.textContent = "×"
    header.append(drag, title, remove)
    const body = document.createElement("div")
    body.className = "rl-prompt-section__body"
    body.dataset.promptSectionBody = section.title
    body.contentEditable = "true"
    body.role = "textbox"
    body.ariaMultiLine = "true"
    body.spellcheck = true
    body.dataset.placeholder = localize(
      this.#preset.subjectMode === "disabled"
        ? PROMPT_MESSAGES.bodyPlaceholder
        : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
      this.#locale,
    )
    for (const part of section.parts) {
      if (part.type === "text") body.append(document.createTextNode(part.text))
      else if (part.type === "subject") {
        const resolved = subjects.get(part.subjectId)
        body.append(makeSubjectChip(part, resolved?.subject, resolved?.ordinal))
      } else
        body.append(
          makeMentionChip(part, references.get(referenceKey(part.mediaKind, part.referenceId))),
        )
    }
    card.append(header, body)
    return card
  }

  #syncDocumentFromEditor(): void {
    if (this.#destroyed) return
    if (this.#document.view === "raw") {
      const editor = this.root.querySelector<HTMLElement>("[data-prompt-editor]")
      if (editor) {
        const parsed = parseRawPrompt(
          textContentWithBreaks(editor),
          this.#references(),
          "raw",
          this.#document.subjects,
        )
        parsed.subjects = this.#orderedSubjects(parsed.sections, parsed.subjects)
        this.#document = parsed
      }
      return
    }
    const sections = Array.from(
      this.root.querySelectorAll<HTMLElement>("[data-prompt-section-body]"),
    ).flatMap((body) => {
      const title = normalizePromptSectionTitle(body.dataset.promptSectionBody ?? "")
      if (!title) return []
      const parts = sectionPartsFromContainer(body)
      const hasContent = parts.some((part) => part.type !== "text" || part.text.trim() !== "")
      if (!hasContent && this.#document.sections.length === 0) return []
      return [{ title, parts }]
    })
    this.#document = {
      ...this.#document,
      subjects: this.#orderedSubjects(sections),
      sections,
    }
  }

  #orderedSubjects(
    sections: readonly { title: string; parts: readonly PromptSectionPart[] }[],
    subjects: readonly PromptSubject[] = this.#document.subjects,
  ): PromptSubject[] {
    const sourceSections =
      this.#preset.subjectMode === "definitions"
        ? sections.filter((section) => section.title === "subject_definitions")
        : sections
    const liveIds = new Set<string>()
    for (const section of sourceSections) {
      for (const part of section.parts) {
        if (part.type === "subject") liveIds.add(part.subjectId)
      }
    }
    return subjects.filter((subject) => liveIds.has(subject.subjectId))
  }

  #onInput(event: Event): void {
    if (!(event.target instanceof Node) || !this.root.contains(event.target)) return
    if (this.#composing) return
    this.#syncDocumentFromEditor()
    this.#syncClearButton()
    this.#syncCopyButton()
    if (this.#document.view === "structured") this.#updatePickerQuery()
    this.#node.setDirtyCanvas(true, true)
  }

  #onClick(event: MouseEvent): void {
    const target = event.target as Element
    if (target.closest<HTMLButtonElement>('[data-prompt-action="copy"]')) {
      void this.#copyPrompt()
      return
    }
    const clear = target.closest<HTMLButtonElement>('[data-prompt-action="clear"]')
    if (clear) {
      this.#clearPrompt()
      return
    }
    const toggle = target.closest<HTMLButtonElement>('[data-prompt-action="toggle-view"]')
    if (toggle) {
      this.#toggleView()
      return
    }
    const remove = target.closest<HTMLButtonElement>('[data-prompt-action="remove-section"]')
    if (remove) {
      this.#removeSection(remove.dataset.promptSectionTitle ?? "")
      return
    }
    const reference = target.closest<HTMLButtonElement>("[data-prompt-reference-index]")
    if (reference) {
      const index = Number(reference.dataset.promptReferenceIndex)
      if (Number.isInteger(index)) this.#insertMention(this.#pickerReferences[index])
      return
    }
    const subject = target.closest<HTMLButtonElement>("[data-prompt-subject-index]")
    if (subject) {
      const index = Number(subject.dataset.promptSubjectIndex)
      if (Number.isInteger(index)) this.#insertSubject(this.#pickerSubjects[index])
      return
    }
    if (target.closest<HTMLButtonElement>("[data-prompt-subject-create]")) {
      this.#createAndInsertSubject(this.#pickerCreateSubject)
      return
    }
    const alias = target.closest<HTMLButtonElement>("[data-prompt-alias-index]")
    if (alias) {
      const index = Number(alias.dataset.promptAliasIndex)
      if (Number.isInteger(index)) this.#insertAlias(this.#pickerAliases[index])
    }
  }

  #onKeydown(event: KeyboardEvent): void {
    if (!(event.target instanceof Node) || !this.root.contains(event.target)) return
    const dragHandle =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-section-drag-handle]")
        : undefined
    if (
      dragHandle?.dataset.promptSectionDragHandle &&
      event.altKey &&
      (event.key === "ArrowUp" || event.key === "ArrowDown")
    ) {
      event.preventDefault()
      this.#moveSection(
        dragHandle.dataset.promptSectionDragHandle,
        event.key === "ArrowUp" ? -1 : 1,
      )
      return
    }
    if (!this.#picker.hidden) {
      const count = this.#pickerOptionCount()
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        this.#pickerIndex = (this.#pickerIndex + delta + count) % Math.max(1, count)
        this.#updatePickerSelection()
        return
      }
      if (
        event.key === "Enter" &&
        count > 0 &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault()
        this.#activatePickerOption()
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        this.#closePicker()
        return
      }
    }
    if (this.#document.view !== "structured") return
    const entry = this.#entry
    if (entry?.contains(event.target)) {
      if (event.key === "Enter") {
        event.preventDefault()
        this.#createSectionFromEntry()
      }
      return
    }
  }

  #toggleView(): void {
    this.#syncDocumentFromEditor()
    this.#recoveredFromVersion = undefined
    this.#document = {
      ...this.#document,
      view: this.#document.view === "raw" ? "structured" : "raw",
    }
    this.#closePicker()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #clearPrompt(): void {
    this.#syncDocumentFromEditor()
    if (this.#document.sections.length === 0 && this.#document.subjects.length === 0) return
    this.#document = { ...this.#document, subjects: [], sections: [] }
    this.#closePicker()
    this.#renderEditor()
    this.#setHint(localize(PROMPT_MESSAGES.cleared, this.#locale))
    this.#node.setDirtyCanvas(true, true)
  }

  async #copyPrompt(): Promise<void> {
    this.#syncDocumentFromEditor()
    const prompt = compilePromptDocument(this.#document, this.#references())
    this.#syncCopyButton()
    if (!prompt) return
    try {
      const writeText = globalThis.navigator?.clipboard?.writeText
      if (!writeText) throw new Error("Clipboard API is unavailable.")
      await writeText.call(globalThis.navigator.clipboard, prompt)
      if (!this.#destroyed) this.#setHint(localize(PROMPT_MESSAGES.copied, this.#locale))
    } catch {
      if (!this.#destroyed) this.#setHint(localize(PROMPT_MESSAGES.copyFailed, this.#locale))
    }
  }

  #createSectionFromEntry(): void {
    const entry = this.#entry
    if (!entry) return
    const value = textContentWithBreaks(entry).trim()
    const alias = value.match(/^\/([a-z]+)$/iu)?.[1]?.toLocaleLowerCase()
    const aliasTitle = this.#preset.aliases.find((option) => option.command === alias)?.title
    const title =
      aliasTitle ?? (value.endsWith(":") ? normalizePromptSectionTitle(value) : undefined)
    if (!title) {
      this.#setHint(localize(PROMPT_MESSAGES.invalidTitle, this.#locale))
      return
    }
    this.#addOrFocusSection(title)
  }

  #addOrFocusSection(title: string): void {
    this.#syncDocumentFromEditor()
    const existing = this.root.querySelector<HTMLElement>(
      `[data-prompt-section-body="${CSS.escape(title)}"]`,
    )
    if (existing) {
      if (this.#entry) this.#entry.textContent = ""
      this.#closePicker()
      placeCaretAtEnd(existing)
      return
    }
    this.#document.sections.push({ title, parts: [] })
    this.#closePicker()
    this.#renderEditor()
    const body = this.root.querySelector<HTMLElement>(
      `[data-prompt-section-body="${CSS.escape(title)}"]`,
    )
    if (body) placeCaretAtEnd(body)
    this.#node.setDirtyCanvas(true, true)
  }

  #removeSection(title: string): void {
    this.#syncDocumentFromEditor()
    const sections = this.#document.sections.filter((section) => section.title !== title)
    this.#document = {
      ...this.#document,
      subjects: this.#orderedSubjects(sections),
      sections,
    }
    this.#closePicker()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #moveSection(title: string, delta: -1 | 1): void {
    this.#syncDocumentFromEditor()
    const sourceIndex = this.#document.sections.findIndex((section) => section.title === title)
    const targetIndex = Math.max(
      0,
      Math.min(this.#document.sections.length - 1, sourceIndex + delta),
    )
    if (sourceIndex < 0 || sourceIndex === targetIndex) return
    this.#recordGraphChange(() => {
      const sections = [...this.#document.sections]
      const [section] = sections.splice(sourceIndex, 1)
      if (!section) return
      sections.splice(targetIndex, 0, section)
      this.#document = { ...this.#document, sections }
      this.#closePicker()
      this.#renderEditor()
      this.#node.setDirtyCanvas(true, true)
      this.root
        .querySelector<HTMLElement>(`[data-prompt-section-drag-handle="${CSS.escape(title)}"]`)
        ?.focus()
    })
  }

  #onSectionDragStart(event: DragEvent): void {
    const handle = (event.target as Element).closest<HTMLElement>(
      "[data-prompt-section-drag-handle]",
    )
    const title = handle?.dataset.promptSectionDragHandle
    if (!title || this.#document.view !== "structured") {
      event.preventDefault()
      return
    }
    this.#syncDocumentFromEditor()
    this.#draggedSectionTitle = title
    event.dataTransfer?.setData(PROMPT_SECTION_DRAG_MIME, title)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    handle.closest<HTMLElement>("[data-prompt-section]")?.classList.add("is-dragging")
    event.stopPropagation()
  }

  #onSectionDragOver(event: DragEvent): void {
    if (!this.#draggedSectionTitle) return
    const target = (event.target as Element).closest<HTMLElement>("[data-prompt-section]")
    if (!target || target.dataset.promptSection === this.#draggedSectionTitle) {
      this.#setSectionDropTarget(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const bounds = target.getBoundingClientRect()
    this.#setSectionDropTarget(target, event.clientY >= bounds.top + bounds.height / 2)
  }

  #onSectionDrop(event: DragEvent): void {
    const sourceTitle = this.#draggedSectionTitle
    const targetTitle = this.#sectionDropTarget?.dataset.promptSection
    const after = this.#dropAfter
    if (!sourceTitle || !targetTitle || sourceTitle === targetTitle) {
      this.#clearSectionDrag()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    this.#syncDocumentFromEditor()
    const sourceIndex = this.#document.sections.findIndex(
      (section) => section.title === sourceTitle,
    )
    const targetIndex = this.#document.sections.findIndex(
      (section) => section.title === targetTitle,
    )
    if (sourceIndex < 0 || targetIndex < 0) {
      this.#clearSectionDrag()
      return
    }
    this.#recordGraphChange(() => {
      const sections = [...this.#document.sections]
      const [section] = sections.splice(sourceIndex, 1)
      if (!section) return
      const adjustedTargetIndex = sections.findIndex((candidate) => candidate.title === targetTitle)
      sections.splice(adjustedTargetIndex + (after ? 1 : 0), 0, section)
      this.#document = { ...this.#document, sections }
      this.#closePicker()
      this.#renderEditor()
      this.#node.setDirtyCanvas(true, true)
    })
    this.#clearSectionDrag()
  }

  #setSectionDropTarget(target: HTMLElement | undefined, after = false): void {
    if (this.#sectionDropTarget === target && this.#dropAfter === after) return
    this.#sectionDropTarget?.classList.remove("is-drop-before", "is-drop-after")
    this.#sectionDropTarget = target
    this.#dropAfter = after
    target?.classList.add(after ? "is-drop-after" : "is-drop-before")
  }

  #clearSectionDrag(): void {
    this.#setSectionDropTarget(undefined)
    this.root
      .querySelectorAll<HTMLElement>("[data-prompt-section].is-dragging")
      .forEach((section) => section.classList.remove("is-dragging"))
    this.#draggedSectionTitle = undefined
  }

  #recordGraphChange(change: () => void): void {
    const graph = this.#node.graph
    graph?.beforeChange?.()
    try {
      change()
    } finally {
      graph?.afterChange?.()
    }
  }

  #updatePickerQuery(): void {
    const entry = this.#entry
    if (entry && document.activeElement === entry) {
      const match = textContentWithBreaks(entry)
        .trim()
        .match(/^\/([a-z]*)$/iu)
      if (match) {
        this.#pickerAnchor = entry
        this.#updateAliasPicker(match[1] ?? "")
      } else this.#closePicker()
      return
    }
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount || !selection.isCollapsed) {
      this.#closePicker()
      return
    }
    const caret = selection.getRangeAt(0)
    const container = caret.startContainer
    const body = closestSectionBody(this.root, container)
    if (container.nodeType !== Node.TEXT_NODE || !body) {
      this.#closePicker()
      return
    }
    const before = (container.textContent ?? "").slice(0, caret.startOffset)
    const referenceMatch = before.match(/@([^\s@]*)$/u)
    const subjectMatch =
      this.#preset.subjectMode === "disabled" ? undefined : before.match(/#([^\s#]*)$/u)
    const match = referenceMatch ?? subjectMatch
    if (!match) return this.#closePicker()
    const range = document.createRange()
    range.setStart(container, caret.startOffset - (match[0]?.length ?? 0))
    range.setEnd(container, caret.startOffset)
    this.#pickerRange = range
    this.#pickerAnchor = body.closest<HTMLElement>("[data-prompt-section]") ?? body
    if (referenceMatch) this.#updateReferencePicker(match[1] ?? "")
    else this.#updateSubjectPicker(subjectMatch?.[1] ?? "", body)
  }

  #updateReferencePicker(query = ""): void {
    this.#pickerMode = "reference"
    this.#pickerSubjects = []
    this.#pickerCreateSubject = undefined
    this.#pickerAliases = []
    const normalized = query.trim().toLowerCase()
    this.#pickerReferences = this.#references().filter((reference) =>
      [reference.label, reference.filename, reference.tag, reference.mediaKind].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerReferences.length - 1))
    this.#renderPicker()
  }

  #updateSubjectPicker(query: string, body: HTMLElement | undefined): void {
    this.#pickerMode = "subject"
    this.#pickerReferences = []
    this.#pickerAliases = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerSubjects = this.#document.subjects.filter((subject, index) =>
      [subject.label, `subject${index + 1}`, `<Subject ${index + 1}>`].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    const label = normalizeSubjectLabel(query)
    const creationAllowed =
      this.#preset.subjectMode === "anywhere" ||
      (this.#preset.subjectMode === "definitions" &&
        body?.dataset.promptSectionBody === "subject_definitions")
    this.#pickerCreateSubject =
      creationAllowed &&
      label &&
      !this.#document.subjects.some(
        (subject) => subject.label.toLowerCase() === label.toLowerCase(),
      )
        ? label
        : undefined
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerOptionCount() - 1))
    this.#renderPicker()
  }

  #updateAliasPicker(query = ""): void {
    this.#pickerMode = "alias"
    this.#pickerRange = undefined
    this.#pickerReferences = []
    this.#pickerSubjects = []
    this.#pickerCreateSubject = undefined
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerAliases = this.#preset.aliases.filter((option) =>
      [
        option.command,
        option.title,
        localize(option.label, this.#locale),
        localize(option.description, this.#locale),
      ].some((value) => value.toLocaleLowerCase().includes(normalized)),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerAliases.length - 1))
    this.#renderPicker()
  }

  #renderPicker(): void {
    const picker = this.#picker
    picker.replaceChildren()
    picker.hidden = false
    this.#placePicker()
    if (this.#pickerOptionCount() === 0) {
      const empty = document.createElement("p")
      empty.textContent =
        this.#pickerMode === "alias"
          ? localize(PROMPT_MESSAGES.noAliases, this.#locale)
          : this.#pickerMode === "subject"
            ? localize(PROMPT_MESSAGES.noSubjects, this.#locale)
            : localize(PROMPT_MESSAGES.noReferences, this.#locale)
      picker.append(empty)
      return
    }
    if (this.#pickerMode === "alias") {
      this.#pickerAliases.forEach((option, index) => {
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptAliasIndex = String(index)
        button.classList.toggle("is-active", index === this.#pickerIndex)
        const icon = document.createElement("span")
        icon.className = `rl-prompt-directive-icon is-${option.command}`
        icon.textContent = option.icon
        icon.style.background = sectionColor(option.title).color
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `/${option.command} → ${option.title}:`
        const detail = document.createElement("small")
        detail.textContent = `${localize(option.label, this.#locale)} · ${localize(option.description, this.#locale)}`
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
    } else if (this.#pickerMode === "subject") {
      this.#pickerSubjects.forEach((subject, index) => {
        const ordinal = this.#document.subjects.findIndex(
          (candidate) => candidate.subjectId === subject.subjectId,
        )
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptSubjectIndex = String(index)
        button.classList.toggle("is-active", index === this.#pickerIndex)
        const icon = document.createElement("span")
        icon.className = "rl-prompt-subject-icon"
        icon.textContent = `S${ordinal + 1}`
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `#${subject.label}`
        const detail = document.createElement("small")
        detail.textContent = `<Subject ${ordinal + 1}>`
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
      if (this.#pickerCreateSubject) {
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptSubjectCreate = ""
        button.classList.toggle("is-active", this.#pickerIndex === this.#pickerSubjects.length)
        const icon = document.createElement("span")
        icon.className = "rl-prompt-subject-icon is-create"
        icon.textContent = "+S"
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = localize(PROMPT_MESSAGES.createSubject, this.#locale).replace(
          "{label}",
          this.#pickerCreateSubject,
        )
        const detail = document.createElement("small")
        detail.textContent = localize(PROMPT_MESSAGES.createSubjectDetail, this.#locale)
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      }
    } else {
      this.#pickerReferences.forEach((reference, index) => {
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptReferenceIndex = String(index)
        button.classList.toggle("is-active", index === this.#pickerIndex)
        button.append(makeReferenceVisual(reference))
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `@${reference.label}`
        const detail = document.createElement("small")
        detail.textContent = `${reference.tag} · ${reference.filename}`
        copy.append(label, detail)
        button.append(copy)
        picker.append(button)
      })
    }
    this.#updatePickerSelection()
  }

  #updatePickerSelection(): void {
    for (const option of this.#picker.querySelectorAll<HTMLElement>(
      "[data-prompt-reference-index], [data-prompt-subject-index], [data-prompt-subject-create], [data-prompt-alias-index]",
    )) {
      const index = Number(
        option.dataset.promptReferenceIndex ??
          option.dataset.promptAliasIndex ??
          option.dataset.promptSubjectIndex ??
          (option.hasAttribute("data-prompt-subject-create")
            ? this.#pickerSubjects.length
            : undefined),
      )
      const active = index === this.#pickerIndex
      option.classList.toggle("is-active", active)
      option.setAttribute("aria-selected", String(active))
    }
    const active = this.#picker.querySelector<HTMLElement>(".is-active")
    active?.scrollIntoView({ block: "nearest" })
  }

  #placePicker(): void {
    const anchor = this.#pickerAnchor
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (!anchor?.isConnected || !picker || picker.hidden) return
    if (this.#pickerMode === "alias") {
      anchor.before(picker)
      return
    }
    const card = anchor.matches("[data-prompt-section]")
      ? anchor
      : anchor.closest<HTMLElement>("[data-prompt-section]")
    const body = card?.querySelector<HTMLElement>(":scope > [data-prompt-section-body]")
    body?.before(picker)
  }

  #insertMention(reference: PromptReference | undefined): void {
    if (!reference || !this.#pickerRange) return
    const selection = globalThis.getSelection?.()
    const chip = makeMentionChip(
      {
        type: "mention",
        referenceId: reference.referenceId,
        mediaKind: reference.mediaKind,
        label: reference.label,
      },
      reference,
    )
    this.#pickerRange.deleteContents()
    this.#pickerRange.insertNode(chip)
    const range = document.createRange()
    range.setStartAfter(chip)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.#closePicker()
    this.#syncDocumentFromEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertSubject(subject: PromptSubject | undefined): void {
    if (!subject || !this.#pickerRange) return
    const ordinal =
      this.#document.subjects.findIndex((candidate) => candidate.subjectId === subject.subjectId) +
      1
    const chip = makeSubjectChip(
      { type: "subject", subjectId: subject.subjectId, label: subject.label },
      subject,
      ordinal,
    )
    const selection = globalThis.getSelection?.()
    this.#pickerRange.deleteContents()
    this.#pickerRange.insertNode(chip)
    const range = document.createRange()
    range.setStartAfter(chip)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.#closePicker()
    this.#syncDocumentFromEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #createAndInsertSubject(label: string | undefined): void {
    if (!label) return
    let subjectId = createSubjectId()
    while (this.#document.subjects.some((subject) => subject.subjectId === subjectId))
      subjectId = createSubjectId()
    const subject = { subjectId, label }
    this.#document.subjects.push(subject)
    this.#insertSubject(subject)
  }

  #insertAlias(alias: PromptAlias | undefined): void {
    if (alias) this.#addOrFocusSection(alias.title)
  }

  #pickerOptionCount(): number {
    if (this.#pickerMode === "alias") return this.#pickerAliases.length
    if (this.#pickerMode === "subject")
      return this.#pickerSubjects.length + (this.#pickerCreateSubject ? 1 : 0)
    return this.#pickerReferences.length
  }

  #activatePickerOption(): void {
    if (this.#pickerMode === "alias") this.#insertAlias(this.#pickerAliases[this.#pickerIndex])
    else if (this.#pickerMode === "subject") {
      if (this.#pickerIndex < this.#pickerSubjects.length)
        this.#insertSubject(this.#pickerSubjects[this.#pickerIndex])
      else this.#createAndInsertSubject(this.#pickerCreateSubject)
    } else this.#insertMention(this.#pickerReferences[this.#pickerIndex])
  }

  #onPickerWheel(event: WheelEvent): void {
    if (
      event.deltaY === 0 ||
      !(event.target instanceof Node) ||
      !this.#picker.contains(event.target) ||
      this.#picker.hidden
    )
      return
    event.preventDefault()
    event.stopPropagation()
    this.#picker.scrollTop += event.deltaY
  }

  #closePicker(): void {
    this.#pickerRange = undefined
    this.#pickerAnchor = undefined
    this.#pickerMode = undefined
    this.#pickerReferences = []
    this.#pickerSubjects = []
    this.#pickerCreateSubject = undefined
    this.#pickerAliases = []
    this.#pickerIndex = 0
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (picker) {
      picker.hidden = true
      picker.replaceChildren()
      const hint = this.root.querySelector<HTMLElement>("[data-prompt-hint]")
      if (hint) hint.before(picker)
    }
  }
}
