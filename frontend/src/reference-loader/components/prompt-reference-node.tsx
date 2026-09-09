import {
  DecoratorNode,
  type EditorConfig,
  type LexicalEditor,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical"
import type { ReactNode } from "react"

import type { PromptPartV6 } from "../prompt-v6.ts"

export const PROMPT_REFERENCE_NODE_TYPE = "reference-loader-prompt-reference"

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

function PromptReferenceChip({ part, label }: { part: PromptPartV6; label?: string }): ReactNode {
  const text = displayText(part, label)
  const kind =
    part.type === "definition-ref"
      ? "definition-ref"
      : part.type === "mention"
        ? part.mediaKind
        : "text"
  return (
    <span
      className={`rl-prompt-mention rl-prompt-lexical-reference is-${kind}`}
      data-prompt-part={part.type}
      data-definition-id={part.type === "definition-ref" ? part.definitionId : undefined}
      data-reference-id={part.type === "mention" ? part.referenceId : undefined}
      data-media-kind={part.type === "mention" ? part.mediaKind : undefined}
      data-label={part.type === "mention" ? part.label : undefined}
      contentEditable={false}
      role="button"
      tabIndex={-1}
    >
      {text}
    </span>
  )
}

export class PromptReferenceNode extends DecoratorNode<ReactNode> {
  __part: PromptPartV6
  __label: string | undefined

  static getType(): string {
    return PROMPT_REFERENCE_NODE_TYPE
  }

  static clone(node: PromptReferenceNode): PromptReferenceNode {
    return new PromptReferenceNode(node.__part, node.__label, node.__key)
  }

  static importJSON(
    serialized: SerializedLexicalNode & Record<string, unknown>,
  ): PromptReferenceNode {
    return new PromptReferenceNode(serialized.part as PromptPartV6)
  }

  constructor(part: PromptPartV6, label?: string, key?: NodeKey) {
    super(key)
    this.__part = part
    this.__label = label
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
    return <PromptReferenceChip part={this.__part} label={this.__label} />
  }

  isInline(): boolean {
    return true
  }

  isKeyboardSelectable(): boolean {
    return true
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
}

export function $createPromptReferenceNode(
  part: PromptPartV6,
  label?: string,
): PromptReferenceNode {
  return new PromptReferenceNode(part, label)
}

export function $isPromptReferenceNode(node: unknown): node is PromptReferenceNode {
  return node instanceof PromptReferenceNode
}
