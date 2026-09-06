import type { ComfyNode } from "../../comfyui.ts"
import type { H3GuideEntry, H3TimelineState, LoaderState, MediaItem } from "../types.ts"
import { MAX_H3_GUIDES } from "../types.ts"
import type { LoaderTimelineAction, ReferenceLoaderController } from "./loader.ts"

const H3_FPS = 24

function itemFilename(item: MediaItem): string {
  return item.sourceFilename ?? item.source.path.split("/").pop() ?? item.id
}

function createGuideId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  )
}

function mediaLabel(item: MediaItem): string {
  const shortId = item.id.length > 18 ? `${item.id.slice(0, 15)}…` : item.id
  return `${itemFilename(item)} · ${shortId}`
}

function option(select: HTMLSelectElement, value: string, label: string): void {
  const entry = document.createElement("option")
  entry.value = value
  entry.textContent = label
  select.append(entry)
}

function selectWithLabel(
  labelText: string,
  value: string,
  options: Array<{ value: string; label: string }>,
  disabled: boolean,
  onChange: (value: string) => void,
): HTMLElement {
  const label = document.createElement("label")
  label.className = "rl-h3-timeline__field"
  const text = document.createElement("span")
  text.textContent = labelText
  const select = document.createElement("select")
  select.setAttribute("aria-label", labelText)
  option(select, "", "None")
  for (const entry of options) option(select, entry.value, entry.label)
  select.value = value ?? ""
  select.disabled = disabled
  select.addEventListener("change", () => onChange(select.value))
  label.append(text, select)
  return label
}

