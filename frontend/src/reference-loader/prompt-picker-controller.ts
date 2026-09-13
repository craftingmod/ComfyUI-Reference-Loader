import { closestPromptBody } from "./components/prompt-dom.ts"
import type {
  PromptBodyTrigger,
  PromptEditorTargetV6,
} from "./components/prompt-editor-contract.ts"
import { PROMPT_MESSAGES, localize } from "./prompt-i18n.ts"
import type { PromptAlias, PromptLocale, PromptPreset } from "./prompt-presets.ts"
import type {
  PromptDocumentV6,
  PromptPartV6,
  PromptReference,
  PromptSubjectV6,
} from "./prompt-v6.ts"

type PromptPickerShot = PromptDocumentV6["shots"][number]

export type PromptPickerOption =
  | { readonly kind: "reference"; readonly reference: PromptReference }
  | { readonly kind: "subject"; readonly subject: PromptSubjectV6; readonly ordinal: number }
  | { readonly kind: "shot"; readonly shot: PromptPickerShot; readonly ordinal: number }
  | {
      readonly kind: "create-subject"
      readonly label: string
      readonly createLabel: string
      readonly createDetail: string
    }
  | {
      readonly kind: "alias"
      readonly alias: PromptAlias
      readonly label: string
      readonly description: string
    }

export interface PromptPickerSnapshot {
  readonly visible: boolean
  readonly mode: "reference" | "subject" | "alias" | undefined
  readonly activeIndex: number
  readonly options: readonly PromptPickerOption[]
  readonly emptyMessage: string
  readonly createSubjectLabel: string
  readonly createSubjectDetail: string
  readonly target: HTMLElement | undefined
}

export interface PromptPickerControllerOptions {
  readonly references: () => readonly PromptReference[]
  readonly document: () => PromptDocumentV6
  readonly preset: () => PromptPreset
  readonly locale: () => PromptLocale
  readonly resolveEditorElement: (target: PromptEditorTargetV6) => HTMLElement | undefined
  readonly insertPart: (
    target: PromptEditorTargetV6,
    part: PromptPartV6,
    replaceTextLength: number,
  ) => boolean
  readonly createSubject: (label: string) => string | undefined
  readonly activateAlias: (alias: PromptAlias) => void
}

/** Owns Picker query, option, target, keyboard, and activation state. */
export class PromptPickerController {
  readonly #references: PromptPickerControllerOptions["references"]
  readonly #document: PromptPickerControllerOptions["document"]
  readonly #preset: PromptPickerControllerOptions["preset"]
  readonly #locale: PromptPickerControllerOptions["locale"]
  readonly #resolveEditorElement: PromptPickerControllerOptions["resolveEditorElement"]
  readonly #insertPart: PromptPickerControllerOptions["insertPart"]
  readonly #createSubject: PromptPickerControllerOptions["createSubject"]
  readonly #activateAlias: PromptPickerControllerOptions["activateAlias"]
  #mode: PromptPickerSnapshot["mode"]
  #referencesOptions: PromptReference[] = []
  #subjects: PromptSubjectV6[] = []
  #shots: PromptPickerShot[] = []
  #createSubjectLabel: string | undefined
  #aliases: PromptAlias[] = []
  #index = 0
  #anchor: HTMLElement | undefined
  #target: HTMLElement | undefined
  #bodyTarget: PromptEditorTargetV6 | undefined
  #replaceTextLength = 0
  #element: HTMLElement | undefined
  #listeners = new Set<() => void>()
  #snapshot: PromptPickerSnapshot | undefined
  #destroyed = false

  constructor(options: PromptPickerControllerOptions) {
    this.#references = options.references
    this.#document = options.document
    this.#preset = options.preset
    this.#locale = options.locale
    this.#resolveEditorElement = options.resolveEditorElement
    this.#insertPart = options.insertPart
    this.#createSubject = options.createSubject
    this.#activateAlias = options.activateAlias
  }

  get mode(): PromptPickerSnapshot["mode"] {
    return this.#mode
  }

  get hasElement(): boolean {
    return this.#element !== undefined
  }

