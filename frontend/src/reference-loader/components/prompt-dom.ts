// Contenteditable primitives: DOM text, atomic tags, selection and visual identity.
// This module does not own document state or ComfyUI lifecycle.
const SECTION_COLOR_PALETTE = [
  "#5b8fdc",
  "#8f9cf4",
  "#aa8ee8",
  "#c787d5",
  "#d482b2",
  "#dc927d",
  "#d8aa66",
  "#c5b96b",
  "#6ebfd3",
  "#64b4bc",
  "#7ba7d7",
  "#9b94c9",
] as const

const NATIVE_LINE_BLOCKS = new Set(["DIV", "P"])
export const SHOT_COLOR = "#2f8f60"

export function sectionColor(title: string): { color: string; index: number } {
  let hash = 0x811c9dc5
  for (let index = 0; index < title.length; index += 1) {
    hash ^= title.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const index = (hash >>> 0) % SECTION_COLOR_PALETTE.length
  return { color: SECTION_COLOR_PALETTE[index], index }
}

export function subjectColor(ordinal: number | undefined): string | undefined {
  return ordinal === undefined
    ? undefined
    : SECTION_COLOR_PALETTE[(ordinal - 1) % SECTION_COLOR_PALETTE.length]
}

export function normalizeDefinitionTagValue(value: string): string {
  return `#${value.replace(/#/gu, "")}`
}

export function normalizeDefinitionTagInput(input: HTMLInputElement): string {
  const value = input.value
  const normalized = normalizeDefinitionTagValue(value)
  if (normalized === value) return value
  const start = input.selectionStart
  const end = input.selectionEnd
  input.value = normalized
  if (start !== null && end !== null) {
    const position = (offset: number): number =>
      1 + value.slice(0, offset).replace(/#/gu, "").length
    input.setSelectionRange(position(start), position(end))
  }
  return normalized
}

export function textContentWithBreaks(container: Node): string {
  let value = ""
  const appendStructuralBreak = (): void => {
    if (value && !value.endsWith("\n")) value += "\n"
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? ""
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.tagName === "BR") {
      value += "\n"
      return
    }
    visitChildren(node)
  }
  const visitChildren = (parent: Node): void => {
    const children = Array.from(parent.childNodes)
    children.forEach((child, index) => {
      const block = child instanceof HTMLElement && NATIVE_LINE_BLOCKS.has(child.tagName)
      if (block) appendStructuralBreak()
      visit(child)
      if (block && index < children.length - 1) appendStructuralBreak()
    })
  }
  visitChildren(container)
  return value
}

export function promptContentFingerprint(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${value.length}:${hash >>> 0}`
}

export function closestPromptBody(
  roots: readonly HTMLElement[],
  node: Node | null,
): HTMLElement | undefined {
  const element = node instanceof HTMLElement ? node : node?.parentElement
  const body = element?.closest<HTMLElement>(
    "[data-prompt-section-body], [data-prompt-definition-body], [data-prompt-editor]",
  )
  return body && roots.some((root) => root.contains(body)) ? body : undefined
}

export function placeCaretAtEnd(element: HTMLElement): void {
  element.focus()
  const selection = globalThis.getSelection?.()
  const range = document.createRange()
  range.selectNodeContents(element)
  range.collapse(false)
  selection?.removeAllRanges()
  selection?.addRange(range)
}
