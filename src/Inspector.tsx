import { useEffect, useId, useRef, useState } from 'react'
import { Circle, Layers, Pencil, Pipette, Play } from 'lucide-react'
import type { Onion, Tool } from './Stage'
import { LinePanel } from './LinePanel'
import type { LinePanelProps } from './LinePanel'

export const swatches = ['#242235', '#ffffff', '#8d6bfa', '#ec668a', '#f3a75d', '#f2d46b', '#57c9ac', '#55a4ec']
const tabs = [{ name: '線', icon: Pencil }, { name: '色', icon: Circle }, { name: '動き', icon: Play }]

type Props = {
  tool: Tool; size: number; setSize: (size: number) => void; color: string; setColor: (color: string) => void
  onion: Onion; setOnion: (onion: Onion) => void; lines: LinePanelProps
}

export function Inspector({ tool, size, setSize, color, setColor, onion, setOnion, lines }: Props) {
  const [tab, setTab] = useState(0)
  useEffect(() => { if (tool === 'select') setTab(0) }, [tool])
  const tabId = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  return (
    <aside className="inspector" aria-label="編集パネル">
      <div className="inspector-tabs" role="tablist" aria-label="編集カテゴリ">
        {tabs.map(({ name, icon: Icon }, index) => (
          <button key={name} ref={button => { buttons.current[index] = button }} role="tab" type="button"
            id={`${tabId}-${index}`} aria-controls={`${tabId}-panel`} aria-selected={tab === index}
            tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                : (index + tabs.length + (event.key === 'ArrowRight' ? 1 : -1)) % tabs.length
              setTab(next)
              buttons.current[next]?.focus()
            }}><Icon />{name}</button>
        ))}
      </div>
      <div id={`${tabId}-panel`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`}>
        {tab === 0 && tool === 'select' && <LinePanel {...lines} />}
        {tab === 0 && tool !== 'select' && <section className="panel-section">
          <h2>ブラシ設定</h2>
          <label className="range-label"><span>{tool === 'eraser' ? '消しゴム' : 'ペン'}の太さ</span>
            <output>{size} px</output>
            <input type="range" min="1" max="200" value={size} onChange={event => setSize(Number(event.target.value))} />
          </label>
          <div className="brush-preview" aria-hidden="true">
            <span style={{ background: tool === 'eraser' ? '#d3cde8' : color, height: Math.min(size, 28) }} />
          </div>
        </section>}
        {tab === 1 && <section className="panel-section">
          <h2>描画色</h2>
          <div className="color-palette">
            {swatches.map(swatch => <button key={swatch} aria-label={`色 ${swatch.toUpperCase()}`}
              aria-pressed={swatch === color} title={swatch.toUpperCase()} style={{ background: swatch }}
              onClick={() => setColor(swatch)} />)}
          </div>
          <label className="custom-color"><Pipette /><span>{color.toUpperCase()}</span>
            <input aria-label="カスタム色" type="color" value={color} onChange={event => setColor(event.target.value)} />
          </label>
        </section>}
        {tab === 2 && <section className="panel-section">
          <h2>動きの編集</h2>
          <p className="panel-note">中割り生成や動作テンプレートは今後追加予定です。コマの編集と再生はタイムラインで操作できます。</p>
        </section>}
      </div>
      <section className="panel-section onion-section">
        <div className="onion-heading"><Layers /><h2>オニオンスキン</h2>
          <label className="switch" title="オニオンスキンの表示">
            <input type="checkbox" role="switch" aria-label="オニオンスキン" checked={onion.enabled}
              onChange={event => setOnion({ ...onion, enabled: event.target.checked })} /><span />
          </label>
        </div>
        <fieldset disabled={!onion.enabled}>
          <label className="onion-option"><input type="checkbox" checked={onion.previous}
            onChange={event => setOnion({ ...onion, previous: event.target.checked })} />前のコマ</label>
          <label className="onion-option"><input type="checkbox" checked={onion.next}
            onChange={event => setOnion({ ...onion, next: event.target.checked })} />次のコマ</label>
          <label className="range-label"><span>透明度</span><output>{Math.round(onion.opacity * 100)}%</output>
            <input type="range" min="5" max="95" value={Math.round(onion.opacity * 100)}
              onChange={event => setOnion({ ...onion, opacity: Number(event.target.value) / 100 })} />
          </label>
        </fieldset>
      </section>
    </aside>
  )
}
