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
  assertPromptDocumentV6,
  compilePromptDocumentV6,
  createEmptyPromptDocumentV6,
  createPromptDefinitionId,
  deserializePromptDocumentV6,
  normalizePromptSectionTitle,
  normalizePromptTag,
  parseAuthoringPromptV6,
  parsePromptPartsV6,
  normalizePromptPartsV6,
  promptPartsV6Equal,
  rebindPromptMentionsByOrderV6,
  renderAuthoringPromptV6,
  removePromptDefinitionV6,
  renamePromptDefinitionV6,
  serializePromptDocumentV6,
  type PromptDocumentV6,
  type PromptPartV6,
  type PromptReference,
  type PromptSubjectV6,
} from "../prompt-v6.ts"
import {
  closestPromptBody,
  normalizeDefinitionTagValue,
  placeCaretAtEnd,
  SHOT_COLOR,
  sectionColor,
  subjectColor,
} from "./prompt-dom.ts"
import type {
  PromptBodyEdit,
  PromptBodyEditResult,
  PromptBodySnapshot,
  PromptBodyTrigger,
  PromptEditorTargetV6,
  PromptRichEditorHandle,
} from "./prompt-editor-contract.ts"
import type { PromptReferenceVisual } from "./prompt-reference-node.tsx"

type ReferenceProvider = () => readonly PromptReference[]

let promptSessionCounter = 0

function createPromptSessionScope(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID === "function")
    return `prompt-session-${randomUUID.call(globalThis.crypto)}`
  return `prompt-session-${Date.now().toString(36)}-${(++promptSessionCounter).toString(36)}`
}

export interface ReferencePromptControllerOptions {
  presetId?: unknown
  presetCatalog?: unknown
  locale?: PromptLocale
}

export interface PromptViewSnapshot {
  readonly view: PromptDocumentV6["view"]
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
  readonly parts: readonly PromptPartV6[]
  readonly definitionId?: string
  readonly bodySnapshot: PromptBodySnapshot
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
  readonly id?: string
  readonly color: string
  readonly colorIndex: number
  readonly isVirtual: boolean
  readonly editor: "react-text" | "lexical"
  readonly text: string
  readonly parts: readonly PromptPartV6[]
  readonly bodySnapshot: PromptBodySnapshot
  readonly placeholder: string
  readonly dragTitle: string
  readonly dragAria: string
  readonly removeTitle: string
  readonly removeAria: string
}

