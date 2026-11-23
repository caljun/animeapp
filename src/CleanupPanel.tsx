import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { CleanupCandidate, CleanupMode } from './cleanup'

const cleanupStyles = ['A · ラフに忠実', 'B · 滑らかに整理', 'C · 大きく補正']

export type CleanupResult = { mode: CleanupMode; candidates: CleanupCandidate[]; active: number }
export type CleanupPanelProps = {
  busy: boolean; result: CleanupResult | null; error: string; canStart: boolean
  generate: (mode: CleanupMode, strength: number) => void
  choose: (index: number) => void; cancel: () => void; apply: () => void
}

export function CleanupPanel({ busy, result, error, canStart, generate, choose, cancel, apply }: CleanupPanelProps) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [strength, setStrength] = useState(55)
  const [reason, setReason] = useState('')
  const [last, setLast] = useState<CleanupMode | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    async function check() {
      try {
        const response = await fetch('/api/cleanup', { signal: controller.signal })
        const data = await response.json()
        if (controller.signal.aborted) return
        setConnected(data.enabled === true)
        setReason(typeof data.reason === 'string' ? data.reason : '')
      } catch {
        if (!controller.signal.aborted) {
          setConnected(false)
          setReason('ローカルでアプリと ComfyUI を起動してください。')
        }
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [])
  const selected = result?.candidates[result.active]
  function start(mode: CleanupMode) {
    setLast(mode)
    generate(mode, strength)
  }
  return <section className="cleanup-panel" aria-label="AI 線画清書">
    <h3><Sparkles />AI 線画清書</h3>
    <p className="panel-note">{connected === null ? '接続を確認中…'
      : connected ? 'ローカルの ComfyUI で3候補を生成します。API キーは不要です。'
        : `${reason || 'ComfyUI は未接続です。'} デモで編集フローを試せます。`}</p>
    <label className="range-label"><span>補正の強さ</span><output>{strength}%</output>
      <input type="range" min="1" max="100" value={strength} onChange={event => setStrength(Number(event.target.value))} disabled={busy} />
    </label>
    {busy && <p className="cleanup-status" role="status">清書候補を生成中…</p>}
    {error && <p className="cleanup-error" role="alert">{error}</p>}
    {result && <div className="cleanup-results">
      <p className="cleanup-status">{result.mode === 'demo' ? 'デモ結果 · ローカルの平滑化と線抽出' : 'AI 清書候補 · SD 1.5 + ControlNet Scribble'}</p>
      <div className="cleanup-candidates" role="group" aria-label="清書候補">
        {result.candidates.map((candidate, i) => <button key={i} type="button" aria-pressed={result.active === i}
          aria-label={cleanupStyles[i]} title={cleanupStyles[i]} onClick={() => choose(i)}>
          <img src={candidate.thumbnail} alt="" /><span>{'ABC'[i]}</span>
        </button>)}
      </div>
      {selected && <p className="panel-note">{cleanupStyles[result.active]}<br />キャンバスは編集可能な線のプレビューです。{selected.note}</p>}
      {selected && <details className="raster-comparison"><summary>変換前の画像を比較</summary>
        <img src={selected.original} alt="変換前の清書候補画像" />
      </details>}
      <button className="line-primary" onClick={apply} disabled={!selected?.strokes.length}>適用</button>
    </div>}
    <div className="selection-modes cleanup-actions">
      {busy ? <button onClick={cancel}>キャンセル</button> : result ? <>
        <button onClick={cancel}>キャンセル</button>
        <button onClick={() => start(result.mode)} disabled={!canStart || (result.mode === 'ai' && !connected)}>再生成</button>
      </> : <>
        <button className="line-primary" onClick={() => start('ai')} disabled={!canStart || !connected}>AIで清書</button>
        <button onClick={() => start('demo')} disabled={!canStart}>デモで試す</button>
        {error && last && <button onClick={() => start(last)} disabled={!canStart || (last === 'ai' && !connected)}>再試行</button>}
      </>}
    </div>
  </section>
}
