import {
  createH3WorkspaceReact,
  type H3WorkspaceReactMount,
} from "./components/h3-workspace-react.tsx"
import {
  clearFileDropFeedback,
  createLoaderReact,
  type LoaderReactActions,
  type LoaderReactMount,
} from "./components/loader-react.tsx"
import {
  createLoaderViewSnapshot,
  sameLoaderViewSnapshot,
  type LoaderViewInput,
  type LoaderViewSnapshot,
} from "./view-model.ts"

export type LoaderViewMode = "references" | "single-image"

export interface LoaderViewBridgeOptions {
  root: HTMLElement
  mode: LoaderViewMode
  dragScope: string
  getViewInput(): LoaderViewInput
  actions: LoaderReactActions
  onReactCommit?(): void
  requestRender(): void
}

/**
 * Owns publication and mount lifecycle for a Loader view.
 *
 * The bridge only reads Controller-provided view input. It never dispatches,
 * mutates LoaderState, or owns runtime/player/editor DOM.
 */
export class LoaderViewBridge {
  readonly #root: HTMLElement
  readonly #reactHost: HTMLElement
  readonly #options: LoaderViewBridgeOptions
  #reactMount: LoaderReactMount | undefined
  #workspaceRoot: HTMLElement | undefined
  #workspaceMount: H3WorkspaceReactMount | undefined
  #viewSnapshot: LoaderViewSnapshot | undefined
  #viewListeners = new Set<() => void>()
  #renderFrame: number | undefined
  #destroyed = false

  constructor(options: LoaderViewBridgeOptions) {
    this.#options = options
    this.#root = options.root
    this.#reactHost = document.createElement("div")
    this.#reactHost.dataset.loaderReactRoot = ""
    this.#root.replaceChildren(this.#reactHost)
  }

  getSnapshot(): LoaderViewSnapshot {
    if (!this.#viewSnapshot)
      this.#viewSnapshot = createLoaderViewSnapshot(this.#options.getViewInput())
    return this.#viewSnapshot
  }

  subscribe(listener: () => void): () => void {
    if (this.#destroyed) return () => undefined
    this.#viewListeners.add(listener)
    listener()
    return () => this.#viewListeners.delete(listener)
  }

  publish(): void {
    if (this.#destroyed) return
    const next = createLoaderViewSnapshot(this.#options.getViewInput())
    if (this.#viewSnapshot && sameLoaderViewSnapshot(this.#viewSnapshot, next)) return
    this.#viewSnapshot = next
    for (const listener of this.#viewListeners) listener()
  }

  render(): void {
    if (this.#destroyed) return
    this.cancelScheduledRender()
    this.publish()
    const options = {
      container: this.#reactHost,
      surface: this.#root,
      mode: this.#options.mode,
      dragScope: this.#options.dragScope,
      subscribe: (listener: () => void) => this.subscribe(listener),
      getSnapshot: () => this.getSnapshot(),
      actions: this.#options.actions,
      onCommit: this.#options.onReactCommit,
    }
    if (!this.#reactMount) this.#reactMount = createLoaderReact(options)
    else this.#reactMount.update()
  }

  update(): void {
    if (!this.#destroyed) this.#reactMount?.update()
  }

  scheduleRender(): void {
    if (this.#destroyed || this.#renderFrame !== undefined) return
    this.#renderFrame = globalThis.requestAnimationFrame(() => {
      this.#renderFrame = undefined
      this.#options.requestRender()
    })
  }

  cancelScheduledRender(): void {
    if (this.#renderFrame === undefined) return
    globalThis.cancelAnimationFrame(this.#renderFrame)
    this.#renderFrame = undefined
  }

  get interactionRoot(): HTMLElement | undefined {
    return this.#workspaceRoot
  }

  mountH3Workspace(container: HTMLElement): H3WorkspaceReactMount {
    this.#workspaceMount?.destroy()
    if (this.#destroyed) return { destroy: () => undefined }
    this.#workspaceRoot = container
    const mount = createH3WorkspaceReact({
      container,
      subscribe: (listener) => this.subscribe(listener),
      getSnapshot: () => this.getSnapshot(),
      actions: this.#options.actions,
    })
    const managedMount: H3WorkspaceReactMount = {
      destroy: () => {
        mount.destroy()
        if (this.#workspaceRoot === container) this.#workspaceRoot = undefined
        if (this.#workspaceMount === managedMount) this.#workspaceMount = undefined
      },
    }
    this.#workspaceMount = managedMount
    return managedMount
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.cancelScheduledRender()
    this.#workspaceMount?.destroy()
    this.#workspaceMount = undefined
    this.#workspaceRoot = undefined
    this.#reactMount?.destroy()
    this.#reactMount = undefined
    clearFileDropFeedback(this.#root)
    this.#root.classList.remove("is-dragging")
    this.#viewListeners.clear()
    this.#root.replaceChildren()
  }
}