export interface PromptSectionsSnapshot {
  readonly view: PromptDocumentV6["view"]
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

type PromptPickerShot = PromptDocumentV6["shots"][number]

export type PromptPickerOption =
  | { readonly kind: "reference"; readonly reference: PromptReference }
  | { readonly kind: "subject"; readonly subject: PromptSubjectV6; readonly ordinal: number }
  | {
      readonly kind: "shot"
      readonly shot: PromptPickerShot
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

function normalizeSubjectLabel(value: string): string | undefined {
  const label = value.trim()
  return label.length > 0 && label.length <= 64 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(label)
    ? label
    : undefined
}

export class ReferencePromptController {
  #workspaceRoot: HTMLElement | undefined
  #definitionsRoot: HTMLElement | undefined
  #node: ComfyNode
  #references: ReferenceProvider
  #sessionScope = createPromptSessionScope()
  #documentV6: PromptDocumentV6
  #v6ShotDraft:
    | {
        initial: PromptDocumentV6
        document: PromptDocumentV6
      }
    | undefined
  #bodyRevisions = new Map<string, number>()
  #bodyEpoch = 0
  #bodyFlushers = new Set<() => void>()
  #bodyHandles = new Map<string, PromptRichEditorHandle>()
  #v6PickerTarget: PromptEditorTargetV6 | undefined
  #v6PickerReplaceLength = 0
  #v6RawDraft: string | undefined
  #v6RawBaseFingerprint = ""
  #v6RawReferenceFingerprint = ""
  #pickerMode: "reference" | "subject" | "alias" | undefined
  #pickerReferences: PromptReference[] = []
  #pickerSubjects: PromptSubjectV6[] = []
  #pickerShots: PromptPickerShot[] = []
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
    const parsed = deserializePromptDocumentV6(serialized)
    this.#documentV6 = parsed.document ?? createEmptyPromptDocumentV6()
    const issues = parsed.document
      ? parsed.issues
      : [
          ...parsed.issues,
          "Only Prompt state version 6 is supported; the previous state was reset.",
        ]
    this.#ensureV6RawSession()
    this.#viewSnapshot = this.#buildViewSnapshot()
    this.#pendingRenderHint = issues.join(" ")
    this.#setHint(this.#pendingRenderHint)
  }

  get promptSessionScope(): string {
    return this.#sessionScope
  }

  getPromptBodySnapshot(target: PromptEditorTargetV6): PromptBodySnapshot | undefined {
    const owner = this.#v6BodyOwner(target)
    if (!owner) return undefined
    const key = this.#v6BodyKey(target)
    return {
      target,
      parts: owner.parts,
      revision: this.#bodyRevisions.get(key) ?? 0,
      epoch: this.#bodyEpoch,
    }
  }

  applyPromptBodyEdit(edit: PromptBodyEdit): PromptBodyEditResult {
    if (this.#v6ShotDraft) return { ok: false, reason: "stale" }
    if (edit.epoch !== this.#bodyEpoch) return { ok: false, reason: "stale" }
    const owner = this.#v6BodyOwner(edit.target)
    if (!owner) return { ok: false, reason: "missing-target" }
    const key = this.#v6BodyKey(edit.target)
    const revision = this.#bodyRevisions.get(key) ?? 0
    if (edit.baseRevision !== revision) return { ok: false, reason: "stale" }
    let parts: PromptPartV6[]
    try {
      parts = normalizePromptPartsV6(edit.parts)
    } catch {
      return { ok: false, reason: "invalid" }
    }
    if (promptPartsV6Equal(parts, owner.parts)) return { ok: true, revision, editId: edit.editId }
    try {
      const next = this.#replaceV6Body(edit.target, parts)
      this.#documentV6 = assertPromptDocumentV6(next)
    } catch {
      return { ok: false, reason: "invalid" }
    }
    const nextRevision = revision + 1
    this.#bodyRevisions.set(key, nextRevision)
    this.#invalidateV6Snapshots()
    this.#publishView()
    if (edit.target.type === "definition") this.#publishDefinitions()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return { ok: true, revision: nextRevision, editId: edit.editId }
  }

  registerPromptBodyEditor(
    target: PromptEditorTargetV6,
    handle: PromptRichEditorHandle | undefined,
  ): () => void {
    if (!handle) return () => undefined
    const flush = (): void => handle.flushAcceptedModel()
    this.#bodyFlushers.add(flush)
    const key = this.#v6BodyKey(target)
    this.#bodyHandles.set(key, handle)
    return () => {
      this.#bodyFlushers.delete(flush)
      if (this.#bodyHandles.get(key) === handle) this.#bodyHandles.delete(key)
    }
  }

  handlePromptBodyTrigger(
    target: PromptEditorTargetV6,
    trigger: PromptBodyTrigger | undefined,
  ): void {
    if (!trigger) {
      if (this.#v6PickerTarget?.id === target.id) this.#closePicker()
      return
    }
    this.#v6PickerTarget = target
    this.#v6PickerReplaceLength = trigger.replaceTextLength
    this.#pickerAnchor = this.#v6EditorElement(target)
    if (trigger.trigger === "@") this.#updateReferencePicker(trigger.query)
    else this.#updateV6SubjectPicker(trigger.query, target)
  }

  resolvePromptPartLabel(part: PromptPartV6): string | undefined {
    if (part.type === "text") return undefined
    if (part.type === "mention")
      return (
        this.#references().find(
          (reference) =>
            reference.referenceId === part.referenceId && reference.mediaKind === part.mediaKind,
        )?.label ?? part.label
      )
    const definition = this.#v6Definition(part.definitionId)
    return definition?.tag
  }

  resolvePromptPartVisual(part: PromptPartV6): PromptReferenceVisual | undefined {
    if (part.type === "text") return undefined
    if (part.type === "mention") {
      const reference = this.#references().find(
        (candidate) =>
          candidate.referenceId === part.referenceId && candidate.mediaKind === part.mediaKind,
      )
      return reference
        ? {
            previewUrl: reference.previewUrl,
            ordinal: reference.ordinal,
          }
        : undefined
    }
    const document = this.#v6ShotDraft?.document ?? this.#documentV6
    const subjectIndex = document.subjects.findIndex((subject) => subject.id === part.definitionId)
    if (subjectIndex >= 0)
      return {
        definitionKind: "subject",
        ordinal: subjectIndex + 1,
        color: subjectColor(document.subjects[subjectIndex]?.id),
      }
    const shotIndex = document.shots.findIndex((shot) => shot.id === part.definitionId)
    return shotIndex >= 0
      ? {
          definitionKind: "shot",
          ordinal: shotIndex + 1,
          color: SHOT_COLOR,
        }
      : undefined
  }

  validatePromptBodyParts(target: PromptEditorTargetV6, parts: readonly PromptPartV6[]): boolean {
    if (this.#v6ShotDraft || !this.#v6BodyOwner(target)) return false
    try {
      assertPromptDocumentV6(this.#replaceV6Body(target, parts))
      return true
    } catch {
      return false
    }
  }

  parsePromptBodyText(value: string): PromptPartV6[] {
    return parsePromptPartsV6(
      value,
      this.#references(),
      this.#v6ShotDraft?.document ?? this.#documentV6,
    )
  }

  get rawDraftText(): string | undefined {
    this.#ensureV6RawSession()
    return this.#v6RawDraft ?? renderAuthoringPromptV6(this.#documentV6, this.#references())
  }

  updateRawDraftText(value: string): void {
    if (this.#documentV6.view !== "raw") return
    this.#ensureV6RawSession()
    this.#v6RawDraft = value
    this.#publishView()
    this.#node.setDirtyCanvas(true, true)
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

  mountPromptWorkspace(workspace: HTMLElement | undefined): void {
    if (this.#destroyed || this.#workspaceRoot === workspace) return
    if (this.#workspaceRoot !== undefined) this.unmountPromptWorkspace()
    this.#workspaceRoot = workspace
    this.#renderEditor()
    this.#publishView()
  }

  unmountPromptWorkspace(): void {
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

  handleReactSectionEntryInput(
    value: string,
    entry: HTMLInputElement,
    input?: PromptEditorInput,
  ): void {
    if (this.#destroyed || !entry.matches("[data-prompt-section-entry]")) return
    const isDeletion = input?.inputType?.startsWith("delete") ?? false
    if (isDeletion && this.#pickerMode === "alias") this.#closePicker()
    else this.#updateSectionEntryPickerQuery(value, entry)
  }

  handleReactSectionEntryKeydown(
    value: string,
    entry: HTMLInputElement,
    event: KeyboardEvent,
  ): boolean {
    if (this.#destroyed || !entry.matches("[data-prompt-section-entry]")) return false
    const pickerWasOpen = this.#pickerMode === "alias"
    if (this.#handlePickerKeydown(event)) return event.key === "Enter" && pickerWasOpen
    if (event.key === "Enter") {
      event.preventDefault()
      return this.#createSectionFromEntry(value)
    }
    return false
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
    const subjectPickerWasOpen = this.#pickerMode === "subject"
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
    const modifier = event.ctrlKey || event.metaKey
    const isUndo = modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z"
    const isRedo =
      modifier &&
      !event.altKey &&
      (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))
    if (isUndo || isRedo) {
      // Let Lexical's local HistoryPlugin handle the command, but keep it
      // away from ComfyUI's graph-level undo handler.
      event.stopPropagation()
      return
    }
    this.#handlePickerKeydown(event)
  }

  moveSection(title: string, delta: -1 | 1): void {
    this.#moveSection(title, delta)
  }

  addDefinition(kind: PromptDefinitionKind): void {
    this.#addDefinition(kind)
  }

  renameDefinition(kind: PromptDefinitionKind, identity: string, value: string): boolean {
    if (kind !== "subject" && kind !== "shot") return false
    const current = this.#v6Definition(identity)
    const next = normalizePromptTag(normalizeDefinitionTagValue(value.trim()).slice(1))
    if (!current || !next) return false
    if (current.tag === next) {
      this.#publishDefinitions(true)
      return true
    }
    return this.#renameV6Definition(identity, next)
  }

  reorderDefinition(kind: PromptDefinitionKind, identity: string, delta: -1 | 1): void {
    this.#moveV6Definition(kind, identity, delta)
  }

  removeDefinition(kind: PromptDefinitionKind, identity: string): void {
    this.#removeV6Definition(kind, identity)
  }

  setShotFrameByIdentity(identity: string, frameIndex: number): boolean {
    const shot = this.#documentV6.shots.find((candidate) => candidate.id === identity)
    return shot ? this.setShotFrame(shot.tag, frameIndex) : false
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

  get document(): PromptDocumentV6 {
    this.#flushBodyEditors()
    return this.#v6ShotDraft?.document ?? this.#documentV6
  }

  get shots(): readonly { tag: string; frameIndex: number }[] {
    this.#flushBodyEditors()
    return (this.#v6ShotDraft?.document.shots ?? this.#documentV6.shots).map((shot) => ({
      tag: shot.tag,
      frameIndex: shot.frameIndex,
    }))
  }

  get hasShotDraft(): boolean {
    return this.#v6ShotDraft !== undefined
  }

  subscribeShots(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#shotListeners.add(listener)
    listener()
    return () => this.#shotListeners.delete(listener)
  }

  setShotFrame(tag: string, frameIndex: number): boolean {
    if (this.#destroyed || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return false
    const current = this.#documentV6.shots.find((shot) => shot.tag === tag)
    if (!current || current.frameIndex === frameIndex) return Boolean(current)
    this.#recordGraphChange(() => {
      this.#documentV6 = assertPromptDocumentV6({
        ...this.#documentV6,
        shots: this.#documentV6.shots.map((shot) =>
          shot.id === current.id ? { ...shot, frameIndex } : shot,
        ),
      })
      this.#invalidateV6Snapshots()
    })
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  setShotFrameDraft(tag: string, frameIndex: number): boolean {
    if (this.#destroyed || !Number.isSafeInteger(frameIndex) || frameIndex < 0) return false
    const current = (this.#v6ShotDraft?.document.shots ?? this.#documentV6.shots).find(
      (shot) => shot.tag === tag,
    )
    if (!current || current.frameIndex === frameIndex) return Boolean(current)
    if (!this.#v6ShotDraft)
      this.#v6ShotDraft = { initial: this.#documentV6, document: this.#documentV6 }
    this.#v6ShotDraft = {
      ...this.#v6ShotDraft,
      document: assertPromptDocumentV6({
        ...this.#v6ShotDraft.document,
        shots: this.#v6ShotDraft.document.shots.map((shot) =>
          shot.id === current.id ? { ...shot, frameIndex } : shot,
        ),
      }),
    }
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  removeShot(tag: string): void {
    const current = (this.#v6ShotDraft?.document.shots ?? this.#documentV6.shots).find(
      (shot) => shot.tag === tag,
    )
    if (!current) return
    if (!this.#v6ShotDraft)
      this.#v6ShotDraft = { initial: this.#documentV6, document: this.#documentV6 }
    this.#v6ShotDraft = {
      ...this.#v6ShotDraft,
      document: assertPromptDocumentV6({
        ...this.#v6ShotDraft.document,
        shots: this.#v6ShotDraft.document.shots.filter((shot) => shot.id !== current.id),
      }),
    }
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  applyShotDraft(): boolean {
    if (this.#destroyed || !this.#v6ShotDraft) return false
    this.#recordGraphChange(() => {
      this.#documentV6 = this.#v6ShotDraft!.document
      this.#v6ShotDraft = undefined
      this.#bodyEpoch += 1
      this.#bodyRevisions.clear()
      this.#invalidateV6Snapshots()
    })
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  cancelShotDraft(): boolean {
    if (this.#destroyed || !this.#v6ShotDraft) return false
    this.#v6ShotDraft = undefined
    this.#invalidateV6Snapshots()
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
    this.#flushBodyEditors()
    return compilePromptDocumentV6(this.#documentV6, this.#references())
  }

  serialize(): string {
    this.#flushBodyEditors()
    return serializePromptDocumentV6(this.#documentV6)
  }

  restore(serialized: unknown): void {
    if (this.#destroyed) return
    if (serialized === undefined || serialized === null || serialized === "") {
      this.#v6ShotDraft = undefined
      this.#documentV6 = createEmptyPromptDocumentV6()
      this.#bodyEpoch += 1
      this.#bodyRevisions.clear()
      this.#v6RawDraft = undefined
      this.#ensureV6RawSession()
      this.#invalidateV6Snapshots()
      this.#closePicker()
      this.#renderEditor()
      this.#setHint()
      this.#notifyShots()
      return
    }
    const parsed = deserializePromptDocumentV6(serialized)
    if (!parsed.document) {
      this.#setHint([...parsed.issues, "Only Prompt state version 6 can be restored."].join(" "))
      return
    }
    this.#v6ShotDraft = undefined
    this.#documentV6 = parsed.document
    this.#bodyEpoch += 1
    this.#bodyRevisions.clear()
    this.#v6RawDraft = undefined
    this.#ensureV6RawSession()
    this.#invalidateV6Snapshots()
    this.#closePicker()
    this.#renderEditor()
    this.#setHint(parsed.issues.join(" "))
    this.#notifyShots()
  }

  setPreset(value: unknown): void {
    if (this.#destroyed) return
    const preset = resolvePromptPreset(value, this.#presetCatalog)
    if (preset.id === this.#preset.id) return
    this.#preset = preset
    this.#closePicker()
    this.#renderEditor()
  }

  refreshReferences(bindByOrder = false): void {
    if (this.#destroyed) return
    const currentReferences = this.#references()
    // Media previews are runtime-only metadata. The Prompt document does not
    // change when a restored reference finishes loading, so invalidate the
    // React snapshots explicitly to refresh existing chips.
    this.#invalidateV6Snapshots()
    if (bindByOrder) {
      this.#documentV6 = rebindPromptMentionsByOrderV6(this.#documentV6, currentReferences)
      this.#invalidateV6Snapshots()
    }
    if (this.#documentV6.view === "raw") {
      this.#v6RawDraft = renderAuthoringPromptV6(this.#documentV6, currentReferences)
      this.#v6RawReferenceFingerprint = this.#v6ReferenceFingerprint()
    }
    if (this.#pickerMode === "reference") this.#updateReferencePicker()
    this.#publishDefinitions()
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
    this.#bodyFlushers.clear()
    this.#bodyHandles.clear()
    this.#bodyRevisions.clear()
    this.#v6ShotDraft = undefined
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

  #v6BodyKey(target: PromptEditorTargetV6): string {
    return `${target.type}:${target.id}`
  }

  #v6BodyOwner(
    target: PromptEditorTargetV6,
  ):
    | PromptDocumentV6["sections"][number]
    | PromptDocumentV6["subjects"][number]
    | PromptDocumentV6["shots"][number]
    | undefined {
    const document = this.#v6ShotDraft?.document ?? this.#documentV6
    if (!document) return undefined
    if (target.type === "section")
      return document.sections.find((section) => section.id === target.id)
    return (
      document.subjects.find((subject) => subject.id === target.id) ??
      document.shots.find((shot) => shot.id === target.id)
    )
  }

  #v6Definition(
    id: string,
    document: PromptDocumentV6 | undefined = this.#v6ShotDraft?.document ?? this.#documentV6,
  ): PromptDocumentV6["subjects"][number] | PromptDocumentV6["shots"][number] | undefined {
    return (
      document?.subjects.find((subject) => subject.id === id) ??
      document?.shots.find((shot) => shot.id === id)
    )
  }

  #replaceV6Body(target: PromptEditorTargetV6, parts: readonly PromptPartV6[]): PromptDocumentV6 {
    const document = this.#v6ShotDraft?.document ?? this.#documentV6
    if (!document) throw new Error("Prompt v6 document is unavailable.")
    if (target.type === "section")
      return {
        ...document,
        sections: document.sections.map((section) =>
          section.id === target.id ? { ...section, parts: [...parts] } : section,
        ),
      }
    return {
      ...document,
      subjects: document.subjects.map((subject) =>
        subject.id === target.id ? { ...subject, parts: [...parts] } : subject,
      ),
      shots: document.shots.map((shot) =>
        shot.id === target.id ? { ...shot, parts: [...parts] } : shot,
      ),
    }
  }

  #invalidateV6Snapshots(): void {
    this.#viewSnapshot = undefined
    this.#sectionsSnapshot = undefined
    this.#definitionsSnapshot = undefined
    this.#pickerSnapshot = undefined
  }

  #v6EditorElement(target: PromptEditorTargetV6): HTMLElement | undefined {
    if (target.type === "section") {
      if (!this.#workspaceRoot) return undefined
      const section = this.#documentV6?.sections.find((candidate) => candidate.id === target.id)
      return section
        ? (this.#workspaceRoot.querySelector<HTMLElement>(
            `[data-prompt-section-body="${CSS.escape(section.title)}"]`,
          ) ?? undefined)
        : undefined
    }
    return (
      this.#definitionsRoot?.querySelector<HTMLElement>(
        `[data-prompt-definition-identity="${CSS.escape(target.id)}"] [data-prompt-react-editor]`,
      ) ?? undefined
    )
  }

  #updateV6SubjectPicker(query: string, target: PromptEditorTargetV6): void {
    this.#pickerMode = "subject"
    this.#pickerReferences = []
    this.#pickerAliases = []
    const normalized = query.trim().toLocaleLowerCase()
    this.#pickerSubjects = this.#documentV6.subjects
      .filter((subject, index) =>
        [subject.tag, `subject${index + 1}`, `<Subject ${index + 1}>`].some((value) =>
          value.toLocaleLowerCase().includes(normalized),
        ),
      )
      .map((subject) => subject)
    this.#pickerShots = this.#documentV6.shots
      .filter((shot) => shot.tag.toLocaleLowerCase().includes(normalized))
      .map((shot) => shot)
    const label = normalizeSubjectLabel(query)
    const body = this.#v6EditorElement(target)
    const creationAllowed =
      this.#preset.subjectMode === "anywhere" ||
      (this.#preset.subjectMode === "definitions" &&
        (body?.closest("[data-prompt-section-body]")?.getAttribute("data-prompt-section-body") ===
          "subject_definitions" ||
          Boolean(body?.closest("[data-prompt-definition-body]"))))
    this.#pickerCreateSubject =
      creationAllowed &&
      label &&
      ![...this.#documentV6.subjects, ...this.#documentV6.shots].some(
        (definition) => definition.tag.toLowerCase() === label.toLowerCase(),
      )
        ? label
        : undefined
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerOptionCount() - 1))
    this.#pickerAnchor = body
    this.#publishPicker()
  }

  #flushBodyEditors(): void {
    if (this.#bodyFlushers.size === 0) return
    for (const flush of [...this.#bodyFlushers]) flush()
  }

  #v6ReferenceFingerprint(): string {
    return JSON.stringify(
      this.#references().map((reference) => [
        reference.mediaKind,
        reference.referenceId,
        reference.label,
        reference.ordinal,
      ]),
    )
  }

  #ensureV6RawSession(): void {
    if (this.#documentV6.view !== "raw" || this.#v6RawDraft !== undefined) return
    this.#v6RawDraft = renderAuthoringPromptV6(this.#documentV6, this.#references())
    this.#v6RawBaseFingerprint = serializePromptDocumentV6(this.#documentV6)
    this.#v6RawReferenceFingerprint = this.#v6ReferenceFingerprint()
  }

  #applyV6RawDraft(): boolean {
    this.#ensureV6RawSession()
    if (this.#v6RawReferenceFingerprint !== this.#v6ReferenceFingerprint()) {
      this.#setHint("References changed while Raw Import was open. Reopen Raw and apply again.")
      return false
    }
    if (this.#v6RawBaseFingerprint !== serializePromptDocumentV6(this.#documentV6)) {
      this.#setHint("Prompt changed while Raw Import was open. Reopen Raw and apply again.")
      return false
    }
    try {
      const next = parseAuthoringPromptV6(
        this.#v6RawDraft ?? "",
        this.#references(),
        this.#documentV6,
      )
      this.#recordGraphChange(() => {
        this.#documentV6 = next
        this.#bodyEpoch += 1
        this.#bodyRevisions.clear()
        this.#v6RawDraft = undefined
        this.#v6RawBaseFingerprint = ""
        this.#v6RawReferenceFingerprint = ""
        this.#invalidateV6Snapshots()
      })
      return true
    } catch (error) {
      this.#setHint(error instanceof Error ? error.message : "Raw Prompt is invalid.")
      return false
    }
  }

  #isReactTextEditor(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest("[data-prompt-react-editor]"))
  }

  #definitionRecords(): {
    kind: PromptDefinitionKind
    tag: string
    identity: string
    ordinal: number
    frameIndex?: number
    parts: readonly PromptPartV6[]
    bodySnapshot: PromptBodySnapshot
    placeholder: string
  }[] {
    const document = this.#v6ShotDraft?.document ?? this.#documentV6
    const placeholder = localize(
      this.#preset.subjectMode === "disabled"
        ? PROMPT_MESSAGES.bodyPlaceholder
        : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
      this.#locale,
    )
    const subjects = document.subjects.map((subject, index) => ({
      kind: "subject" as const,
      tag: subject.tag,
      identity: subject.id,
      definitionId: subject.id,
      ordinal: index + 1,
      parts: subject.parts,
      bodySnapshot: this.getPromptBodySnapshot({ type: "definition", id: subject.id })!,
      placeholder,
    }))
    const shots = document.shots.map((shot, index) => ({
      kind: "shot" as const,
      tag: shot.tag,
      identity: shot.id,
      definitionId: shot.id,
      ordinal: index + 1,
      frameIndex: shot.frameIndex,
      parts: shot.parts,
      bodySnapshot: this.getPromptBodySnapshot({ type: "definition", id: shot.id })!,
      placeholder,
    }))
    return [...subjects, ...shots]
  }

  #buildDefinitionsSnapshot(): PromptDefinitionsSnapshot {
    const records = this.#definitionRecords()
    return {
      subjects: records.filter((record) => record.kind === "subject"),
      shots: records.filter((record) => record.kind === "shot"),
      draft: this.#v6ShotDraft !== undefined,
      mounted: this.#definitionsRoot !== undefined,
    }
  }

  #buildSectionsSnapshot(): PromptSectionsSnapshot {
    const document = this.#documentV6
    const placeholder = localize(
      this.#preset.subjectMode === "disabled"
        ? PROMPT_MESSAGES.bodyPlaceholder
        : PROMPT_MESSAGES.bodyPlaceholderWithSubjects,
      this.#locale,
    )
    return {
      view: document.view,
      sections: document.sections.map((section) => {
        const accent = sectionColor(section.title)
        return {
          title: section.title,
          id: section.id,
          color: accent.color,
          colorIndex: accent.index,
          isVirtual: false,
          editor: "lexical" as const,
          text: section.parts
            .map((part) =>
              part.type === "text"
                ? part.text
                : part.type === "mention"
                  ? `@${this.resolvePromptPartLabel(part) ?? part.label}`
                  : `#${this.resolvePromptPartLabel(part) ?? part.definitionId}`,
            )
            .join(""),
          parts: section.parts,
          bodySnapshot: this.getPromptBodySnapshot({ type: "section", id: section.id })!,
          placeholder,
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
                  this.#documentV6.subjects.findIndex((candidate) => candidate.id === subject.id) +
                  1,
              })),
              ...this.#pickerShots.map((shot) => ({
                kind: "shot" as const,
                shot,
                ordinal:
                  this.#documentV6.shots.findIndex((candidate) => candidate.id === shot.id) + 1,
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
          section.id === candidate.id &&
          section.color === candidate.color &&
          section.colorIndex === candidate.colorIndex &&
          section.isVirtual === candidate.isVirtual &&
          section.editor === candidate.editor &&
          section.text === candidate.text &&
          JSON.stringify(section.parts) === JSON.stringify(candidate.parts) &&
          section.bodySnapshot?.target.id === candidate.bodySnapshot?.target.id &&
          section.bodySnapshot?.revision === candidate.bodySnapshot?.revision &&
          section.bodySnapshot?.epoch === candidate.bodySnapshot?.epoch &&
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
          JSON.stringify(record.parts) === JSON.stringify(right[index]?.parts) &&
          record.bodySnapshot?.target.id === right[index]?.bodySnapshot?.target.id &&
          record.bodySnapshot?.revision === right[index]?.bodySnapshot?.revision &&
          record.bodySnapshot?.epoch === right[index]?.bodySnapshot?.epoch,
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
    this.#hintText = issue || (stale ? `${stale} unavailable reference mention.` : "")
    this.#publishView()
  }

  #buildViewSnapshot(): PromptViewSnapshot {
    const presetLabel = localize(this.#preset.label, this.#locale)
    const document = this.#documentV6
    return {
      view: document.view,
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
      sourceText:
        document.view === "raw"
          ? (this.#v6RawDraft ?? "")
          : renderAuthoringPromptV6(document, this.#references()),
      compiledText: compilePromptDocumentV6(document, this.#references()),
      canClear: document.sections.length > 0,
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

  #renderEditor(): void {
    const renderHint = this.#pendingRenderHint
    this.#pendingRenderHint = undefined
    this.#publishDefinitions()
    this.#publishSections()
    this.#setHint(renderHint)
  }

  #notifyShots(): void {
    for (const listener of this.#shotListeners) listener()
  }

  #renameV6Definition(definitionId: string, tag: string): boolean {
    if (
      [...this.#documentV6.subjects, ...this.#documentV6.shots].some(
        (definition) => definition.tag === tag && definition.id !== definitionId,
      )
    ) {
      this.#setHint("Subject and Shot tags must be unique.")
      return false
    }
    try {
      this.#recordGraphChange(() => {
        this.#documentV6 = renamePromptDefinitionV6(this.#documentV6!, definitionId, tag)
        this.#invalidateV6Snapshots()
      })
    } catch (error) {
      this.#setHint(error instanceof Error ? error.message : "Definition tag is invalid.")
      return false
    }
    this.#closePicker()
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
    return true
  }

  #moveV6Definition(kind: PromptDefinitionKind, definitionId: string, delta: -1 | 1): void {
    if (this.#v6ShotDraft) return
    const values = kind === "subject" ? [...this.#documentV6.subjects] : [...this.#documentV6.shots]
    const index = values.findIndex((definition) => definition.id === definitionId)
    const target = Math.max(0, Math.min(values.length - 1, index + delta))
    if (index < 0 || index === target) return
    const [item] = values.splice(index, 1)
    if (!item) return
    values.splice(target, 0, item)
    this.#recordGraphChange(() => {
      this.#documentV6 = assertPromptDocumentV6(
        kind === "subject"
          ? { ...this.#documentV6!, subjects: values }
          : { ...this.#documentV6!, shots: values },
      )
      this.#invalidateV6Snapshots()
    })
    this.#closePicker()
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #removeV6Definition(kind: PromptDefinitionKind, definitionId: string): void {
    if (this.#v6ShotDraft) return
    const definition = this.#v6Definition(definitionId)
    if (
      !definition ||
      (kind === "subject" && !this.#documentV6.subjects.some((item) => item.id === definitionId)) ||
      (kind === "shot" && !this.#documentV6.shots.some((item) => item.id === definitionId))
    )
      return
    try {
      this.#recordGraphChange(() => {
        this.#documentV6 = removePromptDefinitionV6(this.#documentV6!, definitionId)
        this.#bodyEpoch += 1
        this.#bodyRevisions.delete(`definition:${definitionId}`)
        this.#invalidateV6Snapshots()
      })
    } catch (error) {
      this.#setHint(error instanceof Error ? error.message : "Definition is still referenced.")
      return
    }
    this.#closePicker()
    this.#renderEditor()
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #addDefinition(kind: "subject" | "shot"): void {
    if (this.#v6ShotDraft) {
      this.#setHint("Apply or cancel the current Shot timing edit first.")
      return
    }
    let index = 1
    let tag = `${kind}_${index}`
    while (
      [...this.#documentV6.subjects, ...this.#documentV6.shots].some(
        (definition) => definition.tag === tag,
      )
    )
      tag = `${kind}_${++index}`
    const id = createPromptDefinitionId()
    this.#closePicker()
    this.#recordGraphChange(() => {
      this.#documentV6 = assertPromptDocumentV6(
        kind === "subject"
          ? {
              ...this.#documentV6,
              subjects: [...this.#documentV6.subjects, { id, tag, parts: [] }],
            }
          : {
              ...this.#documentV6,
              shots: [...this.#documentV6.shots, { id, tag, frameIndex: 0, parts: [] }],
            },
      )
      this.#invalidateV6Snapshots()
      this.#renderEditor()
    })
    this.#notifyShots()
    this.#node.setDirtyCanvas(true, true)
  }

  #handlePickerKeydown(event: KeyboardEvent): boolean {
    if (this.#pickerMode === undefined) return false
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

  #toggleView(): void {
    this.#flushBodyEditors()
    if (this.#documentV6.view === "raw") {
      if (!this.#applyV6RawDraft()) return
      this.#documentV6 = { ...this.#documentV6, view: "structured" }
    } else {
      this.#documentV6 = { ...this.#documentV6, view: "raw" }
      this.#v6RawDraft = undefined
      this.#ensureV6RawSession()
    }
    this.#closePicker()
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #clearPrompt(): void {
    if (this.#documentV6.sections.length === 0) return
    this.#documentV6 = { ...this.#documentV6, sections: [] }
    this.#bodyEpoch += 1
    this.#bodyRevisions.clear()
    this.#closePicker()
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#setHint(localize(PROMPT_MESSAGES.cleared, this.#locale))
    this.#node.setDirtyCanvas(true, true)
  }

  async #copyPrompt(compiled: boolean): Promise<void> {
    this.#flushBodyEditors()
    const prompt = compiled
      ? compilePromptDocumentV6(this.#documentV6, this.#references())
      : renderAuthoringPromptV6(this.#documentV6, this.#references())
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

  #createSectionFromEntry(value: string): boolean {
    const normalizedValue = value.trim()
    const alias = normalizedValue.match(/^\/([a-z]+)$/iu)?.[1]?.toLocaleLowerCase()
    const aliasTitle = this.#preset.aliases.find((option) => option.command === alias)?.title
    const title =
      aliasTitle ??
      (normalizedValue.endsWith(":") ? normalizePromptSectionTitle(normalizedValue) : undefined)
    if (!title) {
      this.#setHint(localize(PROMPT_MESSAGES.invalidTitle, this.#locale))
      return false
    }
    this.#addOrFocusSection(title)
    return true
  }

  #addOrFocusSection(title: string): void {
    const existing = this.#documentV6.sections.find((section) => section.title === title)
    if (existing) {
      this.#closePicker()
      return
    }
    const id = createPromptDefinitionId()
    this.#documentV6 = assertPromptDocumentV6({
      ...this.#documentV6,
      view: "structured",
      sections: [...this.#documentV6.sections, { id, title, parts: [] }],
    })
    this.#closePicker()
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    const body = this.#workspaceRoot?.querySelector<HTMLElement>(
      `[data-prompt-section-body="${CSS.escape(title)}"]`,
    )
    if (body) placeCaretAtEnd(body)
    this.#node.setDirtyCanvas(true, true)
  }

  #removeSection(title: string): void {
    if (!this.#documentV6.sections.some((section) => section.title === title)) return
    this.#documentV6 = assertPromptDocumentV6({
      ...this.#documentV6,
      sections: this.#documentV6.sections.filter((section) => section.title !== title),
    })
    this.#bodyEpoch += 1
    this.#bodyRevisions.clear()
    this.#closePicker()
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#node.setDirtyCanvas(true, true)
  }

  #moveSection(title: string, delta: -1 | 1): void {
    const sourceIndex = this.#documentV6.sections.findIndex((section) => section.title === title)
    const targetIndex = Math.max(
      0,
      Math.min(this.#documentV6.sections.length - 1, sourceIndex + delta),
    )
    if (sourceIndex < 0 || sourceIndex === targetIndex) return
    const sections = [...this.#documentV6.sections]
    const [section] = sections.splice(sourceIndex, 1)
    if (!section) return
    sections.splice(targetIndex, 0, section)
    this.#recordGraphChange(() => {
      this.#documentV6 = assertPromptDocumentV6({ ...this.#documentV6, sections })
      this.#closePicker()
      this.#invalidateV6Snapshots()
      this.#renderEditor()
      this.#node.setDirtyCanvas(true, true)
    })
    this.#workspaceRoot
      ?.querySelector<HTMLElement>(`[data-prompt-section-drag-handle="${CSS.escape(title)}"]`)
      ?.focus()
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
    if (!title || this.#documentV6.view !== "structured") {
      event.preventDefault()
      return
    }
    this.#draggedSectionTitle = title
    event.dataTransfer?.setData(PROMPT_SECTION_DRAG_MIME, title)
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
    const dragSection = section ?? handle?.closest<HTMLElement>("[data-prompt-section]")
    dragSection?.classList.add("is-dragging")
    event.stopPropagation()
  }

  #onDefinitionDragStart(kind: PromptDefinitionKind, identity: string, event: DragEvent): void {
    const definition = this.#v6Definition(identity)
    const tag =
      definition &&
      ((kind === "subject" && this.#documentV6.subjects.some((item) => item.id === identity)) ||
        (kind === "shot" && this.#documentV6.shots.some((item) => item.id === identity)))
        ? definition.tag
        : undefined
    const card =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-prompt-definition]")
        : undefined
    if (!tag || this.#v6ShotDraft) {
      event.preventDefault()
      return
    }
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
    const values =
      source.kind === "subject" ? [...this.#documentV6.subjects] : [...this.#documentV6.shots]
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
      this.#documentV6 = assertPromptDocumentV6(
        source.kind === "subject"
          ? { ...this.#documentV6, subjects: values }
          : { ...this.#documentV6, shots: values },
      )
      this.#invalidateV6Snapshots()
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
    const sourceIndex = this.#documentV6.sections.findIndex(
      (section) => section.title === sourceTitle,
    )
    const targetIndex = this.#documentV6.sections.findIndex(
      (section) => section.title === targetTitle,
    )
    if (sourceIndex < 0 || targetIndex < 0) {
      this.#clearSectionDrag()
      return
    }
    this.#recordGraphChange(() => {
      const sections = [...this.#documentV6.sections]
      const [section] = sections.splice(sourceIndex, 1)
      if (!section) return
      const adjustedTargetIndex = sections.findIndex((candidate) => candidate.title === targetTitle)
      sections.splice(adjustedTargetIndex + (after ? 1 : 0), 0, section)
      this.#documentV6 = assertPromptDocumentV6({ ...this.#documentV6, sections })
      this.#closePicker()
      this.#invalidateV6Snapshots()
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
    this.#pickerAnchor = body.closest<HTMLElement>("[data-prompt-section]") ?? body
    if (referenceMatch) this.#updateReferencePicker(match[1] ?? "")
    else if (canOpenSubjectPicker) this.#updateSubjectPicker(subjectMatch?.[1] ?? "", body)
    else this.#closePicker()
  }

  #updateSectionEntryPickerQuery(value: string, entry: HTMLInputElement): void {
    if (document.activeElement !== entry) {
      this.#closePicker()
      return
    }
    const match = value.trim().match(/^\/([a-z]*)$/iu)
    if (match) {
      this.#pickerAnchor = entry
      this.#updateAliasPicker(match[1] ?? "")
    } else this.#closePicker()
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
    this.#pickerSubjects = this.#documentV6.subjects.filter((subject, index) =>
      [subject.tag, `subject${index + 1}`, `<Subject ${index + 1}>`].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    this.#pickerShots = this.#documentV6.shots.filter((shot) =>
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
      ![...this.#documentV6.subjects, ...this.#documentV6.shots].some(
        (definition) => definition.tag.toLowerCase() === label.toLowerCase(),
      )
        ? label
        : undefined
    this.#pickerIndex = Math.min(this.#pickerIndex, Math.max(0, this.#pickerOptionCount() - 1))
    this.#publishPicker()
  }

  #updateAliasPicker(query = ""): void {
    this.#pickerMode = "alias"
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
    if (!reference) return
    this.#insertV6Part({
      type: "mention",
      referenceId: reference.referenceId,
      mediaKind: reference.mediaKind,
      label: reference.label,
    })
  }

