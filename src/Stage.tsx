import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { id } from './model'
import type { Artboard, Frame, Point, Stroke } from './model'
import { hitsVisibleClippedInk, paintFrame, paintStroke, surface } from './render'

import { editableLine, insideBounds, lineBounds, regionPolygon, selectLines, transformLines } from './selection'
import type { Region, SelectionMode } from './selection'

export type Tool = Stroke['tool'] | 'hand' | 'select'
export type Onion = { enabled: boolean; previous: boolean; next: boolean; opacity: number }
type Props = {
  board: Artboard; frame: Frame; previous?: Frame; next?: Frame; onion: Onion
  tool: Tool; size: number; color: string; playing: boolean; space: boolean
  mode: SelectionMode; selected: ReadonlySet<string>; preview: Stroke[] | null
  onSelect: (ids: string[], region?: Region) => void; onMove: (dx: number, dy: number) => void
  onStroke: (frameId: string, stroke: Stroke) => void
}
type View = { zoom: number; x: number; y: number }
type Gesture =
  | { pointer: number; type: 'pan'; x: number; y: number }
  | { pointer: number; type: 'region'; points: Point[] }
  | { pointer: number; type: 'move'; origin: Point }
  | { pointer: number; type: 'draw'; frame: Frame; stroke: Stroke; painted: number }
