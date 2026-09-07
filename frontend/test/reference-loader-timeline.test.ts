import { afterEach, describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import {
  H3Timeline,
  draggedFrame,
  timelineMarks,
  timelineExtent,
} from "../src/reference-loader/components/h3-timeline.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import {
  serializeLoaderState,
  deserializeLoaderState,
} from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

function fixture() {
  const state = createEmptyLoaderState()
  const media = (kind: "image" | "audio", id: string) =>
    createMediaItem(
      kind,
      {
        path: `reference_loader/sources/${id}.${kind === "image" ? "png" : "wav"}`,
        mime: kind === "image" ? "image/png" : "audio/wav",
        sha256: "a".repeat(64),
      },
      id,
    )
  state.items = {
    scene: media("image", "scene"),
    voice: media("audio", "voice"),
    music: media("audio", "music"),
  }
  state.imageOrder = ["scene"]
  state.audioOrder = ["voice", "music"]
  state.h3Timeline = {
    version: 1,
    enabled: true,
    startImageId: null,
    endImageId: "scene",
    guides: [{ id: "pair", frameIndex: 48, visualId: "scene", audioId: "voice" }],
  }
  return state
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function mount() {
  const root = document.createElement("div")
  document.body.append(root)
  const node: ComfyNode = {
    addWidget: () => ({ name: "unused", value: null }),
    addDOMWidget: () => ({ name: "unused", value: null }),
    setDirtyCanvas: () => undefined,
  }
  const controller = new ReferenceLoaderController(
    root,
    node,
    new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
    serializeLoaderState(fixture()),
  )
  cleanups.push(() => {
    controller.destroy()
    root.remove()
  })
  return { root, controller }
}

function key(root: HTMLElement, name: string, shiftKey = false) {
  root.querySelector('[data-timeline-guide="pair"]')!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: name,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  )
}

function pointer(target: EventTarget, type: string, clientX: number) {
  target.dispatchEvent(
    new PointerEvent(type, { clientX, pointerId: 1, button: 0, bubbles: true, cancelable: true }),
  )
}

function sizeSurface(root: HTMLElement, width = 640) {
  root.querySelector<HTMLElement>(".rl-time-axis__surface")!.getBoundingClientRect = () =>
    new DOMRect(0, 0, width, 200)
}

