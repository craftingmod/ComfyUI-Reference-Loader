import type { ComfyNode } from "../../comfyui.ts"
import {
  compilePromptDocument,
  deserializePromptDocument,
  parseRawPrompt,
  serializePromptDocument,
  type PromptDirectiveKind,
  type PromptDocument,
  type PromptInlinePart,
  type PromptMentionPart,
  type PromptPart,
  type PromptReference,
} from "../prompt-state.ts"

type ReferenceProvider = () => readonly PromptReference[]

interface DirectiveOption {
  kind: PromptDirectiveKind
  command: string
  label: string
  description: string
}

const DIRECTIVE_OPTIONS: readonly DirectiveOption[] = [
  {
    kind: "audio",
    command: "audio",
    label: "Audio",
    description: "Music, ambience, speech, and sound effects",
  },
  {
    kind: "style",
    command: "style",
    label: "Style",
    description: "Visual rendering and aesthetic direction",
  },
]

const CARET_SENTINEL = "\u200b"

function appendTextWithBreaks(container: ParentNode, value: string): void {
  const lines = value.split("\n")
  lines.forEach((line, index) => {
    if (index > 0) container.append(document.createElement("br"))
    if (line) container.append(document.createTextNode(line))
  })
}

function textContentWithBreaks(container: Node): string {
  let value = ""
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
    for (const child of node.childNodes) visit(child)
  }
  for (const child of container.childNodes) visit(child)
  return value.replaceAll(CARET_SENTINEL, "")
}

function referenceKey(mediaKind: string, referenceId: string): string {
  return `${mediaKind}:${referenceId}`
}

function makeDialogueBlock(value = ""): HTMLSpanElement {
  const block = document.createElement("span")
  block.className = "rl-prompt-dialogue"
  block.dataset.promptPart = "dialogue"
  block.spellcheck = false
  appendTextWithBreaks(block, value)
  if (!value) block.append(document.createTextNode(CARET_SENTINEL))
  return block
}

function makeDirectiveBlock(
  kind: PromptDirectiveKind,
  parts: readonly PromptInlinePart[] = [],
  references: ReadonlyMap<string, PromptReference> = new Map(),
): HTMLSpanElement {
  const block = document.createElement("span")
  block.className = `rl-prompt-directive is-${kind}`
  block.dataset.promptPart = "directive"
  block.dataset.directiveKind = kind
  block.dataset.directiveLabel = `/${kind}`
  block.spellcheck = true
  for (const part of parts) {
    if (part.type === "text") appendTextWithBreaks(block, part.text)
    else
      block.append(
        makeMentionChip(part, references.get(referenceKey(part.mediaKind, part.referenceId))),
      )
  }
  if (parts.length === 0) block.append(document.createTextNode(CARET_SENTINEL))
  return block
}

