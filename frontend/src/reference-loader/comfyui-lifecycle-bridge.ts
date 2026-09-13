import type { ComfyAppLike, ComfyNode, ComfyWidget } from "../comfyui.ts"
import type { H3WorkspaceReactMount } from "./components/h3-workspace-react.tsx"
import type { ReferenceLoaderController } from "./components/loader.ts"
import type { PromptDefinitionsReactMount } from "./components/prompt-definitions-react.tsx"
import type { ReferencePromptController } from "./components/prompt-editor.ts"
import type { PromptReactMount } from "./components/prompt-react.tsx"

export interface NativeDisplayProxy {
  syncFromState(): void
  dispose(): void
}

export interface PromptPresetBinding {
  dispose(): void
}

type Cleanup = () => void

interface NodeLifecycleState {
  disposed: boolean
  cleanups: Set<Cleanup>
  controller?: ReferenceLoaderController
  loaderCleanup?: Cleanup
  promptController?: ReferencePromptController
  promptCleanup?: Cleanup
  promptReactMount?: PromptReactMount
  h3TimelineReactMount?: H3WorkspaceReactMount
  h3TimelineRoot?: HTMLElement
  promptDefinitionsReactMount?: PromptDefinitionsReactMount
  promptDefinitionRoot?: HTMLElement
  promptSubscription?: Cleanup
  promptPresetBinding?: PromptPresetBinding
  displayProxy?: NativeDisplayProxy
  nodeFileDropBinding?: Cleanup
  removalHookInstalled?: boolean
}

/**
 * Owns the ComfyUI-facing lifecycle for one Reference Loader extension.
 *
 * Canonical Loader/Prompt state stays in their existing controllers. This
 * bridge only keeps node-scoped bindings and makes node teardown idempotent.
 */
export class ComfyUILifecycleBridge {
  readonly #app: ComfyAppLike
  readonly #nodes = new WeakMap<ComfyNode, NodeLifecycleState>()

  constructor(app: ComfyAppLike) {
    this.#app = app
  }

  getController(node: ComfyNode): ReferenceLoaderController | undefined {
    return this.#state(node).controller
  }

  getPromptController(node: ComfyNode): ReferencePromptController | undefined {
    return this.#state(node).promptController
  }

  setPromptSubscription(node: ComfyNode, subscription: Cleanup | undefined): void {
    const state = this.#state(node)
    state.promptSubscription?.()
    state.promptSubscription = subscription
  }

  clearPromptSubscription(node: ComfyNode): void {
    const state = this.#state(node)
    state.promptSubscription?.()
    state.promptSubscription = undefined
  }

  setPromptPresetBinding(node: ComfyNode, binding: PromptPresetBinding | undefined): void {
    const state = this.#state(node)
    state.promptPresetBinding?.dispose()
    state.promptPresetBinding = binding
  }

  setPromptReactMount(node: ComfyNode, mount: PromptReactMount | undefined): void {
    const state = this.#state(node)
    state.promptReactMount?.destroy()
    state.promptReactMount = mount
  }

  setH3TimelineRoot(node: ComfyNode, root: HTMLElement | undefined): void {
    this.#state(node).h3TimelineRoot = root
  }

  getH3TimelineRoot(node: ComfyNode): HTMLElement | undefined {
    return this.#state(node).h3TimelineRoot
  }

  setH3TimelineReactMount(node: ComfyNode, mount: H3WorkspaceReactMount | undefined): void {
    const state = this.#state(node)
    state.h3TimelineReactMount?.destroy()
    state.h3TimelineReactMount = mount
  }

  disposeH3Timeline(node: ComfyNode, expectedRoot?: HTMLElement): void {
    const state = this.#state(node)
    if (expectedRoot && state.h3TimelineRoot !== expectedRoot) return
    state.h3TimelineReactMount?.destroy()
    state.h3TimelineReactMount = undefined
    if (!expectedRoot || state.h3TimelineRoot === expectedRoot) state.h3TimelineRoot = undefined
  }

  setPromptDefinitionRoot(node: ComfyNode, root: HTMLElement | undefined): void {
    this.#state(node).promptDefinitionRoot = root
  }

