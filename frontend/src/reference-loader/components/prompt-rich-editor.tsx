import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer"
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext"
import { ContentEditable } from "@lexical/react/LexicalContentEditable"
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary"
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin"
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin"
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  COPY_COMMAND,
  CLEAR_HISTORY_COMMAND,
  CUT_TAG,
  CUT_COMMAND,
  HISTORY_PUSH_TAG,
  KEY_DOWN_COMMAND,
  PASTE_TAG,
  PASTE_COMMAND,
  type LexicalNode,
} from "lexical"
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react"

import type { PromptPartV6 } from "../prompt-v6.ts"
import { isPromptPartV6, normalizePromptPartsV6, promptPartsV6Equal } from "../prompt-v6.ts"
import type {
  PromptBodyEdit,
  PromptBodyEditResult,
  PromptBodySnapshot,
  PromptRichEditorHandle,
} from "./prompt-editor-contract.ts"
import type { PromptBodyTrigger } from "./prompt-editor-contract.ts"
import {
  $createPromptReferenceNode,
  $isPromptReferenceNode,
  PromptReferenceNode,
  type PromptReferenceVisual,
} from "./prompt-reference-node.tsx"

const INTERNAL_CLIPBOARD_TYPE = "application/x-reference-loader-prompt-parts+json"

export interface PromptRichEditorProps {
  value: PromptBodySnapshot
  onChange(edit: PromptBodyEdit): PromptBodyEditResult
  readOnly?: boolean
  ariaLabel: string
  placeholder?: string
  className?: string
  dataAttributes?: Record<string, string | undefined>
  resolveLabel?(part: PromptPartV6): string | undefined
  resolveVisual?(part: PromptPartV6): PromptReferenceVisual | undefined
  sessionScope: string
  validateParts?(parts: readonly PromptPartV6[]): boolean
  parseText?(value: string): readonly PromptPartV6[]
  onReady?(handle: PromptRichEditorHandle | undefined): void
  onTriggerChange?(trigger: PromptBodyTrigger | undefined): void
  onKeyDown?(event: KeyboardEvent): void
  onPaste?(event: ClipboardEvent): void
  onBlur?(): void
}

function appendTextPart(parts: PromptPartV6[], text: string): void {
  if (!text) return
  const previous = parts.at(-1)
  if (previous?.type === "text") previous.text += text
  else parts.push({ type: "text", text })
}

function readNodeParts(node: LexicalNode, parts: PromptPartV6[]): void {
  if ($isTextNode(node)) {
    appendTextPart(parts, node.getTextContent())
    return
  }
  if ($isLineBreakNode(node)) {
    appendTextPart(parts, "\n")
    return
  }
  if ($isPromptReferenceNode(node)) {
    parts.push({ ...node.getPart() })
    return
  }
  if ($isElementNode(node)) node.getChildren().forEach((child) => readNodeParts(child, parts))
}

export function readPromptEditorParts(): PromptPartV6[] {
  const parts: PromptPartV6[] = []
  const children = $getRoot().getChildren()
  children.forEach((child, index) => {
    if (index > 0) appendTextPart(parts, "\n")
    readNodeParts(child, parts)
  })
  return normalizePromptPartsV6(parts)
}

export function writePromptEditorParts(
  parts: readonly PromptPartV6[],
  resolveLabel?: (part: PromptPartV6) => string | undefined,
  resolveVisual?: (part: PromptPartV6) => PromptReferenceVisual | undefined,
): void {
  const paragraph = $createParagraphNode()
  for (const part of parts) {
    if (part.type === "text") {
      const lines = part.text.split(/(\r?\n)/u)
      for (const line of lines) {
        if (line === "\n" || line === "\r\n") paragraph.append($createLineBreakNode())
        else if (line) paragraph.append($createTextNode(line))
      }
    } else
      paragraph.append(
        $createPromptReferenceNode(part, resolveLabel?.(part), resolveVisual?.(part)),
      )
  }
  $getRoot().clear().append(paragraph)
}

function partsKey(parts: readonly PromptPartV6[]): string {
  return JSON.stringify(parts)
}

function displaySource(
  parts: readonly PromptPartV6[],
  resolveLabel?: (part: PromptPartV6) => string | undefined,
): string {
  return parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "mention"
          ? `@${resolveLabel?.(part) || part.label || part.referenceId}`
          : `#${resolveLabel?.(part) || part.definitionId}`,
    )
    .join("")
}

function clipboardDataFromEvent(
  event: ClipboardEvent | InputEvent | KeyboardEvent | null,
): DataTransfer | null {
  if (!event) return null
  if ("clipboardData" in event) return event.clipboardData
  if ("dataTransfer" in event) return event.dataTransfer
  return null
}

