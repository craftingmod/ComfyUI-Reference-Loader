import type {
  PromptEditorTargetV6,
  PromptRichEditorHandle,
} from "./components/prompt-editor-contract.ts"

/** Owns editor handles and event ownership without owning Prompt state. */
export class PromptEditorEngine {
  readonly #bodyFlushers = new Set<() => void>()
  readonly #bodyHandles = new Map<string, PromptRichEditorHandle>()
  #destroyed = false

  registerBodyEditor(
    target: PromptEditorTargetV6,
    handle: PromptRichEditorHandle | undefined,
  ): () => void {
    if (this.#destroyed || !handle) return () => undefined
    const key = `${target.type}:${target.id}`
    const flush = (): void => handle.flushAcceptedModel()
    this.#bodyFlushers.add(flush)
    this.#bodyHandles.set(key, handle)
    return () => {
      this.#bodyFlushers.delete(flush)
      if (this.#bodyHandles.get(key) === handle) this.#bodyHandles.delete(key)
    }
  }

  flushAcceptedModels(): void {
    if (this.#destroyed) return
    for (const flush of [...this.#bodyFlushers]) flush()
  }

  getBodyEditor(target: PromptEditorTargetV6): PromptRichEditorHandle | undefined {
    return this.#bodyHandles.get(`${target.type}:${target.id}`)
  }

  isReactTextEditor(target: EventTarget | null): target is HTMLElement {
    return target instanceof Element && Boolean(target.closest("[data-prompt-react-editor]"))
  }

  handleKeydown(event: KeyboardEvent, handlePickerKeydown: (event: KeyboardEvent) => void): void {
    if (this.#destroyed || !(event.target instanceof Node) || !this.isReactTextEditor(event.target))
      return
    const modifier = event.ctrlKey || event.metaKey
    const isUndo = modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z"
    const isRedo =
      modifier &&
      !event.altKey &&
      (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))
    if (isUndo || isRedo) {
      // Lexical owns local editor history. Prevent ComfyUI's graph shortcut
      // from seeing the same key event.
      event.stopPropagation()
      return
    }
    handlePickerKeydown(event)
  }

  handlePaste(event: ClipboardEvent): void {
    if (!this.#destroyed) event.stopPropagation()
  }

  handleBlur(roots: readonly HTMLElement[], closePicker: () => void): void {
    if (this.#destroyed) return
    globalThis.setTimeout(() => {
      if (!this.#destroyed && !roots.some((root) => root.contains(document.activeElement)))
        closePicker()
    }, 0)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#bodyFlushers.clear()
    this.#bodyHandles.clear()
  }
}
