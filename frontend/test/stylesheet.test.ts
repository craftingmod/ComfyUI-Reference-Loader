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

    expect(css).toContain('.reference-loader.is-file-dragging[data-file-drop-kinds~="image"]')
    expect(css).toContain(".reference-loader.is-file-dragging:not([data-file-drop-target])::after")
    expect(css).toContain('content: "Drop media to add"')
    expect(css).toContain('.rl-grid-add[data-media-kind="image"]::after')
    expect(css).toContain('content: "+"')
    expect(css).toContain("font-size: 24px;")
    expect(css).toContain("line-height: 1;")
    expect(css).toContain('.rl-grid-add[data-media-kind="image"].is-file-drop-target')
    expect(css).toContain("border: 1px dashed var(--rl-accent);")
    expect(css).toContain("background: color-mix(in srgb, var(--rl-accent) 18%, var(--rl-bg));")
    expect(css).not.toContain("background: color-mix(in srgb, var(--rl-panel) 86%, transparent);")
    expect(css).toContain("pointer-events: none")
    const cards = await Bun.file(
      new URL("../src/reference-loader/styles/cards.css", import.meta.url),
    ).text()
    expect(cards).toContain('.rl-card[data-media-kind="image"]::after')
    expect(cards).toContain('content: "⇄ " attr(data-replace-index)')
    expect(cards).toContain("background: color-mix(in srgb, var(--rl-panel) 74%, transparent);")
    expect(cards).toContain(".rl-card.is-file-drop-target")
    expect(cards).toContain("background: color-mix(in srgb, var(--rl-accent) 42%, transparent);")
  })

  it("keeps the single-image loader compact and native-looking", async () => {
    const tokens = await Bun.file(
      new URL("../src/reference-loader/styles/tokens.css", import.meta.url),
    ).text()
    const loader = await Bun.file(
      new URL("../src/reference-loader/styles/loader.css", import.meta.url),
    ).text()
    const compactRule = tokens.match(/\.reference-image-loader\s*\{([^}]*)\}/)?.[1]
    const panelRule = loader.match(/\.rl-single-image-panel\s*\{([^}]*)\}/)?.[1]
    const controlsRule = loader.match(/\.rl-single-image-controls\s*\{([^}]*)\}/)?.[1]
    const cardRule = loader.match(/\.rl-card\.rl-single-image-card\s*\{([^}]*)\}/)?.[1]
    const previewRule = loader.match(/\.rl-single-image-preview\s*\{([^}]*)\}/)?.[1]
    const previewImageRule = loader.match(
      /\.rl-card__media\.rl-single-image-preview\s*>\s*img\s*\{([^}]*)\}/,
    )?.[1]
    const cardPreviewRule = loader.match(
      /\.rl-card__media\.rl-single-image-preview\s*\{([^}]*)\}/,
    )?.[1]

    expect(compactRule).toContain("min-width: 0;")
    expect(compactRule).toContain("width: 100%;")
    expect(compactRule).toContain("max-width: 100%;")
    expect(compactRule).toContain("min-height: 0;")
    expect(panelRule).toContain("grid-template-rows: max-content minmax(0, 1fr);")
    expect(panelRule).toContain("grid-auto-rows: max-content;")
    expect(panelRule).toContain("width: 100%;")
    expect(panelRule).toContain("max-width: 100%;")
    expect(panelRule).toContain("height: 100%;")
    expect(controlsRule).toContain("grid-template-columns: minmax(0, 1fr) max-content;")
    expect(cardRule).toContain("grid-template-rows: minmax(0, 1fr);")
    expect(cardRule).toContain("grid-auto-rows: max-content;")
    expect(previewRule).toContain("aspect-ratio: auto;")
    expect(previewRule).toContain("width: 100%;")
    expect(previewRule).toContain("max-width: 100%;")
    expect(previewRule).toContain("min-width: 0;")
    expect(previewRule).toContain("justify-self: stretch;")
    expect(previewRule).toContain("height: 100%;")
    expect(cardPreviewRule).toContain("aspect-ratio: auto;")
    expect(previewImageRule).toContain("width: 100%;")
    expect(previewImageRule).toContain("height: 100%;")
    expect(previewImageRule).toContain("max-width: 100%;")
    expect(previewImageRule).toContain("max-height: 100%;")
    expect(previewImageRule).toContain("object-fit: contain;")
    expect(loader).toContain(".rl-single-image-panel")
    expect(loader).toContain(".rl-single-image-select")
    expect(loader).toContain(".rl-single-image-edit")
    expect(loader).toContain('.rl-grid-add[data-media-kind="image"]::after')
    expect(loader).toContain(".rl-single-image-preview.is-empty::after")
  })

  it("keeps the H3 add row compact and aligns editor actions to the bottom", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/h3-timeline.css", import.meta.url),
    ).text()
    const addFormRule = css.match(/\.rl-h3-editor__add-form\s*\{([^}]*)\}/)?.[1]
    const positionRule = css.match(/\.rl-h3-editor__position-field\s*\{([^}]*)\}/)?.[1]
    const frameInputRule = css.match(
      /\.rl-h3-editor__frame-field input\[type="number"\]\s*\{([^}]*)\}/,
    )?.[1]
    const addControlRule = css.match(
      /\.rl-h3-editor__add-form select,\s*\.rl-h3-editor__add-form input\[type="number"\]\s*\{([^}]*)\}/,
    )?.[1]
    const actionRule = css.match(/\.rl-h3-editor__actions\s*\{([^}]*)\}/)?.[1]
    const footerRule = css.match(/\.rl-h3-editor__footer\s*\{([^}]*)\}/)?.[1]

    expect(addFormRule).toContain("min-height: 26px;")
    expect(addFormRule).toContain("display: grid;")
    expect(addFormRule).toContain("grid-template-columns: max-content max-content minmax(0, 1fr);")
    expect(positionRule).not.toContain("flex:")
    expect(positionRule).toContain("border-right: 1px solid var(--rl-border);")
    expect(addControlRule).toContain("min-height: 26px;")
    expect(frameInputRule).toContain("max-width: 50px;")
    expect(frameInputRule).toContain("flex: 0 0 50px;")
    expect(actionRule).toContain("justify-content: flex-end;")
    expect(actionRule).toContain("margin-top: auto;")
    expect(footerRule).toContain("container-type: inline-size;")
    expect(css).toContain("@container (max-width: 320px)")
    expect(css).toContain("grid-template-columns: minmax(0, 1fr) auto;")
    expect(css).toContain("grid-column: 1 / -1;")
  })

  it("lets the Guide editor grow vertically with its stack", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/h3-timeline.css", import.meta.url),
    ).text()
    const cardRule = css.match(/\.rl-card--h3-editor\s*\{([^}]*)\}/)?.[1]
    const stackRule = css.match(/\.rl-h3-editor--stack\s*\{([^}]*)\}/)?.[1]
    const placementsRule = css.match(/\.rl-h3-editor__placements\s*\{([^}]*)\}/)?.[1]
    const bodyRule = css.match(/\.rl-card--h3-editor > \.rl-card__body\s*\{([^}]*)\}/)?.[1]

    expect(cardRule).toContain("display: flex;")
    expect(cardRule).toContain("flex-direction: column;")
    expect(cardRule).toContain("overflow: visible;")
    expect(stackRule).toContain("flex: 0 0 auto;")
    expect(stackRule).toContain("overflow: visible;")
    expect(placementsRule).toContain("overflow: visible;")
    expect(placementsRule).not.toContain("overflow-y: auto;")
    expect(bodyRule).toContain("margin-top: auto;")
    expect(css).not.toContain(".rl-h3-editor__stack-header")
  })

  afterEach(() => {
    document.getElementById(STYLESHEET_ID)?.remove()
  })

  it("loads the CSS bundle next to the extension module exactly once", () => {
    const moduleUrl = "https://example.test/extensions/comfyui-reference-loader/index.js"
    const stale = document.createElement("link")
    stale.id = STYLESHEET_ID
    stale.rel = "stylesheet"
    stale.href = "https://example.test/extensions/comfyui-reference-loader/index.css"
    document.head.append(stale)

    const first = installStylesheet(moduleUrl)
    const second = installStylesheet(moduleUrl)

    expect(first).toBe(second)
    expect(first.rel).toBe("stylesheet")
    expect(first.href).toBe(
      "https://example.test/extensions/comfyui-reference-loader/index.css?v=11",
    )
    expect(document.querySelectorAll(`#${STYLESHEET_ID}`)).toHaveLength(1)
  })

  it("aligns image and audio prompt mentions independently of their child baseline", async () => {
    const css = await Bun.file(
      new URL("../src/reference-loader/styles/prompt.css", import.meta.url),
    ).text()
    const mentionRule = css.match(/\.rl-prompt-mention\s*\{([^}]*)\}/)?.[1]

    expect(mentionRule).toContain("vertical-align: middle;")
    expect(mentionRule).toContain("margin: 1px 2px;")
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
