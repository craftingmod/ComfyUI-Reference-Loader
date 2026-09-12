import { useEffect, useId, useRef, useState } from "react"

export type H3GuidePosition = "start" | "guide" | "end"

export interface H3GuideEditorProps {
  sourceLabel: string
  sourcePreviewUrl?: string
  sourceKind?: "image" | "audio"
  channel: "visual" | "audio"
  fps: number
  start: boolean
  end: boolean
  guides: readonly { id: string; frameIndex: number; pairedLabel?: string }[]
  atGuideLimit: boolean
  issue?: string
  addError?: string
  onAdd(position: H3GuidePosition, frame: string): void
  onRemoveRole(role: "start" | "end"): void
  onRemoveGuide(id: string): void
  onInputFrame(id: string, value: string): void
  onCommitFrame(id: string, value: string): void
  onApply(): void
  onCancel(): void
}

function frameInputValue(frameIndex: number): string {
  return Number.isSafeInteger(frameIndex) && frameIndex >= 0 ? String(frameIndex) : ""
}

function parseFrameInput(value: string): number {
  const raw = value.trim()
  if (raw === "") return Number.NaN
  const frameIndex = Number(raw)
  return Number.isSafeInteger(frameIndex) && frameIndex >= 0 ? frameIndex : Number.NaN
}

function GuideFrame({
  guide,
  props,
}: {
  guide: H3GuideEditorProps["guides"][number]
  props: H3GuideEditorProps
}) {
  const descriptionId = useId()
  const externalFrame = frameInputValue(guide.frameIndex)
  const previousExternalFrame = useRef(externalFrame)
  const [frame, setFrame] = useState(externalFrame)
  const committed = useRef(externalFrame)
  useEffect(() => {
    if (externalFrame === previousExternalFrame.current) return
    const previous = parseFrameInput(previousExternalFrame.current)
    const local = parseFrameInput(frame)
    previousExternalFrame.current = externalFrame
    // A draft input updates the controller projection on every keystroke. Only
    // replace the local buffer when it was still showing the previous external
    // value; unrelated runtime/view updates must not erase in-progress text.
    if (local === previous || (Number.isNaN(local) && Number.isNaN(previous))) {
      setFrame(externalFrame)
      committed.current = externalFrame
    }
  }, [externalFrame, frame])
  const validFrame = Number.isSafeInteger(guide.frameIndex) && guide.frameIndex >= 0
  const frameLabel = validFrame ? `${guide.frameIndex} frame` : "this frame"
  const commit = (value: string): void => {
    if (committed.current === value) return
    committed.current = value
    props.onCommitFrame(guide.id, value)
  }
  return (
    <article
      className="rl-h3-editor__placement rl-h3-editor__stack-row"
      data-h3-guide-id={guide.id}
    >
      <div className="rl-h3-editor__placement-heading">
        <label>
          <span>Guide</span>
          <input
            type="number"
            min="0"
            step="1"
            value={frame}
            data-h3-draft-field="frame"
            data-h3-guide-id={guide.id}
            aria-describedby={descriptionId}
            onInput={(event) => {
              const value = event.currentTarget.value
              setFrame(value)
              props.onInputFrame(guide.id, value)
            }}
            ref={(input) => {
              if (!input) return
              const commitEvent = (event: Event): void => {
                event.stopPropagation()
                commit(input.value)
              }
              input.addEventListener("change", commitEvent)
              input.addEventListener("blur", commitEvent)
              return () => {
                input.removeEventListener("change", commitEvent)
                input.removeEventListener("blur", commitEvent)
              }
            }}
          />
        </label>
        <span id={descriptionId} className="rl-h3-editor__seconds">
          {validFrame ? `${(guide.frameIndex / props.fps).toFixed(2)}s` : ""}
        </span>
        <button
          type="button"
          data-h3-action="delete-draft-placement"
          data-h3-guide-id={guide.id}
          aria-label={`Delete ${frameLabel} ${props.channel === "visual" ? "image" : "audio"} connection`}
          title="Delete this connection"
          onClick={() => props.onRemoveGuide(guide.id)}
        >
          ×
        </button>
      </div>
      {guide.pairedLabel && (
        <small className="rl-h3-editor__paired">Also connected: {guide.pairedLabel}</small>
      )}
    </article>
  )
}

function Role({ role, onRemove }: { role: "start" | "end"; onRemove(): void }) {
  const label = role === "start" ? "Start" : "End"
  return (
    <article
      className="rl-h3-editor__placement rl-h3-editor__stack-row rl-h3-editor__role"
      data-h3-role={role}
    >
      <div>
        <strong>{label}</strong>
        <small>{role === "start" ? "frame 0" : "final output frame"}</small>
      </div>
      <button
        type="button"
        data-h3-action="remove-draft-role"
        data-h3-role={role}
        aria-label={`Delete ${label} image connection`}
        title={`Delete ${label} image connection`}
        onClick={onRemove}
      >
        ×
      </button>
    </article>
  )
}

export interface H3GuideInspectorProps {
  props: H3GuideEditorProps
  showActions?: boolean
  positionMode?: "select" | "radio"
}

