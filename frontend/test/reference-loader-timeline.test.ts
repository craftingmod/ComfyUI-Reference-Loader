import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferenceLoaderApi } from "../src/reference-loader/api.ts"
import {
  draggedFrame,
  nativeToTimelineFrame,
  snapTimelineFrame,
  timelineFrameInputToNative,
  timelineMarks,
  timelineExtent,
} from "../src/reference-loader/components/h3-timeline.ts"
import { ReferenceLoaderController } from "../src/reference-loader/components/loader.ts"
import { executionFingerprintSource } from "../src/reference-loader/execution.ts"
import {
  serializeLoaderState,
  deserializeLoaderState,
} from "../src/reference-loader/serialization.ts"
import { createEmptyLoaderState, createMediaItem } from "../src/reference-loader/types.ts"

function fixture() {
  const state = createEmptyLoaderState()
  state.h3Output = { ...state.h3Output, fps: 24, totalFrames: 243, width: 1344, height: 768 }
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

function mount(state = fixture()) {
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
    serializeLoaderState(state),
  )
  const h3Root = document.createElement("div")
  root.append(h3Root)
  controller.mountH3Workspace(h3Root)
  cleanups.push(() => {
    controller.destroy()
    root.remove()
  })
  return { root, controller }
}

function dirtyShot(controller: ReferenceLoaderController, frame = 25) {
  let currentFrame = frame
  let dirty = true
  const publish = (): void => {
    controller.setPromptShots(
      [{ tag: "opening", frameIndex: currentFrame }],
      (_tag, nextFrame) => {
        currentFrame = nextFrame
        dirty = true
        publish()
      },
      undefined,
      undefined,
      () => {
        dirty = false
        publish()
      },
      () => {
        currentFrame = 24
        dirty = false
        publish()
      },
      dirty,
    )
  }
  publish()
  return {
    get frame(): number {
      return currentFrame
    },
    get isDirty(): boolean {
      return dirty
    },
  }
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
  test("uses the bold title area as the collapse toggle and keeps view controls in the footer", () => {
    const { root, controller } = mount()
    const header = root.querySelector<HTMLElement>(".rl-h3-workspace__header")!
    const heading = header.querySelector<HTMLButtonElement>(".rl-h3-workspace__heading")!
    const tools = header.querySelector<HTMLElement>(".rl-h3-workspace__tools")!
    const footer = root.querySelector<HTMLElement>(".rl-h3-workspace__footer")!
    const footerControls = footer.querySelector<HTMLElement>(".rl-h3-workspace__footer-controls")!
    const viewControls = footer.querySelector<HTMLElement>(".rl-h3-workspace__view-controls")!
    const commitActions = footer.querySelector<HTMLElement>(".rl-h3-workspace__commit-actions")!
    const collapse = heading
    const status = header.querySelector<HTMLButtonElement>(".rl-h3-workspace__status")!
    const output = header.querySelector<HTMLButtonElement>('[data-h3-action="output-settings"]')!
    const timing = header.querySelector<HTMLButtonElement>('[data-h3-action="timing-settings"]')!
    const cancel = root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!
    const apply = root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!

    expect(heading.querySelector("strong")?.textContent).toBe("Timeline Guides")
    expect(collapse.getAttribute("aria-label")).toBe("Expand H3 Timeline")
    expect(heading.querySelector("small")?.textContent).toBe(
      "Assign image/audio guides and output-frame placements.",
    )
    expect(heading.querySelector(".rl-h3-workspace__summary")).toBeNull()
    expect(header.querySelector(".rl-h3-workspace__tools")).not.toBeNull()
    expect(tools.children[0]).toBe(status)
    expect(tools.children[1]).toBe(output)
    expect(tools.children[2]).toBe(timing)
    expect(tools.children).toHaveLength(3)
    expect(footer.hasAttribute("hidden")).toBe(true)
    expect(footerControls.children[0]).toBe(viewControls)
    expect(footerControls.children[1]).toBe(commitActions)
    expect(commitActions.children[0]).toBe(cancel)
    expect(commitActions.children[1]).toBe(apply)
    expect(root.querySelector(".rl-h3-workspace > .rl-h3-workspace__tools")).toBeNull()
    expect(root.querySelector('[aria-label="Timeline zoom"]')).toBeNull()
    expect(
      [...root.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Fit"),
    ).toBe(false)
    expect(status.title).toBe("Toggle Guides")
    expect(
      [...footer.querySelectorAll<HTMLButtonElement>('[aria-label="Timeline view"] button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(["Timeline", "List"])
    expect(
      [
        ...footer.querySelectorAll<HTMLButtonElement>('[aria-label="Timeline snap mode"] button'),
      ].map((button) => button.textContent),
    ).toEqual(["Off", "0.5s"])
    expect(
      footer
        .querySelector<HTMLButtonElement>('[aria-label="Timeline snap mode"] button')
        ?.getAttribute("aria-pressed"),
    ).toBe("true")
    expect(status.textContent).toBe("ON")
    expect(status.getAttribute("aria-pressed")).toBe("true")

    heading.click()
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true")
    expect(root.querySelector(".rl-h3-workspace__summary")?.textContent).toBe(
      "Media (Image/Video/Audio) · 3 media ~ 243 frames · 24 FPS",
    )
    expect(footer.hasAttribute("hidden")).toBe(false)
    expect(tools.children[0]).toBe(status)
    expect(tools.children[1]).toBe(output)
    expect(tools.children[2]).toBe(timing)
    expect(tools.children).toHaveLength(3)

    flushSync(() => {
      footer
        .querySelector<HTMLButtonElement>('[aria-label="Timeline snap mode"] button:nth-child(2)')
        ?.click()
    })
    expect(root.querySelector('[data-h3-snap-mode="half-second"]')).not.toBeNull()

    collapse.click()
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')
        ?.getAttribute("aria-label"),
    ).toBe("Expand H3 Timeline")
    expect(root.querySelector(".rl-h3-workspace__summary")).toBeNull()

    status.click()
    expect(controller.getViewSnapshot().h3?.timeline.enabled).toBe(false)
    expect(status.textContent).toBe("OFF")
    expect(status.getAttribute("aria-pressed")).toBe("false")
  })

  test("expands the collapsed workspace before opening an output or timing panel", () => {
    const { root } = mount()
    const workspace = root.querySelector<HTMLElement>("[data-h3-workspace]")!
    const output = root.querySelector<HTMLButtonElement>('[data-h3-action="output-settings"]')!
    const timing = root.querySelector<HTMLButtonElement>('[data-h3-action="timing-settings"]')!

    expect(workspace.classList.contains("is-collapsed")).toBe(true)
    flushSync(() => output.click())
    expect(workspace.classList.contains("is-collapsed")).toBe(false)
    expect(root.querySelector("[data-h3-output-panel]")).not.toBeNull()
    expect(root.querySelector("[data-h3-timing-panel]")).toBeNull()

    flushSync(() => timing.click())
    expect(root.querySelector("[data-h3-output-panel]")).toBeNull()
    expect(root.querySelector("[data-h3-timing-panel]")).not.toBeNull()

    flushSync(() =>
      workspace.querySelector<HTMLButtonElement>(".rl-h3-workspace__heading")?.click(),
    )
    expect(workspace.classList.contains("is-collapsed")).toBe(true)
    expect(root.querySelector("[data-h3-timing-panel]")).toBeNull()
  })

  test("rounds Timeline interaction frames to the nearest half-second", () => {
    expect(snapTimelineFrame(49, 24, "off")).toBe(49)
    expect(snapTimelineFrame(49, 24, "half-second")).toBe(48)
    expect(snapTimelineFrame(55, 24, "half-second")).toBe(60)
    expect(snapTimelineFrame(31, 30, "half-second")).toBe(30)
  })

  test("does not render a terminal ruler tick outside the Timeline track", () => {
    const { root } = mount()
    const ticks = root.querySelectorAll<HTMLElement>(
      ".rl-h3-timeline__ruler-axis > span:not(.rl-h3-timeline__output-boundary)",
    )

    expect([...ticks].some((tick) => tick.style.left === "100%")).toBe(false)
  })

  test("anchors the Output end border inside the track edge", () => {
    const { root } = mount()
    const boundary = root.querySelector<HTMLElement>('[role="separator"]')!
    const lines = root.querySelectorAll<HTMLElement>(".rl-h3-timeline__output-boundary-line")

    expect(boundary.style.left).toBe("")
    expect(boundary.style.right).toBe("0px")
    expect([...lines].every((line) => line.style.left === "" && line.style.right === "0px")).toBe(
      true,
    )
  })

  test("uses the mention badges for Audio and Shot timeline previews", () => {
    const state = fixture()
    state.h3Timeline.guides.push({
      id: "music-guide",
      frameIndex: 96,
      visualId: null,
      audioId: "music",
    })
    const { root, controller } = mount(state)
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')!.click()
    const audioBadges = root.querySelectorAll<HTMLElement>(
      '[data-timeline-channel="audio"] .rl-h3-timeline__mark .rl-prompt-reference-icon',
    )

    expect([...audioBadges].map((badge) => badge.textContent)).toEqual(["A1", "A2"])

    dirtyShot(controller)
    const shotBadge = root.querySelector<HTMLElement>(
      '[data-timeline-channel="shot"] .rl-h3-timeline__mark .rl-prompt-subject-icon',
    )
    expect(shotBadge?.textContent).toBe("SH1")
  })

  test("renders compact source labels above Start and End roles", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    state.h3Timeline.guides.push({
      id: "last",
      frameIndex: 242,
      visualId: "scene",
      audioId: null,
    })
    const { root, controller } = mount(state)
    const visualEndpointMarkers = root.querySelectorAll<HTMLButtonElement>(
      '[data-timeline-channel="visual"] .rl-h3-timeline__mark.is-endpoint-preview',
    )

    expect(visualEndpointMarkers).toHaveLength(3)
    expect(
      [...visualEndpointMarkers].every((marker) => marker.querySelector("small") === null),
    ).toBe(true)
    expect(
      [...visualEndpointMarkers].some((marker) => marker.classList.contains("is-endpoint-end")),
    ).toBe(true)
    const startMarker = root.querySelector<HTMLButtonElement>(
      '[data-timeline-channel="visual"] .rl-h3-timeline__mark[aria-label^="Start ·"]',
    )!
    expect(startMarker.classList.contains("is-endpoint-role")).toBe(true)
    expect(startMarker.querySelector(".rl-h3-timeline__endpoint-source")?.textContent).toBe(
      "scene.png",
    )
    expect(startMarker.querySelector(".rl-h3-timeline__endpoint-role")?.textContent).toBe("Start")
    const endMarker = root.querySelector<HTMLButtonElement>("[data-h3-end-mark]")!
    expect(endMarker.classList.contains("is-endpoint-role")).toBe(true)
    expect(endMarker.querySelector(".rl-h3-timeline__endpoint-source")?.textContent).toBe(
      "scene.png",
    )
    expect(endMarker.querySelector(".rl-h3-timeline__endpoint-role")?.textContent).toBe("End")

    dirtyShot(controller, 0)
    const shot = root.querySelector<HTMLButtonElement>(
      '[data-timeline-channel="shot"] .rl-h3-timeline__mark',
    )!
    expect(shot.classList.contains("is-endpoint-preview")).toBe(true)
    expect(shot.classList.contains("is-endpoint-role")).toBe(true)
    expect(shot.querySelector(".rl-prompt-subject-icon")?.textContent).toBe("SH1")
    expect(shot.querySelector("small")).toBeNull()
    expect(shot.querySelector(".rl-h3-timeline__endpoint-source")?.textContent).toBe("#opening")
    expect(shot.querySelector(".rl-h3-timeline__endpoint-role")?.textContent).toBe("Start")
    dirtyShot(controller, 242)
    expect(shot.classList.contains("is-endpoint-role")).toBe(true)
    expect(shot.querySelector(".rl-h3-timeline__endpoint-role")?.textContent).toBe("End")
    const shotPosition = shot.closest<HTMLElement>(".rl-h3-timeline__mark-position")
    const endPosition = root.querySelector<HTMLElement>("[data-h3-end-position]")!
    expect(shotPosition?.style.left).toBe(endPosition.style.left)
    const lastGuidePosition = root
      .querySelector<HTMLElement>('[data-timeline-guide="last"]')
      ?.closest<HTMLElement>(".rl-h3-timeline__mark-position")
    expect(lastGuidePosition?.style.left).not.toBe(endPosition.style.left)
  })

  test("uses the Reference Loader H3 output settings and opens selected Guides in the Inspector", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')!.click()
    const executionBefore = executionFingerprintSource(controller.state)
    controller.setH3Output({ fps: 30, totalFrames: 124 })

    expect(controller.state.h3Output).toEqual({
      fps: 30,
      totalFrames: 124,
      resolutionMultiple: 32,
      frameModulo: 17,
      frameRemainder: 5,
      width: 1344,
      height: 768,
      mode: "aspect",
      imageId: null,
      aspect: "16:9",
      targetMegapixels: 1.03,
    })
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(nativeToTimelineFrame(48, 30)).toBe(60)
    expect(timelineFrameInputToNative("61", 30)).toBe("49")
    expect(root.querySelector("[data-timeline-time]")?.textContent).toBe("60f · 2.000s")
    expect(root.querySelector("[data-timeline-channel=visual]")?.textContent).toContain("60f")
    expect(root.querySelector(".rl-h3-timeline__ruler")?.textContent).toContain("4.133s · 124f")
    expect(root.querySelector(".rl-h3-workspace__summary")?.textContent).toBe(
      "Media (Image/Video/Audio) · 3 media ~ 124 frames · 30 FPS",
    )
    expect(root.querySelector(".rl-h3-workspace__summary")?.getAttribute("title")).toBe(
      "30 FPS · 124 frames",
    )
    expect(executionFingerprintSource(controller.state)).not.toBe(executionBefore)

    controller.setH3Output({ fps: 24, totalFrames: 124 })
    expect(root.querySelector(".rl-h3-timeline__ruler")?.textContent).toContain("5.167s · 124f")
    expect(
      Number.parseFloat(
        root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')?.style.backgroundSize ??
          "",
      ),
    ).toBeCloseTo((24 / 124) * 100)
    controller.setH3Output({ fps: 30, totalFrames: 124 })

    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
    expect(document.activeElement).toBe(
      root.querySelector(
        '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
      ),
    )
    const guideInput = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
    )!
    expect(guideInput.value).toBe("60")
    guideInput.value = "61"
    flushSync(() => guideInput.dispatchEvent(new Event("input", { bubbles: true })))
    guideInput.dispatchEvent(new Event("change", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "pair", frameIndex: 48, visualId: null, audioId: "voice" },
      { id: expect.any(String), frameIndex: 49, visualId: "scene", audioId: null },
    ])
  })

  test("marks the configured output end without hiding out-of-range placements", () => {
    const state = fixture()
    state.h3Output = { ...state.h3Output, fps: 24, totalFrames: 124, width: 1344, height: 768 }
    state.h3Timeline.guides[0]!.frameIndex = 200
    const { root } = mount(state)

    expect(root.querySelector('[role="separator"]')?.getAttribute("aria-label")).toBe(
      "Output end · 5.167s · 124f",
    )
    expect(root.querySelectorAll(".rl-h3-timeline__output-boundary-line")).toHaveLength(3)
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')
    expect(marker).not.toBeNull()
    expect(marker?.classList.contains("is-out-of-range")).toBe(true)
    expect(marker?.title).toContain("Out of range · output ends at 124f")
    expect(root.querySelector("[data-h3-end-dock] [data-h3-end-mark]")).toBeNull()
    const endMark = root.querySelector<HTMLButtonElement>(
      '[data-timeline-channel="visual"] [data-h3-end-mark]',
    )
    expect(endMark).not.toBeNull()
    expect(endMark?.classList.contains("rl-h3-timeline__mark")).toBe(true)
    expect(endMark?.classList.contains("is-endpoint-preview")).toBe(true)
    expect(endMark?.classList.contains("is-endpoint-end")).toBe(true)
    expect(endMark?.textContent).toContain("scene.png")
    expect(endMark?.title).toContain("scene.png")
    endMark?.click()
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-timeline-channel="visual"] [data-h3-end-mark]')
        ?.classList.contains("is-selected"),
    ).toBe(true)
  })

  test("does not render an empty End marker over other Guides", () => {
    const state = fixture()
    state.h3Timeline.endImageId = null
    const { root } = mount(state)

    expect(root.querySelector('[data-timeline-guide="pair"]')).not.toBeNull()
    expect(root.querySelector("[data-h3-end-mark]")).toBeNull()
  })

  test("highlights the selected Start or End role in the Guide Inspector", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root } = mount(state)

    for (const [role, selector] of [
      ["start", 'button[aria-label^="Start ·"]'],
      ["end", "[data-h3-end-mark]"],
    ] as const) {
      root.querySelector<HTMLButtonElement>(selector)!.click()
      expect(
        root
          .querySelector(`[data-h3-inspector] [data-h3-role="${role}"]`)
          ?.classList.contains("is-selected"),
      ).toBe(true)
      const otherRole = role === "start" ? "end" : "start"
      expect(
        root
          .querySelector(`[data-h3-inspector] [data-h3-role="${otherRole}"]`)
          ?.classList.contains("is-selected"),
      ).toBe(false)
    }
  })

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
    expect(timelineExtent(marks)).toBe(124)
    state.h3Timeline.disabledAudioIds = ["music"]
    expect(timelineMarks(state, runtime).some((mark) => mark.warning)).toBe(false)
    delete voice.crop
    expect(
      timelineMarks(state, runtime).find(
        (mark) => mark.placement.guideId === "pair" && mark.channel === "audio",
      )?.frames,
    ).toBeUndefined()
  })

  test("keeps a terminal Shot at the configured output extent", () => {
    const state = fixture()
    state.h3Timeline.endImageId = null
    const marks = timelineMarks(state, new Map(), [{ tag: "final", frameIndex: 239 }])

    expect(timelineExtent(marks, 240, 24)).toBe(240)
  })

  test("snaps using screen width at different canvas scales and clamps the lower boundary", () => {
    expect(draggedFrame(48, 64, 640, 240)).toBe(72)
    expect(draggedFrame(48, 32, 320, 240)).toBe(72)
    expect(draggedFrame(48, 1, 640, 240)).toBe(48)
    expect(draggedFrame(48, -640, 640, 240)).toBe(0)
    expect(draggedFrame(48, 640, 640, 240)).toBe(239)
    expect(draggedFrame(48, 64, 0, 240)).toBe(48)
  })

  test("sizes each timeline lane from overlapping placement rows", () => {
    const { root, controller } = mount()
    const state = fixture()
    state.h3Timeline.endImageId = null
    state.h3Timeline.guides = [
      { id: "late", frameIndex: 200, visualId: "scene", audioId: null },
      { id: "middle", frameIndex: 100, visualId: "scene", audioId: null },
      { id: "early", frameIndex: 0, visualId: "scene", audioId: null },
    ]
    controller.restore(serializeLoaderState(state))
    const visualLane = root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')!
    expect(visualLane.style.height).toBe("48px")

    state.h3Timeline.guides.push({
      id: "overlap",
      frameIndex: 84,
      visualId: "scene",
      audioId: null,
    })
    controller.restore(serializeLoaderState(state))
    expect(root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')?.style.height).toBe(
      "84px",
    )
  })

  test("packs an attached End marker into an available visual Guide row", () => {
    const state = fixture()
    state.h3Timeline.guides = [
      { id: "before-end", frameIndex: 60, visualId: "scene", audioId: null },
    ]
    const { root, controller } = mount(state)

    const visualLane = root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')!
    const endPosition = root.querySelector<HTMLElement>(
      '[data-timeline-channel="visual"] [data-h3-end-position]',
    )
    expect(endPosition?.style.top).toBe("4px")
    expect(visualLane.style.height).toBe("48px")

    state.h3Timeline.guides[0]!.frameIndex = 200
    controller.restore(serializeLoaderState(state))
    expect(endPosition?.style.top).toBe("4px")
    expect(visualLane.style.height).toBe("84px")
  })

  test("does not let out-of-range visual Guides push the End marker into a new row", () => {
    const state = fixture()
    state.h3Output = { ...state.h3Output, fps: 24, totalFrames: 124, width: 1344, height: 768 }
    state.h3Timeline.guides = [
      { id: "first", frameIndex: 0, visualId: "scene", audioId: null },
      { id: "out-of-range", frameIndex: 140, visualId: "scene", audioId: null },
    ]
    const { root } = mount(state)

    const visualLane = root.querySelector<HTMLElement>('[data-timeline-channel="visual"]')!
    const endPosition = root.querySelector<HTMLElement>(
      '[data-timeline-channel="visual"] [data-h3-end-position]',
    )
    expect(root.querySelector('[data-timeline-guide="out-of-range"]')?.classList).toContain(
      "is-out-of-range",
    )
    expect(endPosition?.style.top).toBe("4px")
    expect(visualLane.style.height).toBe("48px")
  })

  test("gives short audio markers the normal readable marker width", () => {
    const { root, controller } = mount()
    const state = fixture()
    const voice = state.items.voice
    if (voice?.kind !== "audio") throw new Error("Expected audio")
    voice.crop = { start: 0, end: 1.125 }
    controller.restore(serializeLoaderState(state))

    const position = root.querySelector<HTMLElement>(
      '[data-timeline-channel="audio"] .rl-h3-timeline__mark-position',
    )
    expect(position).not.toBeNull()
    expect(Number.parseFloat(position?.style.width ?? "0")).toBeGreaterThan(11.25)
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

  test("removes the dragging marker class after pointer release", () => {
    const { root } = mount()
    sizeSurface(root)
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!

    pointer(marker, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    expect(marker.classList.contains("is-dragging")).toBe(true)

    pointer(document, "pointerup", 192)
    expect(root.querySelectorAll(".rl-h3-timeline__mark.is-dragging")).toHaveLength(0)
  })

  test("keeps the Guide Inspector Frame field live while a marker is dragged", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const frame = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
    )!
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    sizeSurface(root)

    expect(frame.value).toBe("48")
    expect(root.querySelector("[data-h3-end-dock] [data-h3-element-controls]")).toBeNull()
    pointer(marker, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    expect(frame.value).toBe("48")
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)

    pointer(document, "pointercancel", 192)
    expect(frame.value).toBe("48")
  })

  test("selects the dragged Guide in the Guide Inspector before moving it", () => {
    const state = fixture()
    state.h3Timeline.guides.push({
      id: "other",
      frameIndex: 120,
      visualId: null,
      audioId: "music",
    })
    const { root } = mount(state)
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    sizeSurface(root)

    pointer(
      root.querySelector<HTMLButtonElement>('[data-timeline-guide="other"]')!,
      "pointerdown",
      128,
    )
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Audio Guide Inspector"]'),
    ).not.toBeNull()
    expect(root.querySelector('[data-h3-inspector] [data-h3-guide-id="other"]')).not.toBeNull()

    pointer(document, "pointercancel", 128)
  })

  test("keeps a dragged Shot selected without waiting for focus to leave", () => {
    const { root, controller } = mount()
    dirtyShot(controller)
    sizeSurface(root)
    const shot = root.querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')!

    pointer(shot, "pointerdown", 128)
    pointer(document, "pointermove", 192)
    pointer(document, "pointerup", 192)

    expect(shot.classList.contains("is-selected")).toBe(true)
    expect(shot.getAttribute("aria-pressed")).toBe("true")
  })

  test("moves same-frame Shots by stable identity in any order", () => {
    const { root, controller } = mount()
    const shots = [
      { id: "shot-a", tag: "opening", frameIndex: 0 },
      { id: "shot-b", tag: "middle", frameIndex: 0 },
      { id: "shot-c", tag: "closing", frameIndex: 0 },
      { id: "shot-d", tag: "finale", frameIndex: 0 },
      { id: "shot-e", tag: "credits", frameIndex: 0 },
    ]
    const moved: string[] = []
    let current = shots
    let dirty = true
    const publish = (): void => {
      controller.setPromptShots(
        current,
        (identity, frameIndex) => {
          moved.push(identity)
          current = current.map((shot) => (shot.id === identity ? { ...shot, frameIndex } : shot))
          publish()
        },
        undefined,
        undefined,
        () => {
          dirty = false
          publish()
        },
        () => {
          dirty = false
          current = current.map((shot) => ({ ...shot, frameIndex: 0 }))
          publish()
        },
        dirty,
      )
    }
    publish()
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')!.click()
    sizeSurface(root)

    const order = ["shot-c", "shot-a", "shot-e", "shot-b", "shot-d"]
    for (const identity of order) {
      const marker = root.querySelector<HTMLButtonElement>(`[data-timeline-shot-id="${identity}"]`)!
      pointer(marker, "pointerdown", 128)
      pointer(document, "pointermove", 192)
      pointer(document, "pointerup", 192)
    }

    expect(moved).toEqual(order)
    expect(current.map((shot) => shot.frameIndex)).toEqual([24, 24, 24, 24, 24])
    expect(
      [
        ...root.querySelectorAll<HTMLElement>(
          '[data-timeline-channel="shot"] .rl-h3-timeline__mark-position',
        ),
      ].map((position) => position.style.zIndex),
    ).toEqual(["5", "4", "3", "2", "1"])
    expect(
      new Set(
        [...root.querySelectorAll<HTMLButtonElement>("[data-timeline-shot-id]")].map(
          (marker) => marker.dataset.timelineShotId,
        ),
      ).size,
    ).toBe(5)
  })

  test("keeps a Shot drag alive when selection releases pointer capture", () => {
    const { root, controller } = mount()
    const shots = [
      { id: "shot-a", tag: "opening", frameIndex: 0 },
      { id: "shot-b", tag: "middle", frameIndex: 0 },
    ]
    const moved: string[] = []
    let current = shots
    const publish = (): void => {
      controller.setPromptShots(
        current,
        (identity, frameIndex) => {
          moved.push(identity)
          current = current.map((shot) => (shot.id === identity ? { ...shot, frameIndex } : shot))
          publish()
        },
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      )
    }
    publish()
    root.querySelector<HTMLButtonElement>('[data-h3-action="collapse"]')!.click()
    sizeSurface(root)

    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-shot-id="shot-a"]')!
    pointer(marker, "pointerdown", 128)
    pointer(marker, "lostpointercapture", 128)
    pointer(document, "pointermove", 192)
    pointer(document, "pointerup", 192)

    expect(moved).toEqual(["shot-a"])
    expect(current[0]?.frameIndex).toBe(24)
    expect(marker.getAttribute("aria-pressed")).toBe("true")
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
    expect(root.querySelector<HTMLElement>(".rl-h3-workspace__footer")?.textContent).toContain(
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
        (element) => element.textContent === "73f · 3.042s",
      ),
    ).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toHaveLength(2)
    expect(controller.state.h3Timeline.guides).toContainEqual({
      id: expect.any(String),
      frameIndex: 73,
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
      frameIndex: 73,
      visualId: null,
      audioId: "music",
    })
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toContainEqual({
      id: expect.any(String),
      frameIndex: 73,
      visualId: null,
      audioId: "music",
    })
  })

  test("removes the selected Guide source connection from the Inspector draft", () => {
    const { root, controller } = mount()
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    marker.click()
    root
      .querySelector<HTMLButtonElement>(
        '[data-h3-action="delete-draft-placement"][data-h3-guide-id="pair"]',
      )!
      .click()

    expect(controller.state.h3Timeline.guides).toHaveLength(1)
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "pair", frameIndex: 48, visualId: null, audioId: "voice" },
    ])
  })

  test("shows the selected Guide only in the Guide Inspector", () => {
    const { root } = mount()
    const marker = root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!
    marker.click()

    const dock = root.querySelector<HTMLElement>("[data-h3-end-dock]")!
    expect(dock.querySelector("[data-h3-element-controls]")).toBeNull()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()

    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })
    expect(root.querySelector("[data-h3-list] [data-h3-element-controls]")).toBeNull()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Image Guide Inspector"]'),
    ).not.toBeNull()
  })

  test("keeps Shot auxiliary controls in the Timeline Dock and List row", () => {
    const { root, controller } = mount()
    dirtyShot(controller)
    root.querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')!.click()

    const dock = root.querySelector<HTMLElement>("[data-h3-end-dock]")!
    expect(dock.querySelector('[data-h3-inline-frame][aria-label="Shot frame"]')).not.toBeNull()
    expect(dock.querySelector('[data-h3-element-remove][aria-label="Remove Shot"]')).not.toBeNull()

    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })
    const row = [...root.querySelectorAll<HTMLElement>("[data-h3-list-item]")].find((item) =>
      item.textContent?.includes("Shot #opening"),
    )
    expect(row).toBeDefined()
    expect(row?.querySelector('[data-h3-inline-frame][aria-label="Shot frame"]')).not.toBeNull()
    expect(row?.querySelector('[data-h3-element-remove][aria-label="Remove Shot"]')).not.toBeNull()
  })

  test("sets the selected Shot to the output Start or End frame", () => {
    const { root, controller } = mount()
    const shot = dirtyShot(controller, 25)
    root.querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')!.click()

    const dock = root.querySelector<HTMLElement>("[data-h3-end-dock]")!
    flushSync(() => {
      dock.querySelector<HTMLButtonElement>('[data-h3-frame-shortcut="start"]')!.click()
    })
    expect(shot.frame).toBe(0)
    expect(dock.querySelector<HTMLInputElement>("[data-h3-inline-frame]")!.value).toBe("0")

    flushSync(() => {
      dock.querySelector<HTMLButtonElement>('[data-h3-frame-shortcut="end"]')!.click()
    })
    expect(shot.frame).toBe(242)
    expect(dock.querySelector<HTMLInputElement>("[data-h3-inline-frame]")!.value).toBe("242")

    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })
    const row = [...root.querySelectorAll<HTMLElement>("[data-h3-list-item]")].find((item) =>
      item.textContent?.includes("Shot #opening"),
    )!
    flushSync(() => {
      row.querySelector<HTMLButtonElement>('[data-h3-frame-shortcut="start"]')!.click()
    })
    expect(shot.frame).toBe(0)
    flushSync(() => {
      row.querySelector<HTMLButtonElement>('[data-h3-frame-shortcut="end"]')!.click()
    })
    expect(shot.frame).toBe(242)
  })

  test("removes a selected End role through the timeline draft", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>("[data-h3-end-mark]")!.click()
    root
      .querySelector<HTMLButtonElement>('[data-h3-action="remove-draft-role"][data-h3-role="end"]')!
      .click()

    expect(controller.getViewSnapshot().h3?.timeline.endImageId).toBeNull()
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.endImageId).toBeNull()
  })

  test("removes a selected Start role through the timeline draft", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root, controller } = mount(state)
    root.querySelector<HTMLButtonElement>('button[aria-label^="Start ·"]')!.click()
    root
      .querySelector<HTMLButtonElement>(
        '[data-h3-action="remove-draft-role"][data-h3-role="start"]',
      )!
      .click()

    expect(controller.getViewSnapshot().h3?.timeline.startImageId).toBeNull()
    expect(controller.getViewSnapshot().h3?.dirty).toBe(true)
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.startImageId).toBeNull()
  })

  test("selects Start and End in List view and keeps focus on their rows", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root } = mount(state)
    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })

    const selectListRow = (label: "Start" | "End"): HTMLButtonElement => {
      const row = [...root.querySelectorAll<HTMLElement>("[data-h3-list-item]")].find(
        (item) => item.querySelector("strong")?.textContent === label,
      )
      if (!row) throw new Error(`Missing ${label} List row.`)
      const button = row.querySelector<HTMLButtonElement>(".rl-h3-workspace__list-select")
      if (!button) throw new Error(`Missing ${label} List select button.`)
      button.click()
      return button
    }
    for (const label of ["Start", "End"] as const) {
      const button = selectListRow(label)
      const row = button.closest<HTMLElement>("[data-h3-list-item]")!
      expect(row.classList.contains("is-selected")).toBe(true)
      expect(button.getAttribute("aria-pressed")).toBe("true")
      expect(document.activeElement).toBe(button)
      expect(root.querySelector("[data-h3-list] [data-h3-element-controls]")).toBeNull()
    }
  })

  test("does not keep a same-image Frame Guide selected with Start or End", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root } = mount(state)
    flushSync(() => {
      root
        .querySelector<HTMLButtonElement>('[aria-label="Timeline view"] button:nth-child(2)')!
        .click()
    })

    const selectListRow = (label: string): HTMLButtonElement => {
      const row = [...root.querySelectorAll<HTMLElement>("[data-h3-list-item]")].find(
        (item) => item.querySelector("strong")?.textContent === label,
      )
      if (!row) throw new Error(`Missing ${label} List row.`)
      const button = row.querySelector<HTMLButtonElement>(".rl-h3-workspace__list-select")
      if (!button) throw new Error(`Missing ${label} List select button.`)
      button.click()
      return button
    }
    const selectedLabels = (): string[] =>
      [...root.querySelectorAll<HTMLElement>("[data-h3-list-item].is-selected")].map(
        (item) => item.querySelector("strong")?.textContent ?? "",
      )

    selectListRow("Guide pair")
    expect(selectedLabels()).toEqual(["Guide pair", "Guide pair"])
    const startButton = selectListRow("Start")
    expect(selectedLabels()).toEqual(["Start"])
    expect(document.activeElement).toBe(startButton)
    const endButton = selectListRow("End")
    expect(selectedLabels()).toEqual(["End"])
    expect(document.activeElement).toBe(endButton)
  })

  test("does not keep same-image Start or End selected when another Guide or Shot is selected", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root, controller } = mount(state)
    const sceneCard = root.querySelector<HTMLElement>('.rl-card[data-id="scene"]')!

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')!.click()
    expect(sceneCard.classList.contains("is-selected")).toBe(true)
    expect(root.querySelectorAll('[data-timeline-channel="visual"] .is-selected')).toHaveLength(0)
    expect(root.querySelector("[data-h3-end-mark]")?.classList).not.toContain("is-selected")

    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    expect(controller.getViewSnapshot().h3?.selection).toMatchObject({
      kind: "guide",
      guideId: "pair",
    })
    expect(
      root.querySelector('[data-timeline-channel="visual"] [aria-label^="Start ·"]')?.classList,
    ).not.toContain("is-selected")
    expect(root.querySelector("[data-h3-end-mark]")?.classList).not.toContain("is-selected")
    expect(root.querySelector('[data-timeline-guide="pair"]')?.classList).toContain("is-selected")
    expect(sceneCard.classList.contains("is-selected")).toBe(false)

    dirtyShot(controller)
    root.querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')!.click()
    expect(controller.getViewSnapshot().h3?.selection).toMatchObject({
      kind: "shot",
      tag: "opening",
    })
    expect(
      root.querySelector('[data-timeline-channel="visual"] [aria-label^="Start ·"]')?.classList,
    ).not.toContain("is-selected")
    expect(root.querySelector("[data-h3-end-mark]")?.classList).not.toContain("is-selected")
    expect(root.querySelector('[data-timeline-shot="opening"]')?.classList).toContain("is-selected")
    expect(sceneCard.classList.contains("is-selected")).toBe(false)
  })

  test("clears H3 placement selection after choosing another Media card", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    state.h3Timeline.guides = [{ id: "at-start", frameIndex: 0, visualId: "scene", audioId: null }]
    state.items.other = createMediaItem(
      "image",
      {
        path: "reference_loader/sources/other.png",
        mime: "image/png",
        sha256: "b".repeat(64),
      },
      "other",
    )
    state.imageOrder.push("other")
    const { root, controller } = mount(state)
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="at-start"]')!.click()
    expect(controller.getViewSnapshot().h3?.selection).toMatchObject({
      kind: "guide",
      guideId: "at-start",
    })
    root.querySelector<HTMLElement>('.rl-card[data-id="other"]')!.click()
    expect(controller.getViewSnapshot().h3?.selection).toMatchObject({
      kind: "source",
      mediaId: "scene",
      channel: "visual",
    })
    expect(root.querySelectorAll(".rl-h3-timeline__mark.is-selected")).toHaveLength(0)
    expect(root.querySelectorAll("[data-h3-list-item].is-selected")).toHaveLength(0)
    expect(root.querySelectorAll(".is-selected")).toHaveLength(1)
    expect(root.querySelector('.rl-card[data-id="other"]')?.classList).toContain("is-selected")
  })

  test("removes Start and End independently when they share one image", () => {
    const state = fixture()
    state.h3Timeline.startImageId = "scene"
    const { root, controller } = mount(state)

    root.querySelector<HTMLButtonElement>('button[aria-label^="Start ·"]')!.click()
    root
      .querySelector<HTMLButtonElement>(
        '[data-h3-action="remove-draft-role"][data-h3-role="start"]',
      )!
      .click()
    expect(controller.getViewSnapshot().h3?.timeline).toMatchObject({
      startImageId: null,
      endImageId: "scene",
    })

    root.querySelector<HTMLButtonElement>("[data-h3-end-mark]")!.click()
    root
      .querySelector<HTMLButtonElement>('[data-h3-action="remove-draft-role"][data-h3-role="end"]')!
      .click()
    expect(controller.getViewSnapshot().h3?.timeline).toMatchObject({
      startImageId: null,
      endImageId: null,
    })
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

  test("shares card draft frames with the timeline and keeps the fixed default layout", () => {
    const { root, controller } = mount()
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
    expect(root.querySelector('[aria-label="Timeline zoom"]')).toBeNull()
    root.querySelector<HTMLButtonElement>('[data-h3-action="cancel-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    root.querySelector<HTMLButtonElement>('[data-timeline-guide="pair"]')!.click()
    const frame = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
    )!
    frame.value = "144"
    flushSync(() => frame.dispatchEvent(new Event("input", { bubbles: true })))
    frame.dispatchEvent(new Event("change", { bubbles: true }))
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "pair", frameIndex: 48, visualId: null, audioId: "voice" },
      { id: expect.any(String), frameIndex: 144, visualId: "scene", audioId: null },
    ])
    expect(controller.state.h3Timeline.endImageId).toBe("scene")
  })

  test("moves an unrelated Guide while preserving a dirty Media draft and retains scroll", () => {
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
    expect(root.querySelector(".rl-status")?.textContent).not.toContain("Apply or cancel")
    expect(controller.state.h3Timeline.guides.map((guide) => guide.frameIndex)).toEqual([48, 120])
    expect(
      controller.getViewSnapshot().h3?.timeline.guides.map((guide) => guide.frameIndex),
    ).toEqual([60, 121])
    expect(
      root.querySelector<HTMLInputElement>('[data-h3-inspector] [data-h3-draft-field="frame"]')
        ?.value,
    ).toBe("60")
    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides.map((guide) => guide.frameIndex)).toEqual([60, 121])
    const scroll = root.querySelector<HTMLElement>(".rl-h3-timeline__track-scroll")!
    scroll.scrollLeft = 250
    scroll.dispatchEvent(new Event("scroll"))
    key(root, "ArrowRight")
    expect(root.querySelector<HTMLElement>(".rl-h3-timeline__track-scroll")?.scrollLeft).toBe(250)
  })

  test("switches dirty Timeline selections across Image, Audio, and Shot before one Apply", () => {
    const { root, controller } = mount()
    const state = fixture()
    state.h3Timeline.guides.push({
      id: "other",
      frameIndex: 120,
      visualId: null,
      audioId: "music",
    })
    controller.restore(serializeLoaderState(state))

    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')!.click()
    const imageFrame = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
    )!
    imageFrame.value = "60"
    flushSync(() => imageFrame.dispatchEvent(new Event("input", { bubbles: true })))

    root.querySelector<HTMLButtonElement>('[data-timeline-guide="other"]')!.click()
    expect(
      root.querySelector('[data-h3-inspector][aria-label="Audio Guide Inspector"]'),
    ).not.toBeNull()
    const audioFrame = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="other"]',
    )!
    audioFrame.value = "144"
    flushSync(() => audioFrame.dispatchEvent(new Event("input", { bubbles: true })))

    const shot = dirtyShot(controller)
    root.querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')!.click()
    expect(
      root
        .querySelector<HTMLButtonElement>('[data-timeline-shot="opening"]')
        ?.classList.contains("is-selected"),
    ).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides).toEqual([
      { id: "pair", frameIndex: 60, visualId: "scene", audioId: "voice" },
      { id: "other", frameIndex: 144, visualId: null, audioId: "music" },
    ])
    expect(shot.isDirty).toBe(false)
  })

  test("moves a Guide while a Shot draft is dirty and applies both drafts", () => {
    const { root, controller } = mount()
    const shot = dirtyShot(controller)
    expect(root.querySelector<HTMLElement>(".rl-h3-workspace__footer")?.textContent).toContain(
      "Shot timing is unsaved",
    )
    root
      .querySelector('[data-timeline-guide="pair"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))

    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(controller.getViewSnapshot().h3?.timeline.guides[0]?.frameIndex).toBe(49)
    expect(shot.frame).toBe(25)
    expect(shot.isDirty).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(49)
    expect(shot.isDirty).toBe(false)
  })

  test("moves a Shot while a Media Guide draft is dirty and applies both drafts", () => {
    const { root, controller } = mount()
    root.querySelector<HTMLButtonElement>('[data-action="edit-h3-guide"][data-id="scene"]')!.click()
    const input = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"]',
    )!
    input.value = "60"
    flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
    const shot = dirtyShot(controller)

    root
      .querySelector('[data-timeline-shot="opening"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))

    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(48)
    expect(controller.getViewSnapshot().h3?.timeline.guides[0]?.frameIndex).toBe(60)
    expect(shot.frame).toBe(26)
    expect(shot.isDirty).toBe(true)

    root.querySelector<HTMLButtonElement>('[data-h3-action="apply-editor"]')!.click()
    expect(controller.state.h3Timeline.guides[0]?.frameIndex).toBe(60)
    expect(shot.isDirty).toBe(false)
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
    const input = root.querySelector<HTMLInputElement>(
      '[data-h3-inspector] [data-h3-draft-field="frame"][data-h3-guide-id="pair"]',
    )!
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
