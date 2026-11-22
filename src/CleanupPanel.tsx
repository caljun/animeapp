import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { CleanupCandidate, CleanupMode } from './cleanup'

const cleanupStyles = ['A · ラフに忠実', 'B · 滑らかに整理', 'C · 大きく補正']

export type CleanupResult = { mode: CleanupMode; candidates: CleanupCandidate[]; active: number }
export type CleanupPanelProps = {
  busy: boolean; result: CleanupResult | null; error: string; canStart: boolean
  generate: (mode: CleanupMode, strength: number, token: string) => void
  choose: (index: number) => void; cancel: () => void; apply: () => void
}

export function CleanupPanel({ busy, result, error, canStart, generate, choose, cancel, apply }: CleanupPanelProps) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [strength, setStrength] = useState(55)
  const [token, setToken] = useState('')
  const [last, setLast] = useState<CleanupMode | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/cleanup', { signal: controller.signal }).then(response => response.json())
      .then(data => setConnected(data.enabled === true))
      .catch(() => { if (!controller.signal.aborted) setConnected(false) })
    return () => controller.abort()
  }, [])
  const selected = result?.candidates[result.active]
  function start(mode: CleanupMode) {
    setLast(mode)
    generate(mode, strength, token)
  }
  return <section className="cleanup-panel" aria-label="AI 線画清書">
    <h3><Sparkles />AI 線画清書</h3>
    <p className="panel-note">{connected === null ? '接続を確認中…'
      : connected ? 'OpenAI に選択範囲を送り、画像編集を3回実行します。再生成を含め、実行ごとに従量課金されます。'
        : 'AI は未接続です。無料デモで編集フローを試せます。'}</p>
    {connected && <label className="cleanup-token">清書用アクセスコード
      <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" disabled={busy} />
    </label>}
    <label className="range-label"><span>補正の強さ</span><output>{strength}%</output>
      <input type="range" min="1" max="100" value={strength} onChange={event => setStrength(Number(event.target.value))} disabled={busy} />
    </label>
    {busy && <p className="cleanup-status" role="status">清書候補を生成中…</p>}
    {error && <p className="cleanup-error" role="alert">{error}</p>}
    {result && <div className="cleanup-results">
      <p className="cleanup-status">{result.mode === 'demo' ? 'デモ結果 · ローカルの平滑化と線抽出' : 'AI 清書候補 · GPT-Image-2.5 Flare'}</p>
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
        <button onClick={() => start(result.mode)} disabled={!canStart || (result.mode === 'ai' && !token)}>再生成</button>
      </> : <>
        <button className="line-primary" onClick={() => start('ai')} disabled={!canStart || !connected || !token}>AIで清書</button>
        <button onClick={() => start('demo')} disabled={!canStart}>デモで試す</button>
        {error && last && <button onClick={() => start(last)} disabled={!canStart || (last === 'ai' && !token)}>再試行</button>}
      </>}
    </div>
    {busy && last === 'ai' && <p className="panel-note">キャンセルしても送信済みの処理は課金される場合があります。</p>}
  </section>
}