/** Controlled Guide form for the permanent Media React workspace. */
export function H3GuideInspector({
  props,
  showActions = true,
  positionMode = "select",
}: H3GuideInspectorProps) {
  const [position, setPosition] = useState<H3GuidePosition>("guide")
  const [frame, setFrame] = useState("")
  const frameIndex = frame.trim() === "" ? Number.NaN : Number(frame)
  const showFrame = position === "guide"
  const positionName = `h3-position-${useId()}`
  return (
    <section
      className="rl-h3-editor rl-h3-editor--inspector"
      data-h3-editor=""
      data-h3-inspector=""
      data-h3-react-surface=""
      aria-label={`${props.channel === "visual" ? "Image" : "Audio"} Guide Inspector`}
    >
      <header className="rl-h3-editor__header">
        <span className="rl-h3-editor__source-preview" aria-hidden="true">
          {props.sourcePreviewUrl ? (
            <img src={props.sourcePreviewUrl} alt="" draggable={false} />
          ) : props.sourceKind === "audio" || props.channel === "audio" ? (
            "♫"
          ) : (
            "▧"
          )}
        </span>
        <strong className="rl-h3-editor__title" title={props.sourceLabel}>
          {props.sourceLabel}
        </strong>
        <span className="rl-h3-editor__channel">
          {props.channel === "visual" ? "Image" : "Audio"}
        </span>
      </header>
      <p className="rl-h3-editor__hint">
        {props.channel === "visual"
          ? "Use this Image at Start, a specific frame, or End."
          : "Place this standalone Audio at a specific frame."}
      </p>
      <div className="rl-h3-editor__stack" data-h3-placement-list="">
        <div className="rl-h3-editor__placements">
          {props.start && <Role role="start" onRemove={() => props.onRemoveRole("start")} />}
          {props.guides.map((guide) => (
            <GuideFrame key={guide.id} guide={guide} props={props} />
          ))}
          {props.end && <Role role="end" onRemove={() => props.onRemoveRole("end")} />}
          {!props.start && !props.end && props.guides.length === 0 && (
            <p className="rl-h3-editor__empty">No placements yet.</p>
          )}
        </div>
      </div>
      <div className="rl-h3-editor__add-form" data-h3-add-form="">
        {positionMode === "radio" ? (
          <fieldset className="rl-h3-editor__position-field" aria-label="Guide position">
            <legend>Position</legend>
            {props.channel === "visual" && (
              <label>
                <input
                  type="radio"
                  name={positionName}
                  value="start"
                  data-h3-add-field="position"
                  checked={position === "start"}
                  onChange={() => setPosition("start")}
                />
                Start
              </label>
            )}
            <label>
              <input
                type="radio"
                name={positionName}
                value="guide"
                data-h3-add-field="position"
                checked={position === "guide"}
                disabled={props.atGuideLimit}
                onChange={() => setPosition("guide")}
              />
              Frame
            </label>
            {props.channel === "visual" && (
              <label>
                <input
                  type="radio"
                  name={positionName}
                  value="end"
                  data-h3-add-field="position"
                  checked={position === "end"}
                  onChange={() => setPosition("end")}
                />
                End
              </label>
            )}
          </fieldset>
        ) : (
          <label className="rl-h3-editor__position-field">
            <span>Position</span>
            <select
              data-h3-add-field="position"
              value={position}
              onChange={(event) => setPosition(event.currentTarget.value as H3GuidePosition)}
            >
              {props.channel === "visual" && <option value="start">Start</option>}
              <option value="guide" disabled={props.atGuideLimit}>
                Specific frame{props.atGuideLimit ? " (limit reached)" : ""}
              </option>
              {props.channel === "visual" && <option value="end">End</option>}
            </select>
          </label>
        )}
        <label className="rl-h3-editor__frame-label" data-h3-add-frame="" hidden={!showFrame}>
          <span>Frame</span>
          <span className="rl-h3-editor__frame-field">
            <input
              type="number"
              min="0"
              step="1"
              data-h3-add-field="frame"
              placeholder="0"
              inputMode="numeric"
              disabled={!showFrame}
              value={frame}
              onInput={(event) => setFrame(event.currentTarget.value)}
            />
            <small data-h3-add-seconds="">
              {showFrame && Number.isSafeInteger(frameIndex) && frameIndex >= 0
                ? `(${(frameIndex / props.fps).toFixed(2)}s)`
                : ""}
            </small>
          </span>
        </label>
        <button
          type="button"
          data-h3-action="add-draft-placement"
          className="rl-h3-editor__add"
          aria-label="Add Guide"
          title="Add Guide"
          disabled={showFrame && props.atGuideLimit}
          onClick={() => props.onAdd(position, frame)}
        >
          +
        </button>
      </div>
      {props.addError && (
        <p className="rl-h3-editor__error" role="alert" data-h3-add-error="">
          {props.addError}
        </p>
      )}
      {props.issue && (
        <p className="rl-h3-editor__error" role="alert" data-h3-editor-error="">
          {props.issue}
        </p>
      )}
      {showActions && (
        <div className="rl-h3-editor__actions">
          <button type="button" data-h3-action="cancel-editor" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            data-h3-action="apply-editor"
            disabled={Boolean(props.issue)}
            onClick={props.onApply}
          >
            Apply
          </button>
        </div>
      )}
    </section>
  )
}