export class H3TimelineController {
  readonly root: HTMLElement
  #host: ReferenceLoaderController
  #node: ComfyNode
  #unsubscribe: () => void
  #destroyController = new AbortController()
  #bodyId = `rl-h3-timeline-body-${
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }`
  #collapsed = true
  #destroyed = false

  constructor(root: HTMLElement, host: ReferenceLoaderController, node: ComfyNode) {
    this.root = root
    this.#host = host
    this.#node = node
    this.root.className = "rl-h3-timeline"
    this.root.dataset.h3Timeline = ""
    this.#unsubscribe = host.subscribeH3Timeline(() => this.render())
    this.root.addEventListener("click", (event) => this.#onClick(event), {
      signal: this.#destroyController.signal,
    })
    this.root.addEventListener("change", (event) => this.#onFrameChange(event), {
      signal: this.#destroyController.signal,
    })
    this.render()
  }

  render(): void {
    if (this.#destroyed) return
    const timeline = this.#host.h3Timeline
    const state = this.#host.state
    const images = state.imageOrder
      .map((id) => state.items[id])
      .filter((item): item is Extract<MediaItem, { kind: "image" }> => item?.kind === "image")
    const visuals = [
      ...images,
      ...state.videoOrder
        .map((id) => state.items[id])
        .filter((item): item is Extract<MediaItem, { kind: "video" }> => item?.kind === "video"),
    ]
    const audios = [
      ...state.audioOrder
        .map((id) => state.items[id])
        .filter((item): item is Extract<MediaItem, { kind: "audio" }> => item?.kind === "audio")
        .map((item) => ({ id: item.id, item })),
      ...state.audioOrder
        .map((id) => state.items[id])
        .filter((item): item is Extract<MediaItem, { kind: "video" }> => item?.kind === "video")
        .map((item) => ({ id: `${item.id}:audio`, item })),
    ]
    const issueCount = this.#issueCount(timeline, state)
    const summary = this.#summary(timeline, issueCount)

    this.root.replaceChildren()
    const header = document.createElement("header")
    header.className = "rl-h3-timeline__header"
    const collapse = document.createElement("button")
    collapse.type = "button"
    collapse.dataset.h3Action = "collapse"
    collapse.className = "rl-h3-timeline__collapse"
    collapse.setAttribute("aria-expanded", String(!this.#collapsed))
    collapse.setAttribute("aria-controls", this.#bodyId)
    collapse.textContent = `${this.#collapsed ? "▸" : "▾"} H3 Timeline Guides`
    const status = document.createElement("span")
    status.className = `rl-h3-timeline__status${timeline.enabled ? " is-on" : ""}`
    status.textContent = timeline.enabled ? "ON" : "OFF"
    const detail = document.createElement("span")
    detail.className = "rl-h3-timeline__summary"
    detail.textContent = summary
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.dataset.h3Action = "toggle"
    toggle.className = "rl-h3-timeline__toggle"
    toggle.textContent = timeline.enabled ? "Disable" : "Enable"
    toggle.setAttribute("aria-pressed", String(timeline.enabled))
    header.append(collapse, status, detail, toggle)
    this.root.append(header)

    const body = document.createElement("div")
    body.id = this.#bodyId
    body.className = "rl-h3-timeline__body"
    body.hidden = this.#collapsed
    const hint = document.createElement("p")
    hint.className = "rl-h3-timeline__hint"
    hint.textContent = "24 fps · End is resolved to the native H3 output's final frame."
    body.append(hint)

    const imageOptions = images.map((item) => ({ value: item.id, label: mediaLabel(item) }))
    const visualOptions = visuals.map((item) => ({
      value: item.id,
      label: `${item.kind === "video" ? "Video" : "Image"} · ${mediaLabel(item)}`,
    }))
    const audioOptions = audios.map(({ id, item }) => ({
      value: id,
      label: `${item.kind === "video" ? "Video audio" : "Audio"} · ${mediaLabel(item)}`,
    }))
    const roleGrid = document.createElement("div")
    roleGrid.className = "rl-h3-timeline__roles"
    roleGrid.append(
      selectWithLabel(
        "Start frame",
        timeline.startImageId ?? "",
        imageOptions,
        !timeline.enabled,
        (value) => this.#dispatch({ type: "set-h3-start", id: value || null }),
      ),
      selectWithLabel(
        "End frame",
        timeline.endImageId ?? "",
        imageOptions,
        !timeline.enabled,
        (value) => this.#dispatch({ type: "set-h3-end", id: value || null }),
      ),
    )
    body.append(roleGrid)

    const guideList = document.createElement("div")
    guideList.className = "rl-h3-timeline__guides"
    for (const guide of timeline.guides) {
      guideList.append(this.#guideElement(guide, visualOptions, audioOptions, timeline.enabled))
    }
    body.append(guideList)
    if (issueCount > 0) {
      const error = document.createElement("p")
      error.className = "rl-h3-timeline__error"
      error.setAttribute("role", "alert")
      error.textContent = `${issueCount} timeline row${issueCount === 1 ? "" : "s"} need a Visual or Audio selection.`
      body.append(error)
    }
    const add = document.createElement("button")
    add.type = "button"
    add.dataset.h3Action = "add"
    add.className = "rl-h3-timeline__add"
    add.disabled = !timeline.enabled || timeline.guides.length >= MAX_H3_GUIDES
    add.textContent =
      timeline.guides.length >= MAX_H3_GUIDES ? "Guide limit reached" : "+ Add Guide"
    body.append(add)
    this.root.append(body)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#unsubscribe()
    this.#destroyController.abort()
    this.root.replaceChildren()
  }

  #guideElement(
    guide: H3GuideEntry,
    visualOptions: Array<{ value: string; label: string }>,
    audioOptions: Array<{ value: string; label: string }>,
    enabled: boolean,
  ): HTMLElement {
    const row = document.createElement("article")
    row.className = "rl-h3-timeline__guide"
    row.dataset.guideId = guide.id
    const heading = document.createElement("div")
    heading.className = "rl-h3-timeline__guide-heading"
    const title = document.createElement("strong")
    title.textContent = `Guide ${guide.id.slice(0, 8)}`
    const seconds = document.createElement("span")
    seconds.textContent = `${(guide.frameIndex / H3_FPS).toFixed(2)}s`
    const remove = document.createElement("button")
    remove.type = "button"
    remove.dataset.h3Action = "remove"
    remove.dataset.guideId = guide.id
    remove.disabled = !enabled
    remove.textContent = "Delete"
    remove.setAttribute("aria-label", `Delete guide ${guide.id}`)
    heading.append(title, seconds, remove)
    row.append(heading)

    const frameLabel = document.createElement("label")
    frameLabel.className = "rl-h3-timeline__frame"
    const frameText = document.createElement("span")
    frameText.textContent = "Frame"
    const frame = document.createElement("input")
    frame.type = "number"
    frame.min = "0"
    frame.step = "1"
    frame.value = String(guide.frameIndex)
    frame.disabled = !enabled
    frame.dataset.h3Action = "frame"
    frame.dataset.guideId = guide.id
    frame.setAttribute("aria-label", `Frame for guide ${guide.id}`)
    frameLabel.append(frameText, frame)
    row.append(frameLabel)
    row.append(
      selectWithLabel("Visual", guide.visualId ?? "", visualOptions, !enabled, (value) =>
        this.#dispatch({
          type: "update-h3-guide",
          id: guide.id,
          values: { visualId: value || null },
        }),
      ),
      selectWithLabel("Audio", guide.audioId ?? "", audioOptions, !enabled, (value) =>
        this.#dispatch({
          type: "update-h3-guide",
          id: guide.id,
          values: { audioId: value || null },
        }),
      ),
    )
    return row
  }

  #issueCount(timeline: H3TimelineState, state: LoaderState): number {
    if (!timeline.enabled) return 0
    return timeline.guides.filter((guide) => {
      const visual = guide.visualId === null ? undefined : state.items[guide.visualId]
      const audio = guide.audioId === null ? undefined : state.items[guide.audioId]
      const visualMissing =
        guide.visualId !== null &&
        (visual === undefined || (visual.kind !== "image" && visual.kind !== "video"))
      const audioMissing =
        guide.audioId !== null &&
        audio === undefined &&
        !(
          guide.audioId.endsWith(":audio") &&
          state.items[guide.audioId.slice(0, -6)]?.kind === "video"
        )
      return (guide.visualId === null && guide.audioId === null) || visualMissing || audioMissing
    }).length
  }

  #summary(timeline: H3TimelineState, issueCount: number): string {
    const roles = [
      timeline.startImageId ? "Start" : "",
      `Guides ${timeline.guides.length}`,
      timeline.endImageId ? "End" : "",
    ]
      .filter(Boolean)
      .join(" · ")
    return issueCount > 0 ? `${roles} · ${issueCount} incomplete` : roles
  }

  #dispatch(action: LoaderTimelineAction): void {
    this.#host.dispatchH3Timeline(action)
    this.#node.setDirtyCanvas(true, true)
  }

  #onClick(event: MouseEvent): void {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const action = target.dataset.h3Action
    if (!action) return
    if (action === "collapse") {
      this.#collapsed = !this.#collapsed
      this.render()
    } else if (action === "toggle") {
      this.#dispatch({ type: "toggle-h3-timeline", enabled: !this.#host.h3Timeline.enabled })
    } else if (action === "add") {
      this.#dispatch({
        type: "add-h3-guide",
        guide: { id: createGuideId(), frameIndex: 0, visualId: null, audioId: null },
      })
    } else if (action === "remove" && target.dataset.guideId) {
      this.#dispatch({ type: "remove-h3-guide", id: target.dataset.guideId })
    }
  }

  #onFrameChange(event: Event): void {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || !input.dataset.guideId) return
    const frame = Number(input.value)
    if (!Number.isInteger(frame) || frame < 0) return
    this.#dispatch({
      type: "update-h3-guide",
      id: input.dataset.guideId,
      values: { frameIndex: frame },
    })
  }
}
