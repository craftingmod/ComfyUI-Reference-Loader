import { h3Placements, type H3TimelinePlacement } from "../h3-media-guides.ts"
import type { ItemRuntime, LoaderState } from "../types.ts"

const FPS = 24

export interface TimelineMark {
  placement: H3TimelinePlacement
  channel: "visual" | "audio" | "shot"
  shotTag?: string
  label: string
  previewUrl?: string
  frame: number
  frames?: number
  disabled: boolean
  incomplete: boolean
  warning?: string
}

export function timelineMarks(
  state: LoaderState,
  runtime: ReadonlyMap<string, ItemRuntime>,
  shots: readonly { tag: string; frameIndex: number }[] = [],
): TimelineMark[] {
  const marks: TimelineMark[] = []
  for (const placement of h3Placements(state.h3Timeline)) {
    for (const channel of ["visual", "audio"] as const) {
      const id = channel === "visual" ? placement.visualId : placement.audioId
      const empty = !placement.visualId && !placement.audioId
      if (!id && !(empty && channel === "visual")) continue
      const item = id ? state.items[id] : undefined
      const loaded = id ? runtime.get(id) : undefined
      const duration =
        item?.kind === "audio"
          ? item.crop
            ? item.crop.end - item.crop.start
            : loaded?.metadata?.duration
          : undefined
      const disabledIds =
        channel === "visual"
          ? state.h3Timeline.disabledVisualIds
          : state.h3Timeline.disabledAudioIds
      marks.push({
        placement,
        channel,
        label: item?.sourceFilename || item?.source.path.split("/").pop() || "Media needed",
        previewUrl: channel === "visual" ? loaded?.previewUrl : undefined,
        frame: placement.frameIndex ?? 0,
        frames:
          channel === "visual"
            ? 1
            : duration !== undefined && Number.isFinite(duration) && duration > 0
              ? Math.max(1, Math.ceil(duration * FPS))
              : undefined,
        disabled: !state.h3Timeline.enabled || Boolean(id && disabledIds?.includes(id)),
        incomplete:
          !item ||
          !Number.isSafeInteger(placement.frameIndex ?? 0) ||
          (placement.frameIndex ?? 0) < 0,
      })
    }
  }
  for (const shot of shots) {
    marks.push({
      placement: { kind: "guide", guideId: `shot:${shot.tag}`, frameIndex: shot.frameIndex },
      channel: "shot",
      shotTag: shot.tag,
      label: `#${shot.tag}`,
      frame: shot.frameIndex,
      frames: 1,
      disabled: false,
      incomplete: !Number.isSafeInteger(shot.frameIndex) || shot.frameIndex < 0,
    })
  }
  // At most 34 placements; pairwise checks also keep both sides of a conflict visible.
  for (const [index, mark] of marks.entries()) {
    if (
      mark.channel === "shot" ||
      mark.disabled ||
      mark.placement.kind === "end" ||
      mark.frames === undefined
    )
      continue
    for (const other of marks.slice(index + 1)) {
      if (
        other.channel === "shot" ||
        other.disabled ||
        other.placement.kind === "end" ||
        other.channel !== mark.channel ||
        other.frames === undefined
      )
        continue
      if (mark.frame < other.frame + other.frames && other.frame < mark.frame + mark.frames) {
        mark.warning =
          other.warning = `${mark.channel === "audio" ? "Audio ranges" : "Image placements"} overlap. Wrapper validates the final output.`
      }
    }
  }
  return marks
}

export function timelineExtent(marks: TimelineMark[]): number {
  return Math.max(
    240,
    ...marks
      .filter((mark) => mark.placement.kind !== "end" && Number.isSafeInteger(mark.frame))
      .map(
        (mark) =>
          Math.ceil(Math.max(mark.frame + (mark.frames ?? 1) + FPS, mark.frame * 1.16) / FPS) * FPS,
      ),
  )
}

export function draggedFrame(frame: number, deltaX: number, width: number, extent: number): number {
  if (!(width > 0)) return frame
  return Math.max(0, Math.min(extent - 1, Math.round(frame + (deltaX / width) * extent)))
}
