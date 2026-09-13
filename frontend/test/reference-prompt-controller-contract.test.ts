import { describe, expect, test } from "bun:test"

import type { ComfyAppLike, ComfyExtension, ComfyNode, ComfyWidget } from "../src/comfyui.ts"
import { ComfyUILifecycleBridge } from "../src/reference-loader/comfyui-lifecycle-bridge.ts"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
import {
  getReferencePromptController,
  registerReferenceLoader,
  REFERENCE_PROMPT_WIDGET_TYPE,
} from "../src/reference-loader/extension.ts"
import {
  createEmptyPromptDocumentV6,
  serializePromptDocumentV6,
} from "../src/reference-loader/prompt-v6.ts"

const emptyPrompt = serializePromptDocumentV6(createEmptyPromptDocumentV6())

describe("Prompt controller C0 contracts", () => {
  test("destroys prompt resources before the controller and is idempotent", () => {
    const events: string[] = []
    const app: ComfyAppLike = { registerExtension: () => undefined }
    const bridge = new ComfyUILifecycleBridge(app)
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const controller = new ReferencePromptController(node, () => [], emptyPrompt)
    const originalDestroy = controller.destroy.bind(controller)
    controller.destroy = () => {
      events.push("controller.destroy")
      originalDestroy()
    }
    const promptMount = {
      destroyed: false,
      destroy() {
        if (!this.destroyed) {
          this.destroyed = true
          events.push("prompt.react.destroy")
        }
      },
    }
    const definitionsMount = {
      destroyed: false,
      destroy() {
        if (!this.destroyed) {
          this.destroyed = true
          events.push("definitions.react.destroy")
        }
      },
    }

    bridge.attachPrompt(node, controller, () => events.push("prompt.cleanup"))
    bridge.setPromptReactMount(node, promptMount)
    bridge.setPromptDefinitionsReactMount(node, definitionsMount)
    bridge.disposeNode(node)
    bridge.disposeNode(node)

    expect(events).toEqual([
      "prompt.cleanup",
      "prompt.react.destroy",
      "definitions.react.destroy",
      "controller.destroy",
    ])
    expect(bridge.getPromptController(node)).toBeUndefined()
  })

  test("keeps widget value, serialization, restore, and queue callbacks on one controller", () => {
    let extension: ComfyExtension | undefined
    const app: ComfyAppLike = {
      registerExtension(candidate) {
        extension = candidate
      },
    }
    registerReferenceLoader(app, { fetchApi: async () => new Response("{}") })
    const widgets: ComfyWidget[] = []
    const node: ComfyNode = {
      widgets,
      addDOMWidget(name, _type, _element, options) {
        const widget = { name, value: "", options } as ComfyWidget
        widgets.push(widget)
        return widget
      },
      setDirtyCanvas: () => undefined,
    }
    const factory = extension?.getCustomWidgets?.()[REFERENCE_PROMPT_WIDGET_TYPE]
    const created = factory?.(node, "prompt", ["STRING", { default: emptyPrompt }], app)
    const widget = created?.widget
    const controller = getReferencePromptController(node)
    const next = serializePromptDocumentV6({
      ...createEmptyPromptDocumentV6(),
      sections: [{ id: "section-contract", title: "scene", parts: [] }],
    })
    const getValue = widget?.options?.getValue as (() => unknown) | undefined
    const setValue = widget?.options?.setValue as ((value: unknown) => void) | undefined

    expect(controller).toBeDefined()
    expect(getValue?.()).toBe(emptyPrompt)
    expect(widget?.serializeValue?.()).toBe(emptyPrompt)
    setValue?.(next)
    expect(getValue?.()).toBe(next)
    expect(widget?.serializeValue?.()).toBe(next)
    widget?.beforeQueued?.()
    expect(controller?.serialize()).toBe(next)

    node.onRemoved?.()
  })
})
