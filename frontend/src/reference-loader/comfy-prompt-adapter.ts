import type { ComfyNode, ComfyWidget } from "../comfyui.ts"
import {
  bindRenderedWidgetRoot,
  ComfyUILifecycleBridge,
  type PromptPresetBinding,
} from "./comfyui-lifecycle-bridge.ts"
import { createPromptDefinitionsReact } from "./components/prompt-definitions-react.tsx"
import { ReferencePromptController } from "./components/prompt-editor.ts"
import { createPromptReact } from "./components/prompt-react.tsx"
import { localeStore } from "./i18n.ts"

export const REFERENCE_PROMPT_DEFINITIONS_WIDGET_TYPE = "REFERENCE_PROMPT_DEFINITIONS"
export const REFERENCE_PROMPT_WIDGET_TYPE = "REFERENCE_PROMPT"

/** Owns Prompt widget callbacks and node-scoped Prompt lifecycle bindings. */
export class ComfyPromptAdapter {
  readonly #lifecycle: ComfyUILifecycleBridge

  constructor(lifecycle: ComfyUILifecycleBridge) {
    this.#lifecycle = lifecycle
  }

  createDefinitionsWidget(node: ComfyNode, inputName: string): { widget: ComfyWidget } {
    this.#lifecycle.disposePromptDefinitions(node)
    const root = document.createElement("div")
    root.className = "reference-prompt-definitions"
    root.dataset.input = inputName
    const widget = node.addDOMWidget(inputName, REFERENCE_PROMPT_DEFINITIONS_WIDGET_TYPE, root, {
      serialize: false,
      hideOnZoom: false,
      getValue: () => "",
      setValue: () => undefined,
      getMinHeight: () => Math.max(120, Math.min(900, root.scrollHeight + 9)),
      getMaxHeight: () => Math.max(120, Math.min(900, root.scrollHeight + 9)),
    })
    const releaseRenderedRoot = bindRenderedWidgetRoot(node, root, ".reference-prompt-definitions")
    // Keep an empty workflow slot for this UI-only input. It precedes the
    // canonical prompt widget, and an omitted indexed widget shifts every
    // following value when older workflow deserializers compact the array.
    widget.serialize = true
    this.#lifecycle.setPromptDefinitionRoot(node, root)
    const controller = this.#lifecycle.getPromptController(node)
    controller?.mountDefinitions(root)
    const reactMount = controller
      ? createPromptDefinitionsReact({
          container: root,
          controller,
          onEditShotGuides: (tag) => this.#lifecycle.getController(node)?.editH3GuidesForShot(tag),
        })
      : undefined
    if (reactMount) this.#lifecycle.setPromptDefinitionsReactMount(node, reactMount)
    const releaseLifecycle = this.#lifecycle.registerCleanup(node, () => {
      releaseRenderedRoot()
      this.#lifecycle.disposePromptDefinitions(node, root)
    })
    let removed = false
    const originalWidgetRemove = widget.onRemove
    widget.onRemove = () => {
      if (removed) return
      removed = true
      releaseLifecycle()
      originalWidgetRemove?.call(widget)
    }
    this.#lifecycle.installNodeRemovalHook(node)
    return { widget }
  }

  createPromptWidget(
    node: ComfyNode,
    inputName: string,
    inputData: unknown,
  ): { widget: ComfyWidget } {
    this.#lifecycle.disposePrompt(node)
    const root = document.createElement("div")
    root.className = "reference-prompt"
    root.dataset.input = inputName
    const controller = new ReferencePromptController(
      node,
      () => this.#lifecycle.getController(node)?.promptReferences ?? [],
      initialValue(inputData),
      {
        presetId: node.widgets?.find((candidate) => candidate.name === "prompt_schema_preset")
          ?.value,
        presetCatalog: promptPresetCatalog(inputData),
      },
    )
    const definitionsRoot = this.#lifecycle.getPromptDefinitionRoot(node)
    if (definitionsRoot) controller.mountDefinitions(definitionsRoot)
    const reactMount = createPromptReact({ container: root, controller })
    let removed = false
    const widget = node.addDOMWidget(inputName, REFERENCE_PROMPT_WIDGET_TYPE, root, {
      serialize: true,
      hideOnZoom: false,
      getValue: () => controller.serialize(),
      setValue: (value) => controller.restore(value),
      getMinHeight: () => Math.max(180, Math.min(1200, root.scrollHeight + 9)),
      getMaxHeight: () => Math.max(180, Math.min(1200, root.scrollHeight + 9)),
    })
    const releaseRenderedRoot = bindRenderedWidgetRoot(node, root, ".reference-prompt")
    widget.serialize = true
    widget.serializeValue = () => controller.serialize()
    const releaseQueueBinding = this.#lifecycle.bindWidgetBeforeQueued(widget, () =>
      controller.serialize(),
    )
    const presetBindingTimer = globalThis.setTimeout(() => {
      if (removed || this.#lifecycle.getPromptController(node) !== controller) return
      const binding = bindPromptPresetWidget(node, controller)
      if (binding) this.#lifecycle.setPromptPresetBinding(node, binding)
    }, 0)
    let releasePromptLifecycle: () => void = () => undefined
    const releaseLocale = localeStore.subscribe(() => {
      controller.setLocale(localeStore.getSnapshot())
    })
    const originalWidgetRemove = widget.onRemove
    widget.onRemove = () => {
      if (removed) return
      removed = true
      globalThis.clearTimeout(presetBindingTimer)
      releasePromptLifecycle()
      originalWidgetRemove?.call(widget)
    }
    releasePromptLifecycle = this.#lifecycle.attachPrompt(node, controller, () => {
      globalThis.clearTimeout(presetBindingTimer)
      releaseRenderedRoot()
      releaseQueueBinding()
      releaseLocale()
    })
    this.#lifecycle.setPromptReactMount(node, reactMount)
    if (definitionsRoot) {
      const definitionsReactMount = createPromptDefinitionsReact({
        container: definitionsRoot,
        controller,
        onEditShotGuides: (tag) => this.#lifecycle.getController(node)?.editH3GuidesForShot(tag),
      })
      this.#lifecycle.setPromptDefinitionsReactMount(node, definitionsReactMount)
    }
    this.#lifecycle.installNodeRemovalHook(node)
    return { widget }
  }

  bindReferences(node: ComfyNode): void {
    this.#lifecycle.clearPromptSubscription(node)
    const loader = this.#lifecycle.getController(node)
    const prompt = this.#lifecycle.getPromptController(node)
    if (!loader || !prompt) return
    const releaseReferences = loader.subscribePromptReferences(() => prompt.refreshReferences())
    const releaseShots = prompt.subscribeShots(() => {
      loader.setPromptShots(
        prompt.shots,
        (tag, frame) => prompt.setShotFrameDraft(tag, frame),
        (tag) => prompt.focusShot(tag),
        (tag) => prompt.removeShot(tag),
        () => prompt.applyShotDraft(),
        () => prompt.cancelShotDraft(),
        prompt.hasShotDraft,
      )
    })
    this.#lifecycle.setPromptSubscription(node, () => {
      releaseReferences()
      releaseShots()
    })
  }
}

