import type { ComfyNode } from "../../comfyui.ts"
import {
  PROMPT_SECTION_ALIASES,
  compilePromptDocument,
  deserializePromptDocument,
  normalizePromptSectionTitle,
  parseRawPrompt,
  serializePromptDocument,
  type PromptDocument,
  type PromptMentionPart,
  type PromptReference,
  type PromptSectionAlias,
  type PromptSectionPart,
} from "../prompt-state.ts"

type ReferenceProvider = () => readonly PromptReference[]

interface AliasOption {
  command: PromptSectionAlias
  title: string
  label: string
  description: string
  icon: string
}

const ALIAS_OPTIONS: readonly AliasOption[] = [
  {
    command: "style",
    title: PROMPT_SECTION_ALIASES.style,
    label: "Style",
    description: "Visual rendering and aesthetic direction",
    icon: "St",
  },
  {
    command: "camera",
    title: PROMPT_SECTION_ALIASES.camera,
    label: "Camera",
    description: "Framing, lens, movement, and transitions",
    icon: "C",
  },
  {
    command: "timeline",
    title: PROMPT_SECTION_ALIASES.timeline,
    label: "Timeline",
    description: "Action order, shot timing, cuts, and continuity",
    icon: "T",
  },
  {
    command: "sound",
    title: PROMPT_SECTION_ALIASES.sound,
    label: "Sound",
    description: "Ambience, Foley, effects, and non-verbal sounds",
    icon: "S",
  },
  {
    command: "music",
    title: PROMPT_SECTION_ALIASES.music,
    label: "Music",
    description: "Audience-only non-diegetic background music",
    icon: "M",
  },
  {
    command: "voice",
    title: PROMPT_SECTION_ALIASES.voice,
    label: "Voice",
    description: "Speaker timbre, delivery, narration, and voiceover",
    icon: "V",
  },
  {
    command: "avoid",
    title: PROMPT_SECTION_ALIASES.avoid,
    label: "Avoid",
    description: "Elements and behaviors the rewrite must exclude",
    icon: "!",
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

function makeDialogueBlock(value = ""): HTMLSpanElement {
  const block = document.createElement("span")
  block.className = "rl-prompt-dialogue"
  block.dataset.promptPart = "dialogue"
  block.spellcheck = false
  appendTextWithBreaks(block, value)
  if (!value) block.append(document.createTextNode(CARET_SENTINEL))
  return block
}

function sectionPartsFromContainer(container: Node): PromptSectionPart[] {
  const parts: PromptSectionPart[] = []
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
    if (node.tagName === "BR") {
      pushText("\n")
      return
    }
    for (const child of node.childNodes) visit(child)
  }
  for (const child of container.childNodes) visit(child)
  return parts
}

function closestSectionBody(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const body = element?.closest<HTMLElement>("[data-prompt-section-body]")
  return body && root.contains(body) ? body : undefined
}

function closestDialogue(root: HTMLElement, node: Node | null): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const dialogue = element?.closest<HTMLElement>('[data-prompt-part="dialogue"]')
  return dialogue && root.contains(dialogue) ? dialogue : undefined
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
  #pickerMode: "reference" | "alias" | undefined
  #pickerReferences: PromptReference[] = []
  #pickerAliases: AliasOption[] = []
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
    const raw = this.root.querySelector<HTMLElement>("[data-prompt-editor]")
    if (this.#document.view === "raw") {
      if (raw && document.activeElement !== raw)
        raw.textContent = compilePromptDocument(this.#document, this.#references())
      return
    }
    const references = new Map(
      this.#references().map((reference) => [
        referenceKey(reference.mediaKind, reference.referenceId),
        reference,
      ]),
    )
    for (const chip of this.root.querySelectorAll<HTMLElement>('[data-prompt-part="mention"]')) {
      const mediaKind = chip.dataset.mediaKind ?? ""
      const referenceId = chip.dataset.referenceId ?? ""
      const label = chip.dataset.label ?? referenceId
      const reference = references.get(referenceKey(mediaKind, referenceId))
      chip.replaceWith(
        makeMentionChip(
          {
            type: "mention",
            referenceId,
            mediaKind: mediaKind === "video" || mediaKind === "audio" ? mediaKind : "image",
            label,
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
      <section class="rl-prompt-panel" aria-label="Reference Prompt editor">
        <header class="rl-prompt-toolbar">
          <div><strong>Prompt</strong><small>Stack sections by title · @ media · # dialogue · / alias</small></div>
          <button type="button" data-prompt-action="toggle-view" aria-label="Toggle raw prompt view"></button>
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
    this.root.addEventListener("keydown", (event) => this.#onKeydown(event), {
      capture: true,
      signal,
    })
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
    const stale = this.root.querySelectorAll(".rl-prompt-mention.is-stale").length
    hint.textContent = issue || (stale ? `${stale} unavailable reference mention.` : "")
    hint.hidden = !hint.textContent
  }

  #renderEditor(): void {
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
      editor.dataset.placeholder = "Pseudo-YAML prompt. Every title: line becomes a section."
      editor.textContent = compilePromptDocument(this.#document, this.#references())
      workspace.append(editor)
    } else {
      const stack = document.createElement("div")
      stack.className = "rl-prompt-stack"
      stack.dataset.promptStack = ""
      const sections =
        this.#document.sections.length > 0
          ? this.#document.sections
          : [{ title: "scene", parts: [] as PromptSectionPart[] }]
      const references = new Map(
        this.#references().map((reference) => [
          referenceKey(reference.mediaKind, reference.referenceId),
          reference,
        ]),
      )
      for (const section of sections) stack.append(this.#makeSectionCard(section, references))
      const entry = document.createElement("div")
      entry.className = "rl-prompt-section-entry"
      entry.dataset.promptSectionEntry = ""
      entry.contentEditable = "true"
      entry.role = "textbox"
      entry.spellcheck = false
      entry.dataset.placeholder = "Add section: title_tag: or /alias"
      entry.setAttribute("aria-label", "Add prompt section")
      stack.append(entry)
      workspace.append(stack)
    }
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')
    if (button) {
      const raw = this.#document.view === "raw"
      button.textContent = raw ? "@ Structured" : "</> Raw"
      button.title = raw ? "Back to section stack" : "Show literal pseudo-YAML prompt"
      button.setAttribute("aria-pressed", String(raw))
    }
    this.#setHint()
  }

  #makeSectionCard(
    section: { title: string; parts: readonly PromptSectionPart[] },
    references: ReadonlyMap<string, PromptReference>,
  ): HTMLElement {
    const card = document.createElement("section")
    card.className = "rl-prompt-section"
    card.dataset.promptSection = section.title
    const header = document.createElement("header")
    header.className = "rl-prompt-section__header"
    const title = document.createElement("code")
    title.textContent = `${section.title}:`
    const remove = document.createElement("button")
    remove.type = "button"
    remove.dataset.promptAction = "remove-section"
    remove.dataset.promptSectionTitle = section.title
    remove.title = `Remove ${section.title}`
    remove.setAttribute("aria-label", `Remove ${section.title} section`)
    remove.textContent = "×"
    header.append(title, remove)
    const body = document.createElement("div")
    body.className = "rl-prompt-section__body"
    body.dataset.promptSectionBody = section.title
    body.contentEditable = "true"
    body.role = "textbox"
    body.ariaMultiLine = "true"
    body.spellcheck = true
    body.dataset.placeholder = "Write this section. Type @ for media or # for dialogue."
    for (const part of section.parts) {
      if (part.type === "text") appendTextWithBreaks(body, part.text)
      else if (part.type === "dialogue") body.append(makeDialogueBlock(part.text))
      else
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
      if (editor)
        this.#document = parseRawPrompt(textContentWithBreaks(editor), this.#references(), "raw")
      return
    }
    const sections = Array.from(
      this.root.querySelectorAll<HTMLElement>("[data-prompt-section-body]"),
    ).flatMap((body) => {
      const title = normalizePromptSectionTitle(body.dataset.promptSectionBody ?? "")
      if (!title) return []
      const parts = sectionPartsFromContainer(body)
      if (title === "scene" && parts.length === 0 && this.#document.sections.length === 0) return []
      return [{ title, parts }]
    })
    this.#document = { ...this.#document, sections }
  }

  #onInput(event: Event): void {
    if (!(event.target instanceof Node) || !this.root.contains(event.target)) return
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
    const alias = target.closest<HTMLButtonElement>("[data-prompt-alias-index]")
    if (alias) {
      const index = Number(alias.dataset.promptAliasIndex)
      if (Number.isInteger(index)) this.#insertAlias(this.#pickerAliases[index])
    }
  }

  #onKeydown(event: KeyboardEvent): void {
    if (!(event.target instanceof Node) || !this.root.contains(event.target)) return
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
    const selection = globalThis.getSelection?.()
    const start = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null
    const body = closestSectionBody(this.root, start)
    if (!body) return
    const dialogue = closestDialogue(body, start)
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      if (event.shiftKey) this.#insertLineBreak()
      else if (dialogue) this.#exitDialogue(dialogue, body)
      else this.#entry?.focus()
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
      this.#insertDialogue(body)
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

  #createSectionFromEntry(): void {
    const entry = this.#entry
    if (!entry) return
    const value = textContentWithBreaks(entry).trim()
    const alias = value.match(/^\/([a-z]+)$/iu)?.[1]?.toLocaleLowerCase()
    const aliasTitle = ALIAS_OPTIONS.find((option) => option.command === alias)?.title
    const title =
      aliasTitle ?? (value.endsWith(":") ? normalizePromptSectionTitle(value) : undefined)
    if (!title) {
      this.#setHint("Use a lowercase title_tag: or choose a /alias.")
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
    this.#document.sections = this.#document.sections.filter((section) => section.title !== title)
    this.#closePicker()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertDialogue(body: HTMLElement): void {
    const selection = globalThis.getSelection?.()
    const block = makeDialogueBlock()
    const trailing = document.createTextNode(CARET_SENTINEL)
    if (!selection?.rangeCount || !body.contains(selection.anchorNode)) body.append(block, trailing)
    else {
      const range = selection.getRangeAt(0)
      range.deleteContents()
      range.insertNode(trailing)
      range.insertNode(block)
    }
    placeCaretAtEnd(block)
  }

  #insertLineBreak(): void {
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount) return
    const range = selection.getRangeAt(0)
    const br = document.createElement("br")
    const anchor = document.createTextNode(CARET_SENTINEL)
    range.deleteContents()
    range.insertNode(br)
    br.after(anchor)
    range.setStart(anchor, anchor.data.length)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  #exitDialogue(dialogue: HTMLElement, body: HTMLElement): void {
    const anchor = document.createTextNode(CARET_SENTINEL)
    dialogue.after(anchor)
    const selection = globalThis.getSelection?.()
    const range = document.createRange()
    range.setStart(anchor, anchor.data.length)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    body.focus()
  }

  #updatePickerQuery(): void {
    const entry = this.#entry
    if (entry && document.activeElement === entry) {
      const match = textContentWithBreaks(entry)
        .trim()
        .match(/^\/([a-z]*)$/iu)
      if (match) this.#updateAliasPicker(match[1] ?? "")
      else this.#closePicker()
      return
    }
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount || !selection.isCollapsed) {
      this.#closePicker()
      return
    }
    const caret = selection.getRangeAt(0)
    const container = caret.startContainer
    if (
      container.nodeType !== Node.TEXT_NODE ||
      !closestSectionBody(this.root, container) ||
      closestDialogue(this.root, container)
    ) {
      this.#closePicker()
      return
    }
    const before = (container.textContent ?? "").slice(0, caret.startOffset)
    const match = before.match(/@([^\s@]*)$/u)
    if (!match) {
      this.#closePicker()
      return
    }
    const range = document.createRange()
    range.setStart(container, caret.startOffset - (match[0]?.length ?? 0))
    range.setEnd(container, caret.startOffset)
    this.#pickerRange = range
    this.#updateReferencePicker(match[1] ?? "")
  }

  #updateReferencePicker(query = ""): void {
    this.#pickerMode = "reference"
    this.#pickerAliases = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerReferences = this.#references().filter((reference) =>
      [reference.label, reference.filename, reference.tag, reference.mediaKind].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerReferences.length - 1))
    this.#renderPicker()
  }

  #updateAliasPicker(query = ""): void {
    this.#pickerMode = "alias"
    this.#pickerRange = undefined
    this.#pickerReferences = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerAliases = ALIAS_OPTIONS.filter((option) =>
      [option.command, option.title, option.label, option.description].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerAliases.length - 1))
    this.#renderPicker()
  }

  #renderPicker(): void {
    const picker = this.#picker
    picker.replaceChildren()
    picker.hidden = false
    if (this.#pickerOptionCount() === 0) {
      const empty = document.createElement("p")
      empty.textContent =
        this.#pickerMode === "alias" ? "No aliases match." : "No references match."
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
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `/${option.command} → ${option.title}:`
        const detail = document.createElement("small")
        detail.textContent = option.description
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
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
      "[data-prompt-reference-index], [data-prompt-alias-index]",
    )) {
      const index = Number(option.dataset.promptReferenceIndex ?? option.dataset.promptAliasIndex)
      const active = index === this.#pickerIndex
      option.classList.toggle("is-active", active)
      option.setAttribute("aria-selected", String(active))
    }
    const active = this.#picker.querySelector<HTMLElement>(".is-active")
    active?.scrollIntoView({ block: "nearest" })
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

  #insertAlias(alias: AliasOption | undefined): void {
    if (alias) this.#addOrFocusSection(alias.title)
  }

  #pickerOptionCount(): number {
    return this.#pickerMode === "alias" ? this.#pickerAliases.length : this.#pickerReferences.length
  }

  #activatePickerOption(): void {
    if (this.#pickerMode === "alias") this.#insertAlias(this.#pickerAliases[this.#pickerIndex])
    else this.#insertMention(this.#pickerReferences[this.#pickerIndex])
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
    this.#pickerMode = undefined
    this.#pickerReferences = []
    this.#pickerAliases = []
    this.#pickerIndex = 0
    const picker = this.root.querySelector<HTMLElement>("[data-prompt-picker]")
    if (picker) {
      picker.hidden = true
      picker.replaceChildren()
    }
  }
}
