import { COORDINATE_LIMIT, copyStroke } from './model.ts'
import type { Point, Stroke } from './model.ts'

export type SelectionMode = 'rectangle' | 'lasso'
export type Region = { mode: SelectionMode; points: readonly Point[] }

export type Bounds = { left: number; top: number; right: number; bottom: number }
export type Smoothing = 'original' | 'light' | 'strong'
export type Transform = { dx?: number; dy?: number; scale?: number; degrees?: number }

export const strokeWidth = (size: number, point: Point) =>
  size * (point.pressure === undefined ? 1 : 0.2 + 0.8 * point.pressure)
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function regionPolygon({ mode, points }: Region): readonly Point[] {
  if (mode === 'lasso') return points
  const [a, b = a] = points
  return [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]
}

function include(bounds: Bounds, p: Point, padding = 0) {
  bounds.left = Math.min(bounds.left, p.x - padding)
  bounds.top = Math.min(bounds.top, p.y - padding)
  bounds.right = Math.max(bounds.right, p.x + padding)
  bounds.bottom = Math.max(bounds.bottom, p.y + padding)
}

const emptyBounds = (): Bounds => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })

export function lineBounds(strokes: readonly Stroke[]): Bounds | null {
  if (!strokes.length) return null
  const box = emptyBounds()
  for (const stroke of strokes) for (const p of stroke.points) include(box, p, stroke.size / 2)
  return box
}

export function insideBounds(box: Bounds, p: Point, padding = 0) {
  return p.x >= box.left - padding && p.x <= box.right + padding
    && p.y >= box.top - padding && p.y <= box.bottom + padding
}

export function distanceSquared(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2
}

const side = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

function crosses(a: Point, b: Point, c: Point, d: Point) {
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

export function contains(p: Point, polygon: readonly Point[]) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (b.x - a.x) * (p.y - a.y) / (b.y - a.y)) inside = !inside
  }
  return inside
}

function capsuleTouches(a: Point, b: Point, radius: number, polygon: readonly Point[]) {
  if (contains(a, polygon) || contains(b, polygon)) return true
  const limit = radius * radius
  return polygon.some((c, i) => {
    const d = polygon[(i + 1) % polygon.length]
    return crosses(a, b, c, d) || distanceSquared(c, a, b) <= limit || distanceSquared(d, a, b) <= limit
      || distanceSquared(a, c, d) <= limit || distanceSquared(b, c, d) <= limit
  })
}

function curveTouches(a: Point, control: Point, b: Point, radius: number, polygon: readonly Point[], depth = 0): boolean {
  // The split bounds the difference from the polyline used for hit testing.
  if (depth >= 10 || distanceSquared(control, a, b) <= 0.25 ** 2) return capsuleTouches(a, b, radius, polygon)
  const left = midpoint(a, control), right = midpoint(control, b), center = midpoint(left, right)
  return curveTouches(a, left, center, radius, polygon, depth + 1)
    || curveTouches(center, right, b, radius, polygon, depth + 1)
}

export function selectLines(strokes: readonly Stroke[], region: Region): string[] {
  const polygon = regionPolygon(region)
  const regionBox = emptyBounds()
  for (const p of polygon) include(regionBox, p)
  if (polygon.length < 3 || regionBox.left === regionBox.right || regionBox.top === regionBox.bottom) return []
  return strokes.filter(stroke => {
    if (stroke.tool !== 'pen') return false
    const box = lineBounds([stroke])!
    if (box.right < regionBox.left || box.left > regionBox.right || box.bottom < regionBox.top || box.top > regionBox.bottom) return false
    const { points, size } = stroke
    const first = points[0], last = points[points.length - 1]
    if (capsuleTouches(first, first, strokeWidth(size, first) / 2, polygon)) return true
    for (let i = 1; i < points.length; i++) {
      const control = points[i - 1]
      const from = i === 1 ? control : midpoint(points[i - 2], control)
      const to = midpoint(control, points[i])
      if (curveTouches(from, control, to, strokeWidth(size, control) / 2, polygon)) return true
    }
    return points.length > 1 && capsuleTouches(midpoint(points[points.length - 2], last), last, strokeWidth(size, last) / 2, polygon)
  }).map(stroke => stroke.id)
}

