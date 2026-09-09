import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical"
import type { CSSProperties, ReactNode } from "react"

import type { PromptPartV6 } from "../prompt-v6.ts"

export const PROMPT_REFERENCE_NODE_TYPE = "reference-loader-prompt-reference"

export interface PromptReferenceVisual {
  readonly previewUrl?: string
  readonly definitionKind?: "subject" | "shot"
  readonly ordinal?: number
  readonly color?: string
}

export interface SerializedPromptReferenceNode extends SerializedLexicalNode {
  type: typeof PROMPT_REFERENCE_NODE_TYPE
  version: 1
  part: PromptPartV6
}

function displayText(part: PromptPartV6, label?: string): string {
  if (part.type === "definition-ref") return label ? `#${label}` : `#${part.definitionId}`
  if (part.type === "mention") return `@${label || part.label || part.referenceId}`
  return part.text
}

function PromptReferenceChip({
  part,
  label,
  visual,
}: {
  part: PromptPartV6
  label?: string
  visual?: PromptReferenceVisual
}): ReactNode {
  const text = displayText(part, label)
  if (part.type === "definition-ref") {
    const isShot = visual?.definitionKind === "shot"
    const ordinal = visual?.ordinal
    return (
      <span
        className={`rl-prompt-mention rl-prompt-subject${visual ? "" : " is-stale"}`}
        style={
          visual?.color
            ? ({ "--rl-prompt-subject-color": visual.color } as CSSProperties)
            : undefined
        }
        data-prompt-part={part.type}
        data-definition-id={part.definitionId}
        data-definition-kind={visual?.definitionKind}
        data-definition-ordinal={ordinal === undefined ? undefined : String(ordinal)}
        contentEditable={false}
        role="button"
        tabIndex={-1}
      >
        <span className={`rl-prompt-subject-icon${isShot ? " is-shot" : ""}`} aria-hidden="true">
          {isShot ? `SH${ordinal ?? "?"}` : `S${ordinal ?? "?"}`}
        </span>
        <span className="rl-prompt-mention__label">{text}</span>
      </span>
    )
  }
  if (part.type === "text") return <span>{text}</span>
  const referenceAvailable = visual !== undefined
  const preview = visual?.previewUrl && part.mediaKind !== "audio"
  return (
    <span
      className={`rl-prompt-mention rl-prompt-lexical-reference is-${part.mediaKind}${
        referenceAvailable ? "" : " is-stale"
      }`}
      data-prompt-part={part.type}
      data-reference-id={part.referenceId}
      data-media-kind={part.mediaKind}
      data-label={label ?? part.label}
      contentEditable={false}
      role="button"
      tabIndex={-1}
    >
      {preview ? (
        <img src={visual.previewUrl} alt="" draggable={false} />
      ) : (
        <span
          className={`rl-prompt-reference-icon is-${referenceAvailable ? part.mediaKind : "missing"}`}
          aria-hidden="true"
        >
          {part.mediaKind === "image" ? "I" : part.mediaKind === "video" ? "V" : "A"}
        </span>
      )}
      <span className="rl-prompt-mention__label">{text}</span>
    </span>
  )
}

export class PromptReferenceNode extends DecoratorNode<ReactNode> {
  __part: PromptPartV6
  __label: string | undefined
  __visual: PromptReferenceVisual | undefined

  static getType(): string {
    return PROMPT_REFERENCE_NODE_TYPE
  }

  static clone(node: PromptReferenceNode): PromptReferenceNode {
    return new PromptReferenceNode(node.__part, node.__label, node.__visual, node.__key)
  }

  static importJSON(
    serialized: SerializedLexicalNode & Record<string, unknown>,
  ): PromptReferenceNode {
    return new PromptReferenceNode(serialized.part as PromptPartV6)
  }

  constructor(part: PromptPartV6, label?: string, visual?: PromptReferenceVisual, key?: NodeKey) {
    super(key)
    this.__part = part
    this.__label = label
    this.__visual = visual
  }

  exportJSON(): SerializedPromptReferenceNode {
    return {
      type: PROMPT_REFERENCE_NODE_TYPE,
      version: 1,
      part: this.__part,
    }
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const element = document.createElement("span")
    element.className = "rl-prompt-lexical-reference-host"
    element.setAttribute("data-prompt-lexical-reference", "")
    return element
  }

  updateDOM(): false {
    return false
  }

  decorate(): ReactNode {
    return <PromptReferenceChip part={this.__part} label={this.__label} visual={this.__visual} />
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    // Keep arrow-key navigation on the surrounding text caret instead of
    // replacing it with a NodeSelection that has no visible browser caret.
    return false
  }

  isIsolated(): boolean {
    return false
  }

  getPart(): PromptPartV6 {
    return this.__part
  }

  getDisplayLabel(): string | undefined {
    return this.__label
  }

  setDisplayLabel(label: string | undefined): void {
    const writable = this.getWritable()
    writable.__label = label
  }

  getDisplayVisual(): PromptReferenceVisual | undefined {
    return this.__visual
  }

  setDisplayVisual(visual: PromptReferenceVisual | undefined): void {
    const writable = this.getWritable()
    writable.__visual = visual
  }
}

export function $createPromptReferenceNode(
  part: PromptPartV6,
  label?: string,
  visual?: PromptReferenceVisual,
): PromptReferenceNode {
  return new PromptReferenceNode(part, label, visual)
}

export function $isPromptReferenceNode(node: unknown): node is PromptReferenceNode {
  return node instanceof PromptReferenceNode
}
