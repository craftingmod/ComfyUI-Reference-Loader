import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import {
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
  flushSync(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        clientX,
        pointerId: 1,
        button: 0,
        isPrimary: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

function mediaDrag(target: EventTarget, type: string, transfer: DataTransfer, clientX = 0) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: transfer })
  Object.defineProperty(event, "clientX", { value: clientX })
  flushSync(() => target.dispatchEvent(event))
  return event
}

function protectedLoaderDrag(): DataTransfer {
  return {
    types: ["application/x-reference-loader-item"],
    files: [],
    items: [],
    getData: () => "",
  } as unknown as DataTransfer
}

function sizeSurface(root: HTMLElement, width = 640) {
  for (const lane of root.querySelectorAll<HTMLElement>("[data-timeline-channel]"))
    lane.getBoundingClientRect = () => new DOMRect(0, 0, width, 200)
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
    expect([...marks].map((mark) => mark.textContent)).toEqual(["72f · 3.000s", "72f · 3.000s"])
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
    const { root, controller } = mount()
    sizeSurface(root)
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    pointer(marker, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("72f · 3.000s")
    flushSync(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    pointer(document, "pointerup", 192)
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.000s")

    pointer(
      root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!,
      "pointerdown",
      128,
    )
    pointer(document, "pointermove", 192)
    pointer(document, "pointerup", 192)
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    controller.destroy()
    pointer(document, "pointermove", 240)
    pointer(document, "pointerup", 240)
  })

  test("keeps the lower Guide Frame field live while a marker is dragged", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const frame = root.querySelector<HTMLInputElement>('[aria-label="Guide frame"]')!
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    sizeSurface(root)

    expect(frame.value).toBe("48")
    pointer(marker, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    expect(frame.value).toBe("72")
    expect(frame.parentElement?.querySelector("small")?.textContent).toBe("3.000s")
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)

    pointer(document, "pointercancel", 192)
    expect(frame.value).toBe("48")
  })

  test("starts and continues a drag when a Nodes 2.0 wrapper stops bubbling", () => {
    const host = document.createElement("div")
    const root = mount().root
    host.append(root)
    document.body.append(host)
    sizeSurface(root)
    const mark = root.querySelector<HTMLElement>('[data-timeline-guide="pair"]')!
    mark.addEventListener("pointerdown", (event) => event.stopPropagation())
    host.addEventListener("pointermove", (event) => event.stopPropagation())
    pointer(mark, "pointerdown", 128)
    pointer(mark, "pointermove", 192)
    pointer(mark, "pointerup", 192)
    expect(root.querySelector<HTMLElement>(".rl-h3-workspace__status-row")?.textContent).toContain(
      "Unsaved changes",
    )
    host.remove()
  })

  test("adds a dragged Image to the Timeline draft at the drop frame", async () => {
    const { root, controller } = mount()
    sizeSurface(root)
    const transfer = new DataTransfer()
    const card = root.querySelector<HTMLElement>('.rl-card[data-id="scene"]')!
    pointer(card.querySelector<HTMLElement>(".rl-card__media")!, "pointerdown", 0)
    mediaDrag(card, "dragstart", transfer)
    const lane = root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')!
    // Native browsers expose the custom type during dragover but protect its
    // payload until drop. The lane must still accept the dragover.
    mediaDrag(lane, "dragover", protectedLoaderDrag(), 192)
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lane.classList.contains("is-drop-target")).toBe(true)
    mediaDrag(lane, "drop", transfer, 192)

    expect(controller.state.h3Timeline.guides).toHaveLength(1)
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    expect(
      [...root.querySelectorAll<HTMLElement>("[data-timeline-guide] [data-timeline-time]")].some(
        (element) => element.textContent === "72f · 3.000s",
      ),
    ).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toHaveLength(2)
    expect(controller.state.h3Timeline.guides).toContainEqual({
      id: expect.any(String),
      frameIndex: 72,
      visualId: "scene",
      audioId: null,
    })
  })

  test("adds a dragged standalone Audio to the Timeline draft at the drop frame", async () => {
    const { root, controller } = mount()
    sizeSurface(root)
    const transfer = new DataTransfer()
    const card = root.querySelector<HTMLElement>('.rl-card[data-id="music"][data-channel="audio"]')!
    pointer(card.querySelector<HTMLElement>(".rl-card__media")!, "pointerdown", 0)
    mediaDrag(card, "dragstart", transfer)
    expect(JSON.parse(transfer.getData("application/x-reference-loader-item"))).toMatchObject({
      id: "music",
      channel: "audio",
    })
    const lane = root.querySelector<HTMLElement>('[data-timeline-channel="audio"]')!
    mediaDrag(lane, "dragover", protectedLoaderDrag(), 192)
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(lane.classList.contains("is-drop-target")).toBe(true)
    mediaDrag(lane, "drop", transfer, 192)

    expect(controller.getViewSnapshot().h3?.timeline.guides).toContainEqual({
      id: expect.any(String),
      frameIndex: 72,
      visualId: null,
      audioId: "music",
    })
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toContainEqual({
      id: expect.any(String),
      frameIndex: 72,
      visualId: null,
      audioId: "music",
    })
  })

  test("removes the selected Guide from the Timeline draft", () => {
    const { root, controller } = mount()
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    marker.click()
    root
      .querySelector<HTMLButtonElement>('[data-h3-element-remove][aria-label="Remove Guide"]')!
      .click()

    expect(controller.state.h3Timeline.guides).toHaveLength(1)
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([])
  })

  test("shows the selected Guide controls beside End and in List rows", () => {
    const { root } = mount()
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    marker.click()

    const dock = root.querySelector<HTMLElement>("[data-h3-end-dock]")!
    expect(dock.querySelector('[data-h3-inline-frame][aria-label="Guide frame"]')).not.toBeNull()
    expect(dock.querySelector('[data-h3-element-remove][aria-label="Remove Guide"]')).not.toBeNull()
    expect(
      dock
        .querySelector<HTMLElement>('[data-h3-inline-frame][aria-label="Guide frame"]')
        ?.closest("[data-h3-element-controls]")
        ?.lastElementChild?.classList.contains("rl-h3-element-controls__label"),
    ).toBe(true)

    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })
    const row = root.querySelector<HTMLElement>("[data-h3-list-item]")!
    expect(row.querySelector("[data-h3-element-controls]")).not.toBeNull()
    expect(row.querySelector('[data-h3-inline-frame][aria-label="Guide frame"]')).not.toBeNull()
  })

  test("removes a selected End role through the timeline draft", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>(".rl-h3-timeline__end-mark")!.click()
    root
      .querySelector<HTMLButtonElement>('[data-h3-element-remove][aria-label="Remove End"]')!
      .click()

    expect(controller.getViewSnapshot().h3?.timeline.endImageId).toBeNull()
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.endImageId).toBeNull()
  })

  test("removes the selected Guide with Backspace or Delete", () => {
    for (const keyName of ["Backspace", "Delete"]) {
      const { root, controller } = mount()
      const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
      marker.focus()
      const event = new KeyboardEvent("keydown", {
        key: keyName,
        bubbles: true,
        cancelable: true,
      })
      marker.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
      expect(controller.state.h3Timeline.guides).toHaveLength(1)
      expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    }
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
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("72f · 3.000s")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.000s")
  })

  test("shares card draft frames with the timeline and preserves zoom across edits", () => {
    const { root, controller } = mount()
    const zoom = root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')!
    zoom.value = "4"
    zoom.dispatchEvent(new Event("change", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')!.click()
    const input = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"]',
    )!
    input.value = "96"
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
    expect(
      [
        ...root.querySelectorAll<HTMLElement>('[data-timeline-guide="pair"] [data-timeline-time]'),
      ].every((element) => element.textContent === "96f · 4.000s"),
    ).toBe(true)
    expect(root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')?.value).toBe("4")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const frame = root.querySelector<HTMLInputElement>('[aria-label="Guide frame"]')!
    frame.value = "144"
    flushSync(() => frame.dispatchEvent(new Event("input", { bubbles: true })))
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
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')!.click()
    const input = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"]',
    )!
    input.value = "60"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    root
      .querySelector('[data-timeline-guide="other"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
    expect(root.querySelector(".rl-status")?.textContent).toContain("Apply or cancel")
    expect(controller.state.h3Timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 120])
    expect(
      root.querySelector<HTMLInputElement>('[data-h3-inspector] [data-h3-draft-field="frame"]')
        ?.value,
    ).toBe("60")
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    const zoom = root.querySelector<HTMLSelectElement>('[aria-label="Timeline zoom"]')!
    zoom.value = "4"
    zoom.dispatchEvent(new Event("change", { bubbles: true }))
    const scroll = root.querySelector<HTMLElement>(".rl-h3-timeline__track-scroll")!
    scroll.scrollLeft = 250
    scroll.dispatchEvent(new Event("scroll"))
    key(root, "ArrowRight")
    expect(root.querySelector<HTMLElement>(".rl-h3-timeline__track-scroll")?.scrollLeft).toBe(250)
  })

  test("cancels pointer gestures on restore and rejects invalid whole-Guide input", () => {
    const { root, controller } = mount()
    sizeSurface(root)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    pointer(document, "pointercancel", 192)
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("48f · 2.000s")
    sizeSurface(root)
    pointer(root.querySelector('[data-timeline-guide="pair"]')!, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    controller.restore(serializeLoaderState(fixture()))
    pointer(document, "pointerup", 192)
    expect(controller.getViewSnapshot().h3?.dirty).toBe(false)
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const input = root.querySelector<HTMLInputElement>('[aria-label="Guide frame"]')!
    for (const invalid of ["", "-1", "1.5", "9007199254740992"]) {
      input.value = invalid
      flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
      input.dispatchEvent(new Event("change", { bubbles: true }))
      expect(input.value).toBe(invalid)
      expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    }
    expect(controller.getViewSnapshot().h3?.issue).toContain("frame")
    expect(root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')?.disabled).toBe(
      true,
    )
  })
})
