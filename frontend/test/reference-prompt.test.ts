import { afterEach, describe, expect, test } from "bun:test"

import { flushSync } from "react-dom"

import type { ComfyNode } from "../src/comfyui.ts"
import { createPromptDefinitionsReact } from "../src/reference-loader/components/prompt-definitions-react.tsx"
import {
  ReferencePromptController,
  type ReferencePromptControllerOptions,
} from "../src/reference-loader/components/prompt-editor.ts"
import { createPromptReact } from "../src/reference-loader/components/prompt-react.tsx"
import {
  compilePromptDocument,
  createEmptyPromptDocument,
  deserializePromptDocument,
  parseRawPrompt,
  serializePromptDocument,
  type PromptReference,
} from "../src/reference-loader/prompt-state.ts"

function imageReference(overrides: Partial<PromptReference> = {}): PromptReference {
  return {
    referenceId: "image-a",
    itemId: "image-a",
    mediaKind: "image",
    ordinal: 1,
    tag: "<Picture 1>",
    label: "image1",
    filename: "fighter.png",
    previewUrl: "/fighter.webp",
    ...overrides,
  }
}

const activeMountCleanups = new Set<() => void>()

function makeController(
  references: PromptReference[] = [],
  serialized?: unknown,
  options: ReferencePromptControllerOptions = {},
): {
  root: HTMLElement
  promptRoot: HTMLElement
  definitions: HTMLElement
  definitionsMount: { destroy(): void }
  controller: ReferencePromptController
  dirty: () => number
  transactions: string[]
} {
  const root = document.createElement("div")
  const promptRoot = document.createElement("div")
  const definitions = document.createElement("div")
  root.append(promptRoot, definitions)
  document.body.append(root)
  let dirtyCount = 0
  const transactions: string[] = []
  const node: ComfyNode = {
    addDOMWidget: () => ({ name: "unused", value: null }),
    graph: {
      beforeChange: () => transactions.push("before"),
      afterChange: () => transactions.push("after"),
    },
    setDirtyCanvas: () => {
      dirtyCount += 1
    },
  }
  const controller = new ReferencePromptController(node, () => references, serialized, options)
  const promptMount = createPromptReact({ container: promptRoot, controller })
  controller.mountDefinitions(definitions)
  const definitionsMount = createPromptDefinitionsReact({
    container: definitions,
    controller,
  })
  activeMountCleanups.add(() => {
    definitionsMount.destroy()
    promptMount.destroy()
    controller.destroy()
  })
  return {
    root,
    promptRoot,
    definitions,
    definitionsMount,
    controller,
    dirty: () => dirtyCount,
    transactions,
  }
}

function placeCaretAtEnd(element: HTMLElement): void {
  element.focus()
  const selection = getSelection()
  const range = document.createRange()
  const last = element.lastChild
  if (last?.nodeType === Node.TEXT_NODE) range.setStart(last, last.textContent?.length ?? 0)
  else {
    range.selectNodeContents(element)
    range.collapse(false)
  }
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function inputText(element: HTMLElement, value: string): void {
  element.textContent = value
  placeCaretAtEnd(element)
  const data = value.includes("#") ? "#" : value.includes("@") ? "@" : null
  flushSync(() =>
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data }),
    ),
  )
}

function press(element: HTMLElement, key: string, options: KeyboardEventInit = {}): boolean {
  let result = true
  flushSync(() => {
    result = element.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
    )
  })
  return result
}

function click(element: HTMLElement): void {
  flushSync(() => element.click())
}

function sectionBody(root: HTMLElement, title: string): HTMLElement {
  const body = root.querySelector<HTMLElement>(`[data-prompt-section-body="${title}"]`)
  if (!body) throw new Error(`Missing ${title} section`)
  return body
}

function sectionEntry(root: HTMLElement): HTMLElement {
  const entry = root.querySelector<HTMLElement>("[data-prompt-section-entry]")
  if (!entry) throw new Error("Missing section entry")
  return entry
}

afterEach(() => {
  for (const cleanup of activeMountCleanups) cleanup()
  activeMountCleanups.clear()
  document.body.replaceChildren()
  document.documentElement.removeAttribute("lang")
  getSelection()?.removeAllRanges()
})

