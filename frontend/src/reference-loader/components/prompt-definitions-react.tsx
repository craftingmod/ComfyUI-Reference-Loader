import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import { normalizeDefinitionTagInput, subjectColor } from "./prompt-dom.ts"
import {
  type PromptDefinitionKind,
  type PromptDefinitionSnapshot,
  type PromptDefinitionsSnapshot,
  type ReferencePromptController,
} from "./prompt-editor.ts"
import { PromptEditor, type PromptEditorActions } from "./prompt-react.tsx"

export interface PromptDefinitionsReactActions extends PromptEditorActions {
  addDefinition(kind: PromptDefinitionKind): void
  renameDefinition(kind: PromptDefinitionKind, identity: string, value: string): void
  reorderDefinition(kind: PromptDefinitionKind, identity: string, delta: -1 | 1): void
  startDefinitionDrag(kind: PromptDefinitionKind, identity: string, event: DragEvent): void
  definitionDragOver(event: DragEvent): void
  dropDefinition(event: DragEvent): void
  endDefinitionDrag(): void
  removeDefinition(kind: PromptDefinitionKind, identity: string): void
  setShotFrame(identity: string, frameIndex: number): void
  applyShotDraft(): void
  cancelShotDraft(): void
  renderDefinitionEditor(kind: PromptDefinitionKind, identity: string, editor: HTMLElement): void
}

export interface PromptDefinitionsReactOptions {
  container: HTMLElement
  controller: ReferencePromptController
}

export interface PromptDefinitionsReactMount {
  destroy(): void
}

