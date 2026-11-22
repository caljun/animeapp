import { copyStroke } from './model.ts'
import type { Frame, Point, Stroke } from './model.ts'
import { contains, distanceSquared, editableLine } from './selection.ts'

export function cleanupTargets(frame: Frame, selected: ReadonlySet<string>) {
  return frame.strokes.filter(stroke => selected.has(stroke.id) && editableLine(stroke))
}

export function stageCleanup(frame: Frame, targets: readonly Stroke[], polygon: Point[], generated: Stroke[]) {
  const targetIds = new Set(targets.filter(editableLine).map(stroke => stroke.id))
  const originals = frame.strokes.filter(stroke => targetIds.has(stroke.id) && editableLine(stroke))
  if (!originals.length || !generated.length) return { strokes: frame.strokes, originals: [] }
  // Keep the locked/unselected strokes in their original order. Added ink sits below them.
  const group = generated.map(stroke => ({
    ...stroke, clips: [...(stroke.clips ?? []), { mode: 'inside' as const, polygon }],
  }))
  const remaining = frame.strokes.flatMap(stroke => {
    if (!targetIds.has(stroke.id) || !editableLine(stroke)) return [stroke]
    if (fullyInside(stroke, polygon)) return []
    return [{ ...stroke, clips: [...(stroke.clips ?? []), { mode: 'outside' as const, polygon }] }]
  })
  return { strokes: [...group, ...remaining], originals }
}

function fullyInside(stroke: Stroke, polygon: Point[]) {
  // A convex polygon contains the full Bézier and round brush if every control point
  // fits with a sufficient margin. For concave lassos, keep the clipped original.
  let positive = false, negative = false
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], c = polygon[(i + 2) % polygon.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    positive ||= cross > 0
    negative ||= cross < 0
  }
  // For arbitrary lassos, also verify all vertices lie to one side of every edge,
  // since a self-intersecting outline can have equal turn signs.
  if (positive === negative || polygon.length > 4 || !polygon.every((a, i) => {
    const b = polygon[(i + 1) % polygon.length]
    return polygon.every(p => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) * (positive ? 1 : -1) >= 0)
  })) return false
  return stroke.points.every(p => contains(p, polygon) && polygon.every((a, i) =>
    distanceSquared(p, a, polygon[(i + 1) % polygon.length]) > (stroke.size / 2 + 1) ** 2))
}

export const archiveRoughs = (originals: Stroke[]) => originals.map(copyStroke)