  getPromptDefinitionRoot(node: ComfyNode): HTMLElement | undefined {
    return this.#state(node).promptDefinitionRoot
  }

  setPromptDefinitionsReactMount(
    node: ComfyNode,
    mount: PromptDefinitionsReactMount | undefined,
  ): void {
    const state = this.#state(node)
    state.promptDefinitionsReactMount?.destroy()
    state.promptDefinitionsReactMount = mount
  }

  disposePromptDefinitions(node: ComfyNode, expectedRoot?: HTMLElement): void {
    const state = this.#state(node)
    if (expectedRoot && state.promptDefinitionRoot !== expectedRoot) return
    state.promptDefinitionsReactMount?.destroy()
    state.promptDefinitionsReactMount = undefined
    if (!expectedRoot || state.promptDefinitionRoot === expectedRoot) {
      state.promptDefinitionRoot = undefined
      state.promptController?.mountDefinitions(undefined)
    }
  }

  setDisplayProxy(node: ComfyNode, proxy: NativeDisplayProxy | undefined): void {
    const state = this.#state(node)
    state.displayProxy?.dispose()
    state.displayProxy = proxy
  }

  getDisplayProxy(node: ComfyNode): NativeDisplayProxy | undefined {
    return this.#state(node).displayProxy
  }

  setNodeFileDrop(node: ComfyNode, release: Cleanup | undefined): void {
    const state = this.#state(node)
    state.nodeFileDropBinding?.()
    state.nodeFileDropBinding = release
  }

