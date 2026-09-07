import { useId, useState } from "react"
import { createPortal, flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

export type H3GuidePosition = "start" | "guide" | "end"

export interface H3GuideEditorProps {
  sourceLabel: string
  channel: "visual" | "audio"
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

function GuideFrame({
  guide,
  props,
}: {
  guide: H3GuideEditorProps["guides"][number]
  props: H3GuideEditorProps
}) {
  const descriptionId = useId()
  const validFrame = Number.isInteger(guide.frameIndex)
  const frameLabel = validFrame ? `${guide.frameIndex} frame` : "this frame"
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
            value={Number.isFinite(guide.frameIndex) ? guide.frameIndex : ""}
            data-h3-draft-field="frame"
            data-h3-guide-id={guide.id}
            aria-describedby={descriptionId}
            onInput={(event) => props.onInputFrame(guide.id, event.currentTarget.value)}
            ref={(input) => {
              if (!input) return
              // React onChange fires while typing. Paired Guides must split only
              // on the browser's native change/commit event, as in the DOM editor.
              const commit = (event: Event) => {
                event.stopPropagation()
                props.onCommitFrame(guide.id, input.value)
              }
              input.addEventListener("change", commit)
              return () => input.removeEventListener("change", commit)
            }}
          />
        </label>
        <span id={descriptionId} className="rl-h3-editor__seconds">
          {validFrame ? `${(guide.frameIndex / 24).toFixed(2)}s` : ""}
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

function H3GuideEditor({ props, footer }: { props: H3GuideEditorProps; footer: HTMLElement }) {
  const [position, setPosition] = useState<H3GuidePosition>("guide")
  const [frame, setFrame] = useState("")
  const frameIndex = frame.trim() === "" ? Number.NaN : Number(frame)
  const showFrame = position === "guide"
  return (
    <>
      <div className="rl-h3-editor__stack" data-h3-placement-list="">
        <div className="rl-h3-editor__placements">
          {props.start && <Role role="start" onRemove={() => props.onRemoveRole("start")} />}
          {props.guides.map((guide) => (
            <GuideFrame key={guide.id} guide={guide} props={props} />
          ))}
          {props.end && <Role role="end" onRemove={() => props.onRemoveRole("end")} />}
          {!props.start && !props.end && props.guides.length === 0 && (
            <p className="rl-h3-editor__empty">No guides yet.</p>
          )}
        </div>
      </div>
      {createPortal(
        <div className="rl-h3-editor__footer" data-h3-editor="">
          <span className="rl-h3-editor__title" title={props.sourceLabel}>
            {props.sourceLabel}
          </span>
          <div className="rl-h3-editor__add-form" data-h3-add-form="">
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
                  {showFrame && Number.isInteger(frameIndex) && frameIndex >= 0
                    ? `(${(frameIndex / 24).toFixed(2)}s)`
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
        </div>,
        footer,
      )}
    </>
  )
}

export function createH3GuideEditor() {
  const media = document.createElement("div")
  media.className = "rl-h3-editor rl-h3-editor--stack"
  media.dataset.h3Editor = ""
  media.dataset.h3CardEditor = ""
  media.dataset.h3ReactSurface = ""
  media.setAttribute("aria-label", "Timeline Guide editor")
  const body = document.createElement("div")
  body.className = "rl-card__body"
  body.dataset.h3ReactSurface = ""
  const root = createRoot(media)
  return {
    media,
    body,
    update(props: H3GuideEditorProps) {
      // The native controller restores focus immediately after rendering. Keep
      // its synchronous contract at this boundary, not in React form handlers.
      flushSync(() => root.render(<H3GuideEditor props={props} footer={body} />))
    },
    destroy() {
      root.unmount()
      media.remove()
      body.remove()
    },
  }
}