describe("Reference Prompt state", () => {
  test("round-trips title sections and compiles official per-type tags", () => {
    const prompt = {
      ...createEmptyPromptDocument(),
      sections: [
        {
          title: "integrated_multimodal_description",
          parts: [
            { type: "text" as const, text: "Look at " },
            {
              type: "mention" as const,
              referenceId: "image-a",
              mediaKind: "image" as const,
              label: "image1",
            },
            { type: "text" as const, text: "안녕하세요" },
          ],
        },
        { title: "visual_style", parts: [{ type: "text" as const, text: "Soft 3D" }] },
      ],
    }
    const serialized = serializePromptDocument(prompt)
    expect(deserializePromptDocument(serialized).document).toEqual(prompt)
    expect(compilePromptDocument(prompt, [imageReference()])).toBe(
      "integrated_multimodal_description:\nLook at <Picture 1>안녕하세요\n\nvisual_style:\nSoft 3D",
    )
  })

  test("parses arbitrary pseudo-YAML title tags in source order", () => {
    const raw = [
      "integrated_multimodal_description:",
      "A duel begins.",
      "",
      "overall_soundscape:",
      "Sword clash",
      "",
      "custom_h3_field:",
      "Keep this too",
    ].join("\n")
    const prompt = parseRawPrompt(raw, [])
    expect(prompt.sections).toEqual([
      {
        title: "integrated_multimodal_description",
        parts: [{ type: "text", text: "A duel begins." }],
      },
      { title: "overall_soundscape", parts: [{ type: "text", text: "Sword clash" }] },
      { title: "custom_h3_field", parts: [{ type: "text", text: "Keep this too" }] },
    ])
    expect(compilePromptDocument(prompt, [])).toBe(raw)
  })

  test("merges duplicate raw titles instead of creating ambiguous sections", () => {
    const prompt = parseRawPrompt("scene:\nFirst\n\nscene:\nSecond", [])
    expect(prompt.sections).toEqual([
      { title: "scene", parts: [{ type: "text", text: "First\n\nSecond" }] },
    ])
  })

  test("recovers the previous section state as Raw without discarding legacy parts", () => {
    const result = deserializePromptDocument(
      JSON.stringify({
        version: 3,
        view: "structured",
        sections: [
          {
            title: "scene",
            parts: [
              { type: "text", text: "Say " },
              { type: "dialogue", text: "Hello" },
              {
                type: "mention",
                referenceId: "image-a",
                mediaKind: "image",
                label: "image1",
              },
            ],
          },
        ],
      }),
    )
    expect(result.recoveredFromVersion).toBe(3)
    expect(result.document.view).toBe("raw")
    expect(result.document.subjects).toEqual([])
    expect(result.issues).toEqual([])
    expect(compilePromptDocument(result.document, [imageReference()])).toBe(
      "scene:\nSay <d>Hello</d><Picture 1>",
    )
    expect(JSON.parse(serializePromptDocument(result.document)).version).toBe(5)
  })

  test("recovers the original flat Prompt state and its directives as Raw", () => {
    const result = deserializePromptDocument({
      version: 1,
      parts: [
        { type: "text", text: "Opening " },
        {
          type: "directive",
          kind: "audio",
          parts: [
            { type: "text", text: "Rain near " },
            {
              type: "mention",
              referenceId: "image-a",
              mediaKind: "image",
              label: "image1",
            },
          ],
        },
      ],
    })
    expect(result.recoveredFromVersion).toBe(1)
    expect(compilePromptDocument(result.document, [imageReference()])).toBe(
      "scene:\nOpening <audio>Rain near <Picture 1></audio>",
    )
  })

  test("parses official tags to stable mentions and keeps former dialogue tags as text", () => {
    const prompt = parseRawPrompt("scene:\nUse <Picture 1> and <Video 9><d>Hello</d>", [
      imageReference(),
    ])
    expect(prompt.sections[0]?.parts).toEqual([
      { type: "text", text: "Use " },
      {
        type: "mention",
        referenceId: "image-a",
        mediaKind: "image",
        label: "image1",
      },
      { type: "text", text: " and <Video 9><d>Hello</d>" },
    ])
  })

  test("keeps unavailable stable mentions visible without rebinding", () => {
    const prompt = {
      ...createEmptyPromptDocument(),
      sections: [
        {
          title: "scene",
          parts: [
            {
              type: "mention" as const,
              referenceId: "removed",
              mediaKind: "image" as const,
              label: "old-image",
            },
          ],
        },
      ],
    }
    expect(compilePromptDocument(prompt, [imageReference()])).toBe("scene:\n@old-image")
  })

  test("round-trips stable Subject parts and parses their Raw ordinals", () => {
    const prompt = {
      ...createEmptyPromptDocument(),
      subjects: [
        { tag: "woman", parts: [] },
        { tag: "cafe", parts: [] },
      ],
      sections: [
        {
          title: "scene",
          parts: [{ type: "text" as const, text: "#woman enters #cafe" }],
        },
      ],
    }
    expect(deserializePromptDocument(serializePromptDocument(prompt)).document).toEqual(prompt)
    expect(compilePromptDocument(prompt, [])).toBe(
      "subject_definitions:\n<Subject 1>:\n\n<Subject 2>:\n\nscene:\n<Subject 1> enters <Subject 2>",
    )
    expect(
      parseRawPrompt("scene:\n#cafe greets #woman", [], "raw", prompt).sections[0]?.parts,
    ).toEqual([{ type: "text", text: "#cafe greets #woman" }])
  })
})

