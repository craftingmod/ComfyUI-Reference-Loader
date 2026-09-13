import type { MaskBrushTool } from "./image-editor-model.ts"

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function maskBrushToolForModifier(tool: MaskBrushTool, invert: boolean): MaskBrushTool {
  return invert ? (tool === "erase" ? "restore" : "erase") : tool
}

export function applyMaskBrush(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  opacity: number,
  tool: MaskBrushTool,
): Uint8ClampedArray {
  const next = new Uint8ClampedArray(pixels)
  const target = tool === "erase" ? 0 : 255
  const alpha = clamp(opacity, 0, 1)
  const safeRadius = Math.max(0.5, radius)
  const left = Math.max(0, Math.floor(centerX - safeRadius))
  const right = Math.min(width - 1, Math.ceil(centerX + safeRadius))
  const top = Math.max(0, Math.floor(centerY - safeRadius))
  const bottom = Math.min(height - 1, Math.ceil(centerY + safeRadius))
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 > safeRadius ** 2) continue
      const index = (y * width + x) * 4
      const current = next[index] ?? 255
      const value = Math.round(current + (target - current) * alpha)
      next[index] = value
      next[index + 1] = value
      next[index + 2] = value
      next[index + 3] = 255
    }
  }
  return next
}

export function invertMaskPixels(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const next = new Uint8ClampedArray(pixels)
  for (let index = 0; index < next.length; index += 4) {
    next[index] = 255 - (next[index] ?? 255)
    next[index + 1] = 255 - (next[index + 1] ?? 255)
    next[index + 2] = 255 - (next[index + 2] ?? 255)
  }
  return next
}
