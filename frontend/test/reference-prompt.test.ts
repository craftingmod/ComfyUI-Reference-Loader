import { afterEach, describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import {
  ReferencePromptController,
  type ReferencePromptControllerOptions,
} from "../src/reference-loader/components/prompt-editor.ts"
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

function makeController(
  references: PromptReference[] = [],
  serialized?: unknown,
  options: ReferencePromptControllerOptions = {},
): { root: HTMLElement; controller: ReferencePromptController; dirty: () => number } {
  const root = document.createElement("div")
  document.body.append(root)
  let dirtyCount = 0
  const node: ComfyNode = {
    addDOMWidget: () => ({ name: "unused", value: null }),
    setDirtyCanvas: () => {
      dirtyCount += 1
    },
  }
  return {
    root,
    controller: new ReferencePromptController(root, node, () => references, serialized, options),
    dirty: () => dirtyCount,
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
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
}

function press(element: HTMLElement, key: string, options: KeyboardEventInit = {}): boolean {
  return element.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }),
  )
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
            { type: "dialogue" as const, text: "안녕하세요" },
          ],
        },
        { title: "visual_style", parts: [{ type: "text" as const, text: "Soft 3D" }] },
      ],
    }
    const serialized = serializePromptDocument(prompt)
    expect(deserializePromptDocument(serialized).document).toEqual(prompt)
    expect(compilePromptDocument(prompt, [imageReference()])).toBe(
      "integrated_multimodal_description:\nLook at <Picture 1><d>안녕하세요</d>\n\nvisual_style:\nSoft 3D",
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

  test("rejects the previous version without migration", () => {
    const result = deserializePromptDocument(
      JSON.stringify({ version: 2, parts: [{ type: "text", text: "legacy" }] }),
    )
    expect(result.document).toEqual(createEmptyPromptDocument())
    expect(result.issues).toEqual(["Prompt state was invalid."])
  })

  test("parses official tags to stable mentions and preserves unknown tags", () => {
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
      { type: "text", text: " and <Video 9>" },
      { type: "dialogue", text: "Hello" },
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
})

describe("Reference Prompt section stack", () => {
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
    expect(sectionEntry(root).dataset.placeholder).toContain("섹션 추가")
    inputText(sectionEntry(root), "/sound")
    expect(root.querySelector("[data-prompt-picker]")?.textContent).toContain("전체 사운드")
    expect(sectionBody(root, "integrated_multimodal_description")).toBeTruthy()
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

  test("leaves Enter and Shift+Enter to the native section editor", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    inputText(scene, "Line one")
    expect(press(scene, "Enter")).toBe(true)
    expect(press(scene, "Enter", { shiftKey: true })).toBe(true)
    expect(document.activeElement).toBe(scene)
    controller.destroy()
  })

  test("serializes native contenteditable div, paragraph, br, and blank lines", () => {
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
    root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!.click()
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

  test("inserts dialogue blocks with # inside a section", () => {
    const { root, controller } = makeController()
    const scene = sectionBody(root, "scene")
    placeCaretAtEnd(scene)
    press(scene, "#")
    const dialogue = root.querySelector<HTMLElement>('[data-prompt-part="dialogue"]')!
    inputText(dialogue, "Stand down")
    expect(press(dialogue, "Enter")).toBe(true)
    expect(controller.compiledPrompt).toBe("scene:\n<d>Stand down</d>")
    controller.destroy()
  })

  test("round-trips arbitrary title cards through raw pseudo-YAML", () => {
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      sections: [{ title: "overall_soundscape", parts: [{ type: "text", text: "Wind" }] }],
    })
    const { root, controller } = makeController([], serialized)
    root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!.click()
    const raw = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    expect(raw.textContent).toBe("overall_soundscape:\nWind")
    inputText(raw, "overall_soundscape:\nWind and rain\n\ncustom_field:\nValue")
    root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')!.click()
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
    root
      .querySelector<HTMLButtonElement>(
        '[data-prompt-action="remove-section"][data-prompt-section-title="visual_style"]',
      )!
      .click()
    expect(controller.compiledPrompt).toBe("")
    expect(sectionBody(root, "scene")).toBeTruthy()
    controller.destroy()
  })
})
