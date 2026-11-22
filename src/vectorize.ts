import type { Point } from './model'
import { distanceSquared } from './selection.ts'

const neighbors = [-1, 0, 1, 1, 1, 0, -1, -1].map((x, i) => [x, [-1, -1, -1, 0, 1, 1, 1, 0][i]])

function thin(ink: Uint8Array, width: number, height: number) {
  const skeleton = ink.slice()
  const offsets = neighbors.map(([x, y]) => y * width + x)
  let changed = true
  for (let iteration = 0; changed && iteration < 96; iteration++) {
    changed = false
    for (let pass = 0; pass < 2; pass++) {
      const remove: number[] = []
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const i = y * width + x
        if (!skeleton[i]) continue
        let count = 0, transitions = 0
        for (let j = 0; j < 8; j++) {
          const bit = skeleton[i + offsets[j]]
          count += bit
          if (!bit && skeleton[i + offsets[(j + 1) % 8]]) transitions++
        }
        if (count < 2 || count > 6 || transitions !== 1) continue
        const n = skeleton[i - width], e = skeleton[i + 1], s = skeleton[i + width], w = skeleton[i - 1]
        if (pass === 0 ? n && e && s || e && s && w : n && e && w || n && s && w) continue
        remove.push(i)
      }
      for (const i of remove) skeleton[i] = 0
      changed ||= remove.length > 0
    }
  }
  return skeleton
}

function distanceField(mask: Uint8Array, w: number, h: number) {
  const field = Float32Array.from(mask, bit => bit ? w + h : 0)
  const diagonal = Math.SQRT2
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    if (field[i]) field[i] = Math.min(field[i], field[i - 1] + 1, field[i - w] + 1,
      field[i - w - 1] + diagonal, field[i - w + 1] + diagonal)
  }
  for (let y = h - 2; y > 0; y--) for (let x = w - 2; x > 0; x--) {
    const i = y * w + x
    if (field[i]) field[i] = Math.min(field[i], field[i + 1] + 1, field[i + w] + 1,
      field[i + w + 1] + diagonal, field[i + w - 1] + diagonal)
  }
  return field
}

function removeSpecks(ink: Uint8Array, width: number) {
  const seen = new Uint8Array(ink.length)
  const offsets = neighbors.map(([x, y]) => y * width + x)
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue
    const component = [start]
    seen[start] = 1
    for (let i = 0; i < component.length; i++) for (const offset of offsets) {
      const j = component[i] + offset
      if (ink[j] && !seen[j]) {
        seen[j] = 1
        component.push(j)
      }
    }
    if (component.length < 4) for (const i of component) ink[i] = 0
  }
}

export type TracedLine = { points: Point[]; width: number }
export type Trace = { lines: TracedLine[]; truncated: boolean; branches: number }

export function traceLineArt(rgba: Uint8ClampedArray, allowed: Uint8Array, width: number, height: number): Trace {
  const ink = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, p = i * 4
    const luminance = 0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]
    ink[i] = allowed[i] && (255 - luminance) * rgba[p + 3] / 255 > 105 ? 1 : 0
  }
  removeSpecks(ink, width)
  const radius = distanceField(ink, width, height)
  const skeleton = thin(ink, width, height)
  const degree = new Uint8Array(ink.length)
  const directions = new Uint8Array(ink.length)
  const visited = new Uint8Array(ink.length)
  const offsets = neighbors.map(([x, y]) => y * width + x)
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i]) continue
    for (const [direction, [x, y]] of neighbors.entries()) {
      if (!skeleton[i + offsets[direction]]) continue
      // Omit diagonals when an orthogonal route already connects the pixels.
      if (x && y && (skeleton[i + x] || skeleton[i + y * width])) continue
      directions[i] |= 1 << direction
      degree[i]++
    }
  }

  const lines: TracedLine[] = []
  let usedPoints = 0, truncated = false, branches = 0
  const point = (i: number) => ({ x: i % width + 0.5, y: Math.floor(i / width) + 0.5 })
  const addPath = (path: number[]) => {
    if (lines.length >= 1200 || usedPoints >= 60_000) {
      truncated = true
      return
    }
    const widths = path.map(i => Math.max(1, 2 * radius[i] - 1))
    // Keep samples at bends and at transitions in thickness, and limit chord length.
    const kept = [0]
    for (let i = 1; i < path.length - 1; i++) {
      const a = kept.at(-1)!
      if (i - a >= 4 || Math.abs(widths[a] - widths[i]) > 1 || distanceSquared(point(path[i]), point(path[a]), point(path[i + 1])) > 0.4) kept.push(i)
    }
    if (path.length > 1) kept.push(path.length - 1)
    const strokeWidth = widths.reduce((maximum, value) => Math.max(maximum, value), 1)
    const points = kept.map(i => ({ ...point(path[i]), pressure: Math.max(0, (widths[i] / strokeWidth - 0.2) / 0.8) }))
    usedPoints += points.length
    lines.push({ points, width: strokeWidth })
  }
  const available = (i: number) => directions[i] & ~visited[i]
  const follow = (start: number) => {
    let i = start
    const path = [start]
    while (available(i)) {
      const mask = available(i)
      const direction = Math.log2(mask & -mask)
      const next = i + offsets[direction]
      visited[i] |= 1 << direction
      visited[next] |= 1 << ((direction + 4) % 8)
      path.push(next)
      i = next
      if (i === start || degree[i] !== 2) break
    }
    addPath(path)
  }

  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i] || degree[i] === 2) continue
    if (degree[i] > 2) branches++
    if (degree[i] === 0) addPath([i])
    else while (available(i)) follow(i)
  }
  for (let i = 0; i < skeleton.length; i++) while (available(i)) follow(i)
  return { lines, truncated, branches }
}
