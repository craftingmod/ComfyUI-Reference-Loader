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
  normalizePromptTag,
  parseRawPrompt,
  renderAuthoringPrompt,
  rebindPromptMentionsByOrder,
  renamePromptTag,
  serializePromptDocument,
  type PromptDocument,
  type PromptReference,
  type PromptSectionPart,
  type PromptSubject,
} from "../prompt-state.ts"
import { makePromptDefinitionBody, makePromptSectionBody } from "./prompt-cards.ts"
import {
  appendPromptText,
  closestPromptBody,
  createPromptTagVisuals,
  highlightPromptTags,
  makeMentionChip,
  normalizeDefinitionTagValue,
  nextPromptAtomicAtCaret,
  placeCaretAfterRemovedNode,
  placeCaretAtEnd,
  promptContentFingerprint,
  previousPromptAtomicAtCaret,
  referenceKey,
  sectionColor,
  sectionPartsFromContainer,
  textContentWithBreaks,
} from "./prompt-dom.ts"

type ReferenceProvider = () => readonly PromptReference[]

export interface ReferencePromptControllerOptions {
  presetId?: unknown
  presetCatalog?: unknown
  locale?: PromptLocale
}

export interface PromptViewSnapshot {
  readonly view: PromptDocument["view"]
  readonly presetId: string
  readonly presetLabel: string
  readonly presetDescription: string
  readonly editorAria: string
  readonly clearLabel: string
  readonly clearTitle: string
  readonly clearAria: string
  readonly toggleAria: string
  readonly structuredLabel: string
  readonly rawLabel: string
  readonly backToStructuredTitle: string
  readonly showRawTitle: string
  readonly title: string
  readonly subtitle: string
  readonly rawPlaceholder: string
  readonly sectionEntryPlaceholder: string
  readonly sectionEntryAria: string
  readonly sourceText: string
  readonly compiledText: string
  readonly canClear: boolean
  readonly hint: string
  readonly nativeHosts: {
    readonly workspace: boolean
    readonly picker: boolean
    readonly definitions: boolean
  }
}

export type PromptDefinitionKind = "subject" | "shot"

export interface PromptDefinitionSnapshot {
  readonly identity: string
  readonly kind: PromptDefinitionKind
  readonly tag: string
  readonly ordinal: number
  readonly frameIndex?: number
  readonly parts: readonly PromptSectionPart[]
  readonly placeholder: string
}

export interface PromptDefinitionsSnapshot {
  readonly subjects: readonly PromptDefinitionSnapshot[]
  readonly shots: readonly PromptDefinitionSnapshot[]
  readonly draft: boolean
  readonly mounted: boolean
}

export interface PromptSectionSnapshot {
  readonly title: string
  readonly color: string
  readonly colorIndex: number
  readonly isVirtual: boolean
  readonly editor: "react-text"
  readonly text: string
  readonly parts: readonly PromptSectionPart[]
  readonly placeholder: string
  readonly dragTitle: string
  readonly dragAria: string
  readonly removeTitle: string
  readonly removeAria: string
}

export interface PromptSectionsSnapshot {
  readonly view: PromptDocument["view"]
  readonly sections: readonly PromptSectionSnapshot[]
  readonly mounted: boolean
}

export interface PromptEditorInput {
  readonly data?: string | null
  readonly inputType?: string
}

export type PromptEditorTarget =
  | { readonly type: "section"; readonly title: string }
  | { readonly type: "raw" }
  | {
      readonly type: "definition"
      readonly kind: PromptDefinitionKind
      readonly identity: string
    }

export type PromptPickerOption =
  | { readonly kind: "reference"; readonly reference: PromptReference }
  | { readonly kind: "subject"; readonly subject: PromptSubject; readonly ordinal: number }
  | {
      readonly kind: "shot"
      readonly shot: PromptDocument["shots"][number]
      readonly ordinal: number
    }
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

const PROMPT_SECTION_DRAG_MIME = "application/x-reference-loader-prompt-section"
const PROMPT_DEFINITION_DRAG_MIME = "application/x-reference-loader-prompt-definition"

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

function normalizeSubjectLabel(value: string): string | undefined {
  const label = value.trim()
  return label.length > 0 && label.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(label)
    ? label
    : undefined
}

function plainTextSectionValue(parts: readonly PromptSectionPart[]): string | undefined {
  let value = ""
  for (const part of parts) {
    if (part.type !== "text") return undefined
    value += part.text
  }
  return value
}

