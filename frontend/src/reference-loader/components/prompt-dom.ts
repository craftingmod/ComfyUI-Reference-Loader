import {
  scanPromptTags,
  type PromptDocument,
  type PromptMentionPart,
  type PromptReference,
  type PromptSectionPart,
  type PromptSubject,
  type PromptSubjectPart,
} from "../prompt-state.ts"

// Contenteditable primitives: DOM text, atomic tags, selection and visual identity.
// This module does not own document state or ComfyUI lifecycle.
const SECTION_COLOR_PALETTE = [
  "#6ea8fe",
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
const SHOT_COLOR = "#48bf83"

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

export type PromptTagVisual = {
  kind: "subject" | "shot"
  color: string
  header: string
}

type PromptSelectionOffsets = {
  start: number
  end: number
}

function capturePromptSelection(container: HTMLElement): PromptSelectionOffsets | undefined {
  const selection = globalThis.getSelection?.()
  if (!selection?.rangeCount) return undefined
  const range = selection.getRangeAt(0)
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer))
    return undefined
  const offset = (node: Node, position: number): number => {
    const before = document.createRange()
    before.selectNodeContents(container)
    before.setEnd(node, position)
    return before.toString().length
  }
  return {
    start: offset(range.startContainer, range.startOffset),
    end: offset(range.endContainer, range.endOffset),
  }
}

function isPromptAtomicNode(node: Node): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    node.matches("[data-prompt-tag], [data-prompt-part='mention'], [data-prompt-part='subject']")
  )
}

function restorePromptSelection(container: HTMLElement, offsets: PromptSelectionOffsets): void {
  const locate = (target: number): { node: Node; offset: number } => {
    let remaining = target
    const visit = (parent: Node): { node: Node; offset: number } | undefined => {
      const children = Array.from(parent.childNodes)
      for (const [index, child] of children.entries()) {
        if (isPromptAtomicNode(child)) {
          const length = child.textContent?.length ?? 0
          if (remaining < length) return { node: parent, offset: index }
          remaining -= length
          if (remaining === 0) return { node: parent, offset: index + 1 }
          continue
        }
        if (child.nodeType === Node.TEXT_NODE) {
          const length = child.textContent?.length ?? 0
          if (remaining <= length) return { node: child, offset: remaining }
          remaining -= length
          continue
        }
        const point = visit(child)
        if (point) return point
      }
      return remaining === 0 ? { node: parent, offset: children.length } : undefined
    }
    return visit(container) ?? { node: container, offset: container.childNodes.length }
  }
  const start = locate(offsets.start)
  const end = locate(offsets.end)
  const selection = globalThis.getSelection?.()
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function lastPromptNode(node: Node): Node {
  if (isPromptAtomicNode(node)) return node
  let current = node
  while (current.lastChild) {
    if (isPromptAtomicNode(current.lastChild)) return current.lastChild
    current = current.lastChild
  }
  return current
}

export function previousPromptTagAtCaret(
  root: HTMLElement,
  container: Node,
  offset: number,
): HTMLElement | undefined {
  let current: Node | undefined
  if (container.nodeType === Node.TEXT_NODE) {
    if (offset !== 0) return undefined
    current = container
  } else {
    current = container.childNodes[offset - 1]
    if (current) {
      const candidate = lastPromptNode(current)
      return isPromptAtomicNode(candidate) && candidate.dataset.promptTag ? candidate : undefined
    }
    current = container
  }
  while (current && current !== root) {
    const previous = current.previousSibling
    if (previous) {
      const candidate = lastPromptNode(previous)
      return isPromptAtomicNode(candidate) && candidate.dataset.promptTag ? candidate : undefined
    }
    current = current.parentNode ?? undefined
  }
  return undefined
}

export function placeCaretAfterRemovedNode(parent: Node, index: number): void {
  const next = parent.childNodes[index]
  const previous = parent.childNodes[index - 1]
  const point =
    next?.nodeType === Node.TEXT_NODE
      ? { node: next, offset: 0 }
      : previous?.nodeType === Node.TEXT_NODE
        ? { node: previous, offset: previous.textContent?.length ?? 0 }
        : (() => {
            const text = document.createTextNode("")
            parent.insertBefore(text, next ?? null)
            return { node: text, offset: 0 }
          })()
  const selection = globalThis.getSelection?.()
  const range = document.createRange()
  range.setStart(point.node, point.offset)
  range.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

export function appendPromptText(
  container: HTMLElement | DocumentFragment,
  value: string,
  visuals: ReadonlyMap<string, PromptTagVisual>,
): void {
  const tokens = scanPromptTags(value)
  if (tokens.length === 0) {
    container.append(document.createTextNode(value))
    return
  }
  let cursor = 0
  for (const token of tokens) {
    if (token.start > cursor)
      container.append(document.createTextNode(value.slice(cursor, token.start)))
    const visual = token.escaped ? undefined : visuals.get(token.tag)
    if (!visual) {
      container.append(document.createTextNode(value.slice(token.start, token.end)))
      cursor = token.end
      continue
    }
    const tag = document.createElement("span")
    tag.className = `rl-prompt-tag is-${visual.kind}`
    tag.dataset.promptTag = token.tag
    tag.dataset.promptTagHeader = visual.header
    tag.contentEditable = "false"
    tag.style.setProperty("--rl-prompt-tag-color", visual.color)
    tag.setAttribute("aria-label", `${visual.header} #${token.tag}`)
    tag.title = `${visual.kind === "subject" ? "Subject" : "Shot"} ${visual.header} #${token.tag}`
    tag.textContent = value.slice(token.start, token.end)
    container.append(tag)
    cursor = token.end
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)))
}

