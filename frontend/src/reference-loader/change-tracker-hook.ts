import { ChangeTracker } from "../../scripts/changeTracker.js"

const PATCH_MARKER = "__referenceLoaderHistoryGuard"

export function installReferenceEditorHistoryGuard(): void {
  const prototype = ChangeTracker.prototype as typeof ChangeTracker.prototype & {
    [PATCH_MARKER]?: boolean
    undoRedo: (event: KeyboardEvent | "undo" | "redo" | null) => Promise<true | undefined>
  }

  if (prototype[PATCH_MARKER]) return

  const originalUndoRedo = prototype.undoRedo
  prototype.undoRedo = async function (event: KeyboardEvent | "undo" | "redo" | null) {
    if (event == null || typeof event === "string") {
      return originalUndoRedo.call(this, event)
    }

    const active = document.activeElement
    if (
      active instanceof HTMLElement &&
      (active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement ||
        (active.isContentEditable && event.defaultPrevented))
    ) {
      return
    }

    return originalUndoRedo.call(this, event)
  }

  console.info(
    "[Reference-Loader] ChangeTracker history guard installed.\n" +
      "Workaround before https://github.com/Comfy-Org/ComfyUI_frontend/pull/17316 is merged.",
  )
  Object.defineProperty(prototype, PATCH_MARKER, { value: true })
}