  registerCleanup(node: ComfyNode, cleanup: Cleanup): Cleanup {
    const state = this.#state(node)
    if (state.disposed) {
      cleanup()
      return () => undefined
    }
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      state.cleanups.delete(release)
      cleanup()
    }
    state.cleanups.add(release)
    return release
  }

  attachLoader(node: ComfyNode, controller: ReferenceLoaderController, cleanup: Cleanup): Cleanup {
    this.disposeLoader(node)
    const state = this.#state(node)
    if (state.disposed) {
      cleanup()
      controller.destroy()
      return () => undefined
    }
    state.controller = controller
    const release = this.registerCleanup(node, () => {
      if (state.loaderCleanup === release) state.loaderCleanup = undefined
      cleanup()
      if (state.controller !== controller) return
      state.controller = undefined
      this.#disposeLoaderResources(state)
      controller.destroy()
    })
    state.loaderCleanup = release
    return release
  }

  disposeLoader(node: ComfyNode, expectedController?: ReferenceLoaderController): void {
    const state = this.#state(node)
    if (expectedController && state.controller !== expectedController) return
    if (state.loaderCleanup) {
      state.loaderCleanup()
      return
    }
    this.#disposeLoaderResources(state)
    if (!expectedController || state.controller === expectedController) {
      state.controller?.destroy()
      state.controller = undefined
    }
  }

  attachPrompt(node: ComfyNode, controller: ReferencePromptController, cleanup: Cleanup): Cleanup {
    this.disposePrompt(node)
    const state = this.#state(node)
    if (state.disposed) {
      cleanup()
      controller.destroy()
      return () => undefined
    }
    state.promptController = controller
    const release = this.registerCleanup(node, () => {
      if (state.promptCleanup === release) state.promptCleanup = undefined
      cleanup()
      if (state.promptController !== controller) return
      state.promptController = undefined
      this.#disposePromptResources(state)
      controller.destroy()
    })
    state.promptCleanup = release
    return release
  }

  disposePrompt(node: ComfyNode, expectedController?: ReferencePromptController): void {
    const state = this.#state(node)
    if (expectedController && state.promptController !== expectedController) return
    if (state.promptCleanup) {
      state.promptCleanup()
      return
    }
    this.#disposePromptResources(state)
    if (!expectedController || state.promptController === expectedController) {
      state.promptController?.destroy()
      state.promptController = undefined
    }
  }

  bindWidgetBeforeQueued(widget: ComfyWidget, callback: () => void): Cleanup {
    const original = widget.beforeQueued
    widget.beforeQueued = callback
    let released = false
    return (): void => {
      if (released) return
      released = true
      if (widget.beforeQueued === callback) widget.beforeQueued = original
    }
  }

  bindFileDrop(node: ComfyNode, controller: ReferenceLoaderController): Cleanup {
    if (this.#state(node).disposed) return () => undefined
    const originalDragOver = node.onDragOver
    const originalDragDrop = node.onDragDrop
    const onDragOver = (event: DragEvent): boolean => {
      if (controller.acceptsFileDrop(event.dataTransfer)) return true
      return originalDragOver?.call(node, event) === true
    }
    const onDragDrop = async (event: DragEvent): Promise<boolean> => {
      if (await controller.addDroppedFiles(event.dataTransfer?.files ?? [])) return true
      return (await originalDragDrop?.call(node, event)) === true
    }
    node.onDragOver = onDragOver
    node.onDragDrop = onDragDrop
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (node.onDragOver === onDragOver) {
        if (originalDragOver) node.onDragOver = originalDragOver
        else delete node.onDragOver
      }
      if (node.onDragDrop === onDragDrop) {
        if (originalDragDrop) node.onDragDrop = originalDragDrop
        else delete node.onDragDrop
      }
      if (this.#state(node).nodeFileDropBinding === release)
        this.#state(node).nodeFileDropBinding = undefined
    }
    this.setNodeFileDrop(node, release)
    return release
  }

  recordGraphChange(node: ComfyNode, change: () => void): void {
    this.#app.canvas?.emitBeforeChange?.()
    node.graph?.beforeChange?.()
    try {
      change()
    } finally {
      node.graph?.afterChange?.()
      this.#app.canvas?.emitAfterChange?.()
    }
  }

  recordCanvasChange(change: () => void): void {
    this.#app.canvas?.emitBeforeChange?.()
    try {
      change()
    } finally {
      this.#app.canvas?.emitAfterChange?.()
    }
  }

  markDirty(node: ComfyNode): void {
    node.setDirtyCanvas(true, true)
  }

  installNodeRemovalHook(node: ComfyNode): void {
    const state = this.#state(node)
    if (state.removalHookInstalled) return
    state.removalHookInstalled = true
    const bridge = this
    const originalRemoved = node.onRemoved
    node.onRemoved = function (...args: unknown[]): unknown {
      bridge.disposeNode(this)
      return originalRemoved?.apply(this, args)
    }
  }

  disposeNode(node: ComfyNode): void {
    const state = this.#state(node)
    if (state.disposed) return
    state.disposed = true
    for (const release of [...state.cleanups]) release()
    state.cleanups.clear()
    this.#disposePromptResources(state)
    this.#disposeH3Resources(state)
    this.#disposePromptDefinitionsResources(state)
    this.#disposeLoaderResources(state)
    state.controller = undefined
    state.promptController = undefined
  }

  #state(node: ComfyNode): NodeLifecycleState {
    let state = this.#nodes.get(node)
    if (state) return state
    state = { disposed: false, cleanups: new Set() }
    this.#nodes.set(node, state)
    return state
  }

  #disposeLoaderResources(state: NodeLifecycleState): void {
    state.nodeFileDropBinding?.()
    state.nodeFileDropBinding = undefined
    state.displayProxy?.dispose()
    state.displayProxy = undefined
  }

  #disposePromptResources(state: NodeLifecycleState): void {
    state.promptSubscription?.()
    state.promptSubscription = undefined
    state.promptPresetBinding?.dispose()
    state.promptPresetBinding = undefined
    state.promptReactMount?.destroy()
    state.promptReactMount = undefined
    state.promptDefinitionsReactMount?.destroy()
    state.promptDefinitionsReactMount = undefined
  }

  #disposeH3Resources(state: NodeLifecycleState): void {
    state.h3TimelineReactMount?.destroy()
    state.h3TimelineReactMount = undefined
    state.h3TimelineRoot = undefined
  }

  #disposePromptDefinitionsResources(state: NodeLifecycleState): void {
    state.promptDefinitionRoot = undefined
    state.promptDefinitionsReactMount?.destroy()
    state.promptDefinitionsReactMount = undefined
  }
}