export function highlightPromptTags(
  container: HTMLElement,
  visuals: ReadonlyMap<string, PromptTagVisual>,
): void {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (
      parent?.closest(
        "[data-prompt-tag], [data-prompt-part='mention'], [data-prompt-part='subject']",
      )
    )
      continue
    const tags = scanPromptTags(node.textContent ?? "")
    if (tags.some((tag) => !tag.escaped && visuals.has(tag.tag))) nodes.push(node as Text)
  }
  if (nodes.length === 0) return
  const offsets = capturePromptSelection(container)
  for (const text of nodes) {
    const replacement = document.createDocumentFragment()
    appendPromptText(replacement, text.textContent ?? "", visuals)
    text.replaceWith(replacement)
  }
  if (offsets) restorePromptSelection(container, offsets)
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

export function referenceKey(mediaKind: string, referenceId: string): string {
  return `${mediaKind}:${referenceId}`
}

export function makeReferenceVisual(reference?: PromptReference): HTMLElement {
  if (reference?.previewUrl && reference.mediaKind !== "audio") {
    const image = document.createElement("img")
    image.src = reference.previewUrl
    image.alt = ""
    image.draggable = false
    return image
  }
  const icon = document.createElement("span")
  icon.className = `rl-prompt-reference-icon is-${reference?.mediaKind ?? "missing"}`
  icon.textContent =
    reference?.mediaKind === "image" ? "I" : reference?.mediaKind === "video" ? "V" : "A"
  icon.setAttribute("aria-hidden", "true")
  return icon
}

export function makeMentionChip(
  part: PromptMentionPart,
  reference?: PromptReference,
): HTMLSpanElement {
  const chip = document.createElement("span")
  chip.className = `rl-prompt-mention${reference ? "" : " is-stale"}`
  chip.contentEditable = "false"
  chip.dataset.promptPart = "mention"
  chip.dataset.referenceId = part.referenceId
  chip.dataset.mediaKind = part.mediaKind
  chip.dataset.label = reference?.label ?? part.label
  chip.title = reference
    ? `${reference.tag} · ${reference.filename}`
    : `Unavailable ${part.mediaKind} reference: ${part.label || part.referenceId}`
  chip.append(makeReferenceVisual(reference))
  const label = document.createElement("span")
  label.className = "rl-prompt-mention__label"
  label.textContent = `@${reference?.label ?? (part.label || part.referenceId)}`
  chip.append(label)
  return chip
}