const defaultView: View = { zoom: 1, x: 0, y: 0 }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function Stage({ board, frame, previous, next, onion, tool, size, color, playing, space, mode, selected, preview, onSelect, onMove, onStroke }: Props) {
  const viewport = useRef<HTMLDivElement>(null)
  const display = useRef<HTMLCanvasElement>(null)
  const cache = useRef(new Map<Frame, HTMLCanvasElement>())
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const scheduled = useRef(0)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const [view, setView] = useState(defaultView)
  const [region, setRegion] = useState<Region | null>(null)
  const [offset, setOffset] = useState<Point | null>(null)
  const source = useMemo(() => {
    const strokes = offset ? transformLines(frame.strokes, selected, { dx: offset.x, dy: offset.y })
      : preview ?? frame.strokes
    return strokes === frame.strokes ? frame : { ...frame, strokes }
  }, [frame, offset, selected, preview])
  const baseSelection = useMemo(() => frame.strokes.filter(stroke => selected.has(stroke.id)), [frame, selected])
  const moveBox = useMemo(() => lineBounds(baseSelection.filter(editableLine)), [baseSelection])
  const outline = useMemo(() => {
    const lines = source.strokes.filter(stroke => selected.has(stroke.id))
    return { editable: lineBounds(lines.filter(editableLine)), locked: lines.filter(stroke => stroke.locked) }
  }, [source, selected])

  useLayoutEffect(() => {
    const active = gesture.current
    if (active?.type === 'region' || active?.type === 'move') {
      gesture.current = null
      setRegion(null)
      setOffset(null)
    }
  }, [frame, mode, playing, preview, selected, tool])

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
    let drawing: HTMLCanvasElement
    if (offset && source !== frame) {
      drawing = scratch.current ??= surface(board.width, board.height)
      paintFrame(drawing.getContext('2d')!, source, board, false)
    } else drawing = raster(source)
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
  }, [board, frame, previous, next, onion, playing, raster, source, offset])

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

  function point(event: PointerEvent, bounded = true): Point {
    const rect = display.current!.getBoundingClientRect()
    const x = (event.clientX - rect.left) * board.width / rect.width
    const y = (event.clientY - rect.top) * board.height / rect.height
    return {
      x: bounded ? clamp(x, 0, board.width) : x,
      y: bounded ? clamp(y, 0, board.height) : y,
      ...(event.pointerType === 'pen' && event.pressure > 0 ? { pressure: event.pressure } : {}),
    }
  }

  function down(event: ReactPointerEvent<HTMLDivElement>) {
    if (gesture.current || (event.button !== 0 && event.button !== 1)) return
    if (tool === 'hand' || space || event.button === 1) {
      if (space && document.activeElement instanceof HTMLButtonElement) document.activeElement.blur()
      gesture.current = { type: 'pan', pointer: event.pointerId, x: event.clientX, y: event.clientY }
      setDragging(true)
    } else if (tool === 'select' && !playing && !preview) {
      if (event.target !== display.current) {
        onSelect([])
        return
      }
      const origin = point(event.nativeEvent)
      if (moveBox && !event.shiftKey && insideBounds(moveBox, origin, 5 / scale)) {
        gesture.current = { type: 'move', pointer: event.pointerId, origin }
      } else {
        const points = [origin]
        gesture.current = { type: 'region', pointer: event.pointerId, points }
        setRegion({ mode, points })
      }
    } else {
      if (playing || tool === 'select' || event.target !== display.current) return
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
    } else if (active.type === 'region') {
      updateRegion(active, point(event.nativeEvent))
    } else if (active.type === 'move') {
      setOffset(displacement(active, event.nativeEvent))
    } else {
      const samples = event.nativeEvent.getCoalescedEvents?.()
      for (const sample of samples?.length ? samples : [event.nativeEvent]) append(active, sample)
      schedule()
    }
  }

  function updateRegion(active: Extract<Gesture, { type: 'region' }>, p: Point) {
    if (mode === 'rectangle') active.points[1] = p
    else {
      const last = active.points.at(-1)!
      if (Math.hypot(last.x - p.x, last.y - p.y) >= 1.5 / scale) active.points.push(p)
    }
    setRegion({ mode, points: [...active.points] })
  }

  function displacement(active: Extract<Gesture, { type: 'move' }>, event: PointerEvent): Point {
    const cursor = point(event, false)
    return { x: cursor.x - active.origin.x, y: cursor.y - active.origin.y }
  }

  function end(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const active = gesture.current
    if (!active || active.pointer !== event.pointerId) return
    gesture.current = null
    if (active.type === 'pan') {
      setDragging(false)
    } else if (active.type === 'move') {
      setOffset(null)
      if (commit) {
        const { x, y } = displacement(active, event.nativeEvent)
        onMove(x, y)
      }
    } else if (active.type === 'region') {
      if (commit) {
        const cursor = point(event.nativeEvent)
        updateRegion(active, cursor)
        const origin = active.points[0]
        const hit = 5 / scale
        const isClick = active.points.every(p => Math.hypot(p.x - origin.x, p.y - origin.y) < hit)
        const shape: Region = isClick
          ? { mode: 'rectangle', points: [{ x: cursor.x - hit, y: cursor.y - hit }, { x: cursor.x + hit, y: cursor.y + hit }] }
          : { mode, points: active.points }
        const ids = new Set(selectLines(frame.strokes, shape))
        const visibleIds = frame.strokes.filter(stroke => ids.has(stroke.id) && hitsVisibleClippedInk(stroke, shape)).map(stroke => stroke.id)
        onSelect(isClick ? visibleIds.slice(-1) : visibleIds, isClick ? undefined : shape)
      }
      setRegion(null)
    } else {
      if (commit) {
        append(active, event.nativeEvent)
        onStroke(active.frame.id, active.stroke)
      }
      schedule()
    }
  }

  const placement = {
    width: board.width * scale, height: board.height * scale,
    transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`,
  }
  const guide = (box: NonNullable<typeof moveBox>, locked = false, key?: string) => (
    <rect key={key} x={box.left} y={box.top} width={box.right - box.left} height={box.bottom - box.top}
      className={locked ? 'locked-outline' : 'line-outline'} vectorEffect="non-scaling-stroke" />
  )

  return (
    <section className="stage" aria-label="キャンバス">
      <div className="stage-heading"><span className="artboard-mark" /> キャンバス</div>
      <div className={`viewport ${dragging ? 'grabbing' : tool === 'hand' || space ? 'grab' : playing ? '' : 'draw'}`}
        ref={viewport} onPointerDown={down} onPointerMove={move}
        onPointerUp={event => end(event, true)} onPointerCancel={event => end(event, false)}
        onLostPointerCapture={event => end(event, false)}>
        <canvas ref={display} width={board.width} height={board.height} aria-label="描画キャンバス"
          style={placement} />
        {tool === 'select' && !playing && (region || selected.size > 0) &&
          <svg className="selection-overlay" style={placement} viewBox={`0 0 ${board.width} ${board.height}`} aria-hidden="true">
            {!preview && outline.editable && guide(outline.editable)}
            {outline.locked.map(stroke => guide(lineBounds([stroke])!, true, stroke.id))}
            {region && <polygon className="selection-region" fillRule="evenodd" vectorEffect="non-scaling-stroke"
              points={regionPolygon(region).map(p => `${p.x},${p.y}`).join(' ')} />}
          </svg>}
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
