import { afterEach, describe, expect, it } from "bun:test"

import { STYLESHEET_ID, installStylesheet } from "../src/stylesheet.ts"

describe("Reference Loader stylesheet", () => {
  it("styles the Media heading like the Prompt heading", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/loader.css", import.meta.url),
    ).text()

    expect(css).toContain(".rl-media-topbar")
    expect(css).toContain("flex-wrap: wrap")
    expect(css).toContain(".rl-media-header")
    expect(css).toContain(".rl-media-header > div")
    expect(css).toContain(".rl-media-header small")
    expect(css).toContain("margin-left: auto")
    expect(css).toContain(".rl-snapshot")
    expect(css).toContain(".rl-snapshot__menu[hidden]")
  })

  it("shows an overlay while external media files are dragged over the loader", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/loader.css", import.meta.url),
    ).text()

    expect(css).toContain(".reference-loader.is-file-dragging::after")
    expect(css).toContain('content: "Drop media to add"')
    expect(css).toContain("pointer-events: none")
  })

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

  it("lays autocomplete out inline at its active DOM anchor", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const pickerRule = css.match(/\.rl-prompt-picker\s*\{([^}]*)\}/)?.[1]

    expect(pickerRule).toContain("position: relative;")
    expect(pickerRule).toContain("width: 100%;")
    expect(pickerRule).toContain("box-sizing: border-box;")
    expect(pickerRule).not.toContain("transform:")
    expect(pickerRule).toContain("overflow: auto;")
    expect(pickerRule).toContain("overscroll-behavior: contain;")
  })

  it("renders prompt title sections as independent stacked cards", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const stackRule = css.match(/\.rl-prompt-stack\s*\{([^}]*)\}/)?.[1]
    const sectionRule = css.match(/\.rl-prompt-section\s*\{([^}]*)\}/)?.[1]
    const headerRule = css.match(/\.rl-prompt-section__header\s*\{([^}]*)\}/)?.[1]
    const bodyRule = css.match(/\.rl-prompt-section__body\s*\{([^}]*)\}/)?.[1]

    expect(stackRule).toContain("display: grid;")
    expect(sectionRule).toContain("overflow: hidden;")
    expect(sectionRule).toContain("--rl-prompt-section-color: var(--rl-accent);")
    expect(sectionRule).toContain("var(--rl-prompt-section-color) 32%")
    expect(headerRule).toContain("var(--rl-prompt-section-color) 10%")
    expect(bodyRule).toContain("white-space: pre-wrap;")
    expect(css).toContain(".rl-prompt-section.is-drop-before")
    expect(css).toContain(".rl-prompt-section.is-drop-after")
    expect(css).toContain("cursor: grab;")
  })

  it("groups Prompt actions and styles its scoped Clear action as destructive", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()

    expect(css).toContain(".rl-prompt-toolbar__actions")
    expect(css).toContain(".reference-prompt button.rl-clear")
  })

  it("keeps the Vue Nodes Media row intrinsic and gives spare height to Prompt", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/tokens.css", import.meta.url),
    ).text()
    const gridRule = css.match(/\.rl-reference-loader-widgets\s*\{([^}]*)\}/)?.[1]

    expect(gridRule).toContain("grid-template-rows: max-content minmax(180px, 1fr) !important;")
  })
})