export function makeSubjectChip(
  part: PromptSubjectPart,
  subject: PromptSubject | undefined,
  ordinal: number | undefined,
): HTMLSpanElement {
  const label = (subject?.tag ?? part.label) || part.subjectId
  const chip = document.createElement("span")
  chip.className = `rl-prompt-mention rl-prompt-subject${subject ? "" : " is-stale"}`
  chip.contentEditable = "false"
  chip.dataset.promptPart = "subject"
  chip.dataset.subjectId = part.subjectId
  chip.dataset.label = label
  chip.title = subject ? `<Subject ${ordinal}> · #${label}` : `Unavailable subject: ${label}`
  const color = subjectColor(ordinal)
  if (color) chip.style.setProperty("--rl-prompt-subject-color", color)
  const icon = document.createElement("span")
  icon.className = "rl-prompt-subject-icon"
  icon.textContent = ordinal === undefined ? "S?" : `S${ordinal}`
  icon.setAttribute("aria-hidden", "true")
  const copy = document.createElement("span")
  copy.className = "rl-prompt-mention__label"
  copy.textContent = `#${label}`
  chip.append(icon, copy)
  return chip
}

export function sectionPartsFromContainer(container: Node): PromptSectionPart[] {
  const parts: PromptSectionPart[] = []
  const pushText = (value: string): void => {
    if (!value) return
    const previous = parts.at(-1)
    if (previous?.type === "text") previous.text += value
    else parts.push({ type: "text", text: value })
  }
  const pushStructuralBreak = (): void => {
    if (parts.length === 0) return
    const previous = parts.at(-1)
    if (previous?.type !== "text" || !previous.text.endsWith("\n")) pushText("\n")
  }
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "")
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.dataset.promptTag) {
      pushText(node.textContent ?? "")
      return
    }
    if (node.dataset.promptPart === "mention") {
      const mediaKind = node.dataset.mediaKind
      parts.push({
        type: "mention",
        referenceId: node.dataset.referenceId ?? "missing",
        mediaKind: mediaKind === "video" || mediaKind === "audio" ? mediaKind : "image",
        label: node.dataset.label ?? "reference",
      })
      return
    }
    if (node.dataset.promptPart === "subject") {
      parts.push({
        type: "subject",
        subjectId: node.dataset.subjectId ?? "missing",
        label: node.dataset.label ?? "subject",
      })
      return
    }
    if (node.tagName === "BR") {
      pushText("\n")
      return
    }
    visitChildren(node)
  }
  const visitChildren = (parent: Node): void => {
    const children = Array.from(parent.childNodes)
    children.forEach((child, index) => {
      const block = child instanceof HTMLElement && NATIVE_LINE_BLOCKS.has(child.tagName)
      if (block) pushStructuralBreak()
      visit(child)
      if (block && index < children.length - 1) pushStructuralBreak()
    })
  }
  visitChildren(container)
  return parts
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

export function createPromptTagVisuals(
  prompt: PromptDocument,
): ReadonlyMap<string, PromptTagVisual> {
  const visuals = new Map<string, PromptTagVisual>()
  prompt.subjects.forEach((subject, index) => {
    const tag = subject.tag ?? subject.label ?? subject.subjectId
    if (tag)
      visuals.set(tag, {
        kind: "subject",
        color: subjectColor(index + 1) ?? "#c18cff",
        header: `S${index + 1}`,
      })
  })
  prompt.shots.forEach((shot, index) => {
    visuals.set(shot.tag, { kind: "shot", color: SHOT_COLOR, header: `SH${index + 1}` })
  })
  return visuals
}