  get snapshot(): PromptPickerSnapshot {
    if (!this.#snapshot) this.#snapshot = this.#buildSnapshot()
    return this.#snapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#listeners.add(listener)
    listener()
    return () => this.#listeners.delete(listener)
  }

  mountElement(element: HTMLElement | undefined): void {
    if (this.#destroyed || this.#element === element) return
    this.#element = element
    this.#publish()
  }

  unmountElement(element?: HTMLElement): void {
    if (element && this.#element !== element) return
    if (!this.#element) return
    this.#element = undefined
    this.#publish()
  }

  handleBodyTrigger(target: PromptEditorTargetV6, trigger: PromptBodyTrigger | undefined): void {
    if (this.#destroyed) return
    if (!trigger) {
      if (this.#sameTarget(this.#bodyTarget, target)) this.close()
      return
    }
    this.#bodyTarget = target
    this.#replaceTextLength = trigger.replaceTextLength
    this.#anchor = this.#resolveEditorElement(target)
    if (trigger.trigger === "@") this.updateReferenceQuery(trigger.query)
    else this.updateSubjectQuery(trigger.query, target)
  }

  updateFromSelection(roots: readonly HTMLElement[], canOpenSubjectPicker = true): void {
    if (this.#destroyed) return
    const selection = globalThis.getSelection?.()
    if (!selection?.rangeCount || !selection.isCollapsed) {
      this.close()
      return
    }
    const caret = selection.getRangeAt(0)
    const container = caret.startContainer
    const body = closestPromptBody(roots, container)
    if (container.nodeType !== Node.TEXT_NODE || !body) {
      this.close()
      return
    }
    const before = (container.textContent ?? "").slice(0, caret.startOffset)
    const referenceMatch = before.match(/@([^\s@]*)$/u)
    const subjectMatch = before.match(/#([^\s#]*)$/u)
    const match = referenceMatch ?? subjectMatch
    if (!match) {
      this.close()
      return
    }
    this.#anchor = body.closest<HTMLElement>("[data-prompt-section]") ?? body
    if (referenceMatch) this.updateReferenceQuery(match[1] ?? "")
    else if (canOpenSubjectPicker) this.updateSubjectQuery(subjectMatch?.[1] ?? "", undefined, body)
    else this.close()
  }

  updateSectionEntryQuery(value: string, entry: HTMLInputElement): void {
    if (this.#destroyed) return
    if (document.activeElement !== entry) {
      this.close()
      return
    }
    const match = value.trim().match(/^\/([a-z]*)$/iu)
    if (!match) {
      this.close()
      return
    }
    this.#anchor = entry
    this.updateAliasQuery(match[1] ?? "")
  }

  updateReferenceQuery(query = ""): void {
    if (this.#destroyed) return
    this.#mode = "reference"
    this.#subjects = []
    this.#shots = []
    this.#createSubjectLabel = undefined
    this.#aliases = []
    const normalized = query.trim().toLowerCase()
    this.#referencesOptions = this.#references().filter((reference) =>
      [reference.label, reference.filename, reference.tag, reference.mediaKind].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    )
    this.#clampIndex()
    this.#publish()
  }

  updateSubjectQuery(query: string, target?: PromptEditorTargetV6, body?: HTMLElement): void {
    if (this.#destroyed) return
    this.#mode = "subject"
    this.#referencesOptions = []
    this.#aliases = []
    const normalized = query.trim().toLocaleLowerCase()
    const document = this.#document()
    this.#subjects = document.subjects.filter((subject, index) =>
      [subject.tag, `subject${index + 1}`, `<Subject ${index + 1}>`].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#shots = document.shots.filter((shot) => shot.tag.toLocaleLowerCase().includes(normalized))
    const label = normalizeSubjectLabel(query)
    const editor = body ?? (target ? this.#resolveEditorElement(target) : undefined)
    const creationAllowed =
      this.#preset().subjectMode === "anywhere" ||
      (this.#preset().subjectMode === "definitions" &&
        (editor?.dataset.promptSectionBody === "subject_definitions" ||
          editor?.hasAttribute("data-prompt-definition-body")))
    this.#createSubjectLabel =
      creationAllowed &&
      label &&
      ![...document.subjects, ...document.shots].some(
        (definition) => definition.tag.toLowerCase() === label.toLowerCase(),
      )
        ? label
        : undefined
    this.#clampIndex()
    this.#publish()
  }

  updateAliasQuery(query = ""): void {
    if (this.#destroyed) return
    this.#mode = "alias"
    this.#referencesOptions = []
    this.#subjects = []
    this.#shots = []
    this.#createSubjectLabel = undefined
    const normalized = query.trim().toLocaleLowerCase()
    this.#aliases = this.#preset().aliases.filter((option) =>
      [
        option.command,
        option.title,
        localize(option.label, this.#locale()),
        localize(option.description, this.#locale()),
      ].some((value) => value.toLocaleLowerCase().includes(normalized)),
    )
    this.#clampIndex()
    this.#publish()
  }

  move(delta: -1 | 1): void {
    const count = this.#optionCount()
    if (count === 0) return
    this.#index = (this.#index + delta + count) % count
    this.#publish()
  }

  handleKeydown(event: KeyboardEvent): boolean {
    if (this.#mode === undefined) return false
    const count = this.#optionCount()
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      this.move(event.key === "ArrowDown" ? 1 : -1)
      return true
    }
    if (event.key === "Enter" && count > 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      this.activate()
      return true
    }
    if (event.key === "Escape") {
      event.preventDefault()
      this.close()
      return true
    }
    return false
  }

  activate(index?: number): boolean {
    const nextIndex = index ?? this.#index
    const count = this.#optionCount()
    if (!Number.isSafeInteger(nextIndex) || nextIndex < 0 || nextIndex >= count) return false
    this.#index = nextIndex
    if (this.#mode === "alias") {
      const alias = this.#aliases[this.#index]
      if (!alias) return false
      this.#activateAlias(alias)
      return true
    }
    if (this.#mode === "reference") {
      const reference = this.#referencesOptions[this.#index]
      return reference ? this.#insertMention(reference) : false
    }
    if (this.#index < this.#subjects.length) {
      const subject = this.#subjects[this.#index]
      return subject ? this.#insertDefinition(subject.id) : false
    }
    if (this.#index < this.#subjects.length + this.#shots.length) {
      const shot = this.#shots[this.#index - this.#subjects.length]
      return shot ? this.#insertDefinition(shot.id) : false
    }
    const label = this.#createSubjectLabel
    if (!label) return false
    const id = this.#createSubject(label)
    return id ? this.#insertDefinition(id) : false
  }

  refreshReferences(): void {
    if (this.#mode === "reference") this.updateReferenceQuery()
  }

  close(): void {
    if (this.#destroyed) return
    this.#anchor = undefined
    this.#mode = undefined
    this.#referencesOptions = []
    this.#subjects = []
    this.#shots = []
    this.#createSubjectLabel = undefined
    this.#aliases = []
    this.#index = 0
    this.#target = undefined
    this.#bodyTarget = undefined
    this.#replaceTextLength = 0
    this.#publish()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#listeners.clear()
    this.#element = undefined
    this.#snapshot = undefined
  }

  #insertMention(reference: PromptReference): boolean {
    if (!this.#bodyTarget) return false
    return this.#insertPart(
      this.#bodyTarget,
      {
        type: "mention",
        referenceId: reference.referenceId,
        mediaKind: reference.mediaKind,
        label: reference.label,
      },
      this.#replaceTextLength,
    )
      ? (this.close(), true)
      : false
  }

  #insertDefinition(definitionId: string): boolean {
    if (!this.#bodyTarget) return false
    return this.#insertPart(
      this.#bodyTarget,
      { type: "definition-ref", definitionId },
      this.#replaceTextLength,
    )
      ? (this.close(), true)
      : false
  }

  #optionCount(): number {
    if (this.#mode === "alias") return this.#aliases.length
    if (this.#mode === "subject")
      return this.#subjects.length + this.#shots.length + (this.#createSubjectLabel ? 1 : 0)
    return this.#referencesOptions.length
  }

  #clampIndex(): void {
    this.#index = Math.min(this.#index, Math.max(0, this.#optionCount() - 1))
  }

  #buildSnapshot(): PromptPickerSnapshot {
    const locale = this.#locale()
    const createSubjectLabel = this.#createSubjectLabel
      ? localize(PROMPT_MESSAGES.createSubject, locale).replace("{label}", this.#createSubjectLabel)
      : ""
    const document = this.#document()
    const options: PromptPickerOption[] =
      this.#mode === "reference"
        ? this.#referencesOptions.map((reference) => ({ kind: "reference", reference }))
        : this.#mode === "subject"
          ? [
              ...this.#subjects.map((subject) => ({
                kind: "subject" as const,
                subject,
                ordinal:
                  document.subjects.findIndex((candidate) => candidate.id === subject.id) + 1,
              })),
              ...this.#shots.map((shot) => ({
                kind: "shot" as const,
                shot,
                ordinal: document.shots.findIndex((candidate) => candidate.id === shot.id) + 1,
              })),
              ...(this.#createSubjectLabel
                ? [
                    {
                      kind: "create-subject" as const,
                      label: this.#createSubjectLabel,
                      createLabel: createSubjectLabel,
                      createDetail: localize(PROMPT_MESSAGES.createSubjectDetail, locale),
                    },
                  ]
                : []),
            ]
          : this.#mode === "alias"
            ? this.#aliases.map((alias) => ({
                kind: "alias" as const,
                alias,
                label: localize(alias.label, locale),
                description: localize(alias.description, locale),
              }))
            : []
    const emptyMessage =
      this.#mode === "alias"
        ? localize(PROMPT_MESSAGES.noAliases, locale)
        : this.#mode === "subject"
          ? localize(PROMPT_MESSAGES.noSubjects, locale)
          : localize(PROMPT_MESSAGES.noReferences, locale)
    return {
      visible: this.#mode !== undefined,
      mode: this.#mode,
      activeIndex: this.#index,
      options,
      emptyMessage,
      createSubjectLabel,
      createSubjectDetail: localize(PROMPT_MESSAGES.createSubjectDetail, locale),
      target: this.#target,
    }
  }

  #publish(): void {
    this.#placeTarget()
    const next = this.#buildSnapshot()
    const previous = this.#snapshot
    if (
      previous &&
      previous.visible === next.visible &&
      previous.mode === next.mode &&
      previous.activeIndex === next.activeIndex &&
      previous.emptyMessage === next.emptyMessage &&
      previous.createSubjectLabel === next.createSubjectLabel &&
      previous.createSubjectDetail === next.createSubjectDetail &&
      previous.target === next.target &&
      previous.options.length === next.options.length &&
      previous.options.every(
        (option, index) => JSON.stringify(option) === JSON.stringify(next.options[index]),
      )
    )
      return
    this.#snapshot = next
    for (const listener of this.#listeners) listener()
  }

  #placeTarget(): void {
    const anchor = this.#anchor
    const definition = anchor?.closest<HTMLElement>("[data-prompt-definition]")
    const section = anchor?.closest<HTMLElement>("[data-prompt-section]")
    const entry = anchor?.matches("[data-prompt-section-entry]") ? anchor : undefined
    const editor = anchor?.matches("[data-prompt-editor]") ? anchor : undefined
    this.#target =
      this.#mode === "alias"
        ? entry?.previousElementSibling instanceof HTMLElement
          ? entry.previousElementSibling
          : undefined
        : (definition?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
          section?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
          (editor?.previousElementSibling instanceof HTMLElement
            ? editor.previousElementSibling
            : undefined))
  }

  #sameTarget(left: PromptEditorTargetV6 | undefined, right: PromptEditorTargetV6): boolean {
    return left?.type === right.type && left.id === right.id
  }
}

function normalizeSubjectLabel(value: string): string | undefined {
  const label = value.trim()
  return label.length > 0 && label.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(label)
    ? label
    : undefined
}
