import type {
  ComfyApi,
  ComfyApp,
  ComfyExtension as OfficialComfyExtension,
  DOMWidgetOptions,
} from "@comfyorg/comfyui-frontend-types"

export type { ComfyApi, ComfyApp }

type OfficialWidgetMap = Awaited<
  ReturnType<NonNullable<OfficialComfyExtension["getCustomWidgets"]>>
>
type OfficialWidgetConstructor = OfficialWidgetMap[string]
type OfficialComfyNode = Parameters<OfficialWidgetConstructor>[0]
type OfficialComfyWidget = NonNullable<OfficialComfyNode["widgets"]>[number]

export type ComfyApiLike = Pick<ComfyApi, "fetchApi"> &
  Partial<Pick<ComfyApi, "apiURL" | "addEventListener">>

export type ComfyWidget = Pick<OfficialComfyWidget, "callback" | "name" | "serialize"> & {
  beforeQueued?: () => void
  onRemove?: () => void
  serializeValue?: () => unknown
  options?: {
    read_only?: boolean
    [key: string]: unknown
  }
  disabled?: boolean
  computedDisabled?: boolean
  element?: HTMLElement
  value: OfficialComfyWidget["value"] | null
}

export type DomWidgetOptions = Omit<DOMWidgetOptions<string>, "setValue"> & {
  setValue?: (value: unknown) => void
}

type ComfyGraph = Pick<NonNullable<OfficialComfyNode["graph"]>, "afterChange" | "beforeChange">

export interface ComfyNode {
  addDOMWidget(
    name: string,
    type: string,
    element: HTMLElement,
    options: DomWidgetOptions,
  ): ComfyWidget
  addWidget?: (...args: unknown[]) => ComfyWidget
  graph?: ComfyGraph | null
  comfyClass?: string
  id?: OfficialComfyNode["id"]
  type?: string
  onDragDrop?: (event: DragEvent) => boolean | Promise<boolean>
  onDragOver?: (event: DragEvent) => boolean
  onRemoved?: (...args: unknown[]) => unknown
  properties?: OfficialComfyNode["properties"]
  setDirtyCanvas: OfficialComfyNode["setDirtyCanvas"]
  setSize?: OfficialComfyNode["setSize"]
  size?: OfficialComfyNode["size"]
  widgets?: ComfyWidget[]
}

type ComfyWidgetConstructor = (
  node: ComfyNode,
  inputName: Parameters<OfficialWidgetConstructor>[1],
  inputData: Parameters<OfficialWidgetConstructor>[2],
  app: ComfyAppLike,
  widgetName?: Parameters<OfficialWidgetConstructor>[4],
) => {
  widget: ComfyWidget
  minWidth?: number
  minHeight?: number
}

export interface ComfyExtension {
  name: OfficialComfyExtension["name"]
  getCustomWidgets?(): Record<string, ComfyWidgetConstructor>
  nodeCreated?(node: ComfyNode, app: ComfyAppLike): void
  loadedGraphNode?(node: ComfyNode, app: ComfyAppLike): void
}

export type ComfyAppLike = Omit<Pick<ComfyApp, "registerExtension">, "registerExtension"> & {
  canvas?: Pick<ComfyApp["canvas"], "emitAfterChange" | "emitBeforeChange">
  registerExtension(extension: ComfyExtension): void
}
