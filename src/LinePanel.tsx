import { Copy, LockKeyhole, LockKeyholeOpen, RotateCw, Scan, Trash2, WandSparkles } from 'lucide-react'
import type { SelectionMode, Smoothing, Transform } from './selection'
import type { Stroke } from './model'

export type LinePanelProps = {
  mode: SelectionMode; setMode: (mode: SelectionMode) => void; playing: boolean
  strokes: Stroke[]; candidate: Smoothing | null
  choose: (candidate: Smoothing | null) => void; apply: () => void; clear: () => void
  transform: (value: Transform) => void; duplicate: () => void; remove: () => void
  style: (value: { color?: string; size?: number }) => void; lock: (locked: boolean) => void
}

export function LinePanel({ mode, setMode, playing, strokes, candidate, choose, apply, clear, transform,
  duplicate, remove, style, lock }: LinePanelProps) {
  const locked = strokes.filter(stroke => stroke.locked).length
  const free = strokes.length - locked
  const first = strokes.find(stroke => !stroke.locked)
  return (
    <section className="panel-section line-panel" aria-label="選択した線の編集">
      <div className="selection-heading"><Scan /><h2>範囲選択</h2></div>
      <div className="selection-modes" role="group" aria-label="選択方法">
        <button disabled={playing || candidate !== null} aria-pressed={mode === 'rectangle'} onClick={() => setMode('rectangle')}>矩形</button>
        <button disabled={playing || candidate !== null} aria-pressed={mode === 'lasso'} onClick={() => setMode('lasso')}>投げ縄</button>
      </div>
      <div className="selection-info">
        <span aria-live="polite">{strokes.length} 本を選択{locked > 0 && <small><LockKeyhole /> {locked} 本固定</small>}</span>
        <button onClick={clear} disabled={!strokes.length || playing}>選択解除</button>
      </div>
      {candidate !== null ? (
        <div className="smoothing-panel">
          <h3>線の補正候補</h3>
          <div className="smoothing-options" role="group" aria-label="線の補正候補">
            <button aria-pressed={candidate === 'original'} onClick={() => choose('original')}>元の線を維持</button>
            <button aria-pressed={candidate === 'light'} onClick={() => choose('light')}>軽く滑らかにする</button>
            <button aria-pressed={candidate === 'strong'} onClick={() => choose('strong')}>強く滑らかにする</button>
          </div>
          <div className="selection-modes">
            <button onClick={() => choose(null)}>キャンセル</button>
            <button className="line-primary" disabled={playing} onClick={apply}>適用</button>
          </div>
        </div>
      ) : strokes.length > 0 ? (
        <>
          <p className="panel-note selection-tip">{free ? '選択枠の内側をドラッグして移動できます。' : '線を編集するには固定を解除します。'}</p>
          {first && <fieldset className="line-controls" disabled={playing}>
            <form onSubmit={event => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              transform({ scale: Number(data.get('scale')) / 100, degrees: Number(data.get('angle')) })
            }}>
              <label>拡大・縮小 (%)<input name="scale" type="number" min="1" max="1000" step="any" defaultValue="100" required /></label>
              <label>回転 (°)<input name="angle" type="number" min="-360" max="360" step="any" defaultValue="0" required /></label>
              <button type="submit"><RotateCw />変形</button>
            </form>
            <div className="line-style" key={`${first.id}-${first.size}-${first.color}`}>
              <form onSubmit={event => {
                event.preventDefault()
                style({ color: String(new FormData(event.currentTarget).get('color')) })
              }}>
                <label>線の色<input name="color" type="color" defaultValue={first.color} /></label>
                <button type="submit" aria-label="線の色を適用">適用</button>
              </form>
              <form onSubmit={event => {
                event.preventDefault()
                style({ size: Number(new FormData(event.currentTarget).get('size')) })
              }}>
                <label>太さ (px)<input name="size" type="number" min="1" max="200" step="any" defaultValue={first.size} required /></label>
                <button type="submit" aria-label="線の太さを適用">適用</button>
              </form>
            </div>
            <div className="selection-modes">
              <button onClick={duplicate}><Copy />複製</button>
              <button onClick={remove}><Trash2 />削除</button>
            </div>
            <button className="line-primary" onClick={() => choose('original')}><WandSparkles />線を整える</button>
          </fieldset>}
          <div className="selection-modes line-locks">
            {free > 0 && <button onClick={() => lock(true)} disabled={playing}><LockKeyhole />固定</button>}
            {locked > 0 && <button onClick={() => lock(false)} disabled={playing}><LockKeyholeOpen />固定解除</button>}
          </div>
        </>
      ) : <p className="panel-note">キャンバスをドラッグして線を囲みます。クリックで1本ずつ選べます。</p>}
    </section>
  )
}