function initialValue(inputData: unknown): unknown {
  if (!Array.isArray(inputData)) return undefined
  const options = inputData[1]
  if (typeof options !== "object" || options === null) return undefined
  const record = options as Record<string, unknown>
  return record.default ?? record.defaultValue
}

function promptPresetCatalog(inputData: unknown): unknown {
  if (!Array.isArray(inputData)) return undefined
  const options = inputData[1]
  if (typeof options !== "object" || options === null) return undefined
  return (options as Record<string, unknown>).promptPresets
}

function bindPromptPresetWidget(
  node: ComfyNode,
  controller: ReferencePromptController,
): PromptPresetBinding | undefined {
  const widget = node.widgets?.find((candidate) => candidate.name === "prompt_schema_preset")
  if (!widget) return undefined
  const originalCallback = widget.callback
  const sync = (value: unknown): void => {
    controller.setPreset(value)
    widget.value = controller.presetId
  }
  const callback: NonNullable<ComfyWidget["callback"]> = (value, ...args) => {
    const result = originalCallback?.call(widget, value, ...args)
    sync(value)
    return result
  }
  widget.callback = callback
  sync(widget.value)
  return {
    dispose() {
      if (widget.callback !== callback) return
      if (originalCallback) widget.callback = originalCallback
      else delete widget.callback
    },
  }
}