function readPromptBodyTrigger(): PromptBodyTrigger | undefined {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return undefined
  const node = selection.anchor.getNode()
  if (!$isTextNode(node)) return undefined
  const before = node.getTextContent().slice(0, selection.anchor.offset)
  const match = /(^|[^\p{L}\p{N}_-])([@#])([^\s@#]*)$/u.exec(before)
  if (!match) return undefined
  const triggerIndex = (match.index ?? 0) + (match[1]?.length ?? 0)
  if (before[triggerIndex - 1] === "\\") return undefined
  return {
    trigger: match[2] as "@" | "#",
    query: match[3] ?? "",
    replaceTextLength: (match[2]?.length ?? 0) + (match[3]?.length ?? 0),
  }
}

function ClipboardBridge({
  sessionScope,
  readParts,
  resolveLabel,
  resolveVisual,
  validateParts,
  parseText,
}: {
  sessionScope: string
  readParts(): PromptPartV6[]
  resolveLabel?: (part: PromptPartV6) => string | undefined
  resolveVisual?: (part: PromptPartV6) => PromptReferenceVisual | undefined
  validateParts?: (parts: readonly PromptPartV6[]) => boolean
  parseText?: (value: string) => readonly PromptPartV6[]
}): null {
  const [editor] = useLexicalComposerContext()
  const copy = useCallback(
    (event: ClipboardEvent | InputEvent | KeyboardEvent | null, cut: boolean): boolean => {
      const clipboard = clipboardDataFromEvent(event)
      if (!event || !clipboard) return false
      const parts = editor.getEditorState().read(() => readParts())
      clipboard.setData("text/plain", displaySource(parts, resolveLabel))
      clipboard.setData(
        INTERNAL_CLIPBOARD_TYPE,
        JSON.stringify({ version: 1, sessionScope, parts }),
      )
      event.preventDefault()
      if (cut)
        editor.update(
          () => {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) selection.removeText()
          },
          { tag: CUT_TAG },
        )
      return true
    },
    [editor, readParts, resolveLabel, sessionScope],
  )
  const paste = useCallback(
    (event: ClipboardEvent | InputEvent | KeyboardEvent | null): boolean => {
      const clipboard = clipboardDataFromEvent(event)
      if (!event || !clipboard) return false
      const plainText = clipboard.getData("text/plain")
      let parts: PromptPartV6[] | undefined
      try {
        const parsed: unknown = JSON.parse(clipboard.getData(INTERNAL_CLIPBOARD_TYPE))
        if (
          parsed &&
          typeof parsed === "object" &&
          "version" in parsed &&
          parsed.version === 1 &&
          "sessionScope" in parsed &&
          parsed.sessionScope === sessionScope &&
          "parts" in parsed &&
          Array.isArray(parsed.parts) &&
          parsed.parts.every(isPromptPartV6)
        ) {
          const normalized = normalizePromptPartsV6(parsed.parts)
          if (!validateParts || validateParts(normalized)) parts = normalized
        }
      } catch {
        parts = undefined
      }
      event.preventDefault()
      editor.update(
        () => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return
          const pastedParts =
            parts ?? (parseText ? parseText(plainText) : [{ type: "text", text: plainText }])
          const nodes: LexicalNode[] = pastedParts.flatMap<LexicalNode>((part) =>
            part.type === "text"
              ? [$createTextNode(part.text)]
              : [$createPromptReferenceNode(part, resolveLabel?.(part), resolveVisual?.(part))],
          )
          selection.insertNodes(nodes)
        },
        { tag: PASTE_TAG },
      )
      return true
    },
    [editor, parseText, resolveLabel, resolveVisual, sessionScope, validateParts],
  )
  useEffect(() => {
    const unregisterCopy = editor.registerCommand(
      COPY_COMMAND,
      (event) => copy(event, false),
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterCut = editor.registerCommand(
      CUT_COMMAND,
      (event) => copy(event, true),
      COMMAND_PRIORITY_CRITICAL,
    )
    const unregisterPaste = editor.registerCommand(
      PASTE_COMMAND,
      (event) => paste(event),
      COMMAND_PRIORITY_CRITICAL,
    )
    return () => {
      unregisterCopy()
      unregisterCut()
      unregisterPaste()
    }
  }, [copy, editor, paste])
  return null
}

function EditorBridge({
  value,
  onChange,
  readOnly,
  resolveLabel,
  resolveVisual,
  sessionScope,
  validateParts,
  parseText,
  onReady,
  onTriggerChange,
  onKeyDown,
}: PromptRichEditorProps): ReactNode {
  const [editor] = useLexicalComposerContext()
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const resolveLabelRef = useRef(resolveLabel)
  const resolveVisualRef = useRef(resolveVisual)
  const onTriggerChangeRef = useRef(onTriggerChange)
  const onKeyDownRef = useRef(onKeyDown)
  const composingRef = useRef(false)
  const applyingRef = useRef(false)
  const editCounterRef = useRef(0)
  const lastAcceptedKeyRef = useRef(partsKey(value.parts))
  const lastAppliedKeyRef = useRef("")
  const lastEpochRef = useRef(value.epoch)

  valueRef.current = value
  onChangeRef.current = onChange
  resolveLabelRef.current = resolveLabel
  resolveVisualRef.current = resolveVisual
  onTriggerChangeRef.current = onTriggerChange
  onKeyDownRef.current = onKeyDown

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        onKeyDownRef.current?.(event)
        return event.defaultPrevented
      },
      COMMAND_PRIORITY_CRITICAL,
    )
  }, [editor])

  const readParts = useCallback(
    (): PromptPartV6[] => editor.getEditorState().read(readPromptEditorParts),
    [editor],
  )
  const readDisplayKey = useCallback(
    (parts: readonly PromptPartV6[]): string =>
      JSON.stringify(
        parts.map((part) => ({
          part,
          label: resolveLabelRef.current?.(part) ?? "",
          visual: resolveVisualRef.current?.(part) ?? null,
        })),
      ),
    [],
  )

  const submit = useCallback((parts: readonly PromptPartV6[], composing: boolean): void => {
    const normalized = normalizePromptPartsV6(parts)
    const key = partsKey(normalized)
    const current = valueRef.current
    if (key === lastAcceptedKeyRef.current && promptPartsV6Equal(normalized, current.parts)) return
    const edit: PromptBodyEdit = {
      target: current.target,
      baseRevision: current.revision,
      epoch: current.epoch,
      parts: normalized,
      editId: `edit-${++editCounterRef.current}`,
      composing,
    }
    const result = onChangeRef.current(edit)
    if (result.ok) {
      lastAcceptedKeyRef.current = key
      return
    }
    // Stale/invalid edits are never merged into a newer document. The next
    // external snapshot will restore the accepted model through the sync effect.
    lastAcceptedKeyRef.current = partsKey(current.parts)
  }, [])

  useEffect(() => {
    const unregister = editor.registerUpdateListener(({ editorState }) => {
      if (applyingRef.current) return
      const parts = editorState.read(readPromptEditorParts)
      submit(parts, composingRef.current)
      if (!composingRef.current)
        onTriggerChangeRef.current?.(editorState.read(readPromptBodyTrigger))
    })
    return unregister
  }, [editor, submit])

  useEffect(() => {
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  useEffect(() => {
    let needsDisplayUpdate = false
    editor.getEditorState().read(() => {
      const inspectDisplay = (node: LexicalNode): void => {
        if ($isPromptReferenceNode(node)) {
          const nextLabel = resolveLabelRef.current?.(node.getPart())
          const nextVisual = resolveVisualRef.current?.(node.getPart())
          if (
            node.getDisplayLabel() !== nextLabel ||
            JSON.stringify(node.getDisplayVisual()) !== JSON.stringify(nextVisual)
          )
            needsDisplayUpdate = true
        }
        if ($isElementNode(node)) node.getChildren().forEach(inspectDisplay)
      }
      $getRoot().getChildren().forEach(inspectDisplay)
    })
    if (!needsDisplayUpdate) return
    let changed = false
    editor.update(
      () => {
        const updateDisplay = (node: LexicalNode): void => {
          if ($isPromptReferenceNode(node)) {
            const nextLabel = resolveLabelRef.current?.(node.getPart())
            const nextVisual = resolveVisualRef.current?.(node.getPart())
            if (node.getDisplayLabel() !== nextLabel) {
              node.setDisplayLabel(nextLabel)
              changed = true
            }
            if (JSON.stringify(node.getDisplayVisual()) !== JSON.stringify(nextVisual)) {
              node.setDisplayVisual(nextVisual)
              changed = true
            }
          }
          if ($isElementNode(node)) node.getChildren().forEach(updateDisplay)
        }
        $getRoot().getChildren().forEach(updateDisplay)
      },
      { discrete: true },
    )
    if (changed) lastAppliedKeyRef.current = ""
  }, [editor, value])

  useEffect(() => {
    const root = editor.getRootElement()
    if (!root) return
    const start = (): void => {
      composingRef.current = true
    }
    const end = (): void => {
      composingRef.current = false
    }
    root.addEventListener("compositionstart", start)
    root.addEventListener("compositionend", end)
    return () => {
      root.removeEventListener("compositionstart", start)
      root.removeEventListener("compositionend", end)
    }
  }, [editor])

  useEffect(() => {
    const desiredKey = readDisplayKey(value.parts)
    const currentParts = readParts()
    const currentKey = readDisplayKey(currentParts)
    const epochChanged = value.epoch !== lastEpochRef.current
    lastEpochRef.current = value.epoch
    const needsExternalSync = desiredKey !== currentKey
    if (epochChanged || needsExternalSync) {
      // Controller restore/graph rebuild starts a new editing session. Clear
      // Lexical's local history before applying the external document.
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
    }
    if (desiredKey === currentKey) {
      lastAppliedKeyRef.current = desiredKey
      lastAcceptedKeyRef.current = partsKey(currentParts)
      return
    }
    if (desiredKey === lastAppliedKeyRef.current && value.epoch === valueRef.current.epoch) return
    applyingRef.current = true
    try {
      editor.update(
        () => {
          writePromptEditorParts(
            value.parts,
            (part) => resolveLabelRef.current?.(part),
            (part) => resolveVisualRef.current?.(part),
          )
        },
        { discrete: true },
      )
    } finally {
      applyingRef.current = false
    }
    lastAppliedKeyRef.current = desiredKey
    lastAcceptedKeyRef.current = partsKey(value.parts)
  }, [editor, readDisplayKey, readParts, value.epoch, value.revision, value.parts])

  const handle = useMemo<PromptRichEditorHandle>(
    () => ({
      focus: () => editor.focus(),
      flushAcceptedModel: () => {
        editor.update(() => undefined, { discrete: true })
        submit(readParts(), composingRef.current)
      },
      cancelTransientSession: () => {
        composingRef.current = false
      },
      insertParts: (parts, replaceTextLength) => {
        editor.update(
          () => {
            const selection = $getSelection()
            if (!$isRangeSelection(selection)) return
            for (let index = 0; index < replaceTextLength; index += 1)
              selection.modify("extend", true, "character")
            const nodes: LexicalNode[] = parts.flatMap<LexicalNode>((part) =>
              part.type === "text"
                ? [$createTextNode(part.text)]
                : [
                    $createPromptReferenceNode(
                      part,
                      resolveLabelRef.current?.(part),
                      resolveVisualRef.current?.(part),
                    ),
                  ],
            )
            selection.insertNodes(nodes)
          },
          { discrete: true, tag: HISTORY_PUSH_TAG },
        )
      },
    }),
    [editor, readParts, submit],
  )

  useEffect(() => {
    onReady?.(handle)
    return () => onReady?.(undefined)
  }, [handle, onReady])

  return (
    <ClipboardBridge
      sessionScope={sessionScope}
      readParts={readParts}
      resolveLabel={resolveLabelRef.current}
      resolveVisual={resolveVisualRef.current}
      validateParts={validateParts}
      parseText={parseText}
    />
  )
}

export function PromptRichEditor(props: PromptRichEditorProps): ReactNode {
  const initialValueRef = useRef(props.value.parts)
  const initialResolveLabelRef = useRef(props.resolveLabel)
  const initialResolveVisualRef = useRef(props.resolveVisual)
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: `reference-loader-prompt-${props.value.target.type}-${props.value.target.id}`,
      nodes: [PromptReferenceNode],
      editable: true,
      editorState: (editor) => {
        writePromptEditorParts(
          initialValueRef.current,
          initialResolveLabelRef.current,
          initialResolveVisualRef.current,
        )
        editor.setEditable(!props.readOnly)
      },
      onError: (error) => {
        throw error
      },
    }),
    [props.value.target.id, props.value.target.type],
  )
  const dataAttributes = props.dataAttributes ?? {}
  const readOnly = Boolean(props.readOnly)
  return (
    <LexicalComposer initialConfig={initialConfig}>
      <HistoryPlugin delay={1000} />
      <EditorBridge {...props} />
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className={props.className}
            placeholder={<span>{props.placeholder ?? ""}</span>}
            role="textbox"
            aria-multiline="true"
            aria-label={props.ariaLabel}
            aria-placeholder={props.placeholder ?? ""}
            data-prompt-editor=""
            data-prompt-react-editor=""
            data-capture-wheel="true"
            data-placeholder={props.placeholder}
            spellCheck
            {...dataAttributes}
            contentEditable={!readOnly}
            onCompositionStart={() => undefined}
            onCompositionEnd={() => undefined}
            onPaste={(event) => props.onPaste?.(event.nativeEvent)}
            onBlur={() => props.onBlur?.()}
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
    </LexicalComposer>
  )
}

export { INTERNAL_CLIPBOARD_TYPE }