export class ReferencePromptController {
  #workspaceRoot: HTMLElement | undefined
  #definitionsRoot: HTMLElement | undefined
  #node: ComfyNode
  #references: ReferenceProvider
  #document: PromptDocument
  #pickerRange: Range | undefined
  #pickerMode: "reference" | "subject" | "alias" | undefined
  #pickerReferences: PromptReference[] = []
  #pickerSubjects: PromptSubject[] = []
  #pickerShots: PromptDocument["shots"] = []
  #pickerCreateSubject: string | undefined
  #pickerAliases: PromptAlias[] = []
  #pickerIndex = 0
  #pickerAnchor: HTMLElement | undefined
  #pickerTarget: HTMLElement | undefined
  #pickerElement: HTMLElement | undefined
  #draggedSectionTitle: string | undefined
  #sectionDropTarget: HTMLElement | undefined
  #dropAfter = false
  #draggedDefinition: { kind: PromptDefinitionKind; tag: string } | undefined
  #definitionDropTarget: HTMLElement | undefined
  #definitionDropAfter = false
  #presetCatalog: PromptPresetCatalog
  #preset: PromptPreset
  #locale: PromptLocale
  #recoveredFromVersion: number | undefined
  #hintText = ""
  #pendingRenderHint: string | undefined
  #destroyed = false
  #shotListeners = new Set<() => void>()
  #viewListeners = new Set<() => void>()
  #definitionsListeners = new Set<() => void>()
  #sectionsListeners = new Set<() => void>()
  #pickerListeners = new Set<() => void>()
  #viewSnapshot: PromptViewSnapshot | undefined
  #definitionsSnapshot: PromptDefinitionsSnapshot | undefined
  #sectionsSnapshot: PromptSectionsSnapshot | undefined
  #pickerSnapshot: PromptPickerSnapshot | undefined
  #definitionIdentityCounter = 0
  #definitionIdentities: Record<PromptDefinitionKind, Map<string, string>> = {
    subject: new Map(),
    shot: new Map(),
  }
  #shotDraft:
    | {
        initial: PromptDocument
        document: PromptDocument
      }
    | undefined

  constructor(
    node: ComfyNode,
    references: ReferenceProvider,
    serialized: unknown,
    options: ReferencePromptControllerOptions = {},
  ) {
    this.#node = node
    this.#references = references
    this.#presetCatalog = normalizePromptPresetCatalog(options.presetCatalog)
    this.#preset = resolvePromptPreset(options.presetId, this.#presetCatalog)
    this.#locale = options.locale ?? detectPromptLocale()
    const parsed = deserializePromptDocument(serialized)
    this.#document = parsed.document
    this.#recoveredFromVersion = parsed.recoveredFromVersion
    this.#viewSnapshot = this.#buildViewSnapshot()
    this.#pendingRenderHint = parsed.issues.join(" ")
    this.#setHint(this.#pendingRenderHint)
  }

  mountDefinitions(root: HTMLElement | undefined): void {
    if (this.#destroyed || this.#definitionsRoot === root) return
    this.#definitionsRoot = root
    this.#renderEditor()
    this.#publishDefinitions()
  }

  getDefinitionsSnapshot(): PromptDefinitionsSnapshot {
    if (!this.#definitionsSnapshot) this.#definitionsSnapshot = this.#buildDefinitionsSnapshot()
    return this.#definitionsSnapshot
  }

  subscribeDefinitions(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#definitionsListeners.add(listener)
    listener()
    return () => this.#definitionsListeners.delete(listener)
  }

  mountNativeHosts(workspace: HTMLElement | undefined): void {
    if (this.#destroyed || this.#workspaceRoot === workspace) return
    if (this.#workspaceRoot !== undefined) this.unmountNativeHosts()
    this.#workspaceRoot = workspace
    this.#renderEditor()
    this.#publishView()
  }

  unmountNativeHosts(): void {
    this.#closePicker()
    this.#workspaceRoot = undefined
    this.#pickerElement = undefined
    this.#publishView()
  }

  getViewSnapshot(): PromptViewSnapshot {
    if (!this.#viewSnapshot) this.#viewSnapshot = this.#buildViewSnapshot()
    return this.#viewSnapshot
  }

  subscribeView(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#viewListeners.add(listener)
    listener()
    return () => this.#viewListeners.delete(listener)
  }

  getSectionsSnapshot(): PromptSectionsSnapshot {
    if (!this.#sectionsSnapshot) this.#sectionsSnapshot = this.#buildSectionsSnapshot()
    return this.#sectionsSnapshot
  }

  subscribeSections(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#sectionsListeners.add(listener)
    listener()
    return () => this.#sectionsListeners.delete(listener)
  }

  mountPickerElement(element: HTMLElement | undefined): void {
    if (this.#destroyed || this.#pickerElement === element) return
    this.#pickerElement = element
    this.#publishView()
  }

  unmountPickerElement(element?: HTMLElement): void {
    if (element && this.#pickerElement !== element) return
    if (!this.#pickerElement) return
    this.#pickerElement = undefined
    this.#publishView()
  }

  getPickerSnapshot(): PromptPickerSnapshot {
    if (!this.#pickerSnapshot) this.#pickerSnapshot = this.#buildPickerSnapshot()
    return this.#pickerSnapshot
  }

  subscribePicker(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#pickerListeners.add(listener)
    listener()
    return () => this.#pickerListeners.delete(listener)
  }

  movePicker(delta: -1 | 1): void {
    const count = this.#pickerOptionCount()
    if (count === 0) return
    this.#pickerIndex = (this.#pickerIndex + delta + count) % count
    this.#publishPicker()
  }

  activatePickerOption(index?: number): void {
    if (index !== undefined) this.#pickerIndex = Math.max(0, index)
    this.#activatePickerOption()
  }

  closePicker(): void {
    this.#closePicker()
  }

  renderReactSectionEditor(title: string, editor: HTMLElement): void {
    if (this.#destroyed) return
    const section =
      this.#document.sections.find((candidate) => candidate.title === title) ??
      (title === this.#preset.defaultSectionTitle && this.#document.sections.length === 0
        ? { title, parts: [] as PromptSectionPart[] }
        : undefined)
    if (!section) return
    const references = new Map(
      this.#references().map((reference) => [
        referenceKey(reference.mediaKind, reference.referenceId),
        reference,
      ]),
    )
    const subjects = new Map(
      this.#document.subjects.map((subject, index) => [
        subject.tag ?? subject.label ?? subject.subjectId ?? "",
        { subject, ordinal: index + 1 },
      ]),
    )
    const body = makePromptSectionBody(
      {
        prompt: this.#document,
        references: this.#references(),
        preset: this.#preset,
        locale: this.#locale,
      },
      section,
      references,
      subjects,
    )
    editor.replaceChildren(...body.childNodes)
  }

  renderReactRawEditor(editor: HTMLElement): void {
    if (this.#destroyed || this.#document.view !== "raw") return
    editor.replaceChildren()
    this.#appendPromptText(editor, renderAuthoringPrompt(this.#document, this.#references()))
  }

  renderReactDefinitionEditor(
    kind: PromptDefinitionKind,
    identity: string,
    editor: HTMLElement,
  ): void {
    if (this.#destroyed) return
    const tag = this.#definitionTag(kind, identity)
    if (!tag) return
    const documentForView = this.#shotDraft?.document ?? this.#document
    const definition =
      kind === "subject"
        ? documentForView.subjects.find(
            (subject) => (subject.tag ?? subject.label ?? subject.subjectId) === tag,
          )
        : documentForView.shots.find((shot) => shot.tag === tag)
    if (!definition) return
    const body = makePromptDefinitionBody(
      {
        prompt: documentForView,
        references: this.#references(),
        preset: this.#preset,
        locale: this.#locale,
      },
      kind,
      definition,
      Boolean(this.#shotDraft),
    )
    editor.replaceChildren(...body.childNodes)
  }

  handleReactSectionEntryInput(editor: HTMLElement, input?: PromptEditorInput): void {
    if (this.#destroyed || !editor.matches("[data-prompt-section-entry]")) return
    const isDeletion = input?.inputType?.startsWith("delete") ?? false
    if (isDeletion && this.#pickerMode === "alias") this.#closePicker()
    else this.#updatePickerQuery(true)
  }

  handleReactSectionEntryKeydown(event: KeyboardEvent): void {
    if (
      this.#destroyed ||
      !(event.target instanceof Element) ||
      !event.target.closest("[data-prompt-section-entry]")
    )
      return
    if (this.#handlePickerKeydown(event)) return
    if (event.key === "Enter") {
      event.preventDefault()
      this.#createSectionFromEntry()
    }
  }

  handleReactEditorPaste(event: ClipboardEvent): void {
    event.stopPropagation()
  }

  handleReactEditorBlur(): void {
    globalThis.setTimeout(() => {
      if (!this.#editorRoots.some((root) => root.contains(document.activeElement)))
        this.#closePicker()
    }, 0)
  }

  startSectionDrag(title: string, event: DragEvent): void {
    if (this.#destroyed) return
    this.#onSectionDragStart(event, title)
  }

  sectionDragOver(event: DragEvent): void {
    if (this.#destroyed) return
    this.#onSectionDragOver(event)
  }

  dropSection(event: DragEvent): void {
    if (this.#destroyed) return
    this.#onSectionDrop(event)
  }

  endSectionDrag(): void {
    if (this.#destroyed) return
    this.#clearSectionDrag()
  }

  startDefinitionDrag(kind: PromptDefinitionKind, identity: string, event: DragEvent): void {
    if (this.#destroyed) return
    this.#onDefinitionDragStart(kind, identity, event)
  }

  definitionDragOver(event: DragEvent): void {
    if (this.#destroyed) return
    this.#onDefinitionDragOver(event)
  }

  dropDefinition(event: DragEvent): void {
    if (this.#destroyed) return
    this.#onDefinitionDrop(event)
  }

  endDefinitionDrag(): void {
    if (this.#destroyed) return
    this.#clearDefinitionDrag()
  }

  removeSection(title: string): void {
    this.#removeSection(title)
  }

  handleReactEditorInput(
    _target: PromptEditorTarget | string,
    editor: HTMLElement,
    input?: PromptEditorInput,
  ): void {
    if (this.#destroyed || !this.#isReactTextEditor(editor)) return
    const isDefinitionEditor = editor.matches("[data-prompt-definition-body]")
    const subjectPickerWasOpen = this.#pickerMode === "subject"
    this.#syncDocumentFromEditor()
    this.#highlightTags(editor)
    this.#markReactEditorState(editor)
    if (input?.inputType?.startsWith("delete") && subjectPickerWasOpen) {
      this.#closePicker()
    } else {
      this.#updatePickerQuery(!input || input.data === "#" || subjectPickerWasOpen)
    }
    this.#notifyShots()
    if (isDefinitionEditor) this.#publishDefinitions()
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
  }

  handleReactEditorKeydown(event: KeyboardEvent): void {
    if (
      this.#destroyed ||
      !(event.target instanceof Node) ||
      !this.#isReactTextEditor(event.target)
    )
      return
    if (this.#removeAtomicAtCaret(event)) return
    this.#handlePickerKeydown(event)
  }

  moveSection(title: string, delta: -1 | 1): void {
    this.#moveSection(title, delta)
  }

  addDefinition(kind: PromptDefinitionKind): void {
    this.#addDefinition(kind)
  }

  renameDefinition(kind: PromptDefinitionKind, identity: string, value: string): boolean {
    const tag = this.#definitionTag(kind, identity)
    const next = normalizePromptTag(normalizeDefinitionTagValue(value.trim()).slice(1))
    if (!tag) return false
    if (!next || tag === next) {
      this.#publishDefinitions(true)
      return tag === next
    }
    return this.#renameDefinition(kind, tag, next)
  }

  reorderDefinition(kind: PromptDefinitionKind, identity: string, delta: -1 | 1): void {
    const tag = this.#definitionTag(kind, identity)
    if (tag) this.#moveDefinition(kind, tag, delta)
  }

  removeDefinition(kind: PromptDefinitionKind, identity: string): void {
    const tag = this.#definitionTag(kind, identity)
    if (tag) this.#removeDefinition(kind, tag)
  }

  setShotFrameByIdentity(identity: string, frameIndex: number): boolean {
    const tag = this.#definitionTag("shot", identity)
    return tag ? this.setShotFrame(tag, frameIndex) : false
  }

  clear(): void {
    this.#clearPrompt()
  }

  toggleView(): void {
    this.#toggleView()
  }

  copySource(): Promise<void> {
    return this.#copyPrompt(false)
  }

  copyCompiled(): Promise<void> {
    return this.#copyPrompt(true)
  }

  get presetId(): string {
    return this.#preset.id
  }

  get document(): PromptDocument {
    this.#syncDocumentFromEditor()
    return this.#document
  }

  get shots(): readonly PromptDocument["shots"][number][] {
    this.#syncDocumentFromEditor()
    return this.#shotDraft?.document.shots ?? this.#document.shots
  }

  subscribeShots(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#shotListeners.add(listener)
    listener()
    return () => this.#shotListeners.delete(listener)
  }

  setShotFrame(tag: string, frameIndex: number): boolean {
    if (this.#destroyed || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return false
    this.#syncDocumentFromEditor(false)
    const current = this.#document.shots.find((shot) => shot.tag === tag)
    if (!current || current.frameIndex === frameIndex) return Boolean(current)
    this.#recordGraphChange(() => {
      this.#document = {
        ...this.#document,
        shots: this.#document.shots.map((shot) =>
          shot.tag === tag ? { ...shot, frameIndex } : shot,
        ),
      }
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  setShotFrameDraft(tag: string, frameIndex: number): boolean {
    if (this.#destroyed || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return false
    this.#syncDocumentFromEditor(false)
    const current = (this.#shotDraft?.document.shots ?? this.#document.shots).find(
      (shot) => shot.tag === tag,
    )
    if (!current || current.frameIndex === frameIndex) return Boolean(current)
    this.#beginShotDraft()
    if (!this.#shotDraft) return false
    this.#shotDraft = {
      ...this.#shotDraft,
      document: {
        ...this.#shotDraft.document,
        shots: this.#shotDraft.document.shots.map((shot) =>
          shot.tag === tag ? { ...shot, frameIndex } : shot,
        ),
      },
    }
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  removeShot(tag: string): void {
    this.#syncDocumentFromEditor()
    if (!(this.#shotDraft?.document.shots ?? this.#document.shots).some((shot) => shot.tag === tag))
      return
    this.#beginShotDraft()
    if (!this.#shotDraft) return
    this.#shotDraft = {
      ...this.#shotDraft,
      document: {
        ...this.#shotDraft.document,
        shots: this.#shotDraft.document.shots.filter((shot) => shot.tag !== tag),
      },
    }
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  applyShotDraft(): boolean {
    if (this.#destroyed || !this.#shotDraft) return false
    this.#syncDocumentFromEditor()
    const document = {
      ...this.#shotDraft.document,
      subjects: this.#document.subjects,
      sections: this.#document.sections,
    }
    this.#shotDraft = undefined
    this.#recordGraphChange(() => {
      this.#document = document
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  cancelShotDraft(): boolean {
    if (this.#destroyed || !this.#shotDraft) return false
    this.#shotDraft = undefined
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  focusShot(tag: string): void {
    this.#definitionsRoot
      ?.querySelector<HTMLInputElement>(
        `[data-prompt-definition="shot"][data-prompt-definition-tag="${CSS.escape(tag)}"] [data-prompt-definition-tag-input]`,
      )
      ?.focus()
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
    this.#shotDraft = undefined
    this.#document = parsed.document
    this.#recoveredFromVersion = parsed.recoveredFromVersion
    this.#pendingRenderHint = parsed.issues.join(" ")
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
      this.#document = rebindPromptMentionsByOrder(this.#document, currentReferences)
    }
    const raw = this.#workspaceRoot?.querySelector<HTMLElement>("[data-prompt-editor]")
    if (this.#document.view === "raw") {
      if (raw && document.activeElement !== raw) {
        raw.replaceChildren()
        this.#appendPromptText(raw, renderAuthoringPrompt(this.#document, currentReferences))
      }
    }
    const references = new Map(
      currentReferences.map((reference) => [
        referenceKey(reference.mediaKind, reference.referenceId),
        reference,
      ]),
    )
    for (const editorRoot of this.#editorRoots) {
      for (const chip of editorRoot.querySelectorAll<HTMLElement>('[data-prompt-part="mention"]')) {
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
    }
    if (this.#pickerMode === "reference") this.#updateReferencePicker()
    this.#setHint()
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#shotListeners.clear()
    this.#viewListeners.clear()
    this.#definitionsListeners.clear()
    this.#sectionsListeners.clear()
    this.#pickerListeners.clear()
    this.#shotDraft = undefined
    this.#closePicker()
    this.#clearDefinitionDrag()
    this.#workspaceRoot = undefined
    this.#definitionsRoot = undefined
    this.#pickerElement = undefined
  }

  get #editorRoots(): readonly HTMLElement[] {
    const roots = this.#workspaceRoot ? [this.#workspaceRoot] : []
    if (this.#definitionsRoot) roots.push(this.#definitionsRoot)
    return roots
  }

  #isReactTextEditor(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest("[data-prompt-react-editor]"))
  }

  #definitionIdentity(kind: PromptDefinitionKind, tag: string): string {
    const identities = this.#definitionIdentities[kind]
    const existing = identities.get(tag)
    if (existing) return existing
    const identity = `${kind}-${++this.#definitionIdentityCounter}`
    identities.set(tag, identity)
    return identity
  }

  #definitionTag(kind: PromptDefinitionKind, identity: string): string | undefined {
    for (const [tag, candidate] of this.#definitionIdentities[kind])
      if (candidate === identity) return tag
    return undefined
  }

  #moveDefinitionIdentity(kind: PromptDefinitionKind, from: string, to: string): void {
    const identities = this.#definitionIdentities[kind]
    const identity = identities.get(from)
    if (!identity) return
    identities.delete(from)
    identities.set(to, identity)
  }

  #pruneDefinitionIdentities(document: PromptDocument): void {
    const current = {
      subject: new Set(
        document.subjects.map((subject) => subject.tag ?? subject.label ?? subject.subjectId ?? ""),
      ),
      shot: new Set(document.shots.map((shot) => shot.tag)),
    }
    for (const kind of ["subject", "shot"] as const)
      for (const tag of this.#definitionIdentities[kind].keys())
        if (!current[kind].has(tag)) this.#definitionIdentities[kind].delete(tag)
  }

  #definitionRecords(): {
    kind: PromptDefinitionKind
    tag: string
    identity: string
    ordinal: number
    frameIndex?: number
    parts: readonly PromptSectionPart[]
    placeholder: string
  }[] {
    this.#pruneDefinitionIdentities(this.#document)
    const subjects = this.#document.subjects.flatMap((subject, index) => {
      const tag = subject.tag ?? subject.label ?? subject.subjectId
      return tag
        ? [
            {
              kind: "subject" as const,
              tag,
              identity: this.#definitionIdentity("subject", tag),
              ordinal: index + 1,
              parts: subject.parts ?? [],
              placeholder: localize(
                this.#preset.subjectMode === "disabled"
                  ? PROMPT_MESSAGES.bodyPlaceholder
                  : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
                this.#locale,
              ),
            },
          ]
        : []
    })
    const shots = (this.#shotDraft?.document.shots ?? this.#document.shots).map((shot, index) => ({
      kind: "shot" as const,
      tag: shot.tag,
      identity: this.#definitionIdentity("shot", shot.tag),
      ordinal: index + 1,
      frameIndex: shot.frameIndex,
      parts: shot.parts,
      placeholder: localize(
        this.#preset.subjectMode === "disabled"
          ? PROMPT_MESSAGES.bodyPlaceholder
          : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
        this.#locale,
      ),
    }))
    return [...subjects, ...shots]
  }

  #buildDefinitionsSnapshot(): PromptDefinitionsSnapshot {
    const records = this.#definitionRecords()
    return {
      subjects: records.filter((record) => record.kind === "subject"),
      shots: records.filter((record) => record.kind === "shot"),
      draft: this.#shotDraft !== undefined,
      mounted: this.#definitionsRoot !== undefined,
    }
  }

  #buildSectionsSnapshot(): PromptSectionsSnapshot {
    const sections =
      this.#document.sections.length > 0
        ? this.#document.sections.map((section) => ({ section, isVirtual: false }))
        : this.#document.view === "structured"
          ? [{ section: { title: this.#preset.defaultSectionTitle, parts: [] }, isVirtual: true }]
          : []
    return {
      view: this.#document.view,
      sections: sections.map(({ section, isVirtual }) => {
        const accent = sectionColor(section.title)
        return {
          title: section.title,
          color: accent.color,
          colorIndex: accent.index,
          isVirtual,
          editor: "react-text" as const,
          text: plainTextSectionValue(section.parts) ?? "",
          parts: section.parts,
          placeholder: localize(
            this.#preset.subjectMode === "disabled"
              ? PROMPT_MESSAGES.bodyPlaceholder
              : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
            this.#locale,
          ),
          dragTitle:
            this.#locale === "ko"
              ? `${section.title} 섹션 순서 이동`
              : `Reorder ${section.title} section`,
          dragAria:
            this.#locale === "ko"
              ? `${section.title} 섹션 순서 이동. Alt와 위아래 화살표도 사용할 수 있습니다.`
              : `Reorder ${section.title} section. You can also use Alt plus Up or Down.`,
          removeTitle: this.#locale === "ko" ? `${section.title} 제거` : `Remove ${section.title}`,
          removeAria:
            this.#locale === "ko"
              ? `${section.title} 섹션 제거`
              : `Remove ${section.title} section`,
        }
      }),
      mounted: this.#workspaceRoot !== undefined,
    }
  }

  #buildPickerSnapshot(): PromptPickerSnapshot {
    const subjectTag = (subject: PromptSubject): string =>
      subject.tag ?? subject.label ?? subject.subjectId ?? ""
    const createSubjectLabel = this.#pickerCreateSubject
      ? localize(PROMPT_MESSAGES.createSubject, this.#locale).replace(
          "{label}",
          this.#pickerCreateSubject,
        )
      : ""
    const options: PromptPickerOption[] =
      this.#pickerMode === "reference"
        ? this.#pickerReferences.map((reference) => ({ kind: "reference", reference }))
        : this.#pickerMode === "subject"
          ? [
              ...this.#pickerSubjects.map((subject) => ({
                kind: "subject" as const,
                subject,
                ordinal:
                  this.#document.subjects.findIndex(
                    (candidate) => subjectTag(candidate) === subjectTag(subject),
                  ) + 1,
              })),
              ...this.#pickerShots.map((shot) => ({
                kind: "shot" as const,
                shot,
                ordinal: this.#document.shots.indexOf(shot) + 1,
              })),
              ...(this.#pickerCreateSubject
                ? [
                    {
                      kind: "create-subject" as const,
                      label: this.#pickerCreateSubject,
                      createLabel: createSubjectLabel,
                      createDetail: localize(PROMPT_MESSAGES.createSubjectDetail, this.#locale),
                    },
                  ]
                : []),
            ]
          : this.#pickerMode === "alias"
            ? this.#pickerAliases.map((alias) => ({
                kind: "alias" as const,
                alias,
                label: localize(alias.label, this.#locale),
                description: localize(alias.description, this.#locale),
              }))
            : []
    const emptyMessage =
      this.#pickerMode === "alias"
        ? localize(PROMPT_MESSAGES.noAliases, this.#locale)
        : this.#pickerMode === "subject"
          ? localize(PROMPT_MESSAGES.noSubjects, this.#locale)
          : localize(PROMPT_MESSAGES.noReferences, this.#locale)
    return {
      visible: this.#pickerMode !== undefined,
      mode: this.#pickerMode,
      activeIndex: this.#pickerIndex,
      options,
      emptyMessage,
      createSubjectLabel,
      createSubjectDetail: localize(PROMPT_MESSAGES.createSubjectDetail, this.#locale),
      target: this.#pickerTarget,
    }
  }

  #publishPicker(): void {
    this.#placePicker()
    const next = this.#buildPickerSnapshot()
    const previous = this.#pickerSnapshot
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
    this.#pickerSnapshot = next
    for (const listener of this.#pickerListeners) listener()
  }

  #publishSections(): void {
    const next = this.#buildSectionsSnapshot()
    const previous = this.#sectionsSnapshot
    const same =
      previous &&
      previous.view === next.view &&
      previous.mounted === next.mounted &&
      previous.sections.length === next.sections.length &&
      previous.sections.every((section, index) => {
        const candidate = next.sections[index]
        return (
          candidate &&
          section.title === candidate.title &&
          section.color === candidate.color &&
          section.colorIndex === candidate.colorIndex &&
          section.isVirtual === candidate.isVirtual &&
          section.editor === candidate.editor &&
          section.text === candidate.text &&
          JSON.stringify(section.parts) === JSON.stringify(candidate.parts) &&
          section.placeholder === candidate.placeholder &&
          section.dragTitle === candidate.dragTitle &&
          section.dragAria === candidate.dragAria &&
          section.removeTitle === candidate.removeTitle &&
          section.removeAria === candidate.removeAria
        )
      })
    if (same) return
    this.#sectionsSnapshot = next
    for (const listener of this.#sectionsListeners) listener()
  }

  #publishDefinitions(force = false): void {
    const next = this.#buildDefinitionsSnapshot()
    const previous = this.#definitionsSnapshot
    const sameRecords = (
      left: readonly PromptDefinitionSnapshot[],
      right: readonly PromptDefinitionSnapshot[],
    ): boolean =>
      left.length === right.length &&
      left.every(
        (record, index) =>
          record.identity === right[index]?.identity &&
          record.kind === right[index]?.kind &&
          record.tag === right[index]?.tag &&
          record.ordinal === right[index]?.ordinal &&
          record.frameIndex === right[index]?.frameIndex &&
          record.placeholder === right[index]?.placeholder &&
          JSON.stringify(record.parts) === JSON.stringify(right[index]?.parts),
      )
    if (
      !force &&
      previous &&
      previous.draft === next.draft &&
      previous.mounted === next.mounted &&
      sameRecords(previous.subjects, next.subjects) &&
      sameRecords(previous.shots, next.shots)
    )
      return
    this.#definitionsSnapshot = next
    for (const listener of this.#definitionsListeners) listener()
  }

  #setHint(issue = ""): void {
    const stale = this.#editorRoots.reduce(
      (count, root) => count + root.querySelectorAll(".rl-prompt-mention.is-stale").length,
      0,
    )
    const recovery = this.#recoveredFromVersion
      ? localize(PROMPT_MESSAGES.legacyRecovered, this.#locale).replace(
          "{version}",
          String(this.#recoveredFromVersion),
        )
      : ""
    this.#hintText = issue || recovery || (stale ? `${stale} unavailable reference mention.` : "")
    this.#publishView()
  }

  #buildViewSnapshot(): PromptViewSnapshot {
    const presetLabel = localize(this.#preset.label, this.#locale)
    return {
      view: this.#document.view,
      presetId: this.#preset.id,
      presetLabel,
      presetDescription: localize(this.#preset.description, this.#locale),
      editorAria: localize(PROMPT_MESSAGES.editorAria, this.#locale),
      clearLabel: localize(PROMPT_MESSAGES.clear, this.#locale),
      clearTitle: localize(PROMPT_MESSAGES.clearTitle, this.#locale),
      clearAria: localize(PROMPT_MESSAGES.clearAria, this.#locale),
      toggleAria: localize(PROMPT_MESSAGES.toggleAria, this.#locale),
      structuredLabel: localize(PROMPT_MESSAGES.structured, this.#locale),
      rawLabel: localize(PROMPT_MESSAGES.raw, this.#locale),
      backToStructuredTitle: localize(PROMPT_MESSAGES.backToStructured, this.#locale),
      showRawTitle: localize(PROMPT_MESSAGES.showRaw, this.#locale),
      title: localize(PROMPT_MESSAGES.prompt, this.#locale),
      subtitle: localize(
        this.#preset.subjectMode === "disabled"
          ? PROMPT_MESSAGES.subtitle
          : PROMPT_MESSAGES.subtitleWithSubjects,
        this.#locale,
      ),
      rawPlaceholder: localize(PROMPT_MESSAGES.rawPlaceholder, this.#locale),
      sectionEntryPlaceholder: localize(PROMPT_MESSAGES.addSectionPlaceholder, this.#locale),
      sectionEntryAria: localize(PROMPT_MESSAGES.addSectionAria, this.#locale),
      sourceText: renderAuthoringPrompt(this.#document, this.#references()),
      compiledText: compilePromptDocument(this.#document, this.#references()),
      canClear: this.#document.sections.length > 0,
      hint: this.#hintText,
      nativeHosts: {
        workspace: this.#workspaceRoot !== undefined,
        picker: this.#pickerElement !== undefined,
        definitions: this.#definitionsRoot !== undefined,
      },
    }
  }

  #publishView(): void {
    this.#publishSections()
    this.#publishPicker()
    const next = this.#buildViewSnapshot()
    const previous = this.#viewSnapshot
    if (
      previous &&
      previous.view === next.view &&
      previous.presetId === next.presetId &&
      previous.presetLabel === next.presetLabel &&
      previous.presetDescription === next.presetDescription &&
      previous.editorAria === next.editorAria &&
      previous.clearLabel === next.clearLabel &&
      previous.clearTitle === next.clearTitle &&
      previous.clearAria === next.clearAria &&
      previous.toggleAria === next.toggleAria &&
      previous.structuredLabel === next.structuredLabel &&
      previous.rawLabel === next.rawLabel &&
      previous.backToStructuredTitle === next.backToStructuredTitle &&
      previous.showRawTitle === next.showRawTitle &&
      previous.title === next.title &&
      previous.subtitle === next.subtitle &&
      previous.rawPlaceholder === next.rawPlaceholder &&
      previous.sectionEntryPlaceholder === next.sectionEntryPlaceholder &&
      previous.sectionEntryAria === next.sectionEntryAria &&
      previous.sourceText === next.sourceText &&
      previous.compiledText === next.compiledText &&
      previous.canClear === next.canClear &&
      previous.hint === next.hint &&
      previous.nativeHosts.workspace === next.nativeHosts.workspace &&
      previous.nativeHosts.picker === next.nativeHosts.picker &&
      previous.nativeHosts.definitions === next.nativeHosts.definitions
    )
      return
    this.#viewSnapshot = next
    for (const listener of this.#viewListeners) listener()
  }

  #appendPromptText(container: HTMLElement, value: string): void {
    appendPromptText(container, value, createPromptTagVisuals(this.#document))
  }

  #highlightTags(container: HTMLElement): void {
    highlightPromptTags(container, createPromptTagVisuals(this.#document))
  }

  #markReactEditorState(editor: HTMLElement): void {
    const value = editor.matches("[data-prompt-raw-editor]")
      ? renderAuthoringPrompt(this.#document, this.#references())
      : JSON.stringify(sectionPartsFromContainer(editor))
    editor.dataset.promptEditorState = promptContentFingerprint(value)
  }

  #renderEditor(): void {
    const renderHint = this.#pendingRenderHint
    this.#pendingRenderHint = undefined
    this.#publishDefinitions()
    this.#publishSections()
    this.#setHint(renderHint)
  }

  #syncDocumentFromEditor(syncShotFrames = true): void {
    if (this.#destroyed) return
    const workspace = this.#workspaceRoot
    if (this.#document.view === "raw") {
      const editor = workspace?.querySelector<HTMLElement>("[data-prompt-editor]")
      if (editor) {
        const parsed = parseRawPrompt(
          textContentWithBreaks(editor),
          this.#references(),
          "raw",
          this.#document,
        )
        this.#document = parsed
      }
      this.#syncDefinitionsFromEditor(syncShotFrames)
      return
    }
    const sections = Array.from(
      workspace?.querySelectorAll<HTMLElement>("[data-prompt-section-body]") ?? [],
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
      subjects: this.#document.subjects,
      sections,
    }
    this.#syncDefinitionsFromEditor(syncShotFrames)
  }

  #syncDefinitionsFromEditor(syncShotFrames = true): void {
    const definitions = this.#definitionsRoot
    if (!definitions) return
    const subjects = this.#document.subjects.map((subject) => {
      const tag = subject.tag ?? subject.label ?? subject.subjectId ?? ""
      const card = definitions.querySelector<HTMLElement>(
        `[data-prompt-definition="subject"][data-prompt-definition-tag="${CSS.escape(tag)}"]`,
      )
      const body = card?.querySelector<HTMLElement>("[data-prompt-definition-body]")
      if (!body) return subject
      const parts = sectionPartsFromContainer(body)
      return { ...subject, parts }
    })
    if (this.#shotDraft) {
      this.#document = { ...this.#document, subjects }
      return
    }
    const shots = this.#document.shots.map((shot) => {
      const card = definitions.querySelector<HTMLElement>(
        `[data-prompt-definition="shot"][data-prompt-definition-tag="${CSS.escape(shot.tag)}"]`,
      )
      const body = card?.querySelector<HTMLElement>("[data-prompt-definition-body]")
      const frame = card?.querySelector<HTMLInputElement>("[data-prompt-shot-frame]")
      const value = frame ? Number(frame.value) : shot.frameIndex
      if (!body || !Number.isSafeInteger(value) || value < 0) return shot
      const parts = sectionPartsFromContainer(body)
      return {
        ...shot,
        ...(syncShotFrames ? { frameIndex: value } : {}),
        parts,
      }
    })
    this.#document = { ...this.#document, subjects, shots }
  }

  #notifyShots(): void {
    for (const listener of this.#shotListeners) listener()
  }

  #renameDefinition(kind: PromptDefinitionKind, from: string, to: string): boolean {
    this.#syncDocumentFromEditor()
    if (
      [...this.#document.subjects, ...this.#document.shots].some(
        (definition) => definition.tag === to,
      )
    ) {
      this.#setHint("Subject and Shot tags must be unique.")
      this.#renderEditor()
      this.#publishDefinitions(true)
      return false
    }
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#moveDefinitionIdentity(kind, from, to)
      this.#document = renamePromptTag(this.#document, from, to)
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  #addDefinition(kind: "subject" | "shot"): void {
    if (this.#shotDraft) {
      this.#setHint("Apply or cancel the current Shot timing edit first.")
      return
    }
    this.#syncDocumentFromEditor()
    let index = 1
    let tag = `${kind}_${index}`
    while (
      [...this.#document.subjects, ...this.#document.shots].some(
        (definition) => definition.tag === tag,
      )
    )
      tag = `${kind}_${++index}`
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#document =
        kind === "subject"
          ? { ...this.#document, subjects: [...this.#document.subjects, { tag, parts: [] }] }
          : {
              ...this.#document,
              shots: [...this.#document.shots, { tag, frameIndex: 0, parts: [] }],
            }
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #removeDefinition(kind: "subject" | "shot", tag: string): void {
    if (this.#shotDraft) {
      this.#setHint("Apply or cancel the current Shot timing edit first.")
      return
    }
    this.#syncDocumentFromEditor()
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#document =
        kind === "subject"
          ? {
              ...this.#document,
              subjects: this.#document.subjects.filter((subject) => subject.tag !== tag),
            }
          : { ...this.#document, shots: this.#document.shots.filter((shot) => shot.tag !== tag) }
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #moveDefinition(kind: "subject" | "shot", tag: string, delta: -1 | 1): void {
    if (this.#shotDraft) {
      this.#setHint("Apply or cancel the current Shot timing edit first.")
      return
    }
    this.#syncDocumentFromEditor()
    const values = kind === "subject" ? [...this.#document.subjects] : [...this.#document.shots]
    const index = values.findIndex((definition) => definition.tag === tag)
    const target = Math.max(0, Math.min(values.length - 1, index + delta))
    if (index < 0 || index === target) return
    const [item] = values.splice(index, 1)
    if (!item) return
    values.splice(target, 0, item)
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#document =
        kind === "subject"
          ? { ...this.#document, subjects: values as PromptDocument["subjects"] }
          : { ...this.#document, shots: values as PromptDocument["shots"] }
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #handlePickerKeydown(event: KeyboardEvent): boolean {
    if (this.#pickerMode === undefined || !this.#pickerElement || this.#pickerElement.hidden)
      return false
    const count = this.#pickerOptionCount()
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      this.movePicker(event.key === "ArrowDown" ? 1 : -1)
      return true
    }
    if (event.key === "Enter" && count > 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      this.#activatePickerOption()
      return true
    }
    if (event.key === "Escape") {
      event.preventDefault()
      this.#closePicker()
      return true
    }
    return false
  }

  #removeAtomicAtCaret(event: KeyboardEvent): boolean {
    if (
      (event.key !== "Backspace" && event.key !== "Delete") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return false
    const selection = globalThis.getSelection?.()
    if (!selection?.isCollapsed || selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    const body = (event.target as Element).closest<HTMLElement>(
      "[data-prompt-section-body], [data-prompt-definition-body], [data-prompt-editor]",
    )
    if (!body) return false
    const tag =
      event.key === "Backspace"
        ? previousPromptAtomicAtCaret(body, range.startContainer, range.startOffset)
        : nextPromptAtomicAtCaret(body, range.startContainer, range.startOffset)
    if (!tag?.parentNode) return false
    event.preventDefault()
    const parent = tag.parentNode
    const index = Array.prototype.indexOf.call(parent.childNodes, tag)
    const reactEditor =
      parent instanceof Element
        ? parent.closest<HTMLElement>("[data-prompt-react-editor]")
        : undefined
    this.#closePicker()
    tag.remove()
    placeCaretAfterRemovedNode(parent, index)
    this.#syncDocumentFromEditor()
    if (reactEditor) this.#markReactEditorState(reactEditor)
    this.#notifyShots()
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
    return true
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
    if (this.#document.sections.length === 0) return
    this.#document = { ...this.#document, sections: [] }
    this.#closePicker()
    this.#renderEditor()
    this.#setHint(localize(PROMPT_MESSAGES.cleared, this.#locale))
    this.#node.setDirtyCanvas(true, true)
  }

  #beginShotDraft(): void {
    if (this.#shotDraft) return
    this.#shotDraft = {
      initial: this.#document,
      document: this.#document,
    }
  }

  async #copyPrompt(compiled: boolean): Promise<void> {
    this.#syncDocumentFromEditor()
    const prompt = compiled
      ? compilePromptDocument(this.#document, this.#references())
      : renderAuthoringPrompt(this.#document, this.#references())
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
    const entry = this.#workspaceRoot?.querySelector<HTMLElement>("[data-prompt-section-entry]")
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
    const entry = this.#workspaceRoot?.querySelector<HTMLElement>("[data-prompt-section-entry]")
    const existing = this.#workspaceRoot?.querySelector<HTMLElement>(
      `[data-prompt-section-body="${CSS.escape(title)}"]`,
    )
    if (existing) {
      if (entry) entry.textContent = ""
      this.#closePicker()
      placeCaretAtEnd(existing)
      return
    }
    this.#document.sections.push({ title, parts: [] })
    this.#closePicker()
    this.#renderEditor()
    const body = this.#workspaceRoot?.querySelector<HTMLElement>(
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
      subjects: this.#document.subjects,
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
      this.#workspaceRoot
        ?.querySelector<HTMLElement>(`[data-prompt-section-drag-handle="${CSS.escape(title)}"]`)
        ?.focus()
    })
  }

  #onSectionDragStart(event: DragEvent, explicitTitle?: string): void {
    const handle =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-section-drag-handle]")
        : undefined
    const section =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-section]")
        : undefined
    const title = explicitTitle ?? handle?.dataset.promptSectionDragHandle
    if (!title || this.#document.view !== "structured") {
      event.preventDefault()
      return
    }
    this.#syncDocumentFromEditor()
    this.#draggedSectionTitle = title
    event.dataTransfer?.setData(PROMPT_SECTION_DRAG_MIME, title)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    const dragSection = section ?? handle?.closest<HTMLElement>("[data-prompt-section]")
    dragSection?.classList.add("is-dragging")
    event.stopPropagation()
  }

  #onDefinitionDragStart(kind: PromptDefinitionKind, identity: string, event: DragEvent): void {
    const tag = this.#definitionTag(kind, identity)
    const card =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-definition]")
        : undefined
    if (!tag || this.#shotDraft) {
      event.preventDefault()
      return
    }
    this.#syncDocumentFromEditor()
    this.#draggedDefinition = { kind, tag }
    event.dataTransfer?.setData(PROMPT_DEFINITION_DRAG_MIME, `${kind}:${tag}`)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    card?.classList.add("is-dragging")
    event.stopPropagation()
  }

  #onDefinitionDragOver(event: DragEvent): void {
    const source = this.#draggedDefinition
    if (!source) return
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-definition]")
        : undefined
    if (
      !target ||
      target.dataset.promptDefinition !== source.kind ||
      target.dataset.promptDefinitionTag === source.tag
    ) {
      this.#setDefinitionDropTarget(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const bounds = target.getBoundingClientRect()
    this.#setDefinitionDropTarget(target, event.clientY >= bounds.top + bounds.height / 2)
  }

  #onDefinitionDrop(event: DragEvent): void {
    const source = this.#draggedDefinition
    const target = this.#definitionDropTarget
    const targetKind = target?.dataset.promptDefinition
    const targetTag = target?.dataset.promptDefinitionTag
    const after = this.#definitionDropAfter
    if (
      !source ||
      !target ||
      targetKind !== source.kind ||
      !targetTag ||
      source.tag === targetTag
    ) {
      this.#clearDefinitionDrag()
      return
    }
    event.preventDefault()
    event.stopPropagation()
    this.#syncDocumentFromEditor()
    const values =
      source.kind === "subject" ? [...this.#document.subjects] : [...this.#document.shots]
    const sourceIndex = values.findIndex((definition) => definition.tag === source.tag)
    if (sourceIndex < 0) {
      this.#clearDefinitionDrag()
      return
    }
    const [item] = values.splice(sourceIndex, 1)
    if (!item) {
      this.#clearDefinitionDrag()
      return
    }
    const targetIndex = values.findIndex((definition) => definition.tag === targetTag)
    if (targetIndex < 0) {
      this.#clearDefinitionDrag()
      return
    }
    values.splice(targetIndex + (after ? 1 : 0), 0, item)
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#document =
        source.kind === "subject"
          ? { ...this.#document, subjects: values as PromptDocument["subjects"] }
          : { ...this.#document, shots: values as PromptDocument["shots"] }
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    this.#clearDefinitionDrag()
  }

  #setDefinitionDropTarget(target: HTMLElement | undefined, after = false): void {
    if (this.#definitionDropTarget === target && this.#definitionDropAfter === after) return
    this.#definitionDropTarget?.classList.remove("is-drop-before", "is-drop-after")
    this.#definitionDropTarget = target
    this.#definitionDropAfter = after
    target?.classList.add(after ? "is-drop-after" : "is-drop-before")
  }

  #clearDefinitionDrag(): void {
    this.#setDefinitionDropTarget(undefined)
    this.#definitionsRoot
      ?.querySelectorAll<HTMLElement>("[data-prompt-definition].is-dragging")
      ?.forEach((card) => card.classList.remove("is-dragging"))
    this.#draggedDefinition = undefined
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
    this.#workspaceRoot
      ?.querySelectorAll<HTMLElement>("[data-prompt-section].is-dragging")
      ?.forEach((section) => section.classList.remove("is-dragging"))
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

  #updatePickerQuery(canOpenSubjectPicker = true): void {
    const entry = this.#workspaceRoot?.querySelector<HTMLElement>("[data-prompt-section-entry]")
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
    const body = closestPromptBody(this.#editorRoots, container)
    if (container.nodeType !== Node.TEXT_NODE || !body) {
      this.#closePicker()
      return
    }
    const before = (container.textContent ?? "").slice(0, caret.startOffset)
    const referenceMatch = before.match(/@([^\s@]*)$/u)
    const subjectMatch = before.match(/#([^\s#]*)$/u)
    const match = referenceMatch ?? subjectMatch
    if (!match) return this.#closePicker()
    const range = document.createRange()
    range.setStart(container, caret.startOffset - (match[0]?.length ?? 0))
    range.setEnd(container, caret.startOffset)
    this.#pickerRange = range
    this.#pickerAnchor = body.closest<HTMLElement>("[data-prompt-section]") ?? body
    if (referenceMatch) this.#updateReferencePicker(match[1] ?? "")
    else if (canOpenSubjectPicker) this.#updateSubjectPicker(subjectMatch?.[1] ?? "", body)
    else this.#closePicker()
  }

  #updateReferencePicker(query = ""): void {
    this.#pickerMode = "reference"
    this.#pickerSubjects = []
    this.#pickerShots = []
    this.#pickerCreateSubject = undefined
    this.#pickerAliases = []
    const normalized = query.trim().toLowerCase()
    this.#pickerReferences = this.#references().filter((reference) =>
      [reference.label, reference.filename, reference.tag, reference.mediaKind].some((value) =>
        value.toLowerCase().includes(normalized),
      ),
    )
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerReferences.length - 1))
    this.#publishPicker()
  }

  #updateSubjectPicker(query: string, body: HTMLElement | undefined): void {
    this.#pickerMode = "subject"
    this.#pickerReferences = []
    this.#pickerAliases = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerSubjects = this.#document.subjects.filter((subject, index) =>
      [
        subject.tag ?? subject.label ?? subject.subjectId ?? "",
        `subject${index + 1}`,
        `<Subject ${index + 1}>`,
      ].some((value) => value.toLocaleLowerCase().includes(normalized)),
    )
    this.#pickerShots = this.#document.shots.filter((shot) =>
      shot.tag.toLocaleLowerCase().includes(normalized),
    )
    const label = normalizeSubjectLabel(query)
    const creationAllowed =
      this.#preset.subjectMode === "anywhere" ||
      (this.#preset.subjectMode === "definitions" &&
        (body?.dataset.promptSectionBody === "subject_definitions" ||
          body?.hasAttribute("data-prompt-definition-body")))
    this.#pickerCreateSubject =
      creationAllowed &&
      label &&
      ![...this.#document.subjects, ...this.#document.shots].some(
        (definition) =>
          (
            definition.tag ??
            ("label" in definition ? definition.label : undefined) ??
            ("subjectId" in definition ? definition.subjectId : undefined) ??
            ""
          ).toLowerCase() === label.toLowerCase(),
      )
        ? label
        : undefined
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerOptionCount() - 1))
    this.#publishPicker()
  }

  #updateAliasPicker(query = ""): void {
    this.#pickerMode = "alias"
    this.#pickerRange = undefined
    this.#pickerReferences = []
    this.#pickerSubjects = []
    this.#pickerShots = []
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
    this.#publishPicker()
  }

  #placePicker(): void {
    const anchor = this.#pickerAnchor
    const definition = anchor?.closest<HTMLElement>("[data-prompt-definition]")
    const section = anchor?.closest<HTMLElement>("[data-prompt-section]")
    const entry = anchor?.matches("[data-prompt-section-entry]") ? anchor : undefined
    const editor = anchor?.matches("[data-prompt-editor]") ? anchor : undefined
    this.#pickerTarget =
      this.#pickerMode === "alias"
        ? entry?.previousElementSibling instanceof HTMLElement
          ? entry.previousElementSibling
          : undefined
        : (definition?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
          section?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
          (editor?.previousElementSibling instanceof HTMLElement
            ? editor.previousElementSibling
            : undefined))
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
    const reactEditor = chip.closest<HTMLElement>("[data-prompt-react-editor]")
    this.#closePicker()
    this.#syncDocumentFromEditor()
    if (reactEditor) this.#markReactEditorState(reactEditor)
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertSubject(subject: PromptSubject | undefined): void {
    if (!subject || !this.#pickerRange) return
    const selection = globalThis.getSelection?.()
    this.#pickerRange.deleteContents()
    const text = document.createTextNode(`#${subject.tag} `)
    this.#pickerRange.insertNode(text)
    const range = document.createRange()
    range.setStartAfter(text)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const reactEditor = text.parentElement?.closest<HTMLElement>("[data-prompt-react-editor]")
    this.#closePicker()
    this.#syncDocumentFromEditor()
    if (reactEditor) this.#markReactEditorState(reactEditor)
    const body = text.parentElement?.closest<HTMLElement>(
      "[data-prompt-section-body], [data-prompt-definition-body], [data-prompt-editor]",
    )
    if (body) this.#highlightTags(body)
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
  }

  #insertShot(shot: PromptDocument["shots"][number] | undefined): void {
    if (!shot || !this.#pickerRange) return
    const selection = globalThis.getSelection?.()
    this.#pickerRange.deleteContents()
    const text = document.createTextNode(`#${shot.tag} `)
    this.#pickerRange.insertNode(text)
    const range = document.createRange()
    range.setStartAfter(text)
    range.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(range)
    const reactEditor = text.parentElement?.closest<HTMLElement>("[data-prompt-react-editor]")
    this.#closePicker()
    this.#syncDocumentFromEditor()
    if (reactEditor) this.#markReactEditorState(reactEditor)
    const body = text.parentElement?.closest<HTMLElement>(
      "[data-prompt-section-body], [data-prompt-definition-body], [data-prompt-editor]",
    )
    if (body) this.#highlightTags(body)
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
  }

  #createAndInsertSubject(label: string | undefined): void {
    if (!label) return
    const subject = { tag: label, parts: [] as PromptSectionPart[] }
    if (this.#document.subjects.some((candidate) => candidate.tag === label)) return
    this.#document.subjects.push(subject)
    this.#insertSubject(subject)
  }

  #insertAlias(alias: PromptAlias | undefined): void {
    if (alias) this.#addOrFocusSection(alias.title)
  }

  #pickerOptionCount(): number {
    if (this.#pickerMode === "alias") return this.#pickerAliases.length
    if (this.#pickerMode === "subject")
      return (
        this.#pickerSubjects.length + this.#pickerShots.length + (this.#pickerCreateSubject ? 1 : 0)
      )
    return this.#pickerReferences.length
  }

  #activatePickerOption(): void {
    if (this.#pickerMode === "alias") this.#insertAlias(this.#pickerAliases[this.#pickerIndex])
    else if (this.#pickerMode === "subject") {
      if (this.#pickerIndex < this.#pickerSubjects.length)
        this.#insertSubject(this.#pickerSubjects[this.#pickerIndex])
      else if (this.#pickerIndex < this.#pickerSubjects.length + this.#pickerShots.length)
        this.#insertShot(this.#pickerShots[this.#pickerIndex - this.#pickerSubjects.length])
      else this.#createAndInsertSubject(this.#pickerCreateSubject)
    } else this.#insertMention(this.#pickerReferences[this.#pickerIndex])
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
    this.#pickerTarget = undefined
    this.#publishPicker()
  }
}