export const editableLine = (stroke: Stroke) => stroke.tool === 'pen' && !stroke.locked

export function editSelected(strokes: Stroke[], ids: ReadonlySet<string>, edit: (stroke: Stroke) => Stroke, allowLocked = false) {
  let changed = false
  const next = strokes.map(stroke => {
    if (!ids.has(stroke.id) || stroke.tool !== 'pen' || (stroke.locked && !allowLocked)) return stroke
    const result = edit(stroke)
    changed ||= result !== stroke
    return result
  })
  return changed ? next : strokes
}

export function transformLines(strokes: Stroke[], ids: ReadonlySet<string>, { dx = 0, dy = 0, scale = 1, degrees = 0 }: Transform) {
  if (![dx, dy, scale, degrees].every(Number.isFinite) || scale <= 0 || (!dx && !dy && scale === 1 && degrees % 360 === 0)) return strokes
  const box = lineBounds(strokes.filter(stroke => ids.has(stroke.id) && editableLine(stroke)))
  if (!box) return strokes
  const centerX = (box.left + box.right) / 2, centerY = (box.top + box.bottom) / 2
  const angle = degrees * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle)
  function transformPoint(point: Point): Point {
    const x = (point.x - centerX) * scale, y = (point.y - centerY) * scale
    return { ...point, x: centerX + dx + x * cosine - y * sine, y: centerY + dy + x * sine + y * cosine }
  }
  const result = editSelected(strokes, ids, stroke => ({
    ...stroke, points: stroke.points.map(transformPoint),
    ...(stroke.clips && { clips: stroke.clips.map(clip => ({ ...clip, polygon: clip.polygon.map(transformPoint) })) }),
  }))
  // Keep off-canvas coordinates without clipping the stroke or exceeding the file format limits.
  return result.some((stroke, i) => stroke !== strokes[i] && [...stroke.points, ...(stroke.clips?.flatMap(clip => clip.polygon) ?? [])].some(p =>
    Math.abs(p.x) > COORDINATE_LIMIT || Math.abs(p.y) > COORDINATE_LIMIT)) ? strokes : result
}

export function duplicateLines(strokes: Stroke[], ids: ReadonlySet<string>) {
  const copies = strokes.filter(stroke => ids.has(stroke.id) && editableLine(stroke)).map(copyStroke)
  const copyIds = new Set(copies.map(stroke => stroke.id))
  return { strokes: copies.length ? [...strokes, ...transformLines(copies, copyIds, { dx: 24, dy: 24 })] : strokes, ids: copyIds }
}

export function deleteLines(strokes: Stroke[], ids: ReadonlySet<string>) {
  const next = strokes.filter(stroke => !ids.has(stroke.id) || !editableLine(stroke))
  return next.length === strokes.length ? strokes : next
}

export function smoothLines(strokes: Stroke[], ids: ReadonlySet<string>, mode: Smoothing) {
  if (mode === 'original') return strokes
  const alpha = mode === 'light' ? 0.28 : 0.62
  const passes = mode === 'light' ? 1 : 3
  const maxShift = mode === 'light' ? 5 : 18
  return editSelected(strokes, ids, stroke => {
    if (stroke.points.length < 3) return stroke
    let points = stroke.points
    for (let pass = 0; pass < passes; pass++) {
      points = points.map((p, i) => {
        if (i === 0 || i === points.length - 1) return p
        const before = points[i - 1], after = points[i + 1]
        const left = Math.hypot(p.x - before.x, p.y - before.y)
        const right = Math.hypot(after.x - p.x, after.y - p.y)
        if (!left || !right) return p
        const target = left / (left + right)
        const original = stroke.points[i]
        const dx = p.x + alpha * (before.x + (after.x - before.x) * target - p.x) - original.x
        const dy = p.y + alpha * (before.y + (after.y - before.y) * target - p.y) - original.y
        const factor = Math.min(1, maxShift / (Math.hypot(dx, dy) || 1))
        return { ...p, x: original.x + dx * factor, y: original.y + dy * factor }
      })
    }
    return points.some((p, i) => p.x !== stroke.points[i].x || p.y !== stroke.points[i].y) ? { ...stroke, points } : stroke
  })
}
