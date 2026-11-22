import { useEffect, useLayoutEffect, useRef } from 'react'
import { Clapperboard, Copy, Play, Plus, Repeat2, SkipBack, SkipForward, Square, Trash2 } from 'lucide-react'
import type { Artboard, Frame } from './model'
import { MAX_FRAMES } from './model'
import { paintFrame } from './render'

type Props = {
  board: Artboard; frames: Frame[]; index: number; fps: number; loop: boolean; playing: boolean
  select: (index: number) => void; togglePlay: () => void; toggleLoop: () => void
  setFps: (fps: number) => void; edit: (type: 'add' | 'duplicate' | 'delete') => void
}

function Thumbnail({ frame, board }: { frame: Frame; board: Artboard }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scale = Math.min(176 / board.width, 96 / board.height)
  useLayoutEffect(() => {
    paintFrame(ref.current!.getContext('2d')!, frame, board)
  }, [frame, board])
  return <canvas ref={ref} width={Math.max(1, Math.round(board.width * scale))}
    height={Math.max(1, Math.round(board.height * scale))} aria-hidden="true" />
}

export function Timeline({ board, frames, index, fps, loop, playing, select, togglePlay, toggleLoop, setFps, edit }: Props) {
  const list = useRef<HTMLDivElement>(null)
  const selected = useRef<HTMLButtonElement>(null)
  const scrub = useRef<{ id: number; x: number; y: number } | null>(null)
  const raf = useRef(0)
  const selectRef = useRef(select)
  selectRef.current = select

  useLayoutEffect(() => {
    if (scrub.current || !list.current || !selected.current) return
    const rail = list.current.getBoundingClientRect()
    const card = selected.current.getBoundingClientRect()
    if (card.left < rail.left) list.current.scrollLeft += card.left - rail.left - 16
    if (card.right > rail.right) list.current.scrollLeft += card.right - rail.right + 16
  }, [index, frames.length])

  function scrubAt(x: number, y: number) {
    const element = list.current!
    const bounds = element.getBoundingClientRect()
    const target = document.elementFromPoint(
      Math.min(bounds.right - 2, Math.max(bounds.left + 2, x)),
      Math.min(bounds.bottom - 15, Math.max(bounds.top + 14, y)),
    )?.closest<HTMLButtonElement>('[data-frame]')
    if (target && element.contains(target)) selectRef.current(Number(target.dataset.frame))
  }

  function edgeScroll() {
    const active = scrub.current
    const element = list.current
    if (!active || !element) return
    const bounds = element.getBoundingClientRect()
    if (active.x < bounds.left + 24) element.scrollLeft -= 12
    if (active.x > bounds.right - 24) element.scrollLeft += 12
    scrubAt(active.x, active.y)
    raf.current = requestAnimationFrame(edgeScroll)
  }

  function endScrub() {
    scrub.current = null
    cancelAnimationFrame(raf.current)
  }

  useEffect(() => () => cancelAnimationFrame(raf.current), [])
  const rates = [...new Set([1, 6, 8, 10, 12, 15, 18, 24, 25, 30, 48, 50, 60, fps])].sort((a, b) => a - b)
  const full = frames.length >= MAX_FRAMES

  return (
    <section className="timeline" aria-label="タイムライン">
      <div className="timeline-bar">
        <div className="timeline-name"><Clapperboard />タイムライン</div>
        <div className="transport">
          <button aria-label="前のコマ" title="前のコマ" disabled={index === 0} onClick={() => select(index - 1)}><SkipBack /></button>
          <button className="play-button" aria-label={playing ? '停止' : '再生'} title={playing ? '停止' : '再生'}
            onClick={togglePlay}>{playing ? <Square fill="currentColor" /> : <Play fill="currentColor" />}</button>
          <button aria-label="次のコマ" title="次のコマ" disabled={index === frames.length - 1} onClick={() => select(index + 1)}><SkipForward /></button>
          <button className={loop ? 'loop-on' : ''} aria-label="ループ再生" title="ループ再生" aria-pressed={loop} onClick={toggleLoop}><Repeat2 /></button>
          <span className="transport-divider" />
          <label className="fps-control"><select aria-label="FPS" value={fps} onChange={event => setFps(Number(event.target.value))}>
            {rates.map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
          </select></label>
          <span className="frame-counter" aria-label="現在のコマ番号"><b>{String(index + 1).padStart(2, '0')}</b><span>/</span>{String(frames.length).padStart(2, '0')}</span>
        </div>
        <div className="frame-actions">
          <button aria-label="コマを複製" title="コマを複製" onClick={() => edit('duplicate')} disabled={full}><Copy /></button>
          <button aria-label="コマを削除" title="コマを削除" onClick={() => edit('delete')} disabled={frames.length === 1}><Trash2 /></button>
          <button className="add-frame" onClick={() => edit('add')} disabled={full}><Plus />コマを追加</button>
        </div>
      </div>
      <div className="frame-rail" ref={list}
        onPointerDown={event => {
          const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-frame]')
          if (event.button !== 0 || !target || scrub.current) return
          scrub.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          event.currentTarget.setPointerCapture(event.pointerId)
          target.focus({ preventScroll: true })
          select(Number(target.dataset.frame))
          raf.current = requestAnimationFrame(edgeScroll)
        }}
        onPointerMove={event => {
          if (scrub.current?.id !== event.pointerId) return
          scrub.current.x = event.clientX
          scrub.current.y = event.clientY
          scrubAt(event.clientX, event.clientY)
        }}
        onPointerUp={endScrub} onPointerCancel={endScrub} onLostPointerCapture={endScrub}>
        {frames.map((frame, i) => (
          <button key={frame.id} ref={i === index ? selected : undefined} data-frame={i}
            aria-label={`コマ ${i + 1}`} aria-current={i === index ? 'true' : undefined}
            className={`frame-card ${i === index ? 'current' : ''}`}
            onClick={event => { if (event.detail === 0) select(i) }}>
            <Thumbnail frame={frame} board={board} />
            <span className="frame-label"><span>{String(i + 1).padStart(2, '0')}</span>{i === index && <i />}</span>
          </button>
        ))}
        <button className="rail-add" aria-label="空白のコマを追加" title="空白のコマを追加" onClick={() => edit('add')} disabled={full}><Plus /></button>
      </div>
    </section>
  )
}