function inlinePartsFromContainer(container: Node): PromptInlinePart[] {
  const parts: PromptInlinePart[] = []
  const pushText = (value: string): void => {
    const text = value.replaceAll(CARET_SENTINEL, "")
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += text
    else parts.push({ type: "text", text })
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
    if (node.tagName === "BR") {
      pushText("\n")
      return
    }
    for (const child of node.childNodes) visit(child)
  }
  for (const child of container.childNodes) visit(child)
  return parts
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

function closestDialogue(editor: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const dialogue = element?.closest<HTMLElement>('[data-prompt-part="dialogue"]')
  return dialogue && editor.contains(dialogue) ? dialogue : undefined
}

function closestDirective(editor: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const directive = element?.closest<HTMLElement>('[data-prompt-part="directive"]')
  return directive && editor.contains(directive) ? directive : undefined
}

function closestEditableBlock(editor: HTMLElement, node: Node | null): HTMLElement | undefined {
  return closestDialogue(editor, node) ?? closestDirective(editor, node)
}

export class ReferencePromptController {
  readonly root: HTMLElement
  #node: ComfyNode
  #references: ReferenceProvider
  #document: PromptDocument
  #destroyController = new AbortController()
  #pickerRange: Range | undefined
  #pickerMode: "reference" | "directive" | undefined
  #pickerReferences: PromptReference[] = []
  #pickerDirectives: DirectiveOption[] = []
  #pickerIndex = 0
  #composing = false
  #destroyed = false

  constructor(
    root: HTMLElement,
    node: ComfyNode,
    references: ReferenceProvider,
    serialized: unknown,
  ) {
    this.root = root
    this.#node = node
    this.#references = references
    const parsed = deserializePromptDocument(serialized)
    this.#document = parsed.document
    this.#mount(parsed.issues.join(" "))
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
    this.#closePicker()
    this.#renderEditor()
    this.#setHint(parsed.issues.join(" "))
  }

  refreshReferences(): void {
    if (this.#destroyed) return
    const editor = this.#editor
    if (this.#document.view === "raw") {
      if (document.activeElement !== editor)
        editor.textContent = compilePromptDocument(this.#document, this.#references())
      return
    }
    const references = new Map(
      this.#references().map((reference) => [
        referenceKey(reference.mediaKind, reference.referenceId),
        reference,
      ]),
    )
    for (const chip of editor.querySelectorAll<HTMLElement>('[data-prompt-part="mention"]')) {
      const mediaKind = chip.dataset.mediaKind ?? ""
      const referenceId = chip.dataset.referenceId ?? ""
      const label = chip.dataset.label ?? referenceId
      const reference = references.get(referenceKey(mediaKind, referenceId))
      const replacement = makeMentionChip(
        {
          type: "mention",
          referenceId,
          mediaKind: mediaKind === "video" || mediaKind === "audio" ? mediaKind : "image",
          label,
        },
        reference,
      )
      chip.replaceWith(replacement)
    }
    if (this.#pickerRange && this.#pickerMode === "reference") this.#updateReferencePicker()
    this.#setHint()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#destroyController.abort()
    this.#closePicker()
    this.root.replaceChildren()
  }

  get #editor(): HTMLElement {
    const editor = this.root.querySelector<HTMLElement>("[data-prompt-editor]")
    if (!editor) throw new Error("Reference Prompt editor is not mounted.")
    return editor
  }

  get #picker(): HTMLElement {
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (!picker) throw new Error("Reference Prompt picker is not mounted.")
    return picker
  }

  #mount(issue: string): void {
    this.root.innerHTML = `
      <section class="rl-prompt-panel" aria-label="Reference Prompt editor">
        <header class="rl-prompt-toolbar">
          <div><strong>Prompt</strong><small>Type @ for media · # for dialogue · / for direction</small></div>
          <button type="button" data-prompt-action="toggle-view" aria-label="Toggle raw prompt view"></button>
        </header>
        <div class="rl-prompt-editor" data-prompt-editor contenteditable="true" role="textbox" aria-multiline="true" spellcheck="true" data-placeholder="Describe the scene. Type @ to reference media."></div>
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
    this.root.addEventListener("keydown", (event) => this.#onKeydown(event), { signal })
    this.root.addEventListener("click", (event) => this.#onClick(event), { signal })
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
    const stale = this.#editor.querySelectorAll(".rl-prompt-mention.is-stale").length
    hint.textContent = issue || (stale ? `${stale} unavailable reference mention.` : "")
    hint.hidden = !hint.textContent
  }

  #renderEditor(): void {
    const editor = this.#editor
    editor.replaceChildren()
    editor.classList.toggle("is-raw", this.#document.view === "raw")
    editor.dataset.placeholder =
      this.#document.view === "raw"
        ? "Literal prompt with media, dialogue, audio, and style tags."
        : "Describe the scene. Type @ for media, # for dialogue, or / for direction."
    editor.spellcheck = this.#document.view !== "raw"
    if (this.#document.view === "raw") {
      editor.textContent = compilePromptDocument(this.#document, this.#references())
    } else {
      const references = new Map(
        this.#references().map((reference) => [
          referenceKey(reference.mediaKind, reference.referenceId),
          reference,
        ]),
      )
      for (const part of this.#document.parts) {
        if (part.type === "text") appendTextWithBreaks(editor, part.text)
        else if (part.type === "dialogue") editor.append(makeDialogueBlock(part.text))
        else if (part.type === "directive")
          editor.append(makeDirectiveBlock(part.kind, part.parts, references))
        else
          editor.append(
            makeMentionChip(part, references.get(referenceKey(part.mediaKind, part.referenceId))),
          )
      }
    }
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')
    if (button) {
      const raw = this.#document.view === "raw"
      button.textContent = raw ? "@ Structured" : "</> Raw"
      button.title = raw ? "Back to structured editor" : "Show literal raw prompt"
      button.setAttribute("aria-pressed", String(raw))
    }
    this.#setHint()
  }

  #syncDocumentFromEditor(): void {
    if (this.#destroyed) return
    const editor = this.#editor
    if (this.#document.view === "raw") {
      this.#document = parseRawPrompt(textContentWithBreaks(editor), this.#references(), "raw")
      return
    }
    const parts: PromptPart[] = []
    const pushText = (value: string): void => {
      const text = value.replaceAll(CARET_SENTINEL, "")
      if (!text) return
      const previous = parts.at(-1)
      if (previous?.type === "text") previous.text += text
      else parts.push({ type: "text", text })
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
      if (node.dataset.promptPart === "dialogue") {
        parts.push({ type: "dialogue", text: textContentWithBreaks(node) })
        return
      }
      if (node.dataset.promptPart === "directive") {
        parts.push({
          type: "directive",
          kind: node.dataset.directiveKind === "style" ? "style" : "audio",
          parts: inlinePartsFromContainer(node),
        })
        return
      }
      if (node.tagName === "BR") {
        pushText("\n")
        return
      }
      const block = node.tagName === "DIV" || node.tagName === "P"
      for (const child of node.childNodes) visit(child)
      if (block) pushText("\n")
    }
    for (const child of editor.childNodes) visit(child)
    this.#document = { ...this.#document, parts }
  }

  #onInput(event: Event): void {
    if (!(event.target instanceof Node) || !this.#editor.contains(event.target)) return
    if (this.#composing) return
    this.#syncDocumentFromEditor()
    if (this.#document.view === "structured") this.#updatePickerQuery()
    this.#node.setDirtyCanvas(true, true)
  }

  #onClick(event: MouseEvent): void {
    const target = event.target as Element
    const toggle = target.closest<HTMLButtonElement>('[data-prompt-action="toggle-view"]')
    if (toggle) {
      this.#toggleView()
      return
    }
    const option = target.closest<HTMLButtonElement>("[data-prompt-reference-index]")
    if (option) {
      const index = Number(option.dataset.promptReferenceIndex)
      if (Number.isInteger(index)) this.#insertMention(this.#pickerReferences[index])
      return
    }
    const directive = target.closest<HTMLButtonElement>("[data-prompt-directive-index]")
    if (!directive) return
    const index = Number(directive.dataset.promptDirectiveIndex)
    if (Number.isInteger(index)) this.#insertDirective(this.#pickerDirectives[index])
  }

  #onPickerWheel(event: WheelEvent): void {
    const picker = this.#picker
    if (
      event.deltaY === 0 ||
      !(event.target instanceof Node) ||
      !picker.contains(event.target) ||
      picker.hidden
    )
      return
    const delta =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY * 24
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * Math.max(picker.clientHeight, 1)
          : event.deltaY
    event.preventDefault()
    event.stopPropagation()
    picker.scrollTop += delta
  }

  #onKeydown(event: KeyboardEvent): void {
    if (!(event.target instanceof Node) || !this.#editor.contains(event.target)) return
    if (!this.#picker.hidden) {
      const optionCount = this.#pickerOptionCount()
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        this.#pickerIndex = (this.#pickerIndex + delta + optionCount) % Math.max(1, optionCount)
        this.#updatePickerSelection()
        return
      }
      if (event.key === "Enter" && optionCount > 0) {
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
    const selection = globalThis.getSelection?.()
    const block = closestEditableBlock(
      this.#editor,
      selection?.rangeCount ? selection.getRangeAt(0).startContainer : null,
    )
    if (block && event.key === "Enter") {
      event.preventDefault()
      if (event.shiftKey) this.#insertLineBreak()
      else this.#exitBlock(block)
      this.#syncDocumentFromEditor()
      this.#node.setDirtyCanvas(true, true)
      return
    }
    if (
      event.key === "#" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !this.#composing
    ) {
      event.preventDefault()
      this.#insertDialogue()
      this.#syncDocumentFromEditor()
      this.#node.setDirtyCanvas(true, true)
    }
  }

  #toggleView(): void {
    this.#syncDocumentFromEditor()
    this.#document = {
      ...this.#document,
      view: this.#document.view === "raw" ? "structured" : "raw",
    }
    this.#closePicker()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertDialogue(): void {
    const selection = globalThis.getSelection?.()
    const block = makeDialogueBlock()
    const trailing = document.createTextNode(CARET_SENTINEL)
    if (!selection?.rangeCount || !this.#editor.contains(selection.anchorNode)) {
      this.#editor.append(block, trailing)
    } else {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(trailing)
      range.insertNode(block)
    }
    const range = document.createRange()
    range.selectNodeContents(block)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  #insertLineBreak(): void {
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    const br = document.createElement("br")
    range.deleteContents()
    range.insertNode(br)
    range.setStartAfter(br)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  #exitBlock(block: HTMLElement): void {
    const selection = globalThis.getSelection?.()
    const trailing = document.createTextNode(CARET_SENTINEL)
    block.after(trailing)
    const range = document.createRange()
    range.setStart(trailing, trailing.data.length)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  #updatePickerQuery(): void {
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount || !selection.isCollapsed) {
      this.#closePicker()
      return
    }
    const caret = selection.getRangeAt(0)
    const container = caret.startContainer
    if (
      container.nodeType !== Node.TEXT_NODE ||
      !this.#editor.contains(container) ||
      closestDialogue(this.#editor, container)
    ) {
      this.#closePicker()
      return
    }
    const before = (container.textContent ?? "").slice(0, caret.startOffset)
    const mentionMatch = before.match(/@([^\s@]*)$/u)
    const directiveMatch = closestDirective(this.#editor, container)
      ? undefined
      : before.match(/(?:^|\s)(\/([a-z]*))$/iu)
    if (!mentionMatch && !directiveMatch) {
      this.#closePicker()
      return
    }
    const range = document.createRange()
    const token = mentionMatch?.[0] ?? directiveMatch?.[1] ?? ""
    range.setStart(container, caret.startOffset - token.length)
    range.setEnd(container, caret.startOffset)
    this.#pickerRange = range
    if (mentionMatch) this.#updateReferencePicker(mentionMatch[1] ?? "")
    else this.#updateDirectivePicker(directiveMatch?.[2] ?? "")
  }

  #updateReferencePicker(query = ""): void {
    this.#pickerMode = "reference"
    this.#pickerDirectives = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerReferences = this.#references().filter((reference) =>
      [reference.label, reference.filename, reference.tag, reference.mediaKind].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerReferences.length - 1))
    this.#renderPicker()
  }

  #updateDirectivePicker(query = ""): void {
    this.#pickerMode = "directive"
    this.#pickerReferences = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerDirectives = DIRECTIVE_OPTIONS.filter((option) =>
      [option.command, option.label, option.description].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerDirectives.length - 1))
    this.#renderPicker()
  }

  #renderPicker(): void {
    const picker = this.#picker
    picker.replaceChildren()
    picker.hidden = false
    if (this.#pickerOptionCount() === 0) {
      const empty = document.createElement("p")
      empty.textContent =
        this.#pickerMode === "directive"
          ? "No prompt directions match."
          : "No active references match."
      picker.append(empty)
      return
    }
    if (this.#pickerMode === "directive") {
      this.#pickerDirectives.forEach((directive, index) => {
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptDirectiveIndex = String(index)
        button.classList.toggle("is-active", index === this.#pickerIndex)
        button.setAttribute("aria-selected", String(index === this.#pickerIndex))
        const icon = document.createElement("span")
        icon.className = `rl-prompt-directive-icon is-${directive.kind}`
        icon.textContent = directive.kind === "audio" ? "A" : "S"
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `/${directive.command}`
        const detail = document.createElement("small")
        detail.textContent = directive.description
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
      this.#updatePickerSelection()
      return
    }
    this.#pickerReferences.forEach((reference, index) => {
      const button = document.createElement("button")
      button.type = "button"
      button.role = "option"
      button.dataset.promptReferenceIndex = String(index)
      button.classList.toggle("is-active", index === this.#pickerIndex)
      button.setAttribute("aria-selected", String(index === this.#pickerIndex))
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
    this.#updatePickerSelection()
  }

  #updatePickerSelection(): void {
    for (const option of this.#picker.querySelectorAll<HTMLElement>(
      "[data-prompt-reference-index], [data-prompt-directive-index]",
    )) {
      const optionIndex = Number(
        option.dataset.promptReferenceIndex ?? option.dataset.promptDirectiveIndex,
      )
      const active = optionIndex === this.#pickerIndex
      option.classList.toggle("is-active", active)
      option.setAttribute("aria-selected", String(active))
    }
    this.#scrollActivePickerOptionIntoView()
  }

  #scrollActivePickerOptionIntoView(): void {
    const picker = this.#picker
    const option = picker.querySelector<HTMLElement>(
      `[data-prompt-reference-index="${this.#pickerIndex}"], [data-prompt-directive-index="${this.#pickerIndex}"]`,
    )
    if (!option || picker.clientHeight <= 0) return
    const optionTop = option.offsetTop
    const optionBottom = optionTop + option.offsetHeight
    const visibleTop = picker.scrollTop
    const visibleBottom = visibleTop + picker.clientHeight
    if (optionTop < visibleTop) picker.scrollTop = optionTop
    else if (optionBottom > visibleBottom) picker.scrollTop = optionBottom - picker.clientHeight
  }

  #insertMention(reference: PromptReference | undefined): void {
    if (!reference || !this.#pickerRange) return
    const selection = globalThis.getSelection?.()
    const part: PromptMentionPart = {
      type: "mention",
      referenceId: reference.referenceId,
      mediaKind: reference.mediaKind,
      label: reference.label,
    }
    const chip = makeMentionChip(part, reference)
    const trailing = document.createTextNode(CARET_SENTINEL)
    this.#pickerRange.deleteContents()
    this.#pickerRange.insertNode(trailing)
    this.#pickerRange.insertNode(chip)
    const range = document.createRange()
    range.setStart(trailing, trailing.data.length)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.#closePicker()
    this.#syncDocumentFromEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertDirective(directive: DirectiveOption | undefined): void {
    if (!directive || !this.#pickerRange) return
    const selection = globalThis.getSelection?.()
    const block = makeDirectiveBlock(directive.kind)
    const trailing = document.createTextNode(CARET_SENTINEL)
    this.#pickerRange.deleteContents()
    this.#pickerRange.insertNode(trailing)
    this.#pickerRange.insertNode(block)
    const range = document.createRange()
    range.selectNodeContents(block)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    this.#closePicker()
    this.#syncDocumentFromEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #pickerOptionCount(): number {
    return this.#pickerMode === "directive"
      ? this.#pickerDirectives.length
      : this.#pickerReferences.length
  }

  #activatePickerOption(): void {
    if (this.#pickerMode === "directive")
      this.#insertDirective(this.#pickerDirectives[this.#pickerIndex])
    else this.#insertMention(this.#pickerReferences[this.#pickerIndex])
  }

  #closePicker(): void {
    this.#pickerRange = undefined
    this.#pickerMode = undefined
    this.#pickerReferences = []
    this.#pickerDirectives = []
    this.#pickerIndex = 0
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (picker) {
      picker.hidden = true
      picker.replaceChildren()
    }
  }
}
