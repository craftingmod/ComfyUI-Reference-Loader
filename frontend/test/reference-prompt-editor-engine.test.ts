import { describe, expect, test } from "bun:test"

import type {
  PromptEditorTargetV6,
  PromptRichEditorHandle,
} from "../src/reference-loader/components/prompt-editor-contract.ts"
import { PromptEditorEngine } from "../src/reference-loader/prompt-editor-engine.ts"

const target: PromptEditorTargetV6 = { type: "section", id: "scene" }

describe("PromptEditorEngine", () => {
  test("registers body handles and flushes the current editor set", () => {
    const engine = new PromptEditorEngine()
    let flushes = 0
    const handle: PromptRichEditorHandle = {
      focus: () => undefined,
      flushAcceptedModel: () => {
        flushes += 1
      },
      cancelTransientSession: () => undefined,
      insertParts: () => undefined,
    }

    const release = engine.registerBodyEditor(target, handle)
    expect(engine.getBodyEditor(target)).toBe(handle)
    engine.flushAcceptedModels()
    expect(flushes).toBe(1)

    release()
    expect(engine.getBodyEditor(target)).toBeUndefined()
    engine.flushAcceptedModels()
    expect(flushes).toBe(1)
    engine.destroy()
  })

  test("keeps editor undo local and delegates other keys to the picker", () => {
    const engine = new PromptEditorEngine()
    const host = document.createElement("div")
    const editor = document.createElement("div")
    editor.dataset.promptReactEditor = ""
    host.append(editor)
    document.body.append(host)
    let propagated = 0
    let pickerKeys = 0
    host.addEventListener("keydown", () => {
      propagated += 1
    })
    editor.addEventListener("keydown", (event) =>
      engine.handleKeydown(event, () => {
        pickerKeys += 1
      }),
    )

    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(propagated).toBe(0)
    expect(pickerKeys).toBe(0)

    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    expect(pickerKeys).toBe(1)
    engine.handlePaste(new ClipboardEvent("paste", { bubbles: true }))
    engine.destroy()
    host.remove()
  })
})
