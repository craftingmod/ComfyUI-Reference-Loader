import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type ReactNode,
} from "react"
import { createPortal, flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"

import { sectionColor, SHOT_COLOR, subjectColor } from "./prompt-dom.ts"
import type {
  PromptBodyEdit,
  PromptBodyEditResult,
  PromptBodySnapshot,
  PromptBodyTrigger,
  PromptEditorTargetV6,
  PromptRichEditorHandle,
} from "./prompt-editor-contract.ts"
import type {
  PromptEditorInput,
  PromptEditorTarget,
  PromptPickerOption,
  PromptPickerSnapshot,
  PromptSectionSnapshot,
  PromptSectionsSnapshot,
  PromptViewSnapshot,
  ReferencePromptController,
} from "./prompt-editor.ts"
import type { PromptReferenceVisual } from "./prompt-reference-node.tsx"
import { PromptRichEditor } from "./prompt-rich-editor.tsx"

export interface PromptEditorActions {
  sessionScope: string
  handleReactEditorInput(
    target: PromptEditorTarget,
    editor: HTMLElement,
    input?: PromptEditorInput,
  ): void
  handleReactEditorKeydown(event: KeyboardEvent): void
  handleReactEditorPaste(event: ClipboardEvent): void
  handleReactEditorBlur(): void
  applyPromptBodyEdit(edit: PromptBodyEdit): PromptBodyEditResult
  registerPromptBodyEditor(
    target: PromptEditorTargetV6,
    handle: PromptRichEditorHandle | undefined,
  ): () => void
  resolvePromptPartLabel(part: PromptBodySnapshot["parts"][number]): string | undefined
  resolvePromptPartVisual(
    part: PromptBodySnapshot["parts"][number],
  ): PromptReferenceVisual | undefined
  handlePromptBodyTrigger(
    target: PromptEditorTargetV6,
    trigger: PromptBodyTrigger | undefined,
  ): void
  validatePromptBodyParts(target: PromptEditorTargetV6, parts: PromptBodySnapshot["parts"]): boolean
  parsePromptBodyText(value: string): PromptBodySnapshot["parts"]
}

export interface PromptReactActions extends PromptEditorActions {
  clear(): void
  toggleView(): void
  copySource(): Promise<void>
  copyCompiled(): Promise<void>
  setPreset(value: unknown): void
  removeSection(title: string): void
  handleReactSectionEntryInput(
    value: string,
    entry: HTMLInputElement,
    input?: PromptEditorInput,
  ): void
  handleReactSectionEntryKeydown(
    value: string,
    entry: HTMLInputElement,
    event: KeyboardEvent,
  ): boolean
  moveSection(title: string, delta: -1 | 1): void
  movePicker(delta: -1 | 1): void
  activatePickerOption(index?: number): void
  closePicker(): void
  startSectionDrag(title: string, event: DragEvent): void
  sectionDragOver(event: DragEvent): void
  dropSection(event: DragEvent): void
  endSectionDrag(): void
  rawDraftText(): string | undefined
  updateRawDraftText(value: string): void
}

export interface PromptReactOptions {
  container: HTMLElement
  controller: ReferencePromptController
}

export interface PromptReactMount {
  destroy(): void
}

function PromptV6Editor({
  actions,
  target,
  snapshot,
  placeholder,
  helperText,
  className,
  disabled,
  ariaLabel,
  sessionScope,
}: {
  actions: PromptEditorActions
  target: PromptEditorTarget
  snapshot: PromptBodySnapshot
  placeholder: string
  helperText?: string
  className: string
  disabled: boolean
  ariaLabel?: string
  sessionScope: string
}): ReactNode {
  const releaseRef = useRef<(() => void) | undefined>(undefined)
  const onReady = useCallback(
    (handle: PromptRichEditorHandle | undefined): void => {
      releaseRef.current?.()
      releaseRef.current = handle
        ? actions.registerPromptBodyEditor(snapshot.target, handle)
        : undefined
    },
    [actions, snapshot.target],
  )
  return (
    <>
      <div data-prompt-react-picker-slot="" />
      <PromptRichEditor
        value={snapshot}
        onChange={actions.applyPromptBodyEdit}
        readOnly={disabled}
        ariaLabel={
          ariaLabel ?? (target.type === "section" ? `${target.title} text` : "Prompt text")
        }
        placeholder={helperText ? undefined : placeholder}
        className={className}
        dataAttributes={{
          "data-prompt-section-body": target.type === "section" ? target.title : undefined,
          "data-prompt-section-title": target.type === "section" ? target.title : undefined,
          "data-prompt-definition-body": target.type === "definition" ? "" : undefined,
          "data-prompt-definition-identity":
            target.type === "definition" ? target.identity : undefined,
        }}
        resolveLabel={actions.resolvePromptPartLabel}
        resolveVisual={actions.resolvePromptPartVisual}
        sessionScope={sessionScope}
        validateParts={(parts) => actions.validatePromptBodyParts(snapshot.target, parts)}
        parseText={actions.parsePromptBodyText}
        onReady={onReady}
        onTriggerChange={(trigger) => actions.handlePromptBodyTrigger(snapshot.target, trigger)}
        onKeyDown={actions.handleReactEditorKeydown}
        onPaste={actions.handleReactEditorPaste}
        onBlur={actions.handleReactEditorBlur}
      />
      {helperText ? (
        <small className="rl-prompt-editor__hint" data-prompt-editor-hint="" role="note">
          {helperText}
        </small>
      ) : null}
    </>
  )
}

function PromptToolbar({
  snapshot,
  actions,
}: {
  snapshot: PromptViewSnapshot
  actions: PromptReactActions
}): ReactNode {
  const raw = snapshot.view === "raw"
  return (
    <header className="rl-prompt-toolbar">
      <div className="rl-prompt-toolbar__copy">
        <span className="rl-prompt-toolbar__title">
          <strong data-prompt-title="">{snapshot.title}</strong>
          <span
            className="rl-prompt-preset"
            data-prompt-preset=""
            title={`Preset: ${snapshot.presetLabel} · ${snapshot.presetDescription}`}
          >
            {snapshot.presetLabel}
          </span>
        </span>
        <small data-prompt-subtitle="">{snapshot.subtitle}</small>
      </div>
      <div className="rl-prompt-toolbar__actions">
        <button
          type="button"
          data-prompt-action="copy-source"
          title="Copy source with #tags"
          disabled={snapshot.sourceText.length === 0}
          onClick={() => void actions.copySource()}
        >
          Copy source
        </button>
        <button
          type="button"
          data-prompt-action="copy-compiled"
          title="Copy compiled model prompt"
          disabled={snapshot.compiledText.length === 0}
          onClick={() => void actions.copyCompiled()}
        >
          Copy compiled
        </button>
        <button
          type="button"
          className="rl-clear"
          data-prompt-action="clear"
          title={snapshot.clearTitle}
          aria-label={snapshot.clearAria}
          disabled={!snapshot.canClear}
          onClick={actions.clear}
        >
          {snapshot.clearLabel}
        </button>
        <button
          type="button"
          data-prompt-action="toggle-view"
          title={raw ? snapshot.backToStructuredTitle : snapshot.showRawTitle}
          aria-label={snapshot.toggleAria}
          aria-pressed={raw}
          onClick={actions.toggleView}
        >
          {raw ? snapshot.structuredLabel : snapshot.rawLabel}
        </button>
      </div>
    </header>
  )
}

function PromptV6RawEditor({
  snapshot,
  actions,
}: {
  snapshot: PromptViewSnapshot
  actions: PromptReactActions
}): ReactNode {
  return (
    <textarea
      className="rl-prompt-editor rl-prompt-editor--plain is-raw"
      data-prompt-editor=""
      data-prompt-react-editor=""
      data-prompt-raw-editor=""
      data-capture-wheel="true"
      data-placeholder={snapshot.rawPlaceholder}
      aria-label="Raw prompt editor"
      aria-multiline="true"
      placeholder={snapshot.rawPlaceholder}
      value={actions.rawDraftText() ?? snapshot.sourceText}
      onChange={(event) => actions.updateRawDraftText(event.currentTarget.value)}
      onBlur={actions.handleReactEditorBlur}
      spellCheck
    />
  )
}

export function PromptEditor({
  actions,
  target,
  placeholder,
  helperText,
  bodySnapshot,
  className = "rl-prompt-editor rl-prompt-editor--plain",
  disabled = false,
  ariaLabel,
}: {
  actions: PromptEditorActions
  target: PromptEditorTarget
  placeholder: string
  helperText?: string
  bodySnapshot: PromptBodySnapshot
  className?: string
  disabled?: boolean
  ariaLabel?: string
}): ReactNode {
  return (
    <PromptV6Editor
      actions={actions}
      target={target}
      snapshot={bodySnapshot}
      placeholder={placeholder}
      helperText={helperText}
      className={className}
      disabled={disabled}
      ariaLabel={ariaLabel}
      sessionScope={actions.sessionScope}
    />
  )
}

function PromptSectionCard({
  section,
  actions,
}: {
  section: PromptSectionSnapshot
  actions: PromptReactActions
}): ReactNode {
  const target: PromptEditorTarget = { type: "section", title: section.title }
  return (
    <section
      className="rl-prompt-section"
      data-prompt-section={section.title}
      data-prompt-section-color-index={section.colorIndex}
      data-prompt-section-virtual={String(section.isVirtual)}
      style={{ "--rl-prompt-section-color": section.color } as CSSProperties}
      onDragStart={(event) => actions.startSectionDrag(section.title, event.nativeEvent)}
      onDragOver={(event) => actions.sectionDragOver(event.nativeEvent)}
      onDrop={(event) => actions.dropSection(event.nativeEvent)}
      onDragEnd={actions.endSectionDrag}
    >
      <header className="rl-prompt-section__header" draggable>
        <button
          type="button"
          className="rl-prompt-section__drag"
          data-prompt-section-drag-handle={section.title}
          draggable
          title={section.dragTitle}
          aria-label={section.dragAria}
          onKeyDown={(event) => {
            if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault()
              actions.moveSection(section.title, event.key === "ArrowUp" ? -1 : 1)
            }
          }}
        >
          ⠿
        </button>
        <code>{section.title}:</code>
        <button
          type="button"
          data-prompt-action="remove-section"
          data-prompt-section-title={section.title}
          draggable={false}
          title={section.removeTitle}
          aria-label={section.removeAria}
          onClick={() => actions.removeSection(section.title)}
        >
          ×
        </button>
      </header>
      <PromptEditor
        actions={actions}
        target={target}
        placeholder={section.placeholder}
        helperText={section.bodySnapshot.parts.length === 0 ? section.placeholder : undefined}
        bodySnapshot={section.bodySnapshot}
      />
    </section>
  )
}

