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

import { Button } from "../ui/button.tsx"
import { normalizeDefinitionTagInput, subjectColor } from "./prompt-dom.ts"
import {
  type PromptDefinitionKind,
  type PromptDefinitionSnapshot,
  type PromptDefinitionsSnapshot,
  type ReferencePromptController,
} from "./prompt-editor.ts"
import {
  createPromptReactActions,
  PromptEditor,
  type PromptEditorActions,
  type PromptReactCommandPort,
} from "./prompt-react.tsx"

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
  editShotGuides(tag: string): void
}

export interface PromptDefinitionsReactOptions {
  container: HTMLElement
  controller: ReferencePromptController
  onEditShotGuides?: (tag: string) => void
}

export interface PromptDefinitionsReactMount {
  destroy(): void
}

export type PromptDefinitionsCommandPort = PromptReactCommandPort &
  Pick<
    ReferencePromptController,
    | "addDefinition"
    | "renameDefinition"
    | "reorderDefinition"
    | "startDefinitionDrag"
    | "definitionDragOver"
    | "dropDefinition"
    | "endDefinitionDrag"
    | "removeDefinition"
    | "setShotFrameByIdentity"
  >

export function createPromptDefinitionsReactActions(
  controller: PromptDefinitionsCommandPort,
  onEditShotGuides?: (tag: string) => void,
): PromptDefinitionsReactActions {
  return {
    ...createPromptReactActions(controller),
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
    editShotGuides: (tag) => onEditShotGuides?.(tag),
  }
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
  const tagInput = useRef<HTMLInputElement>(null)
  const commitTag = (value = tagValue): void => {
    actions.renameDefinition(definition.kind, definition.identity, value)
  }
  const updateTagValue = (input: HTMLInputElement): void => {
    setTagValue(normalizeDefinitionTagInput(input))
  }
  const target = {
    type: "definition" as const,
    kind: definition.kind,
    identity: definition.identity,
  }
  const subjectAccent =
    definition.kind === "subject" ? subjectColor(definition.identity) : undefined

  useLayoutEffect(() => {
    if (document.activeElement !== tagInput.current) setTagValue(`#${definition.tag}`)
  }, [definition.tag])

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
        <Button
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
        </Button>
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
              <Button
                type="button"
                className="rl-prompt-definition__frame rl-button--guide-edit rl-edit-button rl-edit-button--guide"
                data-prompt-action="edit-shot-guides"
                data-prompt-definition-kind="shot"
                data-prompt-definition-identity={definition.identity}
                data-prompt-definition-tag={definition.tag}
                aria-label={`Edit Guides at Shot #${definition.tag}`}
                title={`Edit Guides at Shot #${definition.tag} · ${definition.frameIndex}f`}
                disabled={draft}
                onClick={(event) => {
                  event.stopPropagation()
                  actions.editShotGuides(definition.tag)
                }}
              >
                <span aria-hidden="true">G</span>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
                  <path d="m13.5 6.5 4 4" />
                </svg>
              </Button>
              <small data-prompt-shot-seconds="">
                {definition.frameIndex}f · {((definition.frameIndex ?? 0) / 24).toFixed(3)}s
              </small>
            </>
          ) : null}
        </div>
        <div className="rl-prompt-definition__actions">
          <Button
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
          </Button>
          <Button
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
          </Button>
          <Button
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
          </Button>
        </div>
      </header>
      <PromptEditor
        actions={actions}
        target={target}
        placeholder={definition.placeholder}
        helperText={definition.bodySnapshot.parts.length === 0 ? definition.placeholder : undefined}
        bodySnapshot={definition.bodySnapshot}
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
          <Button
            type="button"
            data-prompt-action="add-subject"
            disabled={snapshot.draft}
            onClick={() => actions.addDefinition("subject")}
          >
            + Subject
          </Button>
          <Button
            type="button"
            data-prompt-action="add-shot"
            disabled={snapshot.draft}
            onClick={() => actions.addDefinition("shot")}
          >
            + Shot
          </Button>
        </div>
      </header>
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

export class PromptDefinitionsReactBridge implements PromptDefinitionsReactMount {
  readonly #container: HTMLElement
  readonly #controller: ReferencePromptController
  readonly #root: Root
  readonly #actions: PromptDefinitionsReactActions
  #destroyed = false

  constructor(options: PromptDefinitionsReactOptions) {
    this.#container = options.container
    this.#controller = options.controller
    this.#actions = createPromptDefinitionsReactActions(
      options.controller,
      options.onEditShotGuides,
    )
    this.#root = createRoot(this.#container)
    this.update()
  }

  update(): void {
    if (this.#destroyed) return
    flushSync(() =>
      this.#root.render(
        <PromptDefinitionsReactRoot controller={this.#controller} actions={this.#actions} />,
      ),
    )
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.#root.unmount()
    this.#container.replaceChildren()
  }
}

export function createPromptDefinitionsReact(
  options: PromptDefinitionsReactOptions,
): PromptDefinitionsReactMount {
  return new PromptDefinitionsReactBridge(options)
}
