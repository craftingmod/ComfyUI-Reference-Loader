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
import {
  makePromptDefinitions,
  makePromptSectionBody,
  makePromptSectionCard,
  makePromptDefinitionBody,
  type PromptCardContext,
} from "./prompt-cards.ts"
import {
  appendPromptText,
  closestPromptBody,
  createPromptTagVisuals,
  highlightPromptTags,
  makeMentionChip,
  makeReferenceVisual,
  normalizeDefinitionTagInput,
  normalizeDefinitionTagValue,
  nextPromptAtomicAtCaret,
  placeCaretAfterRemovedNode,
  placeCaretAtEnd,
  promptContentFingerprint,
  previousPromptAtomicAtCaret,
  referenceKey,
  sectionColor,
  sectionPartsFromContainer,
  SHOT_COLOR,
  subjectColor,
  textContentWithBreaks,
} from "./prompt-dom.ts"

type ReferenceProvider = () => readonly PromptReference[]

export interface ReferencePromptControllerOptions {
  presetId?: unknown
  presetCatalog?: unknown
  locale?: PromptLocale
  legacyShell?: boolean
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
  readonly editor: "native" | "react-text"
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
  readonly root: HTMLElement
  #legacyShell: boolean
  #workspaceRoot: HTMLElement | undefined
  #sectionHosts = new Map<string, HTMLElement>()
  #sectionEntryHost: HTMLElement | undefined
  #rawEditorHost: HTMLElement | undefined
  #definitionsRoot: HTMLElement | undefined
  #definitionHosts = new Map<string, HTMLElement>()
  #pickerHost: HTMLElement | undefined
  #node: ComfyNode
  #references: ReferenceProvider
  #document: PromptDocument
  #destroyController = new AbortController()
  #nativeHostController: AbortController | undefined
  #definitionsController: AbortController | undefined
  #hintElement: HTMLElement | undefined
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
  #presetCatalog: PromptPresetCatalog
  #preset: PromptPreset
  #locale: PromptLocale
  #recoveredFromVersion: number | undefined
  #hintText = ""
  #pendingRenderHint: string | undefined
  #composing = false
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
    root: HTMLElement,
    node: ComfyNode,
    references: ReferenceProvider,
    serialized: unknown,
    options: ReferencePromptControllerOptions = {},
  ) {
    this.root = root
    this.#legacyShell = options.legacyShell !== false
    this.#node = node
    this.#references = references
    this.#presetCatalog = normalizePromptPresetCatalog(options.presetCatalog)
    this.#preset = resolvePromptPreset(options.presetId, this.#presetCatalog)
    this.#locale = options.locale ?? detectPromptLocale()
    const parsed = deserializePromptDocument(serialized)
    this.#document = parsed.document
    this.#recoveredFromVersion = parsed.recoveredFromVersion
    this.#viewSnapshot = this.#buildViewSnapshot()
    if (this.#legacyShell) this.#mount(parsed.issues.join(" "))
    else {
      this.#pendingRenderHint = parsed.issues.join(" ")
      this.#setHint(this.#pendingRenderHint)
    }
  }

  mountDefinitions(root: HTMLElement | undefined): void {
    if (this.#destroyed || this.#definitionsRoot === root) return
    this.#definitionsController?.abort()
    this.#definitionsController = undefined
    this.#definitionsRoot?.replaceChildren()
    this.#definitionHosts.clear()
    this.#definitionsRoot = root
    if (root) {
      root.classList.add("reference-prompt-definitions")
      this.#definitionsController = new AbortController()
      if (this.#legacyShell)
        this.#installEditableRootEvents(root, this.#definitionsController.signal, true)
    }
    this.#renderEditor()
    this.#publishDefinitions()
  }

  mountDefinitionHosts(hosts: ReadonlyMap<string, HTMLElement>): void {
    if (this.#destroyed) return
    if (
      hosts.size === this.#definitionHosts.size &&
      [...hosts].every(([identity, host]) => this.#definitionHosts.get(identity) === host)
    )
      return
    this.#definitionHosts = new Map(hosts)
    this.#renderDefinitionBodies()
  }

  unmountDefinitionHosts(): void {
    if (this.#definitionHosts.size === 0) return
    if (this.#legacyShell) for (const host of this.#definitionHosts.values()) host.replaceChildren()
    this.#definitionHosts.clear()
  }

  mountSectionHosts(
    hosts: ReadonlyMap<string, HTMLElement>,
    entryHost: HTMLElement | undefined,
  ): void {
    if (this.#destroyed) return
    if (
      hosts.size === this.#sectionHosts.size &&
      [...hosts].every(([title, host]) => this.#sectionHosts.get(title) === host) &&
      this.#sectionEntryHost === entryHost
    )
      return
    this.#sectionHosts = new Map(hosts)
    this.#sectionEntryHost = entryHost
    this.#renderEditor()
  }

  unmountSectionHosts(): void {
    if (this.#sectionHosts.size === 0 && !this.#sectionEntryHost) return
    this.#sectionHosts.clear()
    this.#sectionEntryHost = undefined
  }

  mountRawEditorHost(host: HTMLElement | undefined): void {
    if (this.#destroyed || this.#rawEditorHost === host) return
    this.#rawEditorHost = host
    this.#renderEditor()
  }

  unmountRawEditorHost(): void {
    if (!this.#rawEditorHost) return
    this.#rawEditorHost = undefined
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

  mountNativeHosts(workspace: HTMLElement | undefined, pickerHost: HTMLElement | undefined): void {
    if (
      this.#destroyed ||
      (this.#workspaceRoot === workspace &&
        this.#pickerHost === pickerHost &&
        this.#nativeHostController !== undefined)
    )
      return
    if (
      this.#workspaceRoot !== undefined ||
      this.#pickerHost !== undefined ||
      this.#nativeHostController !== undefined
    )
      this.unmountNativeHosts()
    this.#workspaceRoot = workspace
    this.#pickerHost = pickerHost
    this.#nativeHostController = new AbortController()
    const signal = this.#nativeHostController.signal
    if (workspace) {
      if (this.#legacyShell) this.#installEditableRootEvents(workspace, signal, false)
      this.#installWorkspaceEvents(workspace, signal, this.#legacyShell)
    }
    if (pickerHost && this.#legacyShell) {
      const picker = document.createElement("div")
      picker.className = "rl-prompt-picker"
      picker.dataset.promptPicker = ""
      picker.setAttribute("role", "listbox")
      picker.hidden = true
      pickerHost.replaceChildren(picker)
      this.#pickerElement = picker
      this.#installPickerEvents(picker, signal)
    }
    this.#renderEditor()
    this.#publishView()
  }

  unmountNativeHosts(): void {
    this.#closePicker()
    this.#nativeHostController?.abort()
    this.#nativeHostController = undefined
    if (this.#legacyShell) this.#workspaceRoot?.replaceChildren()
    else {
      this.unmountSectionHosts()
      this.unmountRawEditorHost()
    }
    if (this.#legacyShell && this.#pickerHost) this.#pickerHost.replaceChildren()
    this.#workspaceRoot = undefined
    this.#pickerHost = undefined
    this.#pickerElement = undefined
    this.#publishSections()
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
    if (this.#legacyShell) this.#updatePickerSelection()
    else this.#publishPicker()
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
    if (this.#destroyed || this.#legacyShell) return
    this.#onSectionDragStart(event, title)
  }

  sectionDragOver(event: DragEvent): void {
    if (this.#destroyed || this.#legacyShell) return
    this.#onSectionDragOver(event)
  }

  dropSection(event: DragEvent): void {
    if (this.#destroyed || this.#legacyShell) return
    this.#onSectionDrop(event)
  }

  endSectionDrag(): void {
    if (this.#destroyed || this.#legacyShell) return
    this.#clearSectionDrag()
  }

  removeSection(title: string): void {
    this.#removeSection(title)
  }

  setPlainTextSectionText(title: string, text: string): boolean {
    if (this.#destroyed) return false
    const sectionIndex = this.#document.sections.findIndex((section) => section.title === title)
    if (sectionIndex < 0) {
      if (
        this.#document.sections.length > 0 ||
        title !== this.#preset.defaultSectionTitle ||
        text.trim().length === 0
      )
        return false
      this.#document = {
        ...this.#document,
        sections: [{ title, parts: [{ type: "text", text }] }],
      }
    } else {
      const section = this.#document.sections[sectionIndex]
      const currentText = section && plainTextSectionValue(section.parts)
      if (currentText === undefined) return false
      if (currentText === text) return true
      const sections = [...this.#document.sections]
      sections[sectionIndex] = { ...section, parts: text ? [{ type: "text", text }] : [] }
      this.#document = { ...this.#document, sections }
    }
    this.#closePicker()
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  handleReactEditorInput(
    _target: PromptEditorTarget | string,
    editor: HTMLElement,
    input?: PromptEditorInput,
  ): void {
    if (this.#destroyed || !this.#isReactTextEditor(editor)) return
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
    this.#definitionsHost
      .querySelector<HTMLInputElement>(
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
    this.#destroyController.abort()
    this.#nativeHostController?.abort()
    this.#definitionsController?.abort()
    this.#shotListeners.clear()
    this.#viewListeners.clear()
    this.#definitionsListeners.clear()
    this.#sectionsListeners.clear()
    this.#pickerListeners.clear()
    this.#shotDraft = undefined
    this.#closePicker()
    if (!this.#legacyShell) {
      this.unmountSectionHosts()
      this.unmountRawEditorHost()
    }
    this.unmountDefinitionHosts()
    if (this.#legacyShell) {
      this.#definitionsRoot?.replaceChildren()
      this.#workspaceRoot?.replaceChildren()
    }
    if (this.#legacyShell) this.#pickerHost?.replaceChildren()
    if (this.#legacyShell) this.root.replaceChildren()
  }

  get #editorRoots(): readonly HTMLElement[] {
    const roots = this.#workspaceRoot ? [this.#workspaceRoot] : []
    if (this.#definitionsRoot) roots.push(this.#definitionsRoot)
    return roots
  }

  #isReactTextEditor(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest("[data-prompt-react-editor]"))
  }

  get #definitionsHost(): HTMLElement {
    return this.#definitionsRoot ?? this.#workspaceRoot ?? this.root
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
        const editor = this.#legacyShell ? "native" : "react-text"
        return {
          title: section.title,
          color: accent.color,
          colorIndex: accent.index,
          isVirtual,
          editor,
          text: editor === "react-text" ? (plainTextSectionValue(section.parts) ?? "") : "",
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
      target: this.#pickerTarget ?? this.#pickerHost,
    }
  }

  #publishPicker(): void {
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

  #renderDefinitionBodies(): void {
    if (!this.#definitionsRoot || this.#legacyShell) return
    const records = this.#definitionRecords()
    const cardContext: PromptCardContext = {
      prompt: this.#shotDraft?.document ?? this.#document,
      references: this.#references(),
      preset: this.#preset,
      locale: this.#locale,
    }
    const definitions = new Map<
      string,
      PromptDocument["subjects"][number] | PromptDocument["shots"][number]
    >()
    for (const subject of this.#document.subjects) {
      const tag = subject.tag ?? subject.label ?? subject.subjectId
      if (tag) definitions.set(this.#definitionIdentity("subject", tag), subject)
    }
    for (const shot of this.#shotDraft?.document.shots ?? this.#document.shots)
      definitions.set(this.#definitionIdentity("shot", shot.tag), shot)
    const active = new Set<string>()
    for (const record of records) {
      const host = this.#definitionHosts.get(record.identity)
      const definition = definitions.get(record.identity)
      if (!host || !definition) continue
      active.add(record.identity)
      const body = host.querySelector<HTMLElement>("[data-prompt-definition-body]")
      const bodyState = JSON.stringify(definition.parts ?? [])
      if (!body) {
        host.append(
          makePromptDefinitionBody(cardContext, record.kind, definition, Boolean(this.#shotDraft)),
        )
      } else {
        body.dataset.promptDefinitionTag = record.tag
        body.contentEditable = this.#shotDraft ? "false" : "true"
        if (body.dataset.promptDefinitionBodyState !== bodyState) {
          body.replaceChildren()
          body.append(
            ...makePromptDefinitionBody(
              cardContext,
              record.kind,
              definition,
              Boolean(this.#shotDraft),
            ).childNodes,
          )
        }
      }
      host.querySelector<HTMLElement>(
        "[data-prompt-definition-body]",
      )!.dataset.promptDefinitionBodyState = bodyState
    }
  }

  get #picker(): HTMLElement {
    const picker = this.#pickerElement
    if (!picker) throw new Error("Reference Prompt picker is not mounted.")
    return picker
  }

  get #entry(): HTMLElement | undefined {
    return (
      this.#workspaceRoot?.querySelector<HTMLElement>("[data-prompt-section-entry]") ?? undefined
    )
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
          <div class="rl-prompt-toolbar__actions"><button type="button" data-prompt-action="copy-source"></button><button type="button" data-prompt-action="copy-compiled"></button><button type="button" class="rl-clear" data-prompt-action="clear"></button><button type="button" data-prompt-action="toggle-view"></button></div>
        </header>
        <div data-prompt-workspace></div>
        <div class="rl-prompt-picker" data-prompt-picker role="listbox" hidden></div>
        <p class="rl-prompt-hint" data-prompt-hint></p>
      </section>`
    this.#workspaceRoot =
      this.root.querySelector<HTMLElement>("[data-prompt-workspace]") ?? undefined
    this.#pickerElement = this.root.querySelector<HTMLElement>("[data-prompt-picker]") ?? undefined
    this.#hintElement = this.root.querySelector<HTMLElement>("[data-prompt-hint]") ?? undefined
    this.#nativeHostController = new AbortController()
    const signal = this.#nativeHostController.signal
    if (this.#workspaceRoot) {
      this.#installEditableRootEvents(this.#workspaceRoot, signal, false)
      this.#installWorkspaceEvents(this.#workspaceRoot, signal)
    }
    if (this.#pickerElement) this.#installPickerEvents(this.#pickerElement, signal)
    this.root.addEventListener("click", (event) => this.#onClick(event), { signal })
    this.#renderEditor()
    this.#setHint(issue)
  }

  #installWorkspaceEvents(root: HTMLElement, signal: AbortSignal, includeDrag = true): void {
    if (includeDrag) {
      root.addEventListener("dragstart", (event) => this.#onSectionDragStart(event), { signal })
      root.addEventListener("dragover", (event) => this.#onSectionDragOver(event), { signal })
      root.addEventListener("drop", (event) => this.#onSectionDrop(event), { signal })
      root.addEventListener(
        "dragend",
        () => {
          this.#clearSectionDrag()
        },
        { signal },
      )
    }
    document.addEventListener("wheel", (event) => this.#onPickerWheel(event), {
      capture: true,
      passive: false,
      signal,
    })
  }

  #installPickerEvents(picker: HTMLElement, signal: AbortSignal): void {
    picker.addEventListener("pointerdown", (event) => event.preventDefault(), { signal })
    picker.addEventListener(
      "click",
      (event) => {
        this.#onClick(event)
        event.stopPropagation()
      },
      { signal },
    )
  }

  #installEditableRootEvents(root: HTMLElement, signal: AbortSignal, includeClick = true): void {
    root.addEventListener("input", (event) => this.#onInput(event), { signal })
    root.addEventListener("change", (event) => this.#onChange(event), { signal })
    root.addEventListener("paste", (event) => event.stopPropagation(), { signal })
    root.addEventListener("keydown", (event) => this.#onKeydown(event), {
      capture: true,
      signal,
    })
    if (includeClick) root.addEventListener("click", (event) => this.#onClick(event), { signal })
    root.addEventListener(
      "compositionstart",
      (event) => {
        if (!this.#isReactTextEditor(event.target)) this.#composing = true
      },
      { signal },
    )
    root.addEventListener(
      "compositionend",
      (event) => {
        if (this.#isReactTextEditor(event.target)) return
        this.#composing = false
        this.#syncDocumentFromEditor()
        this.#updatePickerQuery()
        this.#publishView()
      },
      { signal },
    )
    root.addEventListener(
      "focusout",
      () => {
        globalThis.setTimeout(() => {
          if (!this.#editorRoots.some((candidate) => candidate.contains(document.activeElement)))
            this.#closePicker()
        }, 0)
      },
      { signal },
    )
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
    if (this.#hintElement) {
      this.#hintElement.textContent = this.#hintText
      this.#hintElement.hidden = !this.#hintText
    }
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
    if (this.#legacyShell) {
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
    }
    if (!this.#legacyShell) {
      this.#publishDefinitions()
      this.#publishSections()
      this.#setHint(renderHint)
      return
    }
    const workspace = this.#workspaceRoot
    workspace?.replaceChildren()
    const cardContext: PromptCardContext = {
      prompt: this.#document,
      references: this.#references(),
      preset: this.#preset,
      locale: this.#locale,
    }
    const definitions = this.#legacyShell
      ? makePromptDefinitions(cardContext, this.#shotDraft?.document)
      : undefined
    if (this.#legacyShell && this.#definitionsRoot && definitions)
      this.#definitionsRoot.replaceChildren(definitions)
    if (!workspace) {
      this.#renderDefinitionBodies()
      this.#publishDefinitions()
      this.#setHint(renderHint)
      return
    }
    if (this.#document.view === "raw") {
      if (!this.#definitionsRoot && definitions) workspace.append(definitions)
      const editor = document.createElement("div")
      editor.className = "rl-prompt-editor is-raw"
      editor.dataset.promptEditor = ""
      editor.contentEditable = "true"
      editor.role = "textbox"
      editor.ariaMultiLine = "true"
      editor.spellcheck = false
      editor.dataset.placeholder = localize(PROMPT_MESSAGES.rawPlaceholder, this.#locale)
      this.#appendPromptText(editor, renderAuthoringPrompt(this.#document, this.#references()))
      workspace.append(editor)
    } else {
      const stack = document.createElement("div")
      stack.className = "rl-prompt-stack"
      stack.dataset.promptStack = ""
      if (!this.#definitionsRoot && definitions) stack.append(definitions)
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
          subject.tag ?? subject.label ?? subject.subjectId ?? "",
          { subject, ordinal: index + 1 },
        ]),
      )
      for (const section of sections)
        stack.append(makePromptSectionCard(cardContext, section, references, subjects))
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
    this.#renderDefinitionBodies()
    this.#publishDefinitions()
    if (this.#legacyShell) {
      const button = this.root.querySelector<HTMLButtonElement>(
        '[data-prompt-action="toggle-view"]',
      )
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
    }
    this.#setHint(renderHint)
  }

  #syncClearButton(): void {
    if (!this.#legacyShell) return
    const button = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')
    if (!button) return
    button.textContent = localize(PROMPT_MESSAGES.clear, this.#locale)
    button.title = localize(PROMPT_MESSAGES.clearTitle, this.#locale)
    button.setAttribute("aria-label", localize(PROMPT_MESSAGES.clearAria, this.#locale))
    button.disabled = this.#document.sections.length === 0
  }

  #syncCopyButton(): void {
    if (!this.#legacyShell) return
    const source = this.root.querySelector<HTMLButtonElement>('[data-prompt-action="copy-source"]')
    const compiled = this.root.querySelector<HTMLButtonElement>(
      '[data-prompt-action="copy-compiled"]',
    )
    const sourceText = renderAuthoringPrompt(this.#document, this.#references())
    const compiledText = compilePromptDocument(this.#document, this.#references())
    if (source) {
      source.textContent = "Copy source"
      source.title = "Copy source with #tags"
      source.disabled = sourceText.length === 0
    }
    if (compiled) {
      compiled.textContent = "Copy compiled"
      compiled.title = "Copy compiled model prompt"
      compiled.disabled = compiledText.length === 0
    }
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
    const definitions = this.#definitionsHost
    const subjects = this.#document.subjects.map((subject) => {
      const tag = subject.tag ?? subject.label ?? subject.subjectId ?? ""
      const card = definitions.querySelector<HTMLElement>(
        `[data-prompt-definition="subject"][data-prompt-definition-tag="${CSS.escape(tag)}"]`,
      )
      const body = card?.querySelector<HTMLElement>("[data-prompt-definition-body]")
      if (!body) return subject
      const parts = sectionPartsFromContainer(body)
      body.dataset.promptDefinitionBodyState = JSON.stringify(parts)
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
      body.dataset.promptDefinitionBodyState = JSON.stringify(parts)
      return {
        ...shot,
        ...(syncShotFrames ? { frameIndex: value } : {}),
        parts,
      }
    })
    this.#document = { ...this.#document, subjects, shots }
  }

  #onInput(event: Event): void {
    if (
      !(event.target instanceof Node) ||
      !this.#editorRoots.some((root) => root.contains(event.target as Node))
    )
      return
    if (this.#isReactTextEditor(event.target)) return
    if (this.#composing) return
    if (
      !this.#legacyShell &&
      event.target instanceof Element &&
      event.target.closest("[data-prompt-definition-tag-input], [data-prompt-shot-frame]")
    )
      return
    const tagInput =
      event.target instanceof Element
        ? event.target.closest<HTMLInputElement>("[data-prompt-definition-tag-input]")
        : undefined
    if (tagInput) {
      normalizeDefinitionTagInput(tagInput)
      tagInput.size = Math.max(8, tagInput.value.length + 1)
      return
    }
    if (event.target instanceof Element && event.target.closest("[data-prompt-shot-frame]")) return
    this.#syncDocumentFromEditor()
    const body = (event.target as Element).closest<HTMLElement>(
      "[data-prompt-section-body], [data-prompt-definition-body], [data-prompt-editor], [data-prompt-section-entry]",
    )
    if (body) this.#highlightTags(body)
    this.#notifyShots()
    this.#syncClearButton()
    this.#syncCopyButton()
    this.#publishView()
    const input = event instanceof InputEvent ? event : undefined
    const isDeletion = input?.inputType.startsWith("delete") ?? false
    if (isDeletion && this.#pickerMode === "subject") {
      this.#closePicker()
      this.#node.setDirtyCanvas(true, true)
      return
    }
    const canOpenSubjectPicker = !input || input.data === "#" || this.#pickerMode === "subject"
    this.#updatePickerQuery(canOpenSubjectPicker)
    this.#node.setDirtyCanvas(true, true)
  }

  #onChange(event: Event): void {
    if (
      !(event.target instanceof HTMLElement) ||
      !this.#editorRoots.some((root) => root.contains(event.target as Node))
    )
      return
    if (
      !this.#legacyShell &&
      event.target.closest("[data-prompt-definition-tag-input], [data-prompt-shot-frame]")
    )
      return
    const tagInput = event.target.closest<HTMLInputElement>("[data-prompt-definition-tag-input]")
    if (tagInput) {
      if (this.#shotDraft) return
      normalizeDefinitionTagInput(tagInput)
      const card = tagInput.closest<HTMLElement>("[data-prompt-definition]")
      const oldTag = card?.dataset.promptDefinitionTag
      const next = normalizePromptTag(tagInput.value.slice(1))
      const kind = card?.dataset.promptDefinition as "subject" | "shot" | undefined
      if (oldTag && next && kind && next !== oldTag) this.#renameDefinition(kind, oldTag, next)
      else if (!next) tagInput.value = `#${oldTag ?? ""}`
      tagInput.size = Math.max(8, tagInput.value.length + 1)
      return
    }
    const frame = event.target.closest<HTMLInputElement>("[data-prompt-shot-frame]")
    if (frame) {
      const card = frame.closest<HTMLElement>("[data-prompt-definition]")
      const tag = card?.dataset.promptDefinitionTag
      const value = Number(frame.value)
      if (tag && Number.isSafeInteger(value) && value >= 0) this.setShotFrame(tag, value)
      else
        frame.value = String(this.#document.shots.find((shot) => shot.tag === tag)?.frameIndex ?? 0)
    }
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

  #onClick(event: MouseEvent): void {
    const target = event.target as Element
    const definitionButton = target.closest<HTMLButtonElement>("[data-prompt-action]")
    const action = definitionButton?.dataset.promptAction
    if (action === "apply-shot-draft") {
      this.applyShotDraft()
      return
    }
    if (action === "cancel-shot-draft") {
      this.cancelShotDraft()
      return
    }
    if (action === "add-subject" || action === "add-shot") {
      this.#addDefinition(action === "add-subject" ? "subject" : "shot")
      return
    }
    if (
      action === "remove-definition" ||
      action === "definition-up" ||
      action === "definition-down"
    ) {
      const kind = definitionButton?.dataset.promptDefinitionKind as "subject" | "shot" | undefined
      const tag = definitionButton?.dataset.promptDefinitionTag
      if (kind && tag) {
        if (action === "remove-definition") this.#removeDefinition(kind, tag)
        else this.#moveDefinition(kind, tag, action === "definition-up" ? -1 : 1)
      }
      return
    }
    if (target.closest<HTMLButtonElement>('[data-prompt-action="copy-source"]')) {
      void this.#copyPrompt(false)
      return
    }
    if (target.closest<HTMLButtonElement>('[data-prompt-action="copy-compiled"]')) {
      void this.#copyPrompt(true)
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
    const shot = target.closest<HTMLButtonElement>("[data-prompt-shot-index]")
    if (shot) {
      const index = Number(shot.dataset.promptShotIndex)
      if (Number.isInteger(index)) this.#insertShot(this.#pickerShots[index])
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
    this.#syncClearButton()
    this.#syncCopyButton()
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  #onKeydown(event: KeyboardEvent): void {
    if (
      !(event.target instanceof Node) ||
      !this.#editorRoots.some((root) => root.contains(event.target as Node))
    )
      return
    if (this.#isReactTextEditor(event.target)) return
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
    if (this.#removeAtomicAtCaret(event)) return
    if (!this.#picker.hidden) {
      if (this.#handlePickerKeydown(event)) return
    }
    if (this.#document.view !== "structured") return
    const entry = this.#entry
    if (this.#document.view === "structured" && entry?.contains(event.target)) {
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
    const existing = this.#workspaceRoot?.querySelector<HTMLElement>(
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
    const title = explicitTitle ?? handle?.dataset.promptSectionDragHandle
    if (!title || this.#document.view !== "structured") {
      event.preventDefault()
      return
    }
    this.#syncDocumentFromEditor()
    this.#draggedSectionTitle = title
    event.dataTransfer?.setData(PROMPT_SECTION_DRAG_MIME, title)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    handle?.closest<HTMLElement>("[data-prompt-section]")?.classList.add("is-dragging")
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
    this.#renderPicker()
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
    this.#renderPicker()
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
    this.#renderPicker()
  }

  #renderPicker(): void {
    if (!this.#legacyShell) {
      this.#placePicker()
      this.#publishPicker()
      return
    }
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
          (candidate) => candidate.tag === subject.tag,
        )
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptSubjectIndex = String(index)
        button.classList.toggle("is-active", index === this.#pickerIndex)
        const icon = document.createElement("span")
        icon.className = "rl-prompt-subject-icon"
        icon.textContent = `S${ordinal + 1}`
        icon.style.background = subjectColor(ordinal + 1) ?? ""
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `#${subject.tag}`
        const detail = document.createElement("small")
        detail.textContent = `<Subject ${ordinal + 1}>`
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
      this.#pickerShots.forEach((shot, index) => {
        const ordinal = this.#document.shots.indexOf(shot)
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptShotIndex = String(index)
        button.classList.toggle(
          "is-active",
          index + this.#pickerSubjects.length === this.#pickerIndex,
        )
        const icon = document.createElement("span")
        icon.className = "rl-prompt-subject-icon is-shot"
        icon.textContent = `SH${ordinal + 1}`
        icon.style.background = SHOT_COLOR
        const copy = document.createElement("span")
        const label = document.createElement("strong")
        label.textContent = `#${shot.tag}`
        const detail = document.createElement("small")
        detail.textContent = `Shot · ${shot.frameIndex}f · ${(shot.frameIndex / 24).toFixed(3)}s`
        copy.append(label, detail)
        button.append(icon, copy)
        picker.append(button)
      })
      if (this.#pickerCreateSubject) {
        const button = document.createElement("button")
        button.type = "button"
        button.role = "option"
        button.dataset.promptSubjectCreate = ""
        button.classList.toggle(
          "is-active",
          this.#pickerIndex === this.#pickerSubjects.length + this.#pickerShots.length,
        )
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
      "[data-prompt-reference-index], [data-prompt-subject-index], [data-prompt-shot-index], [data-prompt-subject-create], [data-prompt-alias-index]",
    )) {
      const index = Number(
        option.dataset.promptReferenceIndex ??
          option.dataset.promptAliasIndex ??
          option.dataset.promptSubjectIndex ??
          (option.dataset.promptShotIndex === undefined
            ? undefined
            : String(this.#pickerSubjects.length + Number(option.dataset.promptShotIndex))) ??
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
    const picker = this.#pickerElement
    if (!this.#legacyShell) {
      const definition = anchor?.closest<HTMLElement>("[data-prompt-definition]")
      const section = anchor?.closest<HTMLElement>("[data-prompt-section]")
      const entry = anchor?.matches("[data-prompt-section-entry]") ? anchor : undefined
      const editor = anchor?.matches("[data-prompt-editor]") ? anchor : undefined
      const target =
        this.#pickerMode === "alias"
          ? entry?.previousElementSibling instanceof HTMLElement
            ? entry.previousElementSibling
            : this.#pickerHost
          : (definition?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
            section?.querySelector<HTMLElement>(":scope > [data-prompt-react-picker-slot]") ??
            (editor?.previousElementSibling instanceof HTMLElement
              ? editor.previousElementSibling
              : undefined) ??
            this.#pickerHost)
      this.#pickerTarget = target ?? undefined
      return
    }
    if (!anchor?.isConnected || !picker || picker.hidden) return
    if (this.#pickerMode === "alias") {
      anchor.before(picker)
      return
    }
    const definition = anchor.matches("[data-prompt-definition]")
      ? anchor
      : anchor.closest<HTMLElement>("[data-prompt-definition]")
    const definitionBody = definition?.querySelector<HTMLElement>(
      ":scope > .rl-prompt-definition__body, :scope > .rl-prompt-definition__body-host > .rl-prompt-definition__body",
    )
    if (definitionBody) {
      const host = definitionBody.parentElement
      if (host?.matches(".rl-prompt-definition__body-host")) host.before(picker)
      else definitionBody.before(picker)
      return
    }
    const card = anchor.matches("[data-prompt-section]")
      ? anchor
      : anchor.closest<HTMLElement>("[data-prompt-section]")
    const body = card?.querySelector<HTMLElement>(
      ":scope > [data-prompt-section-body], :scope > .rl-prompt-section__body-host > [data-prompt-section-body]",
    )
    const reactPickerSlot = card?.querySelector<HTMLElement>(
      ":scope > [data-prompt-react-picker-slot]",
    )
    if (reactPickerSlot) {
      reactPickerSlot.append(picker)
      return
    }
    if (body) {
      const host = body.parentElement
      if (host?.matches(".rl-prompt-section__body-host")) host.before(picker)
      else body.before(picker)
    }
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
    this.#pickerTarget = undefined
    if (!this.#legacyShell) {
      this.#publishPicker()
      return
    }
    const picker = this.#pickerElement
    if (picker) {
      picker.hidden = true
      picker.replaceChildren()
      if (this.#legacyShell) this.#hintElement?.before(picker)
      else if (this.#pickerHost && !this.#pickerHost.contains(picker))
        this.#pickerHost.append(picker)
    }
  }
}
