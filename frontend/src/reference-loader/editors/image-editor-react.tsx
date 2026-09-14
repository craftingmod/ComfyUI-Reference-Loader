import { useLayoutEffect, useRef, type ChangeEvent, type InputEvent, type ReactNode } from "react"

import { useI18n } from "../i18n.ts"
import { Button } from "../ui/button.tsx"
import { EditorFooter } from "../ui/editor-footer.tsx"
import { Field } from "../ui/field.tsx"
import { StatusMessage } from "../ui/status-message.tsx"
import { ToggleGroup } from "../ui/toggle-group.tsx"
import type { ImageEditorDraft } from "./image-editor-model.ts"

export interface ImageEditorReactRefs {
  image: HTMLImageElement
  stage: HTMLElement
  visual: HTMLElement
  maskCanvas: HTMLCanvasElement
  cropOverlay: HTMLElement
  maskBrushPreview: HTMLElement
  cropDimensions: HTMLElement
  caption: HTMLTextAreaElement | null
  error: HTMLElement
  backgroundStatus: HTMLElement
  modeView: HTMLButtonElement
  modeCrop: HTMLButtonElement
  modeMask: HTMLButtonElement
  erase: HTMLButtonElement
  restore: HTMLButtonElement
  removeBackground: HTMLButtonElement
  invertMask: HTMLButtonElement
  undo: HTMLButtonElement
  redo: HTMLButtonElement
  apply: HTMLButtonElement
  restoreOriginal: HTMLButtonElement
  fields: Record<string, HTMLInputElement | HTMLSelectElement>
  cropHandles: HTMLButtonElement[]
}

export interface ImageEditorReactOptions {
  filename: string
  sourcePath: string
  caption: string
  captionLabel: string
  captionPlaceholder: string
  showCaption: boolean
  materialized: boolean
  initialDraft: ImageEditorDraft
  onAction(action: string): void
  onInput(field: string, value: number): void
  onChange(field: string, value: string): void
  onReady(refs: ImageEditorReactRefs): void
}

const NATIVE_CHANGE_HANDLED = "__referenceLoaderImageEditorChangeHandled"

function isNativeChangeHandled(event: Event): boolean {
  return Boolean((event as Event & { [NATIVE_CHANGE_HANDLED]?: boolean })[NATIVE_CHANGE_HANDLED])
}

function markNativeChangeHandled(event: Event): void {
  ;(event as Event & { [NATIVE_CHANGE_HANDLED]?: boolean })[NATIVE_CHANGE_HANDLED] = true
}

function assignRef<T extends HTMLElement>(ref: { current: T | null }, element: T | null): void {
  ref.current = element
}

