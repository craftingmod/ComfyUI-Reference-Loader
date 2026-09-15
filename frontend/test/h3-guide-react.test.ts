import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import { executionFingerprintSource } from "../src/reference-loader/execution.ts"
import { serializeLoaderState } from "../src/reference-loader/serialization.ts"
import {
  createEmptyLoaderState,
  createMediaItem,
  normalizeH3OutputDimension,
} from "../src/reference-loader/types.ts"

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

function enterReactInput(input: HTMLInputElement, value: string) {
  flushSync(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value)
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
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

  test("edits canonical Video output dimensions from the H3 workspace picker", () => {
    const { root, controller } = mount()
    const before = executionFingerprintSource(controller.state)
    const trigger = root.querySelector<HTMLButtonElement>('[data-h3-action="output-settings"]')!

    flushSync(() => trigger.click())
    const panel = document.querySelector<HTMLElement>("[data-h3-output-panel]")!
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(panel.parentElement?.className).toBe("rl-h3-stage is-output-open")
    expect(panel.textContent).toContain("Video Output")
    expect(
      [...panel.querySelectorAll<HTMLElement>(".rl-h3-output-panel__mode-group [data-value]")].map(
        (button) => button.dataset.value,
      ),
    ).toEqual(["image", "aspect", "manual"])
    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>('.rl-h3-output-panel__mode-group [data-value="image"]')!
        .click(),
    )
    expect(
      panel.querySelector<HTMLElement>(".rl-h3-output-panel__image-options")?.dataset.captureWheel,
    ).toBe("true")
    expect(panel.querySelector<HTMLButtonElement>('[data-h3-output-image="scene"]')?.disabled).toBe(
      true,
    )
    expect(
      panel.querySelector<HTMLInputElement>("[data-h3-output-megapixels-input]")?.disabled,
    ).toBe(true)
    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>('.rl-h3-output-panel__mode-group [data-value="aspect"]')!
        .click(),
    )
    const aspectTrigger = panel.querySelector<HTMLButtonElement>("[data-h3-output-aspect-trigger]")!
    expect(aspectTrigger.getAttribute("aria-expanded")).toBe("false")
    expect(panel.querySelector("[data-h3-output-aspect]")).toBeNull()
    flushSync(() => aspectTrigger.click())
    expect(aspectTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(
      [
        ...panel.querySelectorAll<HTMLElement>(
          ".rl-h3-output-panel__orientation-group [data-value]",
        ),
      ].map((button) => button.dataset.value),
    ).toEqual(["horizontal", "square", "vertical"])
    expect(
      panel
        .querySelector<HTMLElement>(
          '.rl-h3-output-panel__orientation-group [data-value="horizontal"]',
        )
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(
      [...panel.querySelectorAll<HTMLElement>("[data-h3-output-aspect]")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["5:4", "4:3", "3:2", "16:9", "2:1"])
    expect(panel.querySelector(".rl-h3-output-panel__size-group")).toBeNull()

    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>(
          '.rl-h3-output-panel__orientation-group [data-value="square"]',
        )!
        .click(),
    )
    expect(aspectTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(
      [...panel.querySelectorAll<HTMLElement>("[data-h3-output-aspect]")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["1:1"])

    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>(
          '.rl-h3-output-panel__orientation-group [data-value="vertical"]',
        )!
        .click(),
    )
    expect(aspectTrigger.getAttribute("aria-expanded")).toBe("true")
    expect(
      [...panel.querySelectorAll<HTMLElement>("[data-h3-output-aspect]")].map((button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(["1:2", "9:16", "2:3", "3:4", "4:5"])

    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>(
          '.rl-h3-output-panel__orientation-group [data-value="horizontal"]',
        )!
        .click(),
    )
    flushSync(() =>
      panel.querySelector<HTMLButtonElement>('[data-h3-output-aspect="16:9"]')!.click(),
    )

    flushSync(() =>
      panel.querySelector<HTMLButtonElement>('[data-h3-output-megapixels="2"]')!.click(),
    )
    expect(controller.state.h3Output).toMatchObject({ width: 1888, height: 1056 })
    expect(panel.querySelector<HTMLInputElement>("[data-h3-output-megapixels-input]")?.value).toBe(
      "2",
    )
    flushSync(() => controller.setH3Output({ targetMegapixels: 1.234, width: 1472, height: 832 }))
    expect(controller.state.h3Output).toMatchObject({
      mode: "aspect",
      aspect: "16:9",
      targetMegapixels: 1.234,
    })
    expect(panel.querySelector("[data-h3-output-resolution]")).toBeNull()
    expect(executionFingerprintSource(controller.state)).not.toBe(before)

    flushSync(() =>
      panel
        .querySelector<HTMLButtonElement>('.rl-h3-output-panel__mode-group [data-value="manual"]')!
        .click(),
    )
    const width = panel.querySelector<HTMLInputElement>('[data-h3-output-dimension="width"]')!
    expect(width.step).toBe("32")
    controller.setH3Output({ width: 1000 })
    expect(normalizeH3OutputDimension(1000, 1024)).toBe(992)
    expect(controller.state.h3Output.width).toBe(992)
    expect(JSON.parse(controller.serialize()).h3Output).toMatchObject({
      width: 992,
      height: 832,
      mode: "manual",
      targetMegapixels: 1.234,
    })

    flushSync(() => panel.querySelector<HTMLButtonElement>(".rl-h3-output-panel__close")?.click())
    flushSync(() => trigger.click())
    const reopened = document.querySelector<HTMLElement>("[data-h3-output-panel]")!
    expect(
      reopened
        .querySelector<HTMLButtonElement>('.rl-h3-output-panel__mode-group [data-value="manual"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(
      reopened.querySelector<HTMLInputElement>('[data-h3-output-dimension="width"]')?.value,
    ).toBe("992")
    flushSync(() =>
      reopened
        .querySelector<HTMLButtonElement>('.rl-h3-output-panel__mode-group [data-value="aspect"]')!
        .click(),
    )
    expect(
      reopened.querySelector<HTMLInputElement>("[data-h3-output-megapixels-input]")?.value,
    ).toBe("1.234")
    flushSync(() =>
      reopened.querySelector<HTMLButtonElement>(".rl-h3-output-panel__close")?.click(),
    )
  })

  test("shares one panel slot between output and timing/config settings", async () => {
    const { root, controller } = mount()
    const outputButton = root.querySelector<HTMLButtonElement>(
      '[data-h3-action="output-settings"]',
    )!
    const timingButton = root.querySelector<HTMLButtonElement>(
      '[data-h3-action="timing-settings"]',
    )!

    expect(outputButton.getAttribute("aria-label")).toContain("Output: 16:9 · 1344×768")
    expect(timingButton.getAttribute("aria-label")).toContain("Timing: 24 fps · 124 frames")
    expect(outputButton.textContent).toBe("Resolution: 1344x768")
    expect(timingButton.textContent).toBe("Frame: 24x5.167sec")

    flushSync(() => timingButton.click())
    const timingPanel = root.querySelector<HTMLElement>("[data-h3-timing-panel]")!
    expect(root.querySelector("[data-h3-output-panel]")).toBeNull()
    expect(timingPanel.textContent).toContain("Video Timing")
    expect(
      [...timingPanel.querySelectorAll<HTMLButtonElement>(".rl-h3-timing-panel__tabs button")].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Timing", "Config"])
    expect(timingPanel.querySelector<HTMLElement>("[data-h3-timing-duration]")?.textContent).toBe(
      "Duration5.167s",
    )
    expect(timingButton.getAttribute("aria-expanded")).toBe("true")
    expect(outputButton.getAttribute("aria-expanded")).toBe("false")

    const fps = timingPanel.querySelector<HTMLInputElement>('[data-h3-timing-field="fps"]')!
    enterReactInput(fps, "30")
    flushSync(() => fps.dispatchEvent(new Event("focusout", { bubbles: true })))
    expect(controller.state.h3Output.fps).toBe(30)
    expect(timingPanel.querySelector<HTMLElement>("[data-h3-timing-duration]")?.textContent).toBe(
      "Duration4.133s",
    )

    const totalFrames = timingPanel.querySelector<HTMLInputElement>(
      '[data-h3-timing-field="totalFrames"]',
    )!
    enterReactInput(totalFrames, "243")
    flushSync(() => totalFrames.dispatchEvent(new Event("focusout", { bubbles: true })))
    expect(controller.state.h3Output.totalFrames).toBe(243)
    expect(timingButton.getAttribute("aria-label")).toContain("Timing: 30 fps · 243 frames")

    flushSync(() => controller.setH3Output({ fps: 48, totalFrames: 90 }))
    expect(controller.state.h3Output).toMatchObject({ fps: 48, totalFrames: 90 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const updatedTimingPanel = root.querySelector<HTMLElement>("[data-h3-timing-panel]")!
    expect(
      updatedTimingPanel.querySelector<HTMLInputElement>('[data-h3-timing-field="fps"]')?.value,
    ).toBe("48")
    expect(
      updatedTimingPanel.querySelector<HTMLInputElement>('[data-h3-timing-field="totalFrames"]')
        ?.value,
    ).toBe("90")
    expect(
      updatedTimingPanel.querySelector<HTMLElement>("[data-h3-timing-duration]")?.textContent,
    ).toBe("Duration1.875s")

    const configTab = timingPanel.querySelector<HTMLButtonElement>(
      '.rl-h3-timing-panel__tabs [data-value="config"]',
    )!
    flushSync(() => configTab.click())
    const configPanel = timingPanel.querySelector<HTMLElement>("[data-h3-config-panel]")!
    const resolutionMultiple = configPanel.querySelector<HTMLInputElement>(
      '[data-h3-config-field="resolutionMultiple"]',
    )!
    enterReactInput(resolutionMultiple, "64")
    flushSync(() => resolutionMultiple.dispatchEvent(new Event("focusout", { bubbles: true })))
    expect(controller.state.h3Output.resolutionMultiple).toBe(64)
    const frameModulo = configPanel.querySelector<HTMLInputElement>(
      '[data-h3-config-field="frameModulo"]',
    )!
    enterReactInput(frameModulo, "10")
    flushSync(() => frameModulo.dispatchEvent(new Event("focusout", { bubbles: true })))
    expect(controller.state.h3Output).toMatchObject({
      totalFrames: 95,
      frameModulo: 10,
      frameRemainder: 5,
    })
    const frameRemainder = configPanel.querySelector<HTMLInputElement>(
      '[data-h3-config-field="frameRemainder"]',
    )!
    enterReactInput(frameRemainder, "3")
    flushSync(() => frameRemainder.dispatchEvent(new Event("focusout", { bubbles: true })))
    expect(controller.state.h3Output).toMatchObject({
      totalFrames: 93,
      frameModulo: 10,
      frameRemainder: 3,
    })
    expect(configTab.getAttribute("aria-pressed")).toBe("true")

    const timingTab = timingPanel.querySelector<HTMLButtonElement>(
      '.rl-h3-timing-panel__tabs [data-value="timing"]',
    )!
    flushSync(() => timingTab.click())
    expect(root.querySelector("[data-h3-config-panel]")).toBeNull()
    expect(root.querySelector('[data-h3-timing-field="fps"]')).not.toBeNull()

    flushSync(() => outputButton.click())
    expect(root.querySelector("[data-h3-timing-panel]")).toBeNull()
    expect(root.querySelector("[data-h3-config-panel]")).toBeNull()
    expect(root.querySelector("[data-h3-output-panel]")).not.toBeNull()
    expect(outputButton.getAttribute("aria-expanded")).toBe("true")
    expect(timingButton.getAttribute("aria-expanded")).toBe("false")
    flushSync(() => root.querySelector<HTMLButtonElement>(".rl-h3-output-panel__close")?.click())
    expect(document.activeElement).toBe(outputButton)
    flushSync(() => outputButton.click())
    flushSync(() => outputButton.click())
    expect(root.querySelector("[data-h3-output-panel]")).toBeNull()
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