  #insertSubject(subject: PromptSubjectV6 | undefined): void {
    if (!subject) return
    this.#insertV6Part({ type: "definition-ref", definitionId: subject.id })
  }

  #insertShot(shot: PromptPickerShot | undefined): void {
    if (!shot) return
    this.#insertV6Part({ type: "definition-ref", definitionId: shot.id })
  }

  #createAndInsertSubject(label: string | undefined): void {
    if (!label) return
    if (this.#documentV6.subjects.some((candidate) => candidate.tag === label)) return
    const id = createPromptDefinitionId()
    this.#documentV6 = assertPromptDocumentV6({
      ...this.#documentV6,
      subjects: [...this.#documentV6.subjects, { id, tag: label, parts: [] }],
    })
    this.#invalidateV6Snapshots()
    this.#renderEditor()
    this.#insertV6Part({ type: "definition-ref", definitionId: id })
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

  #insertV6Part(part: PromptPartV6): void {
    if (!this.#v6PickerTarget) return
    const handle = this.#bodyHandles.get(this.#v6BodyKey(this.#v6PickerTarget))
    if (!handle) return
    handle.insertParts([part], this.#v6PickerReplaceLength)
    this.#closePicker()
    this.#node.setDirtyCanvas(true, true)
  }

  #closePicker(): void {
    this.#pickerAnchor = undefined
    this.#pickerMode = undefined
    this.#pickerReferences = []
    this.#pickerSubjects = []
    this.#pickerCreateSubject = undefined
    this.#pickerAliases = []
    this.#pickerIndex = 0
    this.#pickerTarget = undefined
    this.#v6PickerTarget = undefined
    this.#v6PickerReplaceLength = 0
    this.#publishPicker()
  }
}