describe("Reference Prompt section stack", () => {
  test("mounts Subjects and Shots in a separate Stack area between Media and Prompt", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [] }],
      shots: [{ tag: "opening", frameIndex: 24, parts: [] }],
      sections: [{ title: "scene", parts: [{ type: "text", text: "Use #hero." }] }],
    })
    const { root, promptRoot, controller, definitions, definitionsMount } = makeController(
      [],
      serialized,
    )

    expect(promptRoot.querySelector(".rl-prompt-definitions")).toBeNull()
    expect(definitions.querySelector(".rl-prompt-definitions")).toBeTruthy()
    expect(definitions.querySelector('[data-prompt-definition="subject"]')).toBeTruthy()
    expect(definitions.querySelector('[data-prompt-definition="shot"]')).toBeTruthy()
    expect(root.querySelector('[data-prompt-section="scene"]')).toBeTruthy()

    const subjectBody = definitions.querySelector<HTMLElement>(
      '[data-prompt-definition="subject"] [data-prompt-definition-body]',
    )!
    inputText(subjectBody, "Use #")
    const picker = definitions.querySelector<HTMLElement>("[data-prompt-picker]")!
    expect(picker.parentElement?.hasAttribute("data-prompt-react-picker-slot")).toBe(true)
    press(subjectBody, "Escape")
    inputText(subjectBody, "A persistent hero.")
    expect(JSON.parse(controller.serialize()).subjects[0].parts).toEqual([
      { type: "text", text: "A persistent hero." },
    ])

    definitionsMount.destroy()
    controller.destroy()
    expect(definitions.childElementCount).toBe(0)
  })

  test("opens a legacy Prompt in Raw and allows conversion to the current Structured state", () => {
    const legacy = JSON.stringify({
      version: 3,
      sections: [{ title: "scene", parts: [{ type: "text", text: "Recovered scene" }] }],
    })
    const { root, controller } = makeController([], legacy, { locale: "ko" })
    expect(root.querySelector<HTMLElement>("[data-prompt-editor]")?.textContent).toBe(
      "scene:\nRecovered scene",
    )
    expect(root.querySelector<HTMLElement>("[data-prompt-hint]")?.textContent).toContain(
      "이전 Prompt v3을 Raw로 복구",
    )

    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!)
    expect(sectionBody(root, "scene").textContent).toBe("Recovered scene")
    expect(root.querySelector<HTMLElement>("[data-prompt-hint]")?.textContent).toBe("")
    expect(JSON.parse(controller.serialize())).toMatchObject({ version: 5, view: "structured" })
    controller.destroy()
  })

  test("shows a virtual scene card but keeps an untouched prompt empty", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    expect(scene).toBeTruthy()
    const nativeEmptyLine = document.createElement("div")
    nativeEmptyLine.append(document.createElement("br"))
    scene.replaceChildren(nativeEmptyLine)
    scene.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertParagraph" }))
    expect(controller.compiledPrompt).toBe("")
    expect(JSON.parse(controller.serialize()).sections).toEqual([])
    controller.destroy()
  })

  test("derives stable preset colors from section titles without serializing them", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [
        { title: "scene", parts: [] },
        { title: "camera_direction", parts: [] },
        { title: "timeline_direction", parts: [] },
      ],
    })
    const { root, controller } = makeController([], serialized)
    const scene = root.querySelector<HTMLElement>('[data-prompt-section="scene"]')!
    const camera = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    const timeline = root.querySelector<HTMLElement>('[data-prompt-section="timeline_direction"]')!

    expect(scene.dataset.promptSectionColorIndex).toBe("11")
    expect(scene.style.getPropertyValue("--rl-prompt-section-color")).toBe("#9b94c9")
    expect(camera.dataset.promptSectionColorIndex).toBe("8")
    expect(camera.style.getPropertyValue("--rl-prompt-section-color")).toBe("#6ebfd3")
    expect(timeline.dataset.promptSectionColorIndex).toBe("4")
    expect(timeline.style.getPropertyValue("--rl-prompt-section-color")).toBe("#d482b2")
    expect(controller.serialize()).toBe(serialized)
    expect(controller.serialize()).not.toContain("color")
    controller.destroy()
  })

  test("creates a section from a slash alias and stores its title tag", () => {
    const { root, controller, dirty } = makeController()
    const entry = sectionEntry(root)
    inputText(entry, "/style")
    expect(root.querySelectorAll("[data-prompt-alias-index]").length).toBeGreaterThan(0)
    expect(press(entry, "Enter")).toBe(false)
    const body = sectionBody(root, "visual_style")
    inputText(body, "Soft 3D")
    expect(controller.compiledPrompt).toBe("visual_style:\nSoft 3D")
    expect(JSON.parse(controller.serialize()).sections[0].title).toBe("visual_style")
    expect(dirty()).toBeGreaterThan(0)
    controller.destroy()
  })

  test("uses the selected H3 base default and slash aliases", () => {
    const { root, controller } = makeController([], undefined, {
      presetId: "minimax_h3_base",
    })
    expect(sectionBody(root, "integrated_multimodal_description")).toBeTruthy()
    expect(controller.compiledPrompt).toBe("")
    inputText(sectionEntry(root), "/sound")
    press(sectionEntry(root), "Enter")
    inputText(sectionBody(root, "overall_soundscape"), "Steel clashes")
    expect(controller.compiledPrompt).toBe("overall_soundscape:\nSteel clashes")
    expect(root.querySelector("[data-prompt-preset]")?.textContent).toBe("MiniMax H3 Base")
    controller.destroy()
  })

  test("switches preset policy without transforming existing sections", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "scene", parts: [{ type: "text", text: "Keep me" }] }],
    })
    const { root, controller } = makeController([], serialized)
    controller.setPreset("minimax_h3_reference")
    expect(sectionBody(root, "scene").textContent).toBe("Keep me")
    expect(controller.compiledPrompt).toBe("scene:\nKeep me")
    inputText(sectionEntry(root), "/retention")
    press(sectionEntry(root), "Enter")
    expect(sectionBody(root, "retention_analysis")).toBeTruthy()
    controller.destroy()
  })

  test("keeps direct title tags available in the alias-free preset", () => {
    const { root, controller } = makeController([], undefined, { presetId: "freeform" })
    inputText(sectionEntry(root), "/")
    expect(root.querySelectorAll("[data-prompt-alias-index]")).toHaveLength(0)
    expect(root.querySelector("[data-prompt-picker]")?.textContent).toContain("No aliases")
    inputText(sectionEntry(root), "custom_direction:")
    press(sectionEntry(root), "Enter")
    expect(sectionBody(root, "custom_direction")).toBeTruthy()
    controller.destroy()
  })

  test("localizes visible editor copy while preserving prompt identifiers", () => {
    const { root, controller } = makeController([], undefined, {
      presetId: "minimax_h3_base",
      locale: "ko",
    })
    expect(root.querySelector("[data-prompt-title]")?.textContent).toBe("프롬프트")
    expect(root.querySelector("[data-prompt-preset]")?.textContent).toBe("MiniMax H3 기본")
    expect(root.querySelector('[data-prompt-action="clear"]')?.textContent).toBe("지우기")
    expect(sectionEntry(root).dataset.placeholder).toContain("섹션 추가")
    inputText(sectionEntry(root), "/sound")
    expect(root.querySelector("[data-prompt-picker]")?.textContent).toContain("전체 사운드")
    expect(sectionBody(root, "integrated_multimodal_description")).toBeTruthy()
    controller.destroy()
  })

  test("clears Prompt sections immediately while preserving the selected view", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      view: "raw",
      sections: [{ title: "scene", parts: [{ type: "text", text: "Keep media" }] }],
    })
    const { root, controller, dirty } = makeController([], serialized)
    const clear = root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')!
    expect(clear.disabled).toBe(false)
    click(clear)
    expect(controller.compiledPrompt).toBe("")
    expect(controller.document.view).toBe("raw")
    expect(root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')?.disabled).toBe(
      true,
    )
    expect(root.querySelector("[data-prompt-hint]")?.textContent).toBe(
      "Prompt cleared. Media preserved.",
    )
    expect(dirty()).toBe(1)
    controller.destroy()
  })

  test("accepts a direct integrated_multimodal_description title tag", () => {
    const { root, controller } = makeController()
    const entry = sectionEntry(root)
    inputText(entry, "integrated_multimodal_description:")
    press(entry, "Enter")
    const body = sectionBody(root, "integrated_multimodal_description")
    inputText(body, "A character enters.")
    expect(controller.compiledPrompt).toBe(
      "integrated_multimodal_description:\nA character enters.",
    )
    controller.destroy()
  })

  test("focuses an existing title when an alias is entered twice", () => {
    const { root, controller } = makeController()
    inputText(sectionEntry(root), "/camera")
    press(sectionEntry(root), "Enter")
    const first = sectionBody(root, "camera_direction")
    inputText(first, "Tracking shot")
    inputText(sectionEntry(root), "/camera")
    press(sectionEntry(root), "Enter")
    expect(root.querySelectorAll('[data-prompt-section="camera_direction"]')).toHaveLength(1)
    expect(document.activeElement).toBe(first)
    expect(controller.compiledPrompt).toBe("camera_direction:\nTracking shot")
    controller.destroy()
  })

  test("opens @ references inside every section and stores stable identity", () => {
    const reference = imageReference()
    const { root, controller } = makeController([reference])
    const scene = sectionBody(root, "scene")
    inputText(scene, "Battle @")
    expect(root.querySelectorAll("[data-prompt-reference-index]")).toHaveLength(1)
    press(scene, "Enter")
    expect(controller.compiledPrompt).toBe("scene:\nBattle <Picture 1>")
    expect(JSON.parse(controller.serialize()).sections[0].parts[1]).toMatchObject({
      type: "mention",
      referenceId: "image-a",
    })
    controller.destroy()
  })

  test("mounts autocomplete between the active title and text or before Add section", () => {
    const { root, controller } = makeController([imageReference()])
    const scene = sectionBody(root, "scene")
    const entry = sectionEntry(root)

    inputText(scene, "Use @")
    const picker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    expect(picker.parentElement?.hasAttribute("data-prompt-react-picker-slot")).toBe(true)

    inputText(entry, "/")
    const entryPicker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    expect(entryPicker.parentElement?.hasAttribute("data-prompt-react-picker-slot")).toBe(true)

    press(entry, "Escape")
    expect(root.querySelector<HTMLElement>("[data-prompt-picker]")?.hidden).toBe(true)
    controller.destroy()
  })

  test("creates and reuses stable # Subjects in the Generic preset", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    inputText(scene, "Meet #woman")
    expect(root.querySelectorAll("[data-prompt-subject-create]")).toHaveLength(1)
    expect(press(scene, "Enter")).toBe(false)
    expect(root.querySelector(".rl-prompt-subject")).toBeNull()

    inputText(sectionEntry(root), "/camera")
    press(sectionEntry(root), "Enter")
    const camera = sectionBody(root, "camera_direction")
    inputText(camera, "Follow #wom")
    expect(root.querySelectorAll("[data-prompt-subject-index]")).toHaveLength(1)
    expect(press(camera, "Enter")).toBe(false)

    const serialized = JSON.parse(controller.serialize())
    expect(serialized.subjects).toHaveLength(1)
    expect(serialized.subjects[0]).toMatchObject({ tag: "woman", parts: [] })
    expect(serialized.sections[0].parts[0]).toMatchObject({
      type: "text",
      text: "Meet #woman ",
    })
    expect(controller.compiledPrompt).toBe(
      "subject_definitions:\n<Subject 1>:\n\nscene:\nMeet <Subject 1>\n\ncamera_direction:\nFollow <Subject 1>",
    )
    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="clear"]')!)
    expect(JSON.parse(controller.serialize()).subjects).toHaveLength(1)
    expect(controller.compiledPrompt).toBe("subject_definitions:\n<Subject 1>:")
    controller.destroy()
  })

  test("does not reopen Subject autocomplete when Backspace reaches a # prefix", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    const currentPicker = (): HTMLElement =>
      root.querySelector<HTMLElement>("[data-prompt-picker]")!

    inputText(scene, "Meet #woman")
    expect(currentPicker().hidden).toBe(false)
    press(scene, "Escape")
    expect(currentPicker().hidden).toBe(true)

    scene.textContent = "Meet #"
    placeCaretAtEnd(scene)
    flushSync(() =>
      scene.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "deleteContentBackward",
          data: null,
        }),
      ),
    )

    expect(currentPicker().hidden).toBe(true)
    expect(document.activeElement).toBe(scene)

    flushSync(() =>
      scene.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: "#" }),
      ),
    )
    expect(currentPicker().hidden).toBe(false)
    controller.destroy()
  })

  test("keeps the caret after a styled tag when trailing whitespace is deleted", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [] }],
      sections: [{ title: "scene", parts: [{ type: "text", text: "Meet #hero " }] }],
    })
    const { root, controller } = makeController([], serialized)
    const scene = sectionBody(root, "scene")
    const tag = scene.querySelector<HTMLElement>("[data-prompt-tag]")!
    scene.lastChild?.remove()
    const selection = getSelection()!
    const range = document.createRange()
    range.setStartAfter(tag)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    scene.focus()

    scene.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
        data: null,
      }),
    )

    expect(document.activeElement).toBe(scene)
    expect(selection.isCollapsed).toBe(true)
    expect(selection.getRangeAt(0).startContainer).toBe(scene)
    expect(selection.getRangeAt(0).startOffset).toBe(scene.childNodes.length)
    controller.destroy()
  })

  test("deletes a styled tag when Backspace is pressed at its right edge", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [] }],
      sections: [{ title: "scene", parts: [{ type: "text", text: "Meet #hero" }] }],
    })
    const { root, controller } = makeController([], serialized)
    const scene = sectionBody(root, "scene")
    const tag = scene.querySelector<HTMLElement>("[data-prompt-tag]")!
    const selection = getSelection()!
    const range = document.createRange()
    range.setStartAfter(tag)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
    scene.focus()

    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    })
    scene.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(scene.querySelector("[data-prompt-tag]")).toBeNull()
    expect(scene.textContent).toBe("Meet ")
    expect(document.activeElement).toBe(scene)
    controller.destroy()
  })

  test("removes a Subject from the picker after its final chip is deleted", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    inputText(scene, "Meet #place")
    press(scene, "Enter")

    inputText(sectionEntry(root), "/camera")
    press(sectionEntry(root), "Enter")
    const camera = sectionBody(root, "camera_direction")
    inputText(camera, "Show #place")
    press(camera, "Enter")
    expect(JSON.parse(controller.serialize()).subjects).toHaveLength(1)

    const renderedScene = sectionBody(root, "scene")
    inputText(renderedScene, "Meet elsewhere")
    expect(JSON.parse(controller.serialize()).subjects).toHaveLength(1)
    inputText(camera, "Show elsewhere")
    expect(JSON.parse(controller.serialize()).subjects).toHaveLength(1)

    inputText(renderedScene, "Search #pla")
    expect(root.querySelector("[data-prompt-subject-index]")).not.toBeNull()
    expect(root.querySelector("[data-prompt-subject-create]")).not.toBeNull()
    controller.destroy()
  })

  test("prunes an already orphaned Subject when restoring saved state", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "orphan", parts: [] }],
      sections: [{ title: "scene", parts: [{ type: "text", text: "No subjects" }] }],
    })
    const { root, controller } = makeController([], serialized)
    expect(JSON.parse(controller.serialize()).subjects).toEqual([{ tag: "orphan", parts: [] }])

    const scene = sectionBody(root, "scene")
    inputText(scene, "Search #orph")
    expect(root.querySelector("[data-prompt-subject-index]")).not.toBeNull()
    expect(root.querySelector("[data-prompt-subject-create]")).not.toBeNull()
    controller.destroy()
  })

  test("reorders Prompt sections by drag or keyboard without reordering Subjects", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [
        { tag: "place", parts: [] },
        { tag: "woman", parts: [] },
      ],
      sections: [
        {
          title: "scene",
          parts: [{ type: "text", text: "#place" }],
        },
        {
          title: "camera_direction",
          parts: [{ type: "text", text: "#woman" }],
        },
      ],
    })
    const { root, controller, transactions } = makeController([], serialized)
    const sceneHandle = root.querySelector<HTMLElement>(
      '[data-prompt-section-drag-handle="scene"]',
    )!
    const cameraCard = root.querySelector<HTMLElement>('[data-prompt-section="camera_direction"]')!
    expect(sceneHandle.dataset.promptSectionDragHandle).toBe("scene")
    let dragStartResult = false
    flushSync(() => {
      dragStartResult = sceneHandle.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true }),
      )
    })
    expect(dragStartResult).toBe(true)
    expect(
      root
        .querySelector<HTMLElement>('[data-prompt-section="scene"]')
        ?.classList.contains("is-dragging"),
    ).toBe(true)
    Object.defineProperty(cameraCard, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100 }),
    })
    const dragover = new DragEvent("dragover", { bubbles: true, cancelable: true })
    Object.defineProperty(dragover, "clientY", { value: 75 })
    flushSync(() => cameraCard.dispatchEvent(dragover))
    expect(cameraCard.classList.contains("is-drop-after")).toBe(true)
    flushSync(() =>
      cameraCard.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true })),
    )

    expect(controller.document.sections.map((section) => section.title)).toEqual([
      "camera_direction",
      "scene",
    ])
    expect(controller.document.subjects.map((subject) => subject.tag)).toEqual(["place", "woman"])
    expect(controller.compiledPrompt).toBe(
      "subject_definitions:\n<Subject 1>:\n\n<Subject 2>:\n\ncamera_direction:\n<Subject 2>\n\nscene:\n<Subject 1>",
    )
    expect(transactions).toEqual(["before", "after"])

    const movedSceneHandle = root.querySelector<HTMLElement>(
      '[data-prompt-section-drag-handle="scene"]',
    )!
    flushSync(() =>
      movedSceneHandle.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          altKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(controller.document.sections.map((section) => section.title)).toEqual([
      "scene",
      "camera_direction",
    ])
    expect(transactions).toEqual(["before", "after", "before", "after"])
    controller.destroy()
  })

  test("creates H3 Reference Subjects only in subject_definitions", () => {
    const { root, controller } = makeController([], undefined, {
      presetId: "minimax_h3_reference",
    })
    const description = sectionBody(root, "detailed_description")
    inputText(description, "Use #hero")
    expect(root.querySelector("[data-prompt-subject-create]")).toBeNull()

    inputText(sectionEntry(root), "/subjects")
    press(sectionEntry(root), "Enter")
    const definitions = sectionBody(root, "subject_definitions")
    inputText(definitions, "#hero")
    expect(root.querySelectorAll("[data-prompt-subject-create]")).toHaveLength(1)
    press(definitions, "Enter")
    expect(JSON.parse(controller.serialize()).subjects[0].tag).toBe("hero")
    controller.destroy()
  })

  test("gives each Subject a stable distinct color", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [
        { tag: "hero", parts: [] },
        { tag: "villain", parts: [] },
      ],
      sections: [
        {
          title: "subject_definitions",
          parts: [{ type: "text", text: "#hero and #villain" }],
        },
      ],
    })
    const { root, controller } = makeController([], serialized, {
      presetId: "minimax_h3_reference",
    })

    const subjects = [...root.querySelectorAll<HTMLElement>('[data-prompt-definition="subject"]')]
    expect(
      subjects.map((subject) => subject.style.getPropertyValue("--rl-prompt-subject-color")),
    ).toEqual(["#5b8fdc", "#8f9cf4"])
    controller.destroy()
  })

  test("highlights defined Subject and Shot tags without capturing unresolved tags", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [] }],
      shots: [{ tag: "entrance", frameIndex: 24, parts: [] }],
      sections: [
        {
          title: "scene",
          parts: [{ type: "text", text: "Use #hero, then #entrance, and keep #typing editable." }],
        },
      ],
    })
    const { root, controller } = makeController([], serialized)
    const scene = sectionBody(root, "scene")
    const tags = [...scene.querySelectorAll<HTMLElement>("[data-prompt-tag]")]

    expect(tags.map((tag) => tag.textContent)).toEqual(["#hero", "#entrance"])
    expect(tags.map((tag) => tag.className)).toEqual([
      "rl-prompt-tag is-subject",
      "rl-prompt-tag is-shot",
    ])
    expect(tags.map((tag) => tag.dataset.promptTagHeader)).toEqual(["S1", "SH1"])
    expect(tags.map((tag) => tag.contentEditable)).toEqual(["false", "false"])
    expect(scene.textContent).toContain("#typing")
    controller.destroy()
  })

  test("renders styled definition identity above the full-width text row", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      subjects: [{ tag: "hero", parts: [{ type: "text", text: "A calm traveler." }] }],
      shots: [
        {
          tag: "entrance",
          frameIndex: 24,
          parts: [{ type: "text", text: "Camera tracks inward." }],
        },
      ],
    })
    const { root, controller } = makeController([], serialized)

    for (const kind of ["subject", "shot"] as const) {
      const card = root.querySelector<HTMLElement>(`[data-prompt-definition="${kind}"]`)
      expect(card?.querySelector(".rl-prompt-definition__toolbar")).not.toBeNull()
      expect(card?.querySelector(".rl-prompt-definition__identity")).not.toBeNull()
      expect(card?.querySelector(".rl-prompt-definition__ordinal")?.textContent).toBe(
        kind === "subject" ? "S1" : "SH1",
      )
      expect(card?.querySelector(".rl-prompt-definition__actions")).not.toBeNull()
      expect(card?.querySelector(".rl-prompt-definition__body")).not.toBeNull()
    }
    const subjectTag = root.querySelector<HTMLInputElement>(
      '[data-prompt-definition="subject"] [data-prompt-definition-tag-input]',
    )!
    expect(subjectTag.size).toBeGreaterThanOrEqual(subjectTag.value.length)
    subjectTag.value = "#a_longer_subject_tag"
    flushSync(() =>
      subjectTag.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })),
    )
    expect(subjectTag.size).toBe(subjectTag.value.length + 1)
    subjectTag.value = "renamed"
    flushSync(() =>
      subjectTag.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })),
    )
    expect(subjectTag.value).toBe("#renamed")
    subjectTag.value = "#re#named##"
    flushSync(() =>
      subjectTag.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })),
    )
    expect(subjectTag.value).toBe("#renamed")
    subjectTag.value = ""
    flushSync(() =>
      subjectTag.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }),
      ),
    )
    expect(subjectTag.value).toBe("#")
    expect(
      root.querySelector('[data-prompt-definition="shot"] .rl-prompt-definition__frame'),
    ).not.toBeNull()
    controller.destroy()
  })

  test("keeps # literal when Subject authoring is disabled", () => {
    const { root, controller } = makeController([], undefined, { presetId: "freeform" })
    const scene = sectionBody(root, "scene")
    inputText(scene, "Keep #literal")
    expect(root.querySelector("[data-prompt-subject-index]")).toBeNull()
    expect(root.querySelector("[data-prompt-subject-create]")).toBeNull()
    expect(controller.compiledPrompt).toBe("scene:\nKeep #literal")
    expect(JSON.parse(controller.serialize()).subjects).toEqual([])
    controller.destroy()
  })

  test("keeps mention ordinals current when references reorder", () => {
    const references = [imageReference()]
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [
        {
          title: "scene",
          parts: [
            {
              type: "mention",
              referenceId: "image-a",
              mediaKind: "image",
              label: "image1",
            },
          ],
        },
      ],
    })
    const { root, controller } = makeController(references, serialized)
    references[0] = imageReference({ ordinal: 2, tag: "<Picture 2>" })
    controller.refreshReferences()
    expect(controller.compiledPrompt).toBe("scene:\n<Picture 2>")
    expect(root.querySelector(".rl-prompt-mention")?.getAttribute("title")).toContain("<Picture 2>")
    controller.destroy()
  })

  test("rebinds mentions to the current ordinal only when order locking is enabled", () => {
    const references = [
      imageReference({
        referenceId: "replacement",
        itemId: "replacement",
        ordinal: 2,
        tag: "<Picture 2>",
        label: "image2",
        filename: "replacement.png",
      }),
    ]
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [
        {
          title: "scene",
          parts: [
            {
              type: "mention",
              referenceId: "original",
              mediaKind: "image",
              label: "image2",
            },
          ],
        },
      ],
    })
    const { root, controller } = makeController(references, serialized)

    controller.refreshReferences()
    expect(controller.compiledPrompt).toBe("scene:\n@image2")
    expect(JSON.parse(controller.serialize()).sections[0].parts[0].referenceId).toBe("original")

    controller.refreshReferences(true)
    expect(controller.compiledPrompt).toBe("scene:\n<Picture 2>")
    expect(JSON.parse(controller.serialize()).sections[0].parts[0]).toMatchObject({
      referenceId: "replacement",
      label: "image2",
    })
    expect(root.querySelector(".rl-prompt-mention")?.classList.contains("is-stale")).toBe(false)
    controller.destroy()
  })

  test("leaves Enter and Shift+Enter to the section editor", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    inputText(scene, "Line one")
    expect(press(scene, "Enter")).toBe(true)
    expect(press(scene, "Enter", { shiftKey: true })).toBe(true)
    expect(press(scene, "#")).toBe(true)
    expect(document.activeElement).toBe(scene)
    controller.destroy()
  })

  test("keeps Prompt paste events away from the ComfyUI canvas handler", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    let canvasPasteCount = 0
    const onCanvasPaste = (): void => {
      canvasPasteCount += 1
    }
    document.addEventListener("paste", onCanvasPaste)

    const structuredPaste = new Event("paste", { bubbles: true, cancelable: true })
    expect(scene.dispatchEvent(structuredPaste)).toBe(true)
    expect(structuredPaste.defaultPrevented).toBe(false)
    expect(canvasPasteCount).toBe(0)

    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!)
    const raw = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    const rawPaste = new Event("paste", { bubbles: true, cancelable: true })
    expect(raw.dispatchEvent(rawPaste)).toBe(true)
    expect(rawPaste.defaultPrevented).toBe(false)
    expect(canvasPasteCount).toBe(0)

    document.removeEventListener("paste", onCanvasPaste)
    controller.destroy()
  })

  test("copies the synchronized compiled Prompt and reports clipboard failures", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    const copied: string[] = []
    try {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value: string) => void copied.push(value) },
      })
      const serialized = serializePromptDocument({
        ...createEmptyPromptDocument(),
        subjects: [{ tag: "place", parts: [] }],
        sections: [
          {
            title: "scene",
            parts: [
              { type: "text", text: "#place" },
              { type: "text", text: " contains " },
              {
                type: "mention",
                referenceId: "image-a",
                mediaKind: "image",
                label: "image1",
              },
            ],
          },
        ],
      })
      const { root, controller } = makeController([imageReference()], serialized)
      const copy = root.querySelector<HTMLButtonElement>('[data-prompt-action="copy-compiled"]')!
      expect(copy.disabled).toBe(false)
      click(copy)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(copied).toEqual([
        "subject_definitions:\n<Subject 1>:\n\nscene:\n<Subject 1> contains <Picture 1>",
      ])
      expect(root.querySelector<HTMLElement>("[data-prompt-hint]")?.textContent).toBe(
        "Prompt copied.",
      )

      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => Promise.reject(new Error("denied")) },
      })
      click(copy)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(root.querySelector<HTMLElement>("[data-prompt-hint]")?.textContent).toBe(
        "Could not access the clipboard.",
      )
      controller.destroy()
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
      else Reflect.deleteProperty(navigator, "clipboard")
    }
  })

  test("disables Copy while Prompt is empty", () => {
    const { root, controller } = makeController()
    expect(
      root.querySelector<HTMLButtonElement>('[data-prompt-action="copy-source"]')?.disabled,
    ).toBe(true)
    controller.destroy()
  })

  test("serializes contenteditable div, paragraph, br, and blank lines", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    const first = document.createTextNode("Line one")
    const second = document.createElement("div")
    second.textContent = "Line two"
    const blank = document.createElement("p")
    blank.append(document.createElement("br"))
    const fourth = document.createElement("div")
    fourth.textContent = "Line four"
    scene.replaceChildren(first, second, blank, fourth)
    scene.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertParagraph" }))

    expect(controller.compiledPrompt).toBe("scene:\nLine one\nLine two\n\nLine four")
    controller.destroy()
  })

  test("serializes native multiline blocks in Raw view", () => {
    const { root, controller } = makeController()
    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!)
    const raw = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    const title = document.createElement("div")
    title.textContent = "scene:"
    const first = document.createElement("div")
    first.textContent = "Line one"
    const second = document.createElement("div")
    second.textContent = "Line two"
    raw.replaceChildren(title, first, second)
    raw.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertParagraph" }))

    expect(controller.compiledPrompt).toBe("scene:\nLine one\nLine two")
    controller.destroy()
  })

  test("keeps the caret on the new line after a native Enter", () => {
    const { root, controller } = makeController(
      [],
      serializePromptDocument({
        ...createEmptyPromptDocument(),
        sections: [{ title: "scene", parts: [{ type: "text", text: "Line one" }] }],
      }),
    )
    const scene = sectionBody(root, "scene")
    const nextLine = document.createElement("div")
    nextLine.append(document.createElement("br"))
    scene.append(nextLine)
    placeCaretAtEnd(nextLine)

    scene.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertParagraph" }))

    const selection = getSelection()!
    expect(selection.isCollapsed).toBe(true)
    expect(selection.anchorNode).toBe(nextLine)
    expect(selection.anchorOffset).toBe(1)
    controller.destroy()
  })

  test("round-trips arbitrary title cards through raw pseudo-YAML", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "overall_soundscape", parts: [{ type: "text", text: "Wind" }] }],
    })
    const { root, controller } = makeController([], serialized)
    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!)
    const raw = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    expect(raw.textContent).toBe("overall_soundscape:\nWind")
    inputText(raw, "overall_soundscape:\nWind and rain\n\ncustom_field:\nValue")
    click(root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!)
    expect(sectionBody(root, "overall_soundscape").textContent).toBe("Wind and rain")
    expect(sectionBody(root, "custom_field").textContent).toBe("Value")
    expect(controller.document.view).toBe("structured")
    controller.destroy()
  })

  test("removes a section card", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "visual_style", parts: [{ type: "text", text: "Soft" }] }],
    })
    const { root, controller } = makeController([], serialized)
    click(
      root.querySelector<HTMLButtonElement>(
        '[data-prompt-action="remove-section"][data-prompt-section-title="visual_style"]',
      )!,
    )
    expect(controller.compiledPrompt).toBe("")
    expect(sectionBody(root, "scene")).toBeTruthy()
    controller.destroy()
  })
})
