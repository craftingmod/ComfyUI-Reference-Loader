import { afterEach, describe, expect, it } from "bun:test"

import { STYLESHEET_ID, installStylesheet } from "../src/stylesheet.ts"

describe("Reference Loader stylesheet", () => {
  afterEach(() => {
    document.getElementById(STYLESHEET_ID)?.remove()
  })

  it("loads the CSS bundle next to the extension module exactly once", () => {
    const moduleUrl = "https://example.test/extensions/comfyui-reference-loader/index.js"

    const first = installStylesheet(moduleUrl)
    const second = installStylesheet(moduleUrl)

    expect(first).toBe(second)
    expect(first.rel).toBe("stylesheet")
    expect(first.href).toBe("https://example.test/extensions/comfyui-reference-loader/index.css")
    expect(document.querySelectorAll(`#${STYLESHEET_ID}`)).toHaveLength(1)
  })

  it("aligns image and audio prompt mentions independently of their child baseline", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const mentionRule = css.match(/\.rl-prompt-mention\s*\{([^}]*)\}/)?.[1]

    expect(mentionRule).toContain("vertical-align: middle;")
    expect(mentionRule).not.toMatch(/vertical-align:\s*-?\d/)
  })

  it("opens the media picker above the prompt as an overlay", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const pickerRule = css.match(/\.rl-prompt-picker\s*\{([^}]*)\}/)?.[1]

    expect(pickerRule).toContain("position: absolute;")
    expect(pickerRule).toContain("bottom: calc(100% + 6px);")
    expect(pickerRule).toContain("overflow: auto;")
    expect(pickerRule).toContain("overscroll-behavior: contain;")
  })

  it("renders prompt title sections as independent stacked cards", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const stackRule = css.match(/\.rl-prompt-stack\s*\{([^}]*)\}/)?.[1]
    const sectionRule = css.match(/\.rl-prompt-section\s*\{([^}]*)\}/)?.[1]
    const bodyRule = css.match(/\.rl-prompt-section__body\s*\{([^}]*)\}/)?.[1]

    expect(stackRule).toContain("display: grid;")
    expect(sectionRule).toContain("overflow: hidden;")
    expect(bodyRule).toContain("white-space: pre-wrap;")
  })

  it("keeps the Vue Nodes Media row intrinsic and gives spare height to Prompt", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/tokens.css", import.meta.url),
    ).text()
    const gridRule = css.match(/\.rl-reference-loader-widgets\s*\{([^}]*)\}/)?.[1]

    expect(gridRule).toContain("grid-template-rows: max-content minmax(180px, 1fr) !important;")
  })
})
