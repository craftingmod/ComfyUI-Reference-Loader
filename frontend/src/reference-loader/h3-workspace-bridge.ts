import type { H3TimelineFocus } from "./h3-timeline-session.ts"

export interface H3WorkspaceHost {
  getRoot(): HTMLElement
  getInteractionRoot(): HTMLElement | undefined
  isDestroyed(): boolean
  render(force?: boolean): void
}

/** Owns the native DOM effects of the H3 workspace. */
export class H3WorkspaceBridge {
  readonly #host: H3WorkspaceHost
  #destroyed = false

  constructor(host: H3WorkspaceHost) {
    this.#host = host
  }

  requestRender(force = false, focus?: H3TimelineFocus): void {
    if (this.#destroyed || this.#host.isDestroyed()) return
    if (focus?.kind === "preserve-editor-focus") {
      this.#renderPreservingFocus(focus.guideId)
      return
    }
    this.#host.render(force)
    if (!focus || this.#destroyed || this.#host.isDestroyed()) return
    const surface = this.#host.getInteractionRoot() ?? this.#host.getRoot()
    if (focus.kind === "editor-guide") {
      this.#focusEditorGuide(surface, focus.guideId)
      return
    }
    if (focus.kind === "workspace") {
      this.#focusWorkspace(surface)
      return
    }
    if (focus.kind === "timeline-guide") {
      const marker = [...surface.querySelectorAll<HTMLButtonElement>("[data-timeline-guide]")].find(
        (button) => button.dataset.timelineGuide === focus.guideId,
      )
      if (marker) {
        marker.focus({ preventScroll: true })
        return
      }
      surface
        .querySelector<HTMLButtonElement>(
          '[data-h3-action="select-placement"][data-h3-guide-id="' + focus.guideId + '"]',
        )
        ?.focus()
      return
    }
    if (focus.kind === "timeline-shot") {
      const mark = [...surface.querySelectorAll<HTMLButtonElement>("[data-timeline-shot]")].find(
        (button) => button.dataset.timelineShot === focus.tag,
      )
      if (focus.scroll) mark?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
      mark?.focus({ preventScroll: true })
      return
    }
    const parentId = focus.mediaId.endsWith(":audio") ? focus.mediaId.slice(0, -6) : focus.mediaId
    const action = focus.control === "toggle" ? "toggle-h3-guide" : "edit-h3-guide"
    for (const button of this.#host
      .getRoot()
      .querySelectorAll<HTMLButtonElement>("button[data-action]")) {
      if (
        button.dataset.action === action &&
        button.dataset.id === parentId &&
        button.dataset.h3Channel === focus.channel
      ) {
        button.focus()
        return
      }
    }
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
  }

  #focusEditorGuide(surface: HTMLElement, guideId: string): void {
    for (const row of surface.querySelectorAll<HTMLElement>(
      "[data-h3-editor] [data-h3-guide-id]",
    )) {
      if (row.dataset.h3GuideId !== guideId) continue
      row.scrollIntoView?.({ block: "nearest" })
      row.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.focus()
      return
    }
  }

  #focusWorkspace(surface: HTMLElement): void {
    const workspace = surface.querySelector<HTMLElement>("[data-h3-workspace]")
    if (!workspace) return
    workspace.scrollIntoView?.({ block: "nearest" })
    workspace.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')?.focus({
      preventScroll: true,
    })
  }

  #renderPreservingFocus(focusGuideId?: string): void {
    const active = document.activeElement
    const isField = active instanceof HTMLInputElement || active instanceof HTMLSelectElement
    const field = isField ? active.dataset.h3DraftField : undefined
    const guideId = isField ? active.dataset.h3GuideId : undefined
    this.#host.render(true)
    if (this.#destroyed || this.#host.isDestroyed()) return
    const surface = this.#host.getInteractionRoot() ?? this.#host.getRoot()
    if (field) {
      for (const element of surface.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "[data-h3-draft-field]",
      )) {
        if (element.dataset.h3DraftField === field && element.dataset.h3GuideId === guideId) {
          element.focus()
          return
        }
      }
    }
    if (focusGuideId) {
      for (const input of surface.querySelectorAll<HTMLInputElement>(
        '[data-h3-draft-field="frame"]',
      )) {
        if (input.dataset.h3GuideId === focusGuideId) {
          input.focus()
          break
        }
      }
    }
  }
}
