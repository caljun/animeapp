import { COORDINATE_LIMIT } from './model'
import type { Artboard, Frame, Point, Stroke } from './model'
import { lineBounds, midpoint, regionPolygon, strokeWidth } from './selection'
import type { Region } from './selection'

export function surface(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, start = 0, finish = true) {
  const { points, size, color, tool } = stroke
  const width = (point: Point) => strokeWidth(size, point)
  ctx.save()
  for (const clip of stroke.clips ?? []) {
    const [first, ...rest] = clip.polygon
    ctx.beginPath()
    if (clip.mode === 'outside') ctx.rect(-COORDINATE_LIMIT * 2, -COORDINATE_LIMIT * 2, COORDINATE_LIMIT * 4, COORDINATE_LIMIT * 4)
    ctx.moveTo(first.x, first.y)
    for (const point of rest) ctx.lineTo(point.x, point.y)
    ctx.closePath()
    ctx.clip('evenodd')
  }
  ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
  ctx.fillStyle = ctx.strokeStyle = color
  ctx.lineCap = ctx.lineJoin = 'round'
  const first = points[0]
  if (start === 0 && first) {
    ctx.beginPath()
    ctx.arc(first.x, first.y, width(first) / 2, 0, Math.PI * 2)
    ctx.fill()
  }
  for (let i = Math.max(1, start); i < points.length; i++) {
    const point = points[i - 1]
    const from = i === 1 ? point : midpoint(points[i - 2], point)
    const to = midpoint(point, points[i])
    ctx.lineWidth = width(point)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.quadraticCurveTo(point.x, point.y, to.x, to.y)
    ctx.stroke()
  }
  if (finish && points.length > 1) {
    const last = points[points.length - 1]
    const from = midpoint(points[points.length - 2], last)
    ctx.lineWidth = width(last)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(last.x, last.y)
    ctx.stroke()
  }
  ctx.restore()
}

export function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame, board: Artboard, background = true) {
  const { width, height } = ctx.canvas
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.scale(width / board.width, height / board.height)
  frame.strokes.forEach(stroke => paintStroke(ctx, stroke))
  ctx.restore()
  if (background) {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = board.background
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }
}


export function hitsVisibleClippedInk(stroke: Stroke, region: Region) {
  if (!stroke.clips?.length) return true
  const polygon = regionPolygon(region)
  const box = lineBounds([stroke])!
  const left = Math.max(box.left, Math.min(...polygon.map(p => p.x)))
  const top = Math.max(box.top, Math.min(...polygon.map(p => p.y)))
  const width = Math.min(box.right, Math.max(...polygon.map(p => p.x))) - left
  const height = Math.min(box.bottom, Math.max(...polygon.map(p => p.y))) - top
  if (width <= 0 || height <= 0) return false
  const scale = Math.min(1, 768 / Math.max(width, height))
  const canvas = surface(Math.ceil(width * scale), Math.ceil(height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale)
  ctx.beginPath()
  polygon.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y))
  ctx.closePath()
  ctx.clip('evenodd')
  paintStroke(ctx, stroke)
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0)
}
