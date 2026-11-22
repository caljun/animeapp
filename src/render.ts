import type { Artboard, Frame, Point, Stroke } from './model'

export function surface(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, start = 0, finish = true) {
  const { points, size, color, tool } = stroke
  const width = (point: Point) => size * (point.pressure === undefined ? 1 : 0.2 + 0.8 * point.pressure)
  ctx.save()
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
