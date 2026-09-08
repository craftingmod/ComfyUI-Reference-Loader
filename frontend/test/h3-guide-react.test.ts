import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function mount() {
  const state = createEmptyLoaderState()
  state.items.scene = createMediaItem(
    "image",
    { path: "scene.png", mime: "image/png", sha256: "a".repeat(64) },
    "scene",
  )
  state.imageOrder = ["scene"]
  state.h3Timeline.enabled = true
  state.h3Timeline.guides = [{ id: "guide", frameIndex: 48, visualId: "scene", audioId: null }]
  const root = document.createElement("div")
  document.body.append(root)
  const controller = new ReferenceLoaderController(
    root,
    { addDOMWidget: () => ({ name: "unused", value: null }), setDirtyCanvas() {} },
    new ReferenceLoaderApi({ fetchApi: async () => new Response("{}") }),
    serializeLoaderState(state),
  )
  const open = () => root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"]')!.click()
  open()
  cleanups.push(() => {
    controller.destroy()
    root.remove()
  })
  return { root, controller, open }
}

function enter(input: HTMLInputElement, value: string) {
  flushSync(() => {
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

describe("React Guide card boundary", () => {
  test("retains containers, keyed fields, focus and form state across a board update", () => {
    const { root, controller } = mount()
    const before = controller.serialize()
    const media = root.querySelector("[data-h3-card-editor]")!
    const footer = root.querySelector(".rl-card__body[data-h3-react-surface]")!
    const guide = root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    const add = root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!
    const position = root.querySelector<HTMLSelectElement>('[data-h3-add-field="position"]')!
    enter(guide, "72")
    guide.dispatchEvent(new Event("change", { bubbles: true }))
    enter(add, "96")
    flushSync(() => {
      position.value = "start"
      position.dispatchEvent(new Event("change", { bubbles: true }))
    })
    position.focus()

    // Shot updates use the same full-board render path as external controller changes.
    controller.setPromptShots([{ tag: "shot", frameIndex: 120 }])
    expect(root.querySelector("[data-h3-card-editor]")).toBe(media)
    expect(root.querySelector(".rl-card__body[data-h3-react-surface]")).toBe(footer)
    expect(root.querySelector('[data-h3-draft-field="frame"]')).toBe(guide)
    expect(root.querySelector('[data-h3-add-field="frame"]')).toBe(add)
    expect(guide.value).toBe("72")
    expect(add.value).toBe("96")
    expect(position.value).toBe("start")
    expect(document.activeElement).toBe(position)
    expect(add.disabled).toBe(true)
    expect(controller.serialize()).toBe(before)

    flushSync(() => {
      position.value = "guide"
      position.dispatchEvent(new Event("change", { bubbles: true }))
    })
    expect(add.disabled).toBe(false)
    expect(root.querySelector("[data-h3-add-seconds]")?.textContent).toBe("(4.00s)")
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides.map((entry) => entry.frameIndex)).toEqual([72, 96])
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click()
    expect(controller.serialize()).toBe(before)
  })

  test("isolates node instances and cleans up roots and native commit listeners on session end", () => {
    const first = mount()
    const second = mount()
    const media = first.root.querySelector("[data-h3-card-editor]")!
    const footer = first.root.querySelector(".rl-card__body[data-h3-react-surface]")!
    const frame = first.root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    const secondFrame = second.root.querySelector<HTMLInputElement>(
      '[data-h3-draft-field="frame"]',
    )!
    expect(frame.getAttribute("aria-describedby")).not.toBe(
      secondFrame.getAttribute("aria-describedby"),
    )
    const add = first.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!
    enter(add, "144")
    expect(second.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!.value).toBe(
      "",
    )
    first.root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(media.childNodes.length).toBe(0)
    expect(footer.childNodes.length).toBe(0)

    first.open()
    expect(first.root.querySelector("[data-h3-card-editor]")).not.toBe(media)
    expect(first.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!.value).toBe(
      "",
    )
    frame.value = "999"
    frame.dispatchEvent(new Event("change", { bubbles: true }))
    expect(first.root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!.value).toBe(
      "48",
    )

    const restoredMedia = first.root.querySelector("[data-h3-card-editor]")!
    first.controller.restore(first.controller.serialize())
    expect(restoredMedia.childNodes.length).toBe(0)
    expect(first.root.querySelector("[data-h3-react-surface]")).toBeNull()
    const secondMedia = second.root.querySelector("[data-h3-card-editor]")!
    second.controller.destroy()
    expect(secondMedia.childNodes.length).toBe(0)
    expect(second.root.childNodes.length).toBe(0)
  })
})
