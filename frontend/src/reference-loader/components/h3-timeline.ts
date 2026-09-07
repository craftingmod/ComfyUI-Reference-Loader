import { h3Placements, type H3TimelinePlacement } from "../h3-media-guides.ts"
import type { ItemRuntime, LoaderState } from "../types.ts"

const FPS = 24
const MIN_TRACK_WIDTH = 280

export interface TimelineView {
  zoom: number
  scrollLeft: number
  selectedId?: string
}

export interface TimelineMark {
  placement: H3TimelinePlacement
  channel: "visual" | "audio"
  label: string
  previewUrl?: string
  frame: number
  frames?: number
  disabled: boolean
  incomplete: boolean
  warning?: string
}

export function timelineMarks(
  state: LoaderState,
  runtime: ReadonlyMap<string, ItemRuntime>,
): TimelineMark[] {
  const marks: TimelineMark[] = []
  for (const placement of h3Placements(state.h3Timeline)) {
    for (const channel of ["visual", "audio"] as const) {
      const id = channel === "visual" ? placement.visualId : placement.audioId
      const empty = !placement.visualId && !placement.audioId
      if (!id && !(empty && channel === "visual")) continue
      const item = id ? state.items[id] : undefined
      const loaded = id ? runtime.get(id) : undefined
      const duration =
        item?.kind === "audio"
          ? item.crop
            ? item.crop.end - item.crop.start
            : loaded?.metadata?.duration
          : undefined
      const disabledIds =
        channel === "visual"
          ? state.h3Timeline.disabledVisualIds
          : state.h3Timeline.disabledAudioIds
      marks.push({
        placement,
        channel,
        label: item?.sourceFilename || item?.source.path.split("/").pop() || "Media needed",
        previewUrl: channel === "visual" ? loaded?.previewUrl : undefined,
        frame: placement.frameIndex ?? 0,
        frames:
          channel === "visual"
            ? 1
            : duration !== undefined && Number.isFinite(duration) && duration > 0
              ? Math.max(1, Math.ceil(duration * FPS))
              : undefined,
        disabled: !state.h3Timeline.enabled || Boolean(id && disabledIds?.includes(id)),
        incomplete:
          !item ||
          !Number.isSafeInteger(placement.frameIndex ?? 0) ||
          (placement.frameIndex ?? 0) < 0,
      })
    }
  }
  // At most 34 placements; pairwise checks also keep both sides of a conflict visible.
  for (const [index, mark] of marks.entries()) {
    if (mark.disabled || mark.placement.kind === "end" || mark.frames === undefined) continue
    for (const other of marks.slice(index + 1)) {
      if (
        other.disabled ||
        other.placement.kind === "end" ||
        other.channel !== mark.channel ||
        other.frames === undefined
      )
        continue
      if (mark.frame < other.frame + other.frames && other.frame < mark.frame + mark.frames) {
        mark.warning =
          other.warning = `${mark.channel === "audio" ? "Audio ranges" : "Image placements"} overlap. Wrapper validates the final output.`
      }
    }
  }
  return marks
}

export function timelineExtent(marks: TimelineMark[]): number {
  return Math.max(
    240,
    ...marks
      .filter((mark) => mark.placement.kind !== "end" && Number.isSafeInteger(mark.frame))
      .map(
        (mark) =>
          Math.ceil(Math.max(mark.frame + (mark.frames ?? 1) + FPS, mark.frame * 1.16) / FPS) * FPS,
      ),
  )
}

export function draggedFrame(frame: number, deltaX: number, width: number, extent: number): number {
  if (!(width > 0)) return frame
  return Math.max(0, Math.min(extent - 1, Math.round(frame + (deltaX / width) * extent)))
}

function timing(frame: number): string {
  return `${frame}f · ${(frame / FPS).toFixed(2)}s`
}