function PromptSectionEntry({
  actions,
  placeholder,
  ariaLabel,
}: {
  actions: PromptReactActions
  placeholder: string
  ariaLabel: string
}): ReactNode {
  const [value, setValue] = useState("")
  const handleInput = (event: FormEvent<HTMLInputElement>): void => {
    const nativeEvent = event.nativeEvent as Event & Partial<PromptEditorInput>
    const input =
      typeof nativeEvent.inputType === "string" || nativeEvent.data !== undefined
        ? nativeEvent
        : undefined
    const nextValue = event.currentTarget.value
    setValue(nextValue)
    actions.handleReactSectionEntryInput(nextValue, event.currentTarget, input)
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (actions.handleReactSectionEntryKeydown(value, event.currentTarget, event.nativeEvent))
      setValue("")
  }
  return (
    <>
      <div data-prompt-react-picker-slot="" />
      <input
        type="text"
        className="rl-prompt-section-entry"
        data-prompt-section-entry=""
        data-capture-wheel="true"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={actions.handleReactEditorBlur}
      />
    </>
  )
}

function PromptPickerOptionView({
  option,
  index,
  active,
  actions,
  counters,
}: {
  option: PromptPickerOption
  index: number
  active: boolean
  actions: PromptReactActions
  counters: { reference: number; subject: number; shot: number; alias: number }
}): ReactNode {
  const data =
    option.kind === "reference"
      ? { "data-prompt-reference-index": String(counters.reference++) }
      : option.kind === "subject"
        ? { "data-prompt-subject-index": String(counters.subject++) }
        : option.kind === "shot"
          ? { "data-prompt-shot-index": String(counters.shot++) }
          : option.kind === "create-subject"
            ? { "data-prompt-subject-create": "" }
            : { "data-prompt-alias-index": String(counters.alias++) }
  if (option.kind === "reference") {
    const reference = option.reference
    return (
      <button
        type="button"
        role="option"
        {...data}
        className={active ? "is-active" : undefined}
        aria-selected={active}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => actions.activatePickerOption(index)}
      >
        {reference.previewUrl && reference.mediaKind !== "audio" ? (
          <img src={reference.previewUrl} alt="" draggable={false} />
        ) : (
          <span className={`rl-prompt-reference-icon is-${reference.mediaKind}`} aria-hidden="true">
            {reference.mediaKind === "image" ? "I" : reference.mediaKind === "video" ? "V" : "A"}
          </span>
        )}
        <span>
          <strong>{`@${reference.label}`}</strong>
          <small>{`${reference.tag} · ${reference.filename}`}</small>
        </span>
      </button>
    )
  }
  if (option.kind === "subject") {
    return (
      <button
        type="button"
        role="option"
        {...data}
        className={active ? "is-active" : undefined}
        aria-selected={active}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => actions.activatePickerOption(index)}
      >
        <span
          className="rl-prompt-subject-icon"
          style={{ background: subjectColor(option.subject.id) }}
        >
          {`S${option.ordinal}`}
        </span>
        <span>
          <strong>{`#${option.subject.tag}`}</strong>
          <small>{`<Subject ${option.ordinal}>`}</small>
        </span>
      </button>
    )
  }
  if (option.kind === "shot") {
    return (
      <button
        type="button"
        role="option"
        {...data}
        className={active ? "is-active" : undefined}
        aria-selected={active}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => actions.activatePickerOption(index)}
      >
        <span className="rl-prompt-subject-icon is-shot" style={{ background: SHOT_COLOR }}>
          {`SH${option.ordinal}`}
        </span>
        <span>
          <strong>{`#${option.shot.tag}`}</strong>
          <small>{`Shot · ${option.shot.frameIndex}f · ${(option.shot.frameIndex / 24).toFixed(3)}s`}</small>
        </span>
      </button>
    )
  }
  if (option.kind === "create-subject") {
    return (
      <button
        type="button"
        role="option"
        {...data}
        className={active ? "is-active" : undefined}
        aria-selected={active}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => actions.activatePickerOption(index)}
      >
        <span className="rl-prompt-subject-icon is-create" aria-hidden="true">
          +S
        </span>
        <span>
          <strong>{option.createLabel}</strong>
          <small>{option.createDetail}</small>
        </span>
      </button>
    )
  }
  const alias = option.alias
  return (
    <button
      type="button"
      role="option"
      {...data}
      className={active ? "is-active" : undefined}
      aria-selected={active}
      onClick={() => actions.activatePickerOption(index)}
    >
      <span
        className={`rl-prompt-directive-icon is-${alias.command}`}
        style={{ background: sectionColor(alias.title).color }}
      >
        {alias.icon}
      </span>
      <span>
        <strong>{`/${alias.command} → ${alias.title}:`}</strong>
        <small>{`${option.label} · ${option.description}`}</small>
      </span>
    </button>
  )
}