export function ImageEditorDialog({ options }: { options: ImageEditorReactOptions }): ReactNode {
  const { t } = useI18n()
  const image = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLElement>(null)
  const visual = useRef<HTMLElement>(null)
  const maskCanvas = useRef<HTMLCanvasElement>(null)
  const cropOverlay = useRef<HTMLElement>(null)
  const maskBrushPreview = useRef<HTMLElement>(null)
  const cropDimensions = useRef<HTMLElement>(null)
  const caption = useRef<HTMLTextAreaElement>(null)
  const error = useRef<HTMLParagraphElement>(null)
  const backgroundStatus = useRef<HTMLElement>(null)
  const modeView = useRef<HTMLButtonElement>(null)
  const modeCrop = useRef<HTMLButtonElement>(null)
  const modeMask = useRef<HTMLButtonElement>(null)
  const erase = useRef<HTMLButtonElement>(null)
  const restore = useRef<HTMLButtonElement>(null)
  const removeBackground = useRef<HTMLButtonElement>(null)
  const invertMask = useRef<HTMLButtonElement>(null)
  const undo = useRef<HTMLButtonElement>(null)
  const redo = useRef<HTMLButtonElement>(null)
  const apply = useRef<HTMLButtonElement>(null)
  const restoreOriginal = useRef<HTMLButtonElement>(null)
  const fields = useRef<Record<string, HTMLInputElement | HTMLSelectElement>>({})
  const cropHandleRefs = useRef<Array<HTMLButtonElement | null>>([])

  useLayoutEffect(() => {
    const refs = {
      image: image.current,
      stage: stage.current,
      visual: visual.current,
      maskCanvas: maskCanvas.current,
      cropOverlay: cropOverlay.current,
      maskBrushPreview: maskBrushPreview.current,
      cropDimensions: cropDimensions.current,
      caption: caption.current,
      error: error.current,
      backgroundStatus: backgroundStatus.current,
      modeView: modeView.current,
      modeCrop: modeCrop.current,
      modeMask: modeMask.current,
      erase: erase.current,
      restore: restore.current,
      removeBackground: removeBackground.current,
      invertMask: invertMask.current,
      undo: undo.current,
      redo: redo.current,
      apply: apply.current,
      restoreOriginal: restoreOriginal.current,
      fields: fields.current,
      cropHandles: cropHandleRefs.current.filter(
        (handle): handle is HTMLButtonElement => handle !== null,
      ),
    }
    if (
      !refs.image ||
      !refs.stage ||
      !refs.visual ||
      !refs.maskCanvas ||
      !refs.cropOverlay ||
      !refs.maskBrushPreview ||
      !refs.cropDimensions ||
      !refs.error ||
      !refs.backgroundStatus ||
      !refs.modeView ||
      !refs.modeCrop ||
      !refs.modeMask ||
      !refs.erase ||
      !refs.restore ||
      !refs.removeBackground ||
      !refs.invertMask ||
      !refs.undo ||
      !refs.redo ||
      !refs.apply ||
      !refs.restoreOriginal
    )
      return
    options.onReady(refs as ImageEditorReactRefs)
  }, [options])

  useLayoutEffect(() => {
    const changeFields = [
      "crop-aspect",
      "x",
      "y",
      "width",
      "height",
      "background-mode",
      "background-color",
    ]
    const bindings = changeFields
      .map((name) => [fields.current[name], name] as const)
      .filter((binding): binding is readonly [HTMLInputElement | HTMLSelectElement, string] =>
        Boolean(binding[0]),
      )
    const listeners = bindings.map(([input, name]) => {
      const listener = (event: Event): void => {
        if (isNativeChangeHandled(event)) return
        markNativeChangeHandled(event)
        options.onChange(name, input.value)
      }
      input.addEventListener("change", listener)
      return [input, listener] as const
    })
    return () => {
      for (const [input, listener] of listeners) input.removeEventListener("change", listener)
    }
  }, [options])

  const field =
    (name: string) =>
    (element: HTMLInputElement | HTMLSelectElement | null): void => {
      if (element) fields.current[name] = element
    }
  const draft = options.initialDraft
  const mediaColumnClass = `rl-editor-media-column${options.showCaption ? "" : " is-captionless"}`
  const cropHandleDefinitions: Array<readonly [string, string]> = [
    ["north-west", t("resizeCropTopLeft")],
    ["north-east", t("resizeCropTopRight")],
    ["south-west", t("resizeCropBottomLeft")],
    ["south-east", t("resizeCropBottomRight")],
  ]
  const action =
    (name: string): (() => void) =>
    () =>
      options.onAction(name)
  const input =
    (name: string) =>
    (event: InputEvent<HTMLInputElement>): void => {
      if (!isNativeChangeHandled(event.nativeEvent))
        options.onInput(name, event.currentTarget.valueAsNumber)
    }
  const change =
    (name: string) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>): void => {
      if (!isNativeChangeHandled(event.nativeEvent))
        options.onChange(name, event.currentTarget.value)
    }

  return (
    <form method="dialog" className="rl-modal__panel">
      <header>
        <div>
          <strong>{t("imageEditor")}</strong>
          <small>{t("imageEditorSubtitle")}</small>
          <small className="rl-modal__filename" title={options.sourcePath}>
            {t("file", { filename: options.filename })}
          </small>
        </div>
        <Button
          type="button"
          data-action="cancel"
          aria-label={t("close")}
          onClick={action("cancel")}
        >
          ×
        </Button>
      </header>
      <div className="rl-editor-layout">
        <div className={mediaColumnClass}>
          <div className="rl-editor-preview">
            <div ref={(element) => assignRef(stage, element)} className="rl-editor-stage">
              <div ref={(element) => assignRef(visual, element)} className="rl-editor-visual">
                <img
                  ref={(element) => assignRef(image, element)}
                  alt={t("selectedReferencePreview")}
                />
                <canvas
                  ref={(element) => assignRef(maskCanvas, element)}
                  aria-label={t("editableKeepMask")}
                />
              </div>
              <div
                ref={(element) => assignRef(cropOverlay, element)}
                className="rl-crop-overlay"
                aria-label={t("cropViewport")}
              >
                {cropHandleDefinitions.map(([handle, label], index) => (
                  <button
                    key={handle}
                    ref={(element) => {
                      cropHandleRefs.current[index] = element
                    }}
                    type="button"
                    data-crop-handle={handle}
                    aria-label={label}
                  />
                ))}
              </div>
              <div
                ref={(element) => assignRef(maskBrushPreview, element)}
                className="rl-mask-brush-preview"
                data-mask-tool="erase"
                aria-hidden="true"
                hidden
              />
            </div>
          </div>
          {options.showCaption ? (
            <Field label={options.captionLabel || t("caption")} className="rl-modal__caption">
              <textarea
                ref={(element) => assignRef(caption, element)}
                data-field="caption"
                data-capture-wheel="true"
                rows={2}
                maxLength={16384}
                placeholder={options.captionPlaceholder}
                defaultValue={options.caption}
              />
            </Field>
          ) : null}
        </div>
        <div className="rl-editor-controls">
          <ToggleGroup
            className="rl-interaction-modes"
            legend={t("interaction")}
            value={draft.interactionMode}
            items={[
              { value: "view", label: t("view"), ref: modeView, action: "mode-view" },
              { value: "crop", label: t("crop"), ref: modeCrop, action: "mode-crop" },
              { value: "mask", label: t("mask"), ref: modeMask, action: "mode-mask" },
            ]}
            onValueChange={(value) => options.onAction(`mode-${value}`)}
          />
          <fieldset className="rl-viewport-values" hidden aria-hidden="true">
            <legend>{t("viewport")}</legend>
            <Field label={t("zoom")}>
              <input
                ref={field("zoom")}
                data-field="zoom"
                type="range"
                min="1"
                max="3"
                step="0.05"
                defaultValue={draft.zoom}
                onInput={input("zoom")}
              />
            </Field>
            <Field label={t("panX")}>
              <input
                ref={field("pan-x")}
                data-field="pan-x"
                type="range"
                min="-100"
                max="100"
                step="1"
                defaultValue={draft.panX}
                onInput={input("pan-x")}
              />
            </Field>
            <Field label={t("panY")}>
              <input
                ref={field("pan-y")}
                data-field="pan-y"
                type="range"
                min="-100"
                max="100"
                step="1"
                defaultValue={draft.panY}
                onInput={input("pan-y")}
              />
            </Field>
          </fieldset>
          <fieldset>
            <legend>
              {t("cropInSourcePixels")} <span ref={cropDimensions} data-crop-dimensions />
            </legend>
            <Field label={t("aspectRatio")} className="rl-control-wide">
              <select
                ref={field("crop-aspect")}
                data-field="crop-aspect"
                defaultValue={draft.cropAspect}
                onChange={change("crop-aspect")}
              >
                <option value="custom">{t("custom")}</option>
                <option value="original">{t("original")}</option>
                <option value="1:1">1:1</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="3:2">3:2</option>
                <option value="2:3">2:3</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
              </select>
            </Field>
            {(["x", "y", "width", "height"] as const).map((name) => (
              <Field key={name} label={name[0].toUpperCase() + name.slice(1)}>
                <input
                  ref={field(name)}
                  data-field={name}
                  type="number"
                  min={name === "width" || name === "height" ? 1 : 0}
                  step="1"
                  inputMode="numeric"
                  onChange={change(name)}
                />
              </Field>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t("keepMask")}</legend>
            <Button
              ref={erase}
              type="button"
              data-action="erase"
              aria-pressed="true"
              onClick={action("erase")}
            >
              {t("erase")}
            </Button>
            <Button
              ref={restore}
              type="button"
              data-action="restore"
              aria-pressed="false"
              onClick={action("restore")}
            >
              {t("restore")}
            </Button>
            <Field label={t("brushSize")}>
              <input
                ref={field("brush-size")}
                data-field="brush-size"
                type="range"
                min="4"
                max="200"
                step="1"
                defaultValue={draft.brushSize}
                onInput={input("brush-size")}
              />
            </Field>
            <Field label={t("opacity")}>
              <input
                ref={field("brush-opacity")}
                data-field="brush-opacity"
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                defaultValue={draft.brushOpacity}
                onInput={input("brush-opacity")}
              />
            </Field>
            <Button
              ref={invertMask}
              type="button"
              className="rl-control-wide"
              data-action="invert-mask"
              onClick={action("invert-mask")}
            >
              {t("invertMask")}
            </Button>
          </fieldset>
          <fieldset>
            <legend>{t("transform")}</legend>
            <Button type="button" data-action="flip-x" onClick={action("flip-x")}>
              {t("flipHorizontal")}
            </Button>
            <Button type="button" data-action="flip-y" onClick={action("flip-y")}>
              {t("flipVertical")}
            </Button>
          </fieldset>
          <fieldset>
            <legend>{t("background")}</legend>
            <Button
              ref={removeBackground}
              type="button"
              className="rl-control-wide"
              data-action="remove-background"
              aria-pressed="false"
              onClick={action("remove-background")}
            >
              {t("removeBackground")}
            </Button>
            <small ref={backgroundStatus} className="rl-editor-note" data-background-status>
              {t("backgroundStatus")}
            </small>
            <Field label={t("backgroundMode")}>
              <select
                ref={field("background-mode")}
                data-field="background-mode"
                defaultValue={draft.backgroundMode}
                onChange={change("background-mode")}
              >
                <option value="transparent">{t("transparent")}</option>
                <option value="solid">{t("solidColor")}</option>
              </select>
            </Field>
            <Field label={t("backgroundColor")}>
              <input
                ref={field("background-color")}
                data-field="background-color"
                type="color"
                aria-label={t("backgroundColor")}
                defaultValue={draft.backgroundColor}
                onChange={change("background-color")}
              />
            </Field>
          </fieldset>
          <StatusMessage ref={error} status="error" className="rl-modal__error" hidden />
          <EditorFooter
            className="rl-image-editor-actions"
            historyLabel={t("imageHistory")}
            history={
              <>
                <Button ref={undo} type="button" data-action="undo" onClick={action("undo")}>
                  {t("undo")}
                </Button>
                <Button ref={redo} type="button" data-action="redo" onClick={action("redo")}>
                  {t("redo")}
                </Button>
                <Button type="button" data-action="reset-view" onClick={action("reset-view")}>
                  {t("resetView")}
                </Button>
              </>
            }
            leading={
              <Button
                ref={restoreOriginal}
                type="button"
                className="rl-restore-original"
                data-action="restore-original"
                hidden={!options.materialized}
                onClick={action("restore-original")}
              >
                {t("restoreOriginal")}
              </Button>
            }
            applyRef={apply}
            onCancel={action("cancel")}
            onApply={action("apply")}
            applyLabel={t("apply")}
            cancelLabel={t("cancel")}
          />
        </div>
      </div>
    </form>
  )
}
