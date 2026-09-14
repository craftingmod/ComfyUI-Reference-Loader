import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"

import { translateRaw, useI18n } from "../i18n.ts"
import { Button } from "../ui/button.tsx"
import { StatusMessage } from "../ui/status-message.tsx"

export type H3GuidePosition = "start" | "guide" | "end"

export interface H3GuideEditorProps {
  sourceLabel: string
  sourcePreviewUrl?: string
  sourceKind?: "image" | "audio"
  channel: "visual" | "audio"
  fps: number
  start: boolean
  end: boolean
  selectedRole?: "start" | "end"
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
  const { t } = useI18n()
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
  const frameLabel = validFrame ? `${guide.frameIndex} ${t("frame")}` : t("frame")
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
          <span>{t("guide")}</span>
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
        <Button
          type="button"
          className="rl-button--remove"
          data-h3-action="delete-draft-placement"
          data-h3-guide-id={guide.id}
          aria-label={`${t("delete")} ${frameLabel} ${props.channel === "visual" ? t("image") : t("audio")} connection`}
          title={`${t("delete")} ${t("guide")}`}
          onClick={() => props.onRemoveGuide(guide.id)}
        >
          ×
        </Button>
      </div>
      {guide.pairedLabel && (
        <small className="rl-h3-editor__paired">
          {t("alsoConnected")} {guide.pairedLabel}
        </small>
      )}
    </article>
  )
}

function Role({
  role,
  selected,
  onRemove,
}: {
  role: "start" | "end"
  selected: boolean
  onRemove(): void
}) {
  const { t } = useI18n()
  const label = role === "start" ? t("start") : t("end")
  return (
    <article
      className={`rl-h3-editor__placement rl-h3-editor__stack-row rl-h3-editor__role${selected ? " is-selected" : ""}`}
      data-h3-role={role}
    >
      <div>
        <strong>{label}</strong>
        <small>{role === "start" ? `${t("frame")} 0` : t("finalOutputFrame")}</small>
      </div>
      <Button
        type="button"
        className="rl-button--remove"
        data-h3-action="remove-draft-role"
        data-h3-role={role}
        aria-label={`${t("delete")} ${label} ${t("image")} connection`}
        title={`${t("delete")} ${label} ${t("image")} connection`}
        onClick={onRemove}
      >
        ×
      </Button>
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
  const { locale, t } = useI18n()
  const [position, setPosition] = useState<H3GuidePosition>("guide")
  const [frame, setFrame] = useState("")
  const frameIndex = frame.trim() === "" ? Number.NaN : Number(frame)
  const showFrame = position === "guide"
  const positionOptions: readonly H3GuidePosition[] =
    props.channel === "visual" ? ["start", "guide", "end"] : ["guide"]
  const movePosition = (event: KeyboardEvent<HTMLButtonElement>, value: H3GuidePosition): void => {
    const index = positionOptions.indexOf(value)
    let nextIndex: number | undefined
    if (event.key === "Home") nextIndex = 0
    else if (event.key === "End") nextIndex = positionOptions.length - 1
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      nextIndex = (index - 1 + positionOptions.length) % positionOptions.length
    else if (event.key === "ArrowRight" || event.key === "ArrowDown")
      nextIndex = (index + 1) % positionOptions.length
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = positionOptions[nextIndex]
    setPosition(next)
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-h3-add-field="position"][value="${next}"]`)
      ?.focus()
  }
  return (
    <section
      className="rl-h3-editor rl-h3-editor--inspector"
      data-h3-editor=""
      data-h3-inspector=""
      data-h3-react-surface=""
      aria-label={props.channel === "visual" ? t("imageGuideInspector") : t("audioGuideInspector")}
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
          {props.channel === "visual" ? t("image") : t("audio")}
        </span>
      </header>
      <p className="rl-h3-editor__hint">
        {props.channel === "visual" ? t("useImageAtPositions") : t("placeAudioAtFrame")}
      </p>
      <div className="rl-h3-editor__stack" data-h3-placement-list="">
        <div className="rl-h3-editor__placements">
          {props.start && (
            <Role
              role="start"
              selected={props.selectedRole === "start"}
              onRemove={() => props.onRemoveRole("start")}
            />
          )}
          {props.guides.map((guide) => (
            <GuideFrame key={guide.id} guide={guide} props={props} />
          ))}
          {props.end && (
            <Role
              role="end"
              selected={props.selectedRole === "end"}
              onRemove={() => props.onRemoveRole("end")}
            />
          )}
          {!props.start && !props.end && props.guides.length === 0 && (
            <p className="rl-h3-editor__empty">{t("noPlacements")}</p>
          )}
        </div>
      </div>
      <div className="rl-h3-editor__add-form" data-h3-add-form="">
        {positionMode === "radio" ? (
          <div
            className="rl-h3-editor__position-field"
            role="radiogroup"
            aria-label={t("guidePosition")}
          >
            <span className="rl-h3-editor__position-label">{t("position")}</span>
            <div className="rl-h3-editor__position-group">
              {positionOptions.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  value={value}
                  data-h3-add-field="position"
                  aria-checked={position === value}
                  tabIndex={position === value ? 0 : -1}
                  disabled={value === "guide" && props.atGuideLimit}
                  onClick={() => setPosition(value)}
                  onKeyDown={(event) => movePosition(event, value)}
                >
                  {value === "guide" ? t("frame") : value === "start" ? t("start") : t("end")}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <label className="rl-h3-editor__position-field">
            <span>{t("position")}</span>
            <select
              data-h3-add-field="position"
              value={position}
              onChange={(event) => setPosition(event.currentTarget.value as H3GuidePosition)}
            >
              {props.channel === "visual" && <option value="start">{t("start")}</option>}
              <option value="guide" disabled={props.atGuideLimit}>
                {props.atGuideLimit ? t("specificFrameLimitReached") : t("specificFrame")}
              </option>
              {props.channel === "visual" && <option value="end">{t("end")}</option>}
            </select>
          </label>
        )}
        <label className="rl-h3-editor__frame-label" data-h3-add-frame="" hidden={!showFrame}>
          <span>{t("frame")}</span>
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
        <Button
          type="button"
          data-h3-action="add-draft-placement"
          className="rl-button--add rl-h3-editor__add"
          aria-label={t("addGuide")}
          title={t("addGuide")}
          disabled={showFrame && props.atGuideLimit}
          onClick={() => props.onAdd(position, frame)}
        >
          +
        </Button>
      </div>
      {props.addError && (
        <StatusMessage status="error" className="rl-h3-editor__error" data-h3-add-error="">
          {translateRaw(locale, props.addError)}
        </StatusMessage>
      )}
      {props.issue && (
        <StatusMessage status="error" className="rl-h3-editor__error" data-h3-editor-error="">
          {translateRaw(locale, props.issue)}
        </StatusMessage>
      )}
      {showActions && (
        <div className="rl-h3-editor__actions">
          <Button type="button" data-h3-action="cancel-editor" onClick={props.onCancel}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            data-h3-action="apply-editor"
            disabled={Boolean(props.issue)}
            onClick={props.onApply}
          >
            {t("apply")}
          </Button>
        </div>
      )}
    </section>
  )
}
