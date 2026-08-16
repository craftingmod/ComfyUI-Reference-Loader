import { describe, expect, test } from "bun:test"

import type { ComfyNode } from "../src/comfyui.ts"
import { ReferencePromptController } from "../src/reference-loader/components/prompt-editor.ts"
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

function placeCaretAtEnd(element: HTMLElement): void {
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

describe("Reference Prompt state", () => {
  test("round-trips structured parts and compiles official per-type tags", () => {
    const document = {
      ...createEmptyPromptDocument(),
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
    }
    const serialized = serializePromptDocument(document)
    expect(deserializePromptDocument(serialized).document).toEqual(document)
    expect(compilePromptDocument(document, [imageReference()])).toBe(
      "Look at <Picture 1><d>안녕하세요</d>",
    )
  })

  test("parses raw official tags back to stable mentions and preserves unknown tags", () => {
    const document = parseRawPrompt("Use <Picture 1> and <Video 9><d>Hello</d>", [imageReference()])
    expect(document.parts).toEqual([
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

  test("does not silently rebind an unavailable stable mention", () => {
    const document = {
      ...createEmptyPromptDocument(),
      parts: [
        {
          type: "mention" as const,
          referenceId: "removed",
          mediaKind: "image" as const,
          label: "old-image",
        },
      ],
    }
    expect(compilePromptDocument(document, [imageReference()])).toBe("@old-image")
  })
})

describe("Reference Prompt editor", () => {
  test("opens a thumbnail picker for @ and stores a stable mention", () => {
    const root = document.createElement("div")
    document.body.append(root)
    let dirty = 0
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => {
        dirty += 1
      },
    }
    let references = [imageReference()]
    const controller = new ReferencePromptController(root, node, () => references, undefined)
    const editor = root.querySelector<HTMLElement>("[data-prompt-editor]")
    expect(editor).not.toBeNull()
    editor!.textContent = "Battle @"
    editor!.focus()
    placeCaretAtEnd(editor!)
    editor!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))

    const option = root.querySelector<HTMLButtonElement>("[data-prompt-reference-index='0']")
    expect(root.querySelector("[data-prompt-picker]")?.previousElementSibling).toBe(editor!)
    expect(option?.querySelector<HTMLImageElement>("img")?.src).toContain("/fighter.webp")
    expect(option?.textContent).toContain("@image1")
    expect(option?.textContent).toContain("<Picture 1>")
    option?.click()

    const mention = root.querySelector<HTMLElement>(".rl-prompt-mention")
    expect(mention?.dataset.referenceId).toBe("image-a")
    expect(mention?.querySelector<HTMLImageElement>("img")?.src).toContain("/fighter.webp")
    expect(controller.compiledPrompt).toBe("Battle <Picture 1>")
    expect(JSON.parse(controller.serialize()).parts[1]).toMatchObject({
      type: "mention",
      referenceId: "image-a",
      mediaKind: "image",
    })

    references = [imageReference({ ordinal: 2, tag: "<Picture 2>", label: "image2" })]
    controller.refreshReferences()
    expect(root.querySelector(".rl-prompt-mention")?.textContent).toContain("@image2")
    expect(controller.compiledPrompt).toBe("Battle <Picture 2>")
    expect(dirty).toBeGreaterThan(0)
    controller.destroy()
    root.remove()
  })

  test("scrolls a long media picker with the mouse wheel", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const references = Array.from({ length: 12 }, (_, index) =>
      imageReference({
        referenceId: `image-${index}`,
        itemId: `image-${index}`,
        ordinal: index + 1,
        tag: `<Picture ${index + 1}>`,
        label: `image${index + 1}`,
      }),
    )
    const controller = new ReferencePromptController(root, node, () => references, undefined)
    const editor = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    editor.textContent = "@"
    editor.focus()
    placeCaretAtEnd(editor)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))

    const picker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 })
    picker.querySelector<HTMLElement>("[data-prompt-reference-index]")!.dispatchEvent(wheel)

    expect(wheel.defaultPrevented).toBe(true)
    expect(picker.scrollTop).toBe(80)
    controller.destroy()
    root.remove()
  })

  test("scrolls the media picker when keyboard selection leaves the visible range", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const references = Array.from({ length: 12 }, (_, index) =>
      imageReference({
        referenceId: `keyboard-image-${index}`,
        itemId: `keyboard-image-${index}`,
        ordinal: index + 1,
        tag: `<Picture ${index + 1}>`,
        label: `image${index + 1}`,
      }),
    )
    const controller = new ReferencePromptController(root, node, () => references, undefined)
    const editor = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    editor.textContent = "@"
    editor.focus()
    placeCaretAtEnd(editor)
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    const picker = root.querySelector<HTMLElement>("[data-prompt-picker]")!
    Object.defineProperties(picker, {
      clientHeight: { configurable: true, value: 100 },
    })
    for (const option of picker.querySelectorAll<HTMLElement>("[data-prompt-reference-index]")) {
      const index = Number(option.dataset.promptReferenceIndex)
      Object.defineProperties(option, {
        offsetTop: { configurable: true, value: index * 47 },
        offsetHeight: { configurable: true, value: 44 },
      })
    }

    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))

    expect(picker.querySelector("[aria-selected='true']")?.textContent).toContain("@image12")
    expect(picker.scrollTop).toBeGreaterThan(0)
    controller.destroy()
    root.remove()
  })

  test("switches to literal raw view and parses tags back into structured parts", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const reference = imageReference()
    let references = [reference]
    const serialized = serializePromptDocument({
      ...createEmptyPromptDocument(),
      parts: [
        { type: "text", text: "Use " },
        {
          type: "mention",
          referenceId: reference.referenceId,
          mediaKind: reference.mediaKind,
          label: reference.label,
        },
      ],
    })
    const controller = new ReferencePromptController(root, node, () => references, serialized)
    root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click()
    const raw = root.querySelector<HTMLElement>("[data-prompt-editor]")
    expect(raw?.classList.contains("is-raw")).toBe(true)
    expect(raw?.textContent).toBe("Use <Picture 1>")

    references = [imageReference({ ordinal: 2, tag: "<Picture 2>", label: "image2" })]
    controller.refreshReferences()
    expect(raw?.textContent).toBe("Use <Picture 2>")
    expect(controller.document.parts[1]).toMatchObject({ referenceId: "image-a" })

    raw!.textContent = "Frame <Picture 2><d>Hello</d>"
    raw!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    root.querySelector<HTMLButtonElement>('[data-prompt-action="toggle-view"]')?.click()
    expect(root.querySelector(".rl-prompt-mention")?.textContent).toContain("@image2")
    expect(root.querySelector(".rl-prompt-dialogue")?.textContent).toBe("Hello")
    expect(controller.compiledPrompt).toBe("Frame <Picture 2><d>Hello</d>")
    controller.destroy()
    root.remove()
  })

  test("creates a dialogue block with # and exits it with Enter", () => {
    const root = document.createElement("div")
    document.body.append(root)
    const node: ComfyNode = {
      addDOMWidget: () => ({ name: "unused", value: null }),
      setDirtyCanvas: () => undefined,
    }
    const controller = new ReferencePromptController(root, node, () => [], undefined)
    const editor = root.querySelector<HTMLElement>("[data-prompt-editor]")!
    editor.focus()
    placeCaretAtEnd(editor)
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "#", bubbles: true }))
    const dialogue = root.querySelector<HTMLElement>(".rl-prompt-dialogue")
    expect(dialogue).not.toBeNull()
    dialogue!.textContent = "Stand down"
    placeCaretAtEnd(dialogue!)
    dialogue!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }))
    dialogue!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(controller.compiledPrompt).toBe("<d>Stand down</d>")
    controller.destroy()
    root.remove()
  })
})
