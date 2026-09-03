import type {
  ComfyApi,
  ComfyApiLike,
  ComfyApp,
  ComfyAppLike,
  ComfyNode,
  ComfyWidget,
} from "../comfyui.ts"

export const REFERENCE_PROMPT_CACHE_NODE_TYPE = "Alyac_ReferencePromptCache"

type GraphLike = {
  getNodeById(id: string): ComfyNode | null
}

type ExecutionOutput = {
  node: string | number
  display_node: string | number
  output?: Record<string, unknown>
}

export function registerReferencePromptCache(app: ComfyApp, api: ComfyApi): void
export function registerReferencePromptCache(app: ComfyAppLike, api: ComfyApiLike): void
export function registerReferencePromptCache(
  app: ComfyApp | ComfyAppLike,
  api: ComfyApi | ComfyApiLike,
): void {
  const referenceApp = app as ComfyAppLike
  referenceApp.registerExtension({
    name: "reference-loader.prompt-cache",
    nodeCreated(node) {
      setCacheWidgetsReadOnly(node)
      deferCacheWidgetSync(node)
    },
    loadedGraphNode(node) {
      setCacheWidgetsReadOnly(node)
      deferCacheWidgetSync(node)
    },
  })

  const eventApi = api as unknown as Pick<EventTarget, "addEventListener">
  if (typeof eventApi.addEventListener !== "function") return

  eventApi.addEventListener("executed", ((event: Event) => {
    const detail = (event as CustomEvent<ExecutionOutput>).detail
    const output = detail?.output
    if (!output) return
    const prompt = outputValue(output.cached_prompt)
    const hash = outputValue(output.cached_hash)
    if (prompt === undefined && hash === undefined) return

    const node = [detail.node, detail.display_node]
      .map((id) => findExecutionNode(app, String(id)))
      .find((candidate) => candidate !== undefined)
    if (!node || (node.type ?? node.comfyClass) !== REFERENCE_PROMPT_CACHE_NODE_TYPE) return

    if (prompt !== undefined) setWidgetValue(node, "cached_prompt", prompt)
    if (hash !== undefined) setWidgetValue(node, "cached_hash", hash)
    node.setDirtyCanvas(true, true)
  }) as EventListener)
}

function setCacheWidgetsReadOnly(node: ComfyNode): void {
  if ((node.type ?? node.comfyClass) !== REFERENCE_PROMPT_CACHE_NODE_TYPE) return
  const prompt = node.widgets?.find((candidate) => candidate.name === "cached_prompt")
  if (prompt) {
    setWidgetEditable(prompt)
    setWidgetElementState(prompt, false)
  }

  const hash = node.widgets?.find((candidate) => candidate.name === "cached_hash")
  if (!hash) return
  hash.options = { ...(hash.options ?? {}), read_only: true, disabled: true }
  hash.disabled = true
  hash.computedDisabled = true
  setWidgetElementState(hash, true)
  moveWidgetToEnd(node, hash)
}

function setWidgetEditable(widget: ComfyWidget): void {
  if (widget.options) {
    const options = { ...widget.options }
    delete options.read_only
    delete options.disabled
    widget.options = options
  }
  widget.disabled = false
  widget.computedDisabled = false
}

function setWidgetElementState(widget: ComfyWidget, readOnly: boolean): void {
  const element = widget.element
  if (!element) return
  if ("readOnly" in element) {
    const input = element as HTMLInputElement
    input.readOnly = readOnly
  }
  if ("disabled" in element) {
    const input = element as HTMLInputElement
    input.disabled = readOnly
  }
  if (element.isContentEditable || element.getAttribute("contenteditable") !== null) {
    element.contentEditable = readOnly ? "false" : "true"
  }
  element.setAttribute("aria-readonly", String(readOnly))
  element.setAttribute("aria-disabled", String(readOnly))
}

function deferCacheWidgetSync(node: ComfyNode): void {
  const apply = () => setCacheWidgetsReadOnly(node)
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(apply)
    return
  }
  setTimeout(apply, 0)
}

function moveWidgetToEnd(node: ComfyNode, widget: ComfyWidget): void {
  const widgets = node.widgets
  if (!widgets) return
  const index = widgets.indexOf(widget)
  if (index < 0 || index === widgets.length - 1) return
  widgets.splice(index, 1)
  widgets.push(widget)
}

function outputValue(value: unknown): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value
  return typeof candidate === "string" ? candidate : undefined
}

function setWidgetValue(node: ComfyNode, name: string, value: string): void {
  const widget = node.widgets?.find((candidate) => candidate.name === name)
  if (widget) widget.value = value
}

function findExecutionNode(
  app: ComfyApp | ComfyAppLike,
  executionId: string,
): ComfyNode | undefined {
  const graph = (app as Partial<Pick<ComfyApp, "graph">>).graph as GraphLike | undefined
  if (!graph) return undefined
  const parts = executionId.split(":")
  let current = graph
  for (const part of parts.slice(0, -1)) {
    const parent = current.getNodeById(part) as (ComfyNode & { subgraph?: GraphLike }) | null
    if (!parent?.subgraph) return undefined
    current = parent.subgraph
  }
  return current.getNodeById(parts.at(-1) ?? "") ?? undefined
}