function PromptPicker({
  controller,
  actions,
  snapshot,
}: {
  controller: ReferencePromptController
  actions: PromptReactActions
  snapshot: PromptPickerSnapshot
}): ReactNode {
  const elementRef = useRef<HTMLDivElement>(null)
  const setElement = useCallback(
    (element: HTMLDivElement | null): void => {
      elementRef.current = element
      if (element) controller.mountPickerElement(element)
      else controller.unmountPickerElement()
    },
    [controller],
  )
  useLayoutEffect(() => {
    elementRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [snapshot.activeIndex, snapshot.options])
  const counters = { reference: 0, subject: 0, shot: 0, alias: 0 }
  return (
    <div
      ref={setElement}
      className="rl-prompt-picker"
      data-prompt-picker=""
      role="listbox"
      hidden={!snapshot.visible}
      onPointerDown={(event) => event.preventDefault()}
    >
      {snapshot.options.length === 0 ? (
        <p>{snapshot.emptyMessage}</p>
      ) : (
        snapshot.options.map((option, index) => (
          <PromptPickerOptionView
            key={`${option.kind}-${index}`}
            option={option}
            index={index}
            active={index === snapshot.activeIndex}
            actions={actions}
            counters={counters}
          />
        ))
      )}
    </div>
  )
}

function PromptPickerHost({
  controller,
  actions,
}: {
  controller: ReferencePromptController
  actions: PromptReactActions
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null)
  const subscribe = useCallback(
    (listener: () => void): (() => void) => controller.subscribePicker(listener),
    [controller],
  )
  const getSnapshot = useCallback(
    (): PromptPickerSnapshot => controller.getPickerSnapshot(),
    [controller],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const picker = <PromptPicker controller={controller} actions={actions} snapshot={snapshot} />
  const target =
    snapshot.visible && snapshot.target?.isConnected ? snapshot.target : hostRef.current
  return (
    <div data-prompt-picker-host="" ref={hostRef}>
      {target && target !== hostRef.current ? createPortal(picker, target) : picker}
    </div>
  )
}

function PromptWorkspaceHost({
  controller,
  snapshot,
  actions,
  workspaceRef,
}: {
  controller: ReferencePromptController
  snapshot: PromptViewSnapshot
  actions: PromptReactActions
  workspaceRef: Ref<HTMLDivElement>
}): ReactNode {
  const subscribe = useCallback(
    (listener: () => void): (() => void) => controller.subscribeSections(listener),
    [controller],
  )
  const getSnapshot = useCallback(
    (): PromptSectionsSnapshot => controller.getSectionsSnapshot(),
    [controller],
  )
  const sections = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return (
    <div data-prompt-workspace="" ref={workspaceRef}>
      {snapshot.view === "raw" ? (
        <PromptV6RawEditor snapshot={snapshot} actions={actions} />
      ) : (
        <div key="structured" className="rl-prompt-stack" data-prompt-stack="">
          {sections.sections.map((section) => (
            <PromptSectionCard
              key={section.id ?? section.title}
              section={section}
              actions={actions}
            />
          ))}
          <PromptSectionEntry
            actions={actions}
            placeholder={snapshot.sectionEntryPlaceholder}
            ariaLabel={snapshot.sectionEntryAria}
          />
        </div>
      )}
    </div>
  )
}

export function ReferencePromptReactRoot({
  controller,
  actions,
}: {
  controller: ReferencePromptController
  actions: PromptReactActions
}): ReactNode {
  const workspaceRef = useRef<HTMLDivElement>(null)
  const subscribe = (listener: () => void): (() => void) => controller.subscribeView(listener)
  const getSnapshot = (): PromptViewSnapshot => controller.getViewSnapshot()
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useLayoutEffect(() => {
    controller.mountNativeHosts(workspaceRef.current ?? undefined)
    return () => controller.unmountNativeHosts()
  }, [controller])

  return (
    <section
      className="rl-prompt-panel"
      data-prompt-panel=""
      aria-label={snapshot.editorAria}
      data-prompt-workspace-mounted={String(snapshot.nativeHosts.workspace)}
      data-prompt-picker-mounted={String(snapshot.nativeHosts.picker)}
      data-prompt-definitions-mounted={String(snapshot.nativeHosts.definitions)}
    >
      <PromptToolbar snapshot={snapshot} actions={actions} />
      <PromptWorkspaceHost
        controller={controller}
        snapshot={snapshot}
        actions={actions}
        workspaceRef={workspaceRef}
      />
      <PromptPickerHost controller={controller} actions={actions} />
      <p className="rl-prompt-hint" data-prompt-hint="" hidden={!snapshot.hint}>
        {snapshot.hint}
      </p>
    </section>
  )
}

export function createPromptReact(options: PromptReactOptions): PromptReactMount {
  const { controller } = options
  const actions: PromptReactActions = {
    clear: () => controller.clear(),
    toggleView: () => controller.toggleView(),
    copySource: () => controller.copySource(),
    copyCompiled: () => controller.copyCompiled(),
    setPreset: (value) => controller.setPreset(value),
    handleReactEditorInput: (title, editor, input) =>
      controller.handleReactEditorInput(title, editor, input),
    handleReactEditorKeydown: (event) => controller.handleReactEditorKeydown(event),
    handleReactEditorPaste: (event) => controller.handleReactEditorPaste(event),
    handleReactEditorBlur: () => controller.handleReactEditorBlur(),
    applyPromptBodyEdit: (edit) => controller.applyPromptBodyEdit(edit),
    sessionScope: controller.promptSessionScope,
    registerPromptBodyEditor: (target, handle) =>
      controller.registerPromptBodyEditor(target, handle),
    resolvePromptPartLabel: (part) => controller.resolvePromptPartLabel(part),
    resolvePromptPartVisual: (part) => controller.resolvePromptPartVisual(part),
    handlePromptBodyTrigger: (target, trigger) =>
      controller.handlePromptBodyTrigger(target, trigger),
    validatePromptBodyParts: (target, parts) => controller.validatePromptBodyParts(target, parts),
    parsePromptBodyText: (value) => controller.parsePromptBodyText(value),
    rawDraftText: () => controller.rawDraftText,
    updateRawDraftText: (value) => controller.updateRawDraftText(value),
    removeSection: (title) => controller.removeSection(title),
    handleReactSectionEntryInput: (value, entry, input) =>
      controller.handleReactSectionEntryInput(value, entry, input),
    handleReactSectionEntryKeydown: (value, entry, event) =>
      controller.handleReactSectionEntryKeydown(value, entry, event),
    moveSection: (title, delta) => controller.moveSection(title, delta),
    movePicker: (delta) => controller.movePicker(delta),
    activatePickerOption: (index) => controller.activatePickerOption(index),
    closePicker: () => controller.closePicker(),
    startSectionDrag: (title, event) => controller.startSectionDrag(title, event),
    sectionDragOver: (event) => controller.sectionDragOver(event),
    dropSection: (event) => controller.dropSection(event),
    endSectionDrag: () => controller.endSectionDrag(),
  }
  const root: Root = createRoot(options.container)
  let destroyed = false
  const update = (): void => {
    if (destroyed) return
    flushSync(() =>
      root.render(<ReferencePromptReactRoot controller={controller} actions={actions} />),
    )
  }
  update()
  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      root.unmount()
      options.container.replaceChildren()
    },
  }
}

export { PromptToolbar }
