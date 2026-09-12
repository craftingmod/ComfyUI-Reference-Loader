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
  const h3Root = document.createElement("div")
  root.append(h3Root)
  const h3Mount = controller.mountH3Workspace(h3Root)
  const open = () => root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"]')!.click()
  open()
  cleanups.push(() => {
    h3Mount.destroy()
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

function position(root: HTMLElement, value: "start" | "guide" | "end") {
  const button = root.querySelector<HTMLButtonElement>(
    `[data-h3-add-field="position"][value="${value}"]`,
  )
  if (!button) throw new Error(`Missing Guide position ${value}.`)
  flushSync(() => button.click())
  return button
}

describe("React Guide inspector boundary", () => {
  test("retains the workspace, keyed fields, focus, and form state across a board update", () => {
    const { root, controller } = mount()
    const before = controller.serialize()
    const workspace = root.querySelector<HTMLElement>("[data-h3-workspace]")!
    const inspector = root.querySelector<HTMLElement>("[data-h3-inspector]")!
    const guide = inspector.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    const add = root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!
    expect(
      inspector
        .querySelector('[data-h3-action="delete-draft-placement"]')
        ?.classList.contains("rl-button--remove"),
    ).toBe(true)
    expect(
      root
        .querySelector('[data-h3-action="add-draft-placement"]')
        ?.classList.contains("rl-button--add"),
    ).toBe(true)

    enter(guide, "72")
    guide.dispatchEvent(new Event("change", { bubbles: true }))
    enter(add, "96")
    position(root, "start").focus()

    // Shot updates use the same full-board render path as external controller changes.
    controller.setPromptShots([{ tag: "shot", frameIndex: 120 }])
    expect(root.querySelector<HTMLElement>("[data-h3-workspace]")).toBe(workspace)
    expect(root.querySelector<HTMLElement>("[data-h3-inspector]")).toBe(inspector)
    expect(inspector.querySelector('[data-h3-draft-field="frame"]')).toBe(guide)
    expect(root.querySelector('[data-h3-add-field="frame"]')).toBe(add)
    expect(guide.value).toBe("72")
    expect(add.value).toBe("96")
    expect(document.activeElement).toBe(
      root.querySelector('[data-h3-add-field="position"][value="start"]'),
    )
    expect(add.disabled).toBe(true)
    expect(controller.serialize()).toBe(before)

    position(root, "guide")
    expect(add.disabled).toBe(false)
    expect(root.querySelector("[data-h3-add-seconds]")?.textContent).toBe("(4.00s)")
    root.querySelector<HTMLButtonElement>('[data-h3-action="add-draft-placement"]')!.click()
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides.map((entry) => entry.frameIndex)).toEqual([72, 96])
    root.querySelector<HTMLButtonElement>('[data-action="undo"]')!.click()
    expect(controller.serialize()).toBe(before)
  })

  test("renders Position as an accessible segmented radio button group", () => {
    const { root } = mount()
    const group = root.querySelector<HTMLElement>('[role="radiogroup"]')
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-h3-add-field="position"]')]

    expect(group?.getAttribute("aria-label")).toBe("Guide position")
    expect(buttons.map((button) => button.textContent)).toEqual(["Start", "Frame", "End"])
    expect(buttons.map((button) => button.getAttribute("role"))).toEqual([
      "radio",
      "radio",
      "radio",
    ])
    expect(buttons.map((button) => button.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ])
    expect(buttons.map((button) => button.tabIndex)).toEqual([-1, 0, -1])
    expect(root.querySelector<HTMLElement>("[data-h3-add-frame]")?.hidden).toBe(false)

    flushSync(() => {
      buttons[1]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(buttons[2])
    expect(buttons[2]?.getAttribute("aria-checked")).toBe("true")
    expect(root.querySelector<HTMLElement>("[data-h3-add-frame]")?.hidden).toBe(true)

    flushSync(() => buttons[1]!.click())
    expect(root.querySelector<HTMLElement>("[data-h3-add-frame]")?.hidden).toBe(false)
  })

  test("isolates node instances and cleans up the permanent roots on restore and destroy", () => {
    const first = mount()
    const second = mount()
    const firstSurface = first.root.querySelector<HTMLElement>("[data-loader-react-surface]")!
    const secondSurface = second.root.querySelector<HTMLElement>("[data-loader-react-surface]")!
    const firstInspector = first.root.querySelector<HTMLElement>("[data-h3-inspector]")!
    const frame = firstInspector.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!
    const secondFrame = second.root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"]',
    )!
    expect(frame.getAttribute("aria-describedby")).not.toBe(
      secondFrame.getAttribute("aria-describedby"),
    )

    const add = first.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!
    enter(add, "144")
    enter(frame, "72")
    expect(second.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!.value).toBe(
      "",
    )
    first.root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(first.root.querySelector("[data-h3-inspector][data-h3-editor]")).toBeNull()

    first.open()
    expect(first.root.querySelector<HTMLElement>("[data-loader-react-surface]")).toBe(firstSurface)
    expect(first.root.querySelector<HTMLInputElement>('[data-h3-add-field="frame"]')!.value).toBe(
      "",
    )
    frame.value = "999"
    frame.dispatchEvent(new Event("change", { bubbles: true }))
    expect(first.root.querySelector<HTMLInputElement>('[data-h3-draft-field="frame"]')!.value).toBe(
      "48",
    )

    first.controller.restore(first.controller.serialize())
    expect(first.root.querySelector<HTMLElement>("[data-loader-react-surface]")).toBe(firstSurface)
    expect(first.root.querySelector("[data-h3-inspector][data-h3-editor]")).toBeNull()

    second.controller.destroy()
    expect(second.root.childNodes.length).toBe(0)
    expect(secondSurface.isConnected).toBe(false)
    first.controller.destroy()
    expect(first.root.childNodes.length).toBe(0)
  })
})
