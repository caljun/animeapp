import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  ChevronDown, Download, Eraser, FileDown, Film, FolderOpen, Hand, Image, Layers,
  Pencil, Redo2, Undo2, X,
} from 'lucide-react'
import { Stage } from './Stage'
import type { Onion, Tool } from './Stage'
import { Inspector, swatches } from './Inspector'
import { Timeline } from './Timeline'
import { initialProject, makeHistory, MAX_IMPORT_BYTES, parseProject, reduce } from './model'
import type { Stroke } from './model'
import { usePlayback } from './playback'
import { download, exportPng, fileBase } from './files'

const tools = [
  { id: 'pen', name: 'ペン', key: 'B', icon: Pencil },
  { id: 'eraser', name: '消しゴム', key: 'E', icon: Eraser },
  { id: 'hand', name: '移動', key: 'H', icon: Hand },
] as const

export function App() {
  const [history, dispatch] = useReducer(reduce, undefined, () => makeHistory(initialProject()))
  const { project, index } = history.present
  const [tool, setTool] = useState<Tool>('pen')
  const [sizes, setSizes] = useState({ pen: 8, eraser: 36 })
  const [color, setColor] = useState(swatches[0])
  const [onion, setOnion] = useState<Onion>({ enabled: true, previous: true, next: false, opacity: 0.25 })
  const [loop, setLoop] = useState(true)
  const [space, setSpace] = useState(false)
  const [notice, setNotice] = useState<{ message: string; error?: boolean } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [boardKey, setBoardKey] = useState(0)
  const [name, setName] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const exportMenu = useRef<HTMLDivElement>(null)
  const selectIndex = useCallback((position: number) => dispatch({ type: 'select', index: position }), [])
  const playback = usePlayback(project.fps, project.frames.length, loop, selectIndex)
  const { playing } = playback
  const shown = playing ? playback.preview : index
  const frame = project.frames[shown]
  const brush = tool === 'eraser' ? 'eraser' : 'pen'
  const onStroke = useCallback((frameId: string, stroke: Stroke) => dispatch({ type: 'stroke', frameId, stroke }), [])

  function changeFrame(position: number) {
    playback.cancel()
    selectIndex(position)
  }

  function togglePlay() {
    if (playing) playback.stop()
    else playback.play(index)
  }

  function historyAction(type: 'undo' | 'redo') {
    playback.cancel()
    dispatch({ type })
  }

  function save() {
    const snapshot = name?.trim() ? { ...project, name: name.trim() } : project
    const json = JSON.stringify(snapshot)
    if (new Blob([json]).size > MAX_IMPORT_BYTES) {
      setNotice({ message: 'プロジェクトが 64 MB を超えています。コマを減らしてから保存してください。', error: true })
      return
    }
    download(new Blob([json], { type: 'application/json' }), fileBase(snapshot.name) + '.json')
    setNotice({ message: 'プロジェクトを書き出しました。' })
  }

  async function load(file?: File) {
    if (!file) return
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('64 MB 以下の JSON を選択してください。')
      const next = parseProject(await file.text())
      playback.cancel()
      setName(null)
      setBoardKey(key => key + 1)
      dispatch({ type: 'load', project: next })
      setNotice({ message: 'プロジェクトを読み込みました。' })
    } catch (error) {
      setNotice({ message: error instanceof Error ? error.message : 'ファイルを読み込めませんでした。', error: true })
    }
  }

  async function exportImage(format: 'png' | 'gif') {
    exportMenu.current?.hidePopover()
    setExporting(true)
    try {
      const blob = format === 'png' ? await exportPng(frame, project.canvas)
        : await (await import('./gif')).exportGif(project, loop)
      const suffix = format === 'png' ? `-${shown + 1}.png` : '.gif'
      download(blob, fileBase(project.name) + suffix)
      setNotice({ message: `${format.toUpperCase()} を書き出しました。` })
    } catch {
      setNotice({ message: '画像を書き出せませんでした。', error: true })
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    if (!notice || notice.error) return
    const timer = window.setTimeout(() => setNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    function keyDown(event: KeyboardEvent) {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && key === 's') {
        event.preventDefault()
        if (!event.repeat) save()
        return
      }
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable], [role="tab"]')) return
      if (event.metaKey || event.ctrlKey) {
        if (key === 'z' || key === 'y') {
          event.preventDefault()
          historyAction(key === 'y' || event.shiftKey ? 'redo' : 'undo')
        }
        return
      }
      if (event.altKey) return
      if (key === ' ') {
        if (!(event.target instanceof HTMLElement && event.target.closest('button'))) event.preventDefault()
        setSpace(true)
      }
      if (key === 'b') setTool('pen')
      if (key === 'e') setTool('eraser')
      if (key === 'h') setTool('hand')
      if (key === 'arrowleft' || key === 'arrowright') {
        event.preventDefault()
        const next = shown + (key === 'arrowright' ? 1 : -1)
        if (project.frames[next]) changeFrame(next)
      }
    }
    function keyUp(event: KeyboardEvent) { if (event.key === ' ') setSpace(false) }
    function blur() { setSpace(false) }
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
    }
  })

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Layers /></span>
          <span className="wordmark">KOMA<span> Studio</span></span>
        </div>
        <span className="header-divider" />
        <input className="project-name" aria-label="プロジェクト名" maxLength={100} value={name ?? project.name}
          onChange={event => setName(event.target.value)}
          onBlur={() => { if (name !== null) dispatch({ type: 'rename', value: name }); setName(null) }}
          onKeyDown={event => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') setName(null)
          }} />
        <div className="file-actions">
          <button onClick={() => input.current?.click()}><FolderOpen />開く</button>
          <button onClick={save}><FileDown />保存</button>
          <button className="export-button" popoverTarget="export-options" disabled={exporting}>
            <Download />{exporting ? '書き出し中…' : '書き出し'}<ChevronDown className="chevron" />
          </button>
          <div id="export-options" ref={exportMenu} popover="auto" className="export-menu">
            <button onClick={() => void exportImage('png')}><Image />現在のコマを PNG に</button>
            <button onClick={() => void exportImage('gif')}><Film />アニメーションを GIF に</button>
          </div>
          <input ref={input} type="file" accept=".json,application/json" hidden onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            void load(file)
          }} />
        </div>
      </header>
      <main className="workbench">
        <aside className="toolbar" aria-label="描画ツール">
          <div className="tool-group">
            {tools.map(({ id, name: label, key, icon: Icon }) => (
              <button key={id} className={tool === id ? 'active' : ''} aria-pressed={tool === id}
                title={`${label} (${key})`} onClick={() => setTool(id)}><Icon /><span>{label}</span></button>
            ))}
          </div>
          <label className="toolbar-color" title="描画色を選択"><span style={{ background: color }} />
            <input aria-label="描画色" type="color" value={color} onChange={event => setColor(event.target.value)} />
            色
          </label>
          <div className="tool-group history-tools">
            <button title="元に戻す (Ctrl/⌘ Z)" aria-label="元に戻す" disabled={!history.past.length} onClick={() => historyAction('undo')}><Undo2 /><span>戻す</span></button>
            <button title="やり直す (Ctrl/⌘ Shift Z)" aria-label="やり直す" disabled={!history.future.length} onClick={() => historyAction('redo')}><Redo2 /><span>進む</span></button>
          </div>
        </aside>
        <Stage key={boardKey} board={project.canvas} frame={frame} previous={project.frames[shown - 1]}
          next={project.frames[shown + 1]} onion={onion} tool={tool} size={sizes[brush]} color={color}
          playing={playing} space={space} onStroke={onStroke} />
        <Inspector tool={tool} size={sizes[brush]} setSize={size => setSizes({ ...sizes, [brush]: size })}
          color={color} setColor={setColor} onion={onion} setOnion={setOnion} />
      </main>
      <Timeline board={project.canvas} frames={project.frames} index={shown} fps={project.fps} loop={loop}
        playing={playing} select={changeFrame} togglePlay={togglePlay} toggleLoop={() => setLoop(value => !value)}
        setFps={value => { playback.stop(); dispatch({ type: 'fps', value }) }}
        edit={type => { playback.stop(); dispatch({ type }) }} />
      <footer className="status-bar">
        <span><i className={playing ? 'live' : ''} />{playing ? '再生中' : '編集中'}</span>
        <span><kbd>Space</kbd> + ドラッグで移動 <b>·</b> ホイールでズーム</span>
      </footer>
      {notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
        {notice.message}<button aria-label="通知を閉じる" onClick={() => setNotice(null)}><X /></button>
      </div>}
    </div>
  )
}