export class H3Timeline {
  #abort = new AbortController()
  #resize: ResizeObserver
  #drag?: {
    id: string
    pointerId: number
    x: number
    left: number
    frame: number
    next: number
    width: number
    moved: boolean
  }
  #suppressClick = false
  #marks: TimelineMark[]
  #extent: number
  #scroller: HTMLElement
  #surface: HTMLElement
  #readout: HTMLElement
  #input: HTMLInputElement

  constructor(
    readonly root: HTMLElement,
    state: LoaderState,
    runtime: ReadonlyMap<string, ItemRuntime>,
    readonly view: TimelineView,
    readonly callbacks: {
      select(placement: H3TimelinePlacement, channel: "visual" | "audio"): void
      change(id: string, frame: number): void
      settled(): void
    },
  ) {
    this.#marks = timelineMarks(state, runtime)
    this.#extent = timelineExtent(this.#marks)
    root.className = "rl-time-axis"
    root.innerHTML = `<div class="rl-time-axis__tools"><span>24 fps · View range only</span><label>Zoom <select aria-label="Timeline zoom"><option value="1">1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></label><button type="button" data-timeline-fit>Fit</button></div><div class="rl-time-axis__scroll" tabindex="0" aria-label="Guide timeline; scroll horizontally when zoomed"><div class="rl-time-axis__surface"></div></div><div class="rl-time-axis__end"></div><div class="rl-time-axis__selection"><label>Guide frame <input type="number" min="0" step="1" aria-label="Selected Guide frame"></label><span data-timeline-readout aria-live="polite"></span></div><p class="rl-time-axis__hint">Drag or use ← / → to move a whole Guide (Shift: 24 frames). Apply saves; Cancel discards. Audio bars show the source range, not output duration.</p><p class="rl-time-axis__warnings" role="status"></p>`
    this.#scroller = root.querySelector<HTMLElement>(".rl-time-axis__scroll")!
    this.#surface = root.querySelector<HTMLElement>(".rl-time-axis__surface")!
    this.#readout = root.querySelector<HTMLElement>("[data-timeline-readout]")!
    this.#input = root.querySelector<HTMLInputElement>("input")!
    const zoom = root.querySelector<HTMLSelectElement>("select")!
    zoom.value = String(view.zoom)
    const signal = this.#abort.signal
    zoom.addEventListener(
      "change",
      () => {
        view.zoom = Number(zoom.value)
        this.#draw()
      },
      { signal },
    )
    root.querySelector("[data-timeline-fit]")!.addEventListener(
      "click",
      () => {
        view.zoom = 1
        view.scrollLeft = 0
        zoom.value = "1"
        this.#draw()
      },
      { signal },
    )
    this.#scroller.addEventListener(
      "scroll",
      () => {
        view.scrollLeft = this.#scroller.scrollLeft
      },
      { signal },
    )
    root.addEventListener("wheel", (event) => event.stopPropagation(), { signal })
    root.addEventListener("pointerdown", (event) => this.#pointerDown(event), { signal })
    document.addEventListener("pointermove", (event) => this.#pointerMove(event), { signal })
    document.addEventListener(
      "pointerup",
      (event) => {
        if (event.pointerId === this.#drag?.pointerId) this.#finish(false)
      },
      { signal },
    )
    document.addEventListener(
      "pointercancel",
      (event) => {
        if (event.pointerId === this.#drag?.pointerId) this.#finish(true)
      },
      { signal },
    )
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && this.#drag) {
          event.preventDefault()
          event.stopPropagation()
          this.#finish(true)
        }
      },
      { signal, capture: true },
    )
    globalThis.addEventListener(
      "blur",
      () => {
        if (this.#drag) this.#finish(true)
      },
      { signal },
    )
    root.addEventListener(
      "click",
      (event) => {
        event.stopPropagation()
        if (this.#suppressClick) {
          this.#suppressClick = false
          return
        }
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-timeline-mark]")
        const mark = button ? this.#marks[Number(button.dataset.timelineMark)] : undefined
        if (!mark) return
        view.selectedId = mark.placement.guideId
        this.callbacks.select(mark.placement, mark.channel)
      },
      { signal },
    )
    root.addEventListener(
      "keydown",
      (event) => {
        event.stopPropagation()
        const button = (event.target as Element).closest<HTMLButtonElement>("[data-timeline-mark]")
        const mark = button ? this.#marks[Number(button.dataset.timelineMark)] : undefined
        if (!mark?.placement.guideId || !["ArrowLeft", "ArrowRight"].includes(event.key)) return
        event.preventDefault()
        const frame = Math.max(
          0,
          mark.frame + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? FPS : 1),
        )
        this.#change(mark.placement.guideId, frame)
      },
      { signal },
    )
    this.#input.addEventListener(
      "change",
      () => {
        const frame = this.#input.value === "" ? Number.NaN : Number(this.#input.value)
        if (!Number.isSafeInteger(frame) || frame < 0) {
          this.#input.setCustomValidity("Enter a non-negative whole frame.")
          this.#input.reportValidity()
          return
        }
        this.#input.setCustomValidity("")
        if (view.selectedId) this.#change(view.selectedId, frame)
      },
      { signal },
    )
    this.#input.addEventListener("input", () => this.#input.setCustomValidity(""), { signal })
    this.#draw()
    let width = this.#scroller.clientWidth
    this.#resize = new ResizeObserver(() => {
      if (this.#scroller.clientWidth === width || this.dragging) return
      width = this.#scroller.clientWidth
      this.#draw()
    })
    this.#resize.observe(this.#scroller)
  }

  get dragging(): boolean {
    return Boolean(this.#drag)
  }

  destroy(): void {
    this.#abort.abort()
    this.#resize.disconnect()
    this.#drag = undefined
  }

  #draw(): void {
    this.#surface.replaceChildren()
    this.#surface.style.width = `${this.view.zoom * 100}%`
    this.#surface.style.minWidth = `${this.view.zoom * MIN_TRACK_WIDTH}px`
    const layoutWidth = Math.max(MIN_TRACK_WIDTH, this.#scroller.clientWidth) * this.view.zoom
    const ruler = document.createElement("div")
    ruler.className = "rl-time-axis__ruler"
    const tickFrames = Math.max(
      FPS,
      Math.ceil(this.#extent / Math.max(2, Math.floor(layoutWidth / 76)) / FPS) * FPS,
    )
    for (let frame = 0; frame <= this.#extent * (1 - 70 / layoutWidth); frame += tickFrames) {
      const tick = document.createElement("span")
      tick.style.left = `${(frame / this.#extent) * 100}%`
      tick.textContent = `${frame / FPS}s · ${frame}f`
      ruler.append(tick)
    }
    this.#surface.append(ruler)
    this.root.querySelector(".rl-time-axis__end")!.replaceChildren()
    for (const channel of ["visual", "audio"] as const) {
      const label = document.createElement("div")
      label.className = "rl-time-axis__lane-label"
      label.textContent = channel === "visual" ? "Image" : "Audio"
      const lane = document.createElement("div")
      lane.className = "rl-time-axis__lane"
      lane.style.backgroundSize = `${(tickFrames / this.#extent) * 100}% 100%`
      lane.setAttribute("aria-label", `${label.textContent} guides`)
      const occupied: number[] = []
      for (const [index, mark] of this.#marks.entries()) {
        if (mark.channel !== channel) continue
        const button = document.createElement("button")
        button.type = "button"
        button.dataset.timelineMark = String(index)
        if (mark.placement.guideId) button.dataset.timelineGuide = mark.placement.guideId
        const selected = Boolean(
          mark.placement.guideId && mark.placement.guideId === this.view.selectedId,
        )
        button.className = `rl-time-axis__mark${mark.disabled ? " is-paused" : ""}${mark.incomplete ? " is-incomplete" : ""}${mark.warning ? " is-warning" : ""}${selected ? " is-selected" : ""}`
        button.classList.toggle("is-audio", channel === "audio")
        button.classList.toggle("is-unknown", mark.frames === undefined)
        button.draggable = false
        const time =
          mark.placement.kind === "end"
            ? "End · final output frame (time unknown)"
            : timing(mark.frame)
        button.title = `${mark.label} · ${time}${channel === "audio" ? (mark.frames === undefined ? " · duration unknown" : ` · ${(mark.frames / FPS).toFixed(2)}s source span`) : ""}${mark.disabled ? " · paused" : ""}${mark.warning ? ` · ${mark.warning}` : ""}`
        button.setAttribute("aria-label", button.title)
        button.setAttribute("aria-pressed", String(selected))
        if (mark.previewUrl) {
          const image = document.createElement("img")
          image.src = mark.previewUrl
          image.alt = ""
          image.draggable = false
          button.append(image)
        }
        const name = document.createElement("span")
        name.textContent = `${mark.placement.kind === "start" ? "Start · " : ""}${mark.label}`
        const detail = document.createElement("small")
        detail.dataset.timelineTime = ""
        detail.textContent = time
        button.append(name, detail)
        if (mark.placement.kind === "end") {
          this.root.querySelector(".rl-time-axis__end")!.append(button)
          continue
        }
        const frame = Number.isFinite(mark.frame) ? mark.frame : 0
        const visualWidth = Math.max(mark.frames ?? 1, (this.#extent * 88) / layoutWidth)
        let row = occupied.findIndex((end) => end <= frame)
        if (row < 0) row = occupied.length
        occupied[row] = frame + visualWidth
        button.style.left = `${(frame / this.#extent) * 100}%`
        button.style.maxWidth = `${Math.max(0, 1 - frame / this.#extent) * 100}%`
        button.style.top = `${row * 42 + 3}px`
        if (channel === "audio" && mark.frames !== undefined)
          button.style.width = `${(mark.frames / this.#extent) * 100}%`
        lane.append(button)
      }
      lane.style.height = `${Math.max(1, occupied.length) * 42 + 6}px`
      this.#surface.append(label, lane)
    }
    this.#scroller.scrollLeft = this.view.scrollLeft
    const selected = this.#marks.find(
      (mark) => mark.placement.guideId === this.view.selectedId && this.view.selectedId,
    )
    this.#input.disabled = !selected
    this.#input.value = selected && Number.isFinite(selected.frame) ? String(selected.frame) : ""
    this.#readout.textContent = selected
      ? timing(selected.frame)
      : "Select a Guide; Start and End are fixed anchors."
    const warnings = new Set(this.#marks.flatMap((mark) => (mark.warning ? [mark.warning] : [])))
    if (this.#marks.some((mark) => mark.channel === "audio" && mark.frames === undefined))
      warnings.add("Some audio durations are unknown; range checks are incomplete.")
    if (this.#marks.some((mark) => mark.incomplete))
      warnings.add("Some Guides need a source or a valid frame.")
    this.root.querySelector(".rl-time-axis__warnings")!.textContent = [...warnings].join(" ")
  }

  #pointerDown(event: PointerEvent): void {
    event.stopPropagation()
    this.#suppressClick = false
    if (event.button !== 0 || this.#drag) return
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-timeline-mark]")
    const mark = button ? this.#marks[Number(button.dataset.timelineMark)] : undefined
    if (!mark?.placement.guideId || !Number.isSafeInteger(mark.frame)) return
    const rect = this.#surface.getBoundingClientRect()
    this.#drag = {
      id: mark.placement.guideId,
      pointerId: event.pointerId,
      x: event.clientX,
      left: rect.left,
      frame: mark.frame,
      next: mark.frame,
      width: rect.width,
      moved: false,
    }
  }

  #pointerMove(event: PointerEvent): void {
    const drag = this.#drag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!drag.moved && Math.abs(event.clientX - drag.x) < 3) return
    event.preventDefault()
    event.stopPropagation()
    drag.moved = true
    drag.next = draggedFrame(
      drag.frame,
      event.clientX - drag.x + drag.left - this.#surface.getBoundingClientRect().left,
      drag.width,
      this.#extent,
    )
    for (const mark of this.root.querySelectorAll<HTMLElement>("[data-timeline-guide]")) {
      if (mark.dataset.timelineGuide !== drag.id) continue
      mark.style.left = `${(drag.next / this.#extent) * 100}%`
      mark.style.maxWidth = `${Math.max(0, 1 - drag.next / this.#extent) * 100}%`
      mark.classList.add("is-dragging")
      mark.querySelector("[data-timeline-time]")!.textContent = timing(drag.next)
    }
    this.#readout.textContent = `${timing(drag.next)} · release to edit; Esc cancels`
  }

  #finish(cancel: boolean): void {
    const drag = this.#drag
    this.#drag = undefined
    if (!drag) return
    this.#suppressClick = drag.moved
    if (!cancel && drag.moved && drag.next !== drag.frame) this.#change(drag.id, drag.next)
    else if (drag.moved) this.#draw()
    this.callbacks.settled()
  }

  #change(id: string, frame: number): void {
    this.view.selectedId = id
    this.callbacks.change(id, frame)
  }
}
