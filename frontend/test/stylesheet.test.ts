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
})