function PromptDefinitionCard({
  definition,
  draft,
  actions,
}: {
  definition: PromptDefinitionSnapshot
  draft: boolean
  actions: PromptDefinitionsReactActions
}): ReactNode {
  const [tagValue, setTagValue] = useState(`#${definition.tag}`)
  const [frameValue, setFrameValue] = useState(String(definition.frameIndex ?? 0))
  const tagInput = useRef<HTMLInputElement>(null)
  const frameInput = useRef<HTMLInputElement>(null)
  const commitTag = (value = tagValue): void => {
    actions.renameDefinition(definition.kind, definition.identity, value)
  }
  const commitFrame = (value = frameValue): void => {
    const frame = Number(value)
    if (Number.isSafeInteger(frame) && frame >= 0) actions.setShotFrame(definition.identity, frame)
    else setFrameValue(String(definition.frameIndex ?? 0))
  }
  const updateTagValue = (input: HTMLInputElement): void => {
    setTagValue(normalizeDefinitionTagInput(input))
  }
  const target = {
    type: "definition" as const,
    kind: definition.kind,
    identity: definition.identity,
  }
  const renderContent = useCallback(
    (editor: HTMLElement) =>
      actions.renderDefinitionEditor(definition.kind, definition.identity, editor),
    [actions, definition.identity, definition.kind],
  )
  const subjectAccent = definition.kind === "subject" ? subjectColor(definition.ordinal) : undefined

  useLayoutEffect(() => {
    if (document.activeElement !== tagInput.current) setTagValue(`#${definition.tag}`)
    if (document.activeElement !== frameInput.current)
      setFrameValue(String(definition.frameIndex ?? 0))
  }, [definition.tag, definition.frameIndex])

  return (
    <article
      className={`rl-prompt-definition rl-prompt-definition--${definition.kind}`}
      data-prompt-definition={definition.kind}
      data-prompt-definition-identity={definition.identity}
      data-prompt-definition-tag={definition.tag}
      style={
        subjectAccent
          ? ({ "--rl-prompt-subject-color": subjectAccent } as CSSProperties)
          : undefined
      }
      onDragOver={(event) => actions.definitionDragOver(event.nativeEvent)}
      onDrop={(event) => actions.dropDefinition(event.nativeEvent)}
      onDragEnd={actions.endDefinitionDrag}
    >
      <header className="rl-prompt-definition__toolbar">
        <button
          type="button"
          className="rl-prompt-definition__drag"
          data-prompt-definition-drag-handle=""
          draggable={!draft}
          title={`Reorder ${definition.kind}`}
          aria-label={`Reorder ${definition.kind} ${definition.tag}`}
          onDragStart={(event) =>
            actions.startDefinitionDrag(definition.kind, definition.identity, event.nativeEvent)
          }
        >
          ⠿
        </button>
        <div className="rl-prompt-definition__identity">
          <span className="rl-prompt-definition__ordinal" aria-hidden="true">
            {definition.kind === "subject" ? "S" : "SH"}
            {definition.ordinal}
          </span>
          <input
            ref={tagInput}
            type="text"
            className="rl-prompt-definition__tag"
            value={tagValue}
            size={Math.max(8, tagValue.length + 1)}
            disabled={draft}
            data-prompt-definition-tag-input=""
            aria-label={`${definition.kind} tag`}
            onInput={(event) => updateTagValue(event.currentTarget)}
            onChange={(event) => {
              updateTagValue(event.currentTarget)
              if (event.nativeEvent.type === "change") commitTag(event.currentTarget.value)
            }}
            onBlur={(event) => {
              updateTagValue(event.currentTarget)
              commitTag(event.currentTarget.value)
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
          />
          {definition.kind === "shot" ? (
            <>
              <input
                ref={frameInput}
                type="number"
                className="rl-prompt-definition__frame"
                min="0"
                step="1"
                value={frameValue}
                disabled={draft}
                data-prompt-shot-frame=""
                aria-label="Shot frame"
                onInput={(event) => setFrameValue(event.currentTarget.value)}
                onChange={(event) => {
                  setFrameValue(event.currentTarget.value)
                  if (event.nativeEvent.type === "change") commitFrame(event.currentTarget.value)
                }}
                onBlur={() => commitFrame()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    event.currentTarget.blur()
                  }
                }}
              />
              <small data-prompt-shot-seconds="">
                {definition.frameIndex}f · {((definition.frameIndex ?? 0) / 24).toFixed(3)}s
              </small>
            </>
          ) : null}
        </div>
        <div className="rl-prompt-definition__actions">
          <button
            type="button"
            data-prompt-action="definition-up"
            data-prompt-definition-kind={definition.kind}
            data-prompt-definition-identity={definition.identity}
            disabled={draft}
            title="Reorder"
            aria-label={`Move ${definition.kind} up`}
            onClick={() => actions.reorderDefinition(definition.kind, definition.identity, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            data-prompt-action="definition-down"
            data-prompt-definition-kind={definition.kind}
            data-prompt-definition-identity={definition.identity}
            disabled={draft}
            title="Reorder"
            aria-label={`Move ${definition.kind} down`}
            onClick={() => actions.reorderDefinition(definition.kind, definition.identity, 1)}
          >
            ↓
          </button>
          <button
            type="button"
            data-prompt-action="remove-definition"
            data-prompt-definition-kind={definition.kind}
            data-prompt-definition-identity={definition.identity}
            disabled={draft}
            title={`Delete ${definition.kind}`}
            aria-label={`Delete ${definition.kind} ${definition.tag}`}
            onClick={() => actions.removeDefinition(definition.kind, definition.identity)}
          >
            ×
          </button>
        </div>
      </header>
      <PromptEditor
        actions={actions}
        target={target}
        contentKey={JSON.stringify(definition.parts)}
        placeholder={definition.placeholder}
        renderContent={renderContent}
        className="rl-prompt-definition__body"
        disabled={draft}
        ariaLabel={`${definition.kind} ${definition.tag} text`}
      />
    </article>
  )
}

export function PromptDefinitionsReactRoot({
  controller,
  actions,
}: {
  controller: ReferencePromptController
  actions: PromptDefinitionsReactActions
}): ReactNode {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => controller.subscribeDefinitions(listener),
    [controller],
  )
  const getSnapshot = useCallback(
    (): PromptDefinitionsSnapshot => controller.getDefinitionsSnapshot(),
    [controller],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return (
    <section
      className="rl-prompt-definitions"
      data-prompt-definitions-react=""
      data-prompt-definitions-mounted={String(snapshot.mounted)}
    >
      <header className="rl-prompt-toolbar">
        <div className="rl-prompt-toolbar__copy">
          <strong>Subjects &amp; Shots</strong>
          <small>Definitions keep #tags; indexes are generated only in compiled output.</small>
        </div>
        <div className="rl-prompt-toolbar__actions">
          <button
            type="button"
            data-prompt-action="add-subject"
            disabled={snapshot.draft}
            onClick={() => actions.addDefinition("subject")}
          >
            + Subject
          </button>
          <button
            type="button"
            data-prompt-action="add-shot"
            disabled={snapshot.draft}
            onClick={() => actions.addDefinition("shot")}
          >
            + Shot
          </button>
        </div>
      </header>
      {snapshot.draft ? (
        <div className="rl-prompt-definitions__draft" role="status">
          <span>Shot timing is unsaved. Apply or Cancel.</span>
          <button
            type="button"
            data-prompt-action="cancel-shot-draft"
            onClick={actions.cancelShotDraft}
          >
            Cancel
          </button>
          <button
            type="button"
            data-prompt-action="apply-shot-draft"
            onClick={actions.applyShotDraft}
          >
            Apply
          </button>
        </div>
      ) : null}
      <section className="rl-channel" data-prompt-definition-category="subject">
        <header>
          <div>
            <strong>Subjects</strong>
            <span>{snapshot.subjects.length}</span>
          </div>
        </header>
        <div className="rl-prompt-definition-stack">
          {snapshot.subjects.map((definition) => (
            <PromptDefinitionCard
              key={definition.identity}
              definition={definition}
              draft={snapshot.draft}
              actions={actions}
            />
          ))}
        </div>
      </section>
      <section className="rl-channel" data-prompt-definition-category="shot">
        <header>
          <div>
            <strong>Shots</strong>
            <span>{snapshot.shots.length}</span>
          </div>
        </header>
        <div className="rl-prompt-definition-stack">
          {snapshot.shots.map((definition) => (
            <PromptDefinitionCard
              key={definition.identity}
              definition={definition}
              draft={snapshot.draft}
              actions={actions}
            />
          ))}
        </div>
      </section>
    </section>
  )
}

export function createPromptDefinitionsReact(
  options: PromptDefinitionsReactOptions,
): PromptDefinitionsReactMount {
  const { controller } = options
  const actions: PromptDefinitionsReactActions = {
    addDefinition: (kind) => controller.addDefinition(kind),
    renameDefinition: (kind, identity, value) => controller.renameDefinition(kind, identity, value),
    reorderDefinition: (kind, identity, delta) =>
      controller.reorderDefinition(kind, identity, delta),
    startDefinitionDrag: (kind, identity, event) =>
      controller.startDefinitionDrag(kind, identity, event),
    definitionDragOver: (event) => controller.definitionDragOver(event),
    dropDefinition: (event) => controller.dropDefinition(event),
    endDefinitionDrag: () => controller.endDefinitionDrag(),
    removeDefinition: (kind, identity) => controller.removeDefinition(kind, identity),
    setShotFrame: (identity, frameIndex) => controller.setShotFrameByIdentity(identity, frameIndex),
    applyShotDraft: () => controller.applyShotDraft(),
    cancelShotDraft: () => controller.cancelShotDraft(),
    handleReactEditorInput: (target, editor, input) =>
      controller.handleReactEditorInput(target, editor, input),
    handleReactEditorKeydown: (event) => controller.handleReactEditorKeydown(event),
    handleReactEditorPaste: (event) => controller.handleReactEditorPaste(event),
    handleReactEditorBlur: () => controller.handleReactEditorBlur(),
    renderDefinitionEditor: (kind, identity, editor) =>
      controller.renderReactDefinitionEditor(kind, identity, editor),
  }
  const root: Root = createRoot(options.container)
  let destroyed = false
  flushSync(() =>
    root.render(<PromptDefinitionsReactRoot controller={controller} actions={actions} />),
  )
  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      root.unmount()
      options.container.replaceChildren()
    },
  }
}
