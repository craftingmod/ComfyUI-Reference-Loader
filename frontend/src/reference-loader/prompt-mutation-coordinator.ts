import type {
  PromptBodyEdit,
  PromptBodyEditResult,
  PromptBodySnapshot,
  PromptEditorTargetV6,
} from "./components/prompt-editor-contract.ts"
import type { PromptStore } from "./prompt-store.ts"
import {
  assertPromptDocumentV6,
  createPromptDefinitionId,
  normalizePromptPartsV6,
  removePromptDefinitionV6,
  renamePromptDefinitionV6,
  type PromptDocumentV6,
  type PromptPartV6,
} from "./prompt-v6.ts"

export type PromptMutationReason =
  | "stale"
  | "invalid"
  | "missing-target"
  | "not-found"
  | "draft-active"
  | "no-op"
  | "raw-conflict"

export interface PromptMutationOutcome {
  readonly accepted: boolean
  readonly changed: boolean
  readonly reason?: PromptMutationReason
  readonly message?: string
}

export interface PromptRestoreOutcome extends PromptMutationOutcome {
  readonly issues: readonly string[]
  readonly recoveredFromVersion?: number
}

export interface PromptCreatedSubjectOutcome extends PromptMutationOutcome {
  readonly id?: string
}

export interface PromptMutationCoordinatorOptions {
  readonly runGraphChange: (change: () => void) => void
  readonly markDirty: () => void
  readonly referenceFingerprint: () => string
}

type DefinitionKind = "subject" | "shot"

type PromptShotDraft = {
  readonly initial: PromptDocumentV6
  readonly document: PromptDocumentV6
}

/** Owns Prompt document write use-cases without DOM or snapshot knowledge. */
export class PromptMutationCoordinator {
  readonly #store: PromptStore
  readonly #runGraphChange: (change: () => void) => void
  readonly #markDirty: () => void
  #shotDraft: PromptShotDraft | undefined
  #bodyRevisions = new Map<string, number>()
  #bodyEpoch = 0
  #rawDraft: string | undefined
  #rawBaseFingerprint = ""
  #rawReferenceFingerprint = ""
  readonly #referenceFingerprint: () => string

  constructor(store: PromptStore, options: PromptMutationCoordinatorOptions) {
    this.#store = store
    this.#runGraphChange = options.runGraphChange
    this.#markDirty = options.markDirty
    this.#referenceFingerprint = options.referenceFingerprint
  }

  get document(): PromptDocumentV6 {
    return this.#shotDraft?.document ?? this.#store.document
  }

  get draftDocument(): PromptDocumentV6 | undefined {
    return this.#shotDraft?.document
  }

  get hasShotDraft(): boolean {
    return this.#shotDraft !== undefined
  }

  get bodyEpoch(): number {
    return this.#bodyEpoch
  }

  get rawDraftText(): string | undefined {
    this.#ensureRawSession()
    return this.#rawDraft ?? this.#store.sourceText
  }

  getPromptBodySnapshot(target: PromptEditorTargetV6): PromptBodySnapshot | undefined {
    const owner = this.#bodyOwner(target)
    if (!owner) return undefined
    return {
      target,
      parts: owner.parts,
      revision: this.#bodyRevisions.get(this.#bodyKey(target)) ?? 0,
      epoch: this.#bodyEpoch,
    }
  }

