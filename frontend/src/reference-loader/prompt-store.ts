import {
  assertPromptDocumentV6,
  compilePromptDocumentV6,
  createEmptyPromptDocumentV6,
  deserializePromptDocumentV6,
  parseAuthoringPromptV6,
  parsePromptPartsV6,
  removePromptDefinitionV6,
  renamePromptDefinitionV6,
  renderAuthoringPromptV6,
  serializePromptDocumentV6,
  type PromptDocumentV6,
  type PromptPartV6,
  type PromptReference,
  type PromptV6ValidationResult,
} from "./prompt-v6.ts"

type ReferenceProvider = () => readonly PromptReference[]

export interface PromptStoreSnapshot {
  readonly document: PromptDocumentV6
  readonly serialized: string
  readonly sourceText: string
  readonly compiledText: string
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return value
}

/** Owns the canonical Prompt v6 document and its pure projections. */
export class PromptStore {
  readonly #references: ReferenceProvider
  readonly #initialIssues: readonly string[]
  #document: PromptDocumentV6
  #snapshot: PromptStoreSnapshot
  #listeners = new Set<() => void>()
  #destroyed = false

  constructor(references: ReferenceProvider, serialized: unknown) {
    this.#references = references
    const parsed = deserializePromptDocumentV6(serialized)
    this.#initialIssues = Object.freeze(
      parsed.document
        ? [...parsed.issues]
        : [
            ...parsed.issues,
            "Only Prompt state version 6 is supported; the previous state was reset.",
          ],
    )
    this.#document = deepFreeze(parsed.document ?? createEmptyPromptDocumentV6())
    this.#snapshot = this.#buildSnapshot()
  }

  get initialIssues(): readonly string[] {
    return this.#initialIssues
  }

  get document(): PromptDocumentV6 {
    return this.#document
  }

  get snapshot(): PromptStoreSnapshot {
    return this.#snapshot
  }

  get sourceText(): string {
    return this.#snapshot.sourceText
  }

  get compiledText(): string {
    return this.#snapshot.compiledText
  }

  subscribe(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#listeners.add(listener)
    listener()
    return () => this.#listeners.delete(listener)
  }

  replace(value: PromptDocumentV6): boolean {
    if (this.#destroyed) return false
    const next = deepFreeze(assertPromptDocumentV6(value))
    const nextSerialized = serializePromptDocumentV6(next)
    if (nextSerialized === this.#snapshot.serialized) return false
    this.#document = next
    this.#snapshot = this.#buildSnapshot()
    for (const listener of this.#listeners) listener()
    return true
  }

  restore(serialized: unknown): PromptV6ValidationResult {
    const parsed = deserializePromptDocumentV6(serialized)
    if (parsed.document) this.replace(parsed.document)
    return parsed
  }

  refresh(): void {
    if (this.#destroyed) return
    this.#snapshot = this.#buildSnapshot()
    for (const listener of this.#listeners) listener()
  }

  serialize(): string {
    return this.#snapshot.serialized
  }

  parsePromptParts(value: string, currentDocument = this.#document): PromptPartV6[] {
    return parsePromptPartsV6(value, this.#references(), currentDocument)
  }

  parseAuthoring(value: string, currentDocument = this.#document): PromptDocumentV6 {
    return parseAuthoringPromptV6(value, this.#references(), currentDocument)
  }

  renameDefinition(definitionId: string, tag: string): boolean {
    return this.replace(renamePromptDefinitionV6(this.#document, definitionId, tag))
  }

  removeDefinition(definitionId: string): boolean {
    return this.replace(removePromptDefinitionV6(this.#document, definitionId))
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#listeners.clear()
  }

  #buildSnapshot(): PromptStoreSnapshot {
    const document = this.#document
    return Object.freeze({
      document,
      serialized: serializePromptDocumentV6(document),
      sourceText: renderAuthoringPromptV6(document, this.#references()),
      compiledText: compilePromptDocumentV6(document, this.#references()),
    })
  }
}