describe("Guide timeline", () => {
  test("uses trimmed audio intervals, ignores paused ranges, and keeps End out of the view extent", () => {
    const state = fixture()
    const voice = state.items.voice
    if (voice?.kind !== "audio") throw new Error("Expected audio")
    voice.crop = { start: 2, end: 4 }
    state.h3Timeline.guides.push({ id: "music", frameIndex: 72, visualId: null, audioId: "music" })
    const runtime = new Map([["music", { loading: false, metadata: { duration: 1 } }]])
    const marks = timelineMarks(state, runtime)
    expect(
      marks.find((mark) => mark.channel === "audio" && mark.placement.guideId === "pair")?.frames,
    ).toBe(48)
    expect(marks.filter((mark) => mark.warning)).toHaveLength(2)
    expect(timelineExtent(marks)).toBe(240)
    state.h3Timeline.disabledAudioIds = ["music"]
    expect(timelineMarks(state, runtime).some((mark) => mark.warning)).toBe(false)
    delete voice.crop
    expect(
      timelineMarks(state, runtime).find(
        (mark) => mark.placement.guideId === "pair" && mark.channel === "audio",
      )?.frames,
    ).toBeUndefined()
  })

  test("snaps using screen width at different canvas scales and clamps the lower boundary", () => {
    expect(draggedFrame(48, 64, 640, 240)).toBe(72)
    expect(draggedFrame(48, 32, 320, 240)).toBe(72)
    expect(draggedFrame(48, 1, 640, 240)).toBe(48)
    expect(draggedFrame(48, -640, 640, 240)).toBe(0)
    expect(draggedFrame(48, 640, 640, 240)).toBe(239)
    expect(draggedFrame(48, 64, 0, 240)).toBe(48)
  })

  test("moves both channels in one draft, applies once, and restores through Undo and serialization", () => {
    const { root, controller } = mount()
    key(root, "ArrowRight", true)
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    const marks = root.querySelectorAll('[data-timeline-guide="pair"] [data-timeline-time]')
    expect([...marks].map((mark) => mark.textContent)).toEqual(["72f · 3.00s", "72f · 3.00s"])
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "pair", frameIndex: 72, visualId: "scene", audioId: "voice" },
    ])
    const restored = deserializeLoaderState(serializeLoaderState(controller.state)).state
    expect(restored.h3Timeline).toEqual(controller.state.h3Timeline)
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    root.querySelector<HTMLButtonElement>('[data-action="redo"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(72)
  })

  test("keeps drag previews local, cancels on Escape, and cleans listeners on destroy", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const changes: number[] = []
    const axis = new H3Timeline(
      root,
      fixture(),
      new Map(),
      { zoom: 1, scrollLeft: 0 },
      {
        select: () => undefined,
        change: (_id, frame) => changes.push(frame),
        settled: () => undefined,
      },
    )
    cleanups.push(() => {
      axis.destroy()
      root.remove()
    })
    sizeSurface(root, 320)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 64)
    pointer(document, "pointermove", 96)
    expect(axis.dragging).toBe(true)
    expect(changes).toEqual([])
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("72f · 3.00s")
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    pointer(document, "pointerup", 96)
    expect(changes).toEqual([])
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.00s")
    sizeSurface(root)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    pointer(document, "pointerup", 192)
    expect(changes).toEqual([72])
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    axis.destroy()
    pointer(document, "pointermove", 240)
    pointer(document, "pointerup", 240)
    expect(changes).toEqual([72])
  })

  test("defers full renders during dragging and discards the edited frame on Cancel", () => {
    const { root, controller } = mount()
    sizeSurface(root)
    const original = root.querySelector('[data-timeline-guide="pair"]')!
    pointer(original, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    controller.render(true)
    expect(root.querySelector('[data-timeline-guide="pair"]')).toBe(original)
    pointer(document, "pointerup", 192)
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("72f · 3.00s")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.00s")
  })

  test("shares card draft frames with the timeline and preserves zoom across edits", () => {
    const { root, controller } = mount()
    const zoom = root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')!
    zoom.value = "4"
    zoom.dispatchEvent(new Event("change", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const input = root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    input.value = "96"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("96f · 4.00s")
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')?.value).toBe("4")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    key(root, "ArrowLeft")
    const frame = root.querySelector<HTMLInputElement>('[aria-label="Selected Guide frame"]')!
    frame.value = "144"
    frame.dispatchEvent(new Event("change", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(144)
    expect(controller.state.h3Timeline.endImageId).toBe("scene")
  })

  test("protects an unrelated dirty media draft and retains scroll on a frame edit", () => {
    const { root, controller } = mount()
    const state = fixture()
    state.h3Timeline.guides.push({ id: "other", frameIndex: 120, visualId: null, audioId: "music" })
    controller.restore(serializeLoaderState(state))
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const input = root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    input.value = "60"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    root
      .querySelector('[data-timeline-guide="other"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(root.querySelector(".rl-status")?.textContent).toContain("Apply or cancel")
    expect(controller.state.h3Timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 120])
    expect(root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')?.value).toBe("60")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    const zoom = root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')!
    zoom.value = "4"
    zoom.dispatchEvent(new Event("change", { bubbles: true }))
    const scroll = root.querySelector<HTMLElement>(".rl-time-axis__scroll")!
    scroll.scrollLeft = 250
    scroll.dispatchEvent(new Event("scroll"))
    key(root, "ArrowRight")
    expect(root.querySelector<HTMLElement>(".rl-time-axis__scroll")?.scrollLeft).toBe(250)
  })

  test("cancels pointer gestures on restore and rejects invalid whole-Guide input", () => {
    const { root, controller } = mount()
    sizeSurface(root)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    pointer(document, "pointercancel", 192)
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.00s")
    sizeSurface(root)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    controller.restore(serializeLoaderState(fixture()))
    pointer(document, "pointerup", 192)
    expect(root.querySelector(".rl-time-axis__draft")).toBeNull()
    key(root, "ArrowRight")
    const input = root.querySelector<HTMLInputElement>('[aria-label="Selected Guide frame"]')!
    for (const invalid of ["", "-1", "1.5"]) {
      input.value = invalid
      input.dispatchEvent(new Event("change", { bubbles: true }))
      expect(input.validationMessage).toContain("whole frame")
    }
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("49f · 2.04s")
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
  })
})