  applyPromptBodyEdit(edit: PromptBodyEdit): PromptBodyEditResult {
    if (this.#shotDraft) return { ok: false, reason: "stale" }
    if (edit.epoch !== this.#bodyEpoch) return { ok: false, reason: "stale" }
    const owner = this.#bodyOwner(edit.target)
    if (!owner) return { ok: false, reason: "missing-target" }
    const key = this.#bodyKey(edit.target)
    const revision = this.#bodyRevisions.get(key) ?? 0
    if (edit.baseRevision !== revision) return { ok: false, reason: "stale" }

    let parts: PromptPartV6[]
    try {
      parts = normalizePromptPartsV6(edit.parts)
    } catch {
      return { ok: false, reason: "invalid" }
    }
    if (partsEqual(parts, owner.parts)) return { ok: true, revision, editId: edit.editId }

    try {
      this.#store.replace(this.#replaceBody(edit.target, parts))
    } catch {
      return { ok: false, reason: "invalid" }
    }
    const nextRevision = revision + 1
    this.#bodyRevisions.set(key, nextRevision)
    this.#markDirty()
    return { ok: true, revision: nextRevision, editId: edit.editId }
  }

  validatePromptBodyParts(target: PromptEditorTargetV6, parts: readonly PromptPartV6[]): boolean {
    if (this.#shotDraft || !this.#bodyOwner(target)) return false
    try {
      assertPromptDocumentV6(this.#replaceBody(target, parts))
      return true
    } catch {
      return false
    }
  }

  parsePromptBodyText(value: string): PromptPartV6[] {
    return this.#store.parsePromptParts(value, this.document)
  }

  updateRawDraftText(value: string): PromptMutationOutcome {
    if (this.document.view !== "raw") return this.#outcome(false, false, "not-found")
    this.#ensureRawSession()
    this.#rawDraft = value
    this.#markDirty()
    return this.#outcome(true, true)
  }

  toggleView(): PromptMutationOutcome {
    if (this.document.view === "raw") {
      const applied = this.#applyRawDraft()
      if (!applied.accepted) return applied
      this.#store.replace({ ...this.#store.document, view: "structured" })
    } else {
      this.#store.replace({ ...this.#store.document, view: "raw" })
      this.#rawDraft = undefined
      this.#ensureRawSession()
    }
    this.#markDirty()
    return this.#outcome(true, true)
  }

  clear(): PromptMutationOutcome {
    if (this.#store.document.sections.length === 0) return this.#outcome(true, false, "no-op")
    this.#store.replace({ ...this.#store.document, sections: [] })
    this.#resetBodyState()
    this.#markDirty()
    return this.#outcome(true, true)
  }

  restore(serialized: unknown): PromptRestoreOutcome {
    const parsed = this.#store.restore(serialized)
    if (!parsed.document) {
      return { ...this.#outcome(false, false, "invalid"), issues: parsed.issues }
    }
    this.#shotDraft = undefined
    this.#resetBodyState()
    this.#rawDraft = undefined
    this.#rawBaseFingerprint = ""
    this.#rawReferenceFingerprint = ""
    this.#ensureRawSession()
    return {
      ...this.#outcome(true, parsed.changed),
      issues: parsed.issues,
      recoveredFromVersion: parsed.recoveredFromVersion,
    }
  }

  refreshRawReferenceSession(referenceFingerprint: string): void {
    if (this.document.view !== "raw") return
    this.#rawDraft = this.#store.sourceText
    this.#rawReferenceFingerprint = referenceFingerprint
  }

  setShotFrame(tag: string, frameIndex: number): PromptMutationOutcome {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0)
      return this.#outcome(false, false, "invalid")
    const current = this.#store.document.shots.find((shot) => shot.tag === tag)
    if (!current) return this.#outcome(false, false, "not-found")
    if (current.frameIndex === frameIndex) return this.#outcome(true, false, "no-op")
    this.#runGraphChange(() => {
      this.#store.replace({
        ...this.#store.document,
        shots: this.#store.document.shots.map((shot) =>
          shot.id === current.id ? { ...shot, frameIndex } : shot,
        ),
      })
    })
    this.#markDirty()
    return this.#outcome(true, true)
  }

