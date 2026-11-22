import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { id } from './model'
import type { Artboard, Frame, Point, Stroke } from './model'
import { paintFrame, paintStroke, surface } from './render'

export type Tool = Stroke['tool'] | 'hand'
export type Onion = { enabled: boolean; previous: boolean; next: boolean; opacity: number }
type Props = {
  board: Artboard; frame: Frame; previous?: Frame; next?: Frame; onion: Onion
  tool: Tool; size: number; color: string; playing: boolean; space: boolean
  onStroke: (frameId: string, stroke: Stroke) => void
}
type View = { zoom: number; x: number; y: number }
type Gesture =
  | { pointer: number; type: 'pan'; x: number; y: number }
  | { pointer: number; type: 'draw'; frame: Frame; stroke: Stroke; painted: number }
const defaultView: View = { zoom: 1, x: 0, y: 0 }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function Stage({ board, frame, previous, next, onion, tool, size, color, playing, space, onStroke }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const display = useRef<HTMLCanvasElement>(null)
  const cache = useRef(new Map<Frame, HTMLCanvasElement>())
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const scheduled = useRef(0)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [view, setView] = useState(defaultView)
  const [dragging, setDragging] = useState(false)
  const fit = Math.min(Math.max(1, bounds.width - 66) / board.width, Math.max(1, bounds.height - 79) / board.height, 1)
  const scale = view.zoom * fit

  useLayoutEffect(() => {
    const element = viewport.current!
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBounds({ width, height })
    })
    resize.observe(element)
    return () => resize.disconnect()
  }, [])

  const raster = useCallback((source: Frame) => {
    const cached = cache.current.get(source)
    if (cached) {
      cache.current.delete(source)
      cache.current.set(source, cached)
      return cached
    }
    const canvas = surface(board.width, board.height)
    paintFrame(canvas.getContext('2d')!, source, board, false)
    cache.current.set(source, canvas)
    if (cache.current.size > 6) cache.current.delete(cache.current.keys().next().value!)
    return canvas
  }, [board])

  const redraw = useCallback(() => {
    const ctx = display.current?.getContext('2d')
    if (!ctx) return
    const active = gesture.current
    let drawing = raster(frame)
    if (!playing && active?.type === 'draw' && active.frame === frame && scratch.current) {
      drawing = scratch.current
      paintStroke(drawing.getContext('2d')!, active.stroke, active.painted, false)
      active.painted = active.stroke.points.length
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = board.background
    ctx.fillRect(0, 0, board.width, board.height)
    if (onion.enabled && !playing) {
      ctx.globalAlpha = onion.opacity
      if (onion.previous && previous) ctx.drawImage(raster(previous), 0, 0)
      if (onion.next && next) ctx.drawImage(raster(next), 0, 0)
      ctx.globalAlpha = 1
    }
    ctx.drawImage(drawing, 0, 0)
  }, [board, frame, previous, next, onion, playing, raster])

  useLayoutEffect(() => {
    if (gesture.current?.type === 'draw' && (gesture.current.frame !== frame || playing)) gesture.current = null
    redraw()
    return () => {
      cancelAnimationFrame(scheduled.current)
      scheduled.current = 0
    }
  }, [redraw])

  function schedule() {
    if (scheduled.current) return
    scheduled.current = requestAnimationFrame(() => {
      scheduled.current = 0
      redraw()
    })
  }

  function changeZoom(factor: number, anchorX = 0, anchorY = 0) {
    setView(current => {
      const zoom = clamp(current.zoom * factor, 0.25, 8)
      const ratio = zoom / current.zoom
      return { zoom, x: anchorX + (current.x - anchorX) * ratio, y: anchorY + (current.y - anchorY) * ratio }
    })
  }

  useEffect(() => {
    const element = viewport.current!
    function wheel(event: WheelEvent) {
      event.preventDefault()
      if (gesture.current) return
      const rect = element.getBoundingClientRect()
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)
      changeZoom(Math.exp(-delta * 0.0015), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  function point(event: PointerEvent): Point {
    const rect = display.current!.getBoundingClientRect()
    return {
      x: clamp((event.clientX - rect.left) * board.width / rect.width, 0, board.width),
      y: clamp((event.clientY - rect.top) * board.height / rect.height, 0, board.height),
      ...(event.pointerType === 'pen' && event.pressure > 0 ? { pressure: event.pressure } : {}),
    }
  }

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current || (event.button !== 0 && event.button !== 1)) return
    if (tool === 'hand' || space || event.button === 1) {
      if (space && document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
      gesture.current = { type: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY }
      setDragging(true)
    } else {
      if (playing || event.target !== display.current) return
      const stroke: Stroke = { id: id(), tool, size, color, points: [point(event.nativeEvent)] }
      const layer = scratch.current ??= surface(board.width, board.height)
      const ctx = layer.getContext('2d')!
      ctx.clearRect(0, 0, board.width, board.height)
      ctx.drawImage(raster(frame), 0, 0)
      gesture.current = { type: 'draw', pointer: event.pointerId, frame, stroke, painted: 0 }
      schedule()
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function append(active: Extract<Gesture, { type: 'draw' }>, event: PointerEvent) {
    const nextPoint = point(event)
    const last = active.stroke.points.at(-1)!
    if (Math.hypot(nextPoint.x - last.x, nextPoint.y - last.y) >= 0.25) {
      if (event.pointerType === 'pen' && nextPoint.pressure === undefined) nextPoint.pressure = last.pressure
      active.stroke.points.push(nextPoint)
    }
  }

  function move(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    if (active.type === 'pan') {
      const dx = event.clientX - active.x
      const dy = event.clientY - active.y
      active.x = event.clientX
      active.y = event.clientY
      setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }))
    } else {
      const samples = event.nativeEvent.getCoalescedEvents?.()
      for (const sample of samples?.length ? samples : [event.nativeEvent]) append(active, sample)
      schedule()
    }
  }

  function end(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    gesture.current = null
    if (active.type === 'pan') {
      setDragging(false)
    } else {
      if (commit) {
        append(active, event.nativeEvent)
        onStroke(active.frame.id, active.stroke)
      }
      schedule()
    }
  }

  return (
    <section className="stage" aria-label="キャンバス">
      <div className="stage-heading"><span className="artboard-mark" /> キャンバス</div>
      <div className={`viewport ${dragging ? 'grabbing' : tool === 'hand' || space ? 'grab' : playing ? '' : 'draw'}`}
        ref={viewport} onPointerDown={down} onPointerMove={move}
        onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)}
        onLostPointerCapture={event => end(event, false)}>
        <canvas ref={display} width={board.width} height={board.height} aria-label="描画キャンバス"
          style={{ width: board.width * scale, height: board.height * scale, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` }} />
      </div>
      <div className="stage-bottom">
        <span className="stage-dimensions">{board.width} × {board.height} px</span>
        <div className="zoom-controls">
          <button aria-label="縮小" title="縮小" onClick={() => changeZoom(1 / 1.25)} disabled={view.zoom <= 0.25}><Minus /></button>
          <span title="実寸に対する表示倍率">{Math.round(scale * 100)}%</span>
          <button aria-label="拡大" title="拡大" onClick={() => changeZoom(1.25)} disabled={view.zoom >= 8}><Plus /></button>
          <button className="fit" aria-label="画面に合わせる" title="画面に合わせる" onClick={() => setView(defaultView)}><Maximize /></button>
        </div>
      </div>
    </section>
  )
}
