import type { PromptPartV6 } from "../prompt-v6.ts"

export type PromptEditorTargetV6 =
  | { readonly type: "section"; readonly id: string }
  | { readonly type: "definition"; readonly id: string }

export interface PromptBodySnapshot {
  readonly target: PromptEditorTargetV6
  readonly parts: readonly PromptPartV6[]
  readonly revision: number
  readonly epoch: number
}

export interface PromptBodyEdit {
  readonly target: PromptEditorTargetV6
  readonly baseRevision: number
  readonly epoch: number
  readonly parts: readonly PromptPartV6[]
  readonly editId: string
  readonly composing: boolean
}

export type PromptBodyEditResult =
  | { readonly ok: true; readonly revision: number; readonly editId: string }
  | { readonly ok: false; readonly reason: "stale" | "invalid" | "missing-target" }

export interface PromptRichEditorHandle {
  focus(): void
  flushAcceptedModel(): void
  cancelTransientSession(): void
  insertParts(parts: readonly PromptPartV6[], replaceTextLength: number): void
}

export interface PromptBodyTrigger {
  readonly trigger: "@" | "#"
  readonly query: string
  readonly replaceTextLength: number
}