  setShotFrameDraft(tag: string, frameIndex: number): PromptMutationOutcome {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0)
      return this.#outcome(false, false, "invalid")
    const current = this.document.shots.find((shot) => shot.tag === tag)
    if (!current) return this.#outcome(false, false, "not-found")
    if (current.frameIndex === frameIndex) return this.#outcome(true, false, "no-op")
    const draft = this.#shotDraft ?? {
      initial: this.#store.document,
      document: this.#store.document,
    }
    this.#shotDraft = {
      ...draft,
      document: assertPromptDocumentV6({
        ...draft.document,
        shots: draft.document.shots.map((shot) =>
          shot.id === current.id ? { ...shot, frameIndex } : shot,
        ),
      }),
    }
    this.#markDirty()
    return this.#outcome(true, true)
  }

  setShotFrameDraftByIdentity(identity: string, frameIndex: number): PromptMutationOutcome {
    const shot = this.document.shots.find((candidate) => candidate.id === identity)
    return shot
      ? this.setShotFrameDraft(shot.tag, frameIndex)
      : this.#outcome(false, false, "not-found")
  }

  removeShot(tag: string): PromptMutationOutcome {
    const current = this.document.shots.find((shot) => shot.tag === tag)
    if (!current) return this.#outcome(false, false, "not-found")
    const draft = this.#shotDraft ?? {
      initial: this.#store.document,
      document: this.#store.document,
    }
    this.#shotDraft = {
      ...draft,
      document: assertPromptDocumentV6({
        ...draft.document,
        shots: draft.document.shots.filter((shot) => shot.id !== current.id),
      }),
    }
    this.#markDirty()
    return this.#outcome(true, true)
  }

  removeShotByIdentity(identity: string): PromptMutationOutcome {
    const shot = this.document.shots.find((candidate) => candidate.id === identity)
    return shot ? this.removeShot(shot.tag) : this.#outcome(false, false, "not-found")
  }

  applyShotDraft(): PromptMutationOutcome {
    if (!this.#shotDraft) return this.#outcome(false, false, "not-found")
    this.#runGraphChange(() => {
      this.#store.replace(this.#shotDraft!.document)
    })
    this.#shotDraft = undefined
    this.#resetBodyState()
    this.#markDirty()
    return this.#outcome(true, true)
  }

  cancelShotDraft(): PromptMutationOutcome {
    if (!this.#shotDraft) return this.#outcome(false, false, "not-found")
    this.#shotDraft = undefined
    this.#markDirty()
    return this.#outcome(true, true)
  }

  renameDefinition(definitionId: string, tag: string): PromptMutationOutcome {
    const current = this.#definition(definitionId)
    if (!current) return this.#outcome(false, false, "not-found")
    if (current.tag === tag) return this.#outcome(true, false, "no-op")
    let next: PromptDocumentV6
    try {
      next = renamePromptDefinitionV6(this.#store.document, definitionId, tag)
    } catch (error) {
      return this.#outcome(
        false,
        false,
        "invalid",
        errorMessage(error, "Definition tag is invalid."),
      )
    }
    this.#runGraphChange(() => this.#store.replace(next))
    this.#markDirty()
    return this.#outcome(true, true)
  }

  reorderDefinition(
    kind: DefinitionKind,
    definitionId: string,
    delta: -1 | 1,
  ): PromptMutationOutcome {
    if (this.#shotDraft) return this.#outcome(false, false, "draft-active")
    const values = this.#definitions(kind)
    const sourceIndex = values.findIndex((definition) => definition.id === definitionId)
    const targetIndex = Math.max(0, Math.min(values.length - 1, sourceIndex + delta))
    if (sourceIndex < 0 || sourceIndex === targetIndex)
      return this.#outcome(sourceIndex >= 0, false, "no-op")
    const next = [...values]
    const [item] = next.splice(sourceIndex, 1)
    if (!item) return this.#outcome(false, false, "not-found")
    next.splice(targetIndex, 0, item)
    return this.#replaceDefinitionOrder(kind, next)
  }

  reorderDefinitionByTarget(
    kind: DefinitionKind,
    sourceTag: string,
    targetTag: string,
    after: boolean,
  ): PromptMutationOutcome {
    if (this.#shotDraft || sourceTag === targetTag)
      return this.#outcome(false, false, this.#shotDraft ? "draft-active" : "no-op")
    const values = this.#definitions(kind)
    const sourceIndex = values.findIndex((definition) => definition.tag === sourceTag)
    if (sourceIndex < 0) return this.#outcome(false, false, "not-found")
    const [item] = values.splice(sourceIndex, 1)
    const targetIndex = values.findIndex((definition) => definition.tag === targetTag)
    if (!item || targetIndex < 0) return this.#outcome(false, false, "not-found")
    values.splice(targetIndex + (after ? 1 : 0), 0, item)
    return this.#replaceDefinitionOrder(kind, values)
  }

  removeDefinition(kind: DefinitionKind, definitionId: string): PromptMutationOutcome {
    if (this.#shotDraft) return this.#outcome(false, false, "draft-active")
    const values = this.#definitions(kind)
    if (!values.some((definition) => definition.id === definitionId))
      return this.#outcome(false, false, "not-found")
    let next: PromptDocumentV6
    try {
      next = removePromptDefinitionV6(this.#store.document, definitionId)
    } catch (error) {
      return this.#outcome(
        false,
        false,
        "invalid",
        errorMessage(error, "Definition is still referenced."),
      )
    }
    this.#runGraphChange(() => this.#store.replace(next))
    this.#bodyEpoch += 1
    this.#bodyRevisions.delete(`definition:${definitionId}`)
    this.#markDirty()
    return this.#outcome(true, true)
  }

  addDefinition(kind: DefinitionKind): PromptMutationOutcome {
    if (this.#shotDraft)
      return this.#outcome(
        false,
        false,
        "draft-active",
        "Apply or cancel the current Shot timing edit first.",
      )
    let index = 1
    let tag = `${kind}_${index}`
    while (
      [...this.#store.document.subjects, ...this.#store.document.shots].some(
        (item) => item.tag === tag,
      )
    )
      tag = `${kind}_${++index}`
    const id = createPromptDefinitionId()
    this.#runGraphChange(() => {
      this.#store.replace(
        kind === "subject"
          ? {
              ...this.#store.document,
              subjects: [...this.#store.document.subjects, { id, tag, parts: [] }],
            }
          : {
              ...this.#store.document,
              shots: [...this.#store.document.shots, { id, tag, frameIndex: 0, parts: [] }],
            },
      )
    })
    this.#markDirty()
    return this.#outcome(true, true)
  }

  addOrFocusSection(title: string): PromptMutationOutcome {
    if (this.#store.document.sections.some((section) => section.title === title))
      return this.#outcome(true, false, "no-op")
    this.#store.replace({
      ...this.#store.document,
      view: "structured",
      sections: [
        ...this.#store.document.sections,
        { id: createPromptDefinitionId(), title, parts: [] },
      ],
    })
    this.#markDirty()
    return this.#outcome(true, true)
  }

  removeSection(title: string): PromptMutationOutcome {
    if (!this.#store.document.sections.some((section) => section.title === title))
      return this.#outcome(false, false, "not-found")
    this.#store.replace({
      ...this.#store.document,
      sections: this.#store.document.sections.filter((section) => section.title !== title),
    })
    this.#resetBodyState()
    this.#markDirty()
    return this.#outcome(true, true)
  }

  reorderSection(title: string, delta: -1 | 1): PromptMutationOutcome {
    const values = [...this.#store.document.sections]
    const sourceIndex = values.findIndex((section) => section.title === title)
    const targetIndex = Math.max(0, Math.min(values.length - 1, sourceIndex + delta))
    if (sourceIndex < 0 || sourceIndex === targetIndex)
      return this.#outcome(sourceIndex >= 0, false, "no-op")
    const [item] = values.splice(sourceIndex, 1)
    if (!item) return this.#outcome(false, false, "not-found")
    values.splice(targetIndex, 0, item)
    return this.#replaceSectionOrder(values)
  }

  reorderSectionByTarget(
    sourceTitle: string,
    targetTitle: string,
    after: boolean,
  ): PromptMutationOutcome {
    if (sourceTitle === targetTitle) return this.#outcome(false, false, "no-op")
    const values = [...this.#store.document.sections]
    const sourceIndex = values.findIndex((section) => section.title === sourceTitle)
    if (sourceIndex < 0) return this.#outcome(false, false, "not-found")
    const [item] = values.splice(sourceIndex, 1)
    const targetIndex = values.findIndex((section) => section.title === targetTitle)
    if (!item || targetIndex < 0) return this.#outcome(false, false, "not-found")
    values.splice(targetIndex + (after ? 1 : 0), 0, item)
    return this.#replaceSectionOrder(values)
  }

  createSubject(label: string): PromptCreatedSubjectOutcome {
    if (
      [...this.#store.document.subjects, ...this.#store.document.shots].some(
        (item) => item.tag === label,
      )
    )
      return { ...this.#outcome(false, false, "no-op"), id: undefined }
    const id = createPromptDefinitionId()
    this.#store.replace({
      ...this.#store.document,
      subjects: [...this.#store.document.subjects, { id, tag: label, parts: [] }],
    })
    return { ...this.#outcome(true, true), id }
  }

  #replaceDefinitionOrder(
    kind: DefinitionKind,
    values: PromptDocumentV6["subjects"] | PromptDocumentV6["shots"],
  ): PromptMutationOutcome {
    this.#runGraphChange(() => {
      this.#store.replace(
        kind === "subject"
          ? { ...this.#store.document, subjects: values as PromptDocumentV6["subjects"] }
          : { ...this.#store.document, shots: values as PromptDocumentV6["shots"] },
      )
    })
    this.#markDirty()
    return this.#outcome(true, true)
  }

  #replaceSectionOrder(sections: PromptDocumentV6["sections"]): PromptMutationOutcome {
    this.#runGraphChange(() => this.#store.replace({ ...this.#store.document, sections }))
    this.#markDirty()
    return this.#outcome(true, true)
  }

  #applyRawDraft(): PromptMutationOutcome {
    this.#ensureRawSession()
    if (this.#rawReferenceFingerprint !== this.#referenceFingerprint())
      return this.#outcome(
        false,
        false,
        "raw-conflict",
        "References changed while Raw Import was open. Reopen Raw and apply again.",
      )
    if (this.#rawBaseFingerprint !== this.#store.serialize())
      return this.#outcome(
        false,
        false,
        "raw-conflict",
        "Prompt changed while Raw Import was open. Reopen Raw and apply again.",
      )
    let next: PromptDocumentV6
    try {
      next = this.#store.parseAuthoring(this.#rawDraft ?? "", this.document)
    } catch (error) {
      return this.#outcome(false, false, "invalid", errorMessage(error, "Raw Prompt is invalid."))
    }
    this.#runGraphChange(() => this.#store.replace(next))
    this.#resetBodyState()
    this.#rawDraft = undefined
    this.#rawBaseFingerprint = ""
    this.#rawReferenceFingerprint = ""
    return this.#outcome(true, true)
  }

  #ensureRawSession(): void {
    if (this.document.view !== "raw" || this.#rawDraft !== undefined) return
    this.#rawDraft = this.#store.sourceText
    this.#rawBaseFingerprint = this.#store.serialize()
    this.#rawReferenceFingerprint = this.#referenceFingerprint()
  }

  #bodyKey(target: PromptEditorTargetV6): string {
    return `${target.type}:${target.id}`
  }

  #bodyOwner(
    target: PromptEditorTargetV6,
  ):
    | PromptDocumentV6["sections"][number]
    | PromptDocumentV6["subjects"][number]
    | PromptDocumentV6["shots"][number]
    | undefined {
    if (target.type === "section")
      return this.document.sections.find((section) => section.id === target.id)
    return this.#definition(target.id)
  }

  #definition(
    id: string,
  ): PromptDocumentV6["subjects"][number] | PromptDocumentV6["shots"][number] | undefined {
    return (
      this.document.subjects.find((subject) => subject.id === id) ??
      this.document.shots.find((shot) => shot.id === id)
    )
  }

  #definitions(kind: DefinitionKind): PromptDocumentV6["subjects"] | PromptDocumentV6["shots"] {
    return kind === "subject" ? [...this.#store.document.subjects] : [...this.#store.document.shots]
  }

  #replaceBody(target: PromptEditorTargetV6, parts: readonly PromptPartV6[]): PromptDocumentV6 {
    if (target.type === "section")
      return {
        ...this.document,
        sections: this.document.sections.map((section) =>
          section.id === target.id ? { ...section, parts: [...parts] } : section,
        ),
      }
    return {
      ...this.document,
      subjects: this.document.subjects.map((subject) =>
        subject.id === target.id ? { ...subject, parts: [...parts] } : subject,
      ),
      shots: this.document.shots.map((shot) =>
        shot.id === target.id ? { ...shot, parts: [...parts] } : shot,
      ),
    }
  }

  #resetBodyState(): void {
    this.#bodyEpoch += 1
    this.#bodyRevisions.clear()
  }

  #outcome(
    accepted: boolean,
    changed: boolean,
    reason?: PromptMutationReason,
    message?: string,
  ): PromptMutationOutcome {
    return { accepted, changed, reason, message }
  }
}

function partsEqual(left: readonly PromptPartV6[], right: readonly PromptPartV6[]): boolean {
  if (left.length !== right.length) return false
  return left.every((part, index) => {
    const other = right[index]
    return (
      other?.type === part.type &&
      (part.type === "text"
        ? other.type === "text" && other.text === part.text
        : part.type === "mention"
          ? other.type === "mention" &&
            other.referenceId === part.referenceId &&
            other.mediaKind === part.mediaKind &&
            other.label === part.label
          : other.type === "definition-ref" && other.definitionId === part.definitionId)
    )
  })
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}
