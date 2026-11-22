import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ChevronDown, Download, Eraser, FileDown, Film, FolderOpen, Hand, Image, Layers,
  Pencil, Redo2, Scan, Undo2, X,
} from 'lucide-react'
import { Stage } from './Stage'
import type { Onion, Tool } from './Stage'
import { Inspector, swatches } from './Inspector'
import { Timeline } from './Timeline'
import { initialProject, makeHistory, MAX_IMPORT_BYTES, parseProject, reduce } from './model'
import type { Frame, Stroke } from './model'
import type { CleanupResult } from './CleanupPanel'
import type { CleanupInput, CleanupMode } from './cleanup'
import { archiveRoughs, stageCleanup } from './cleanupScope'
import { deleteLines, duplicateLines, editSelected, smoothLines, transformLines } from './selection'
import type { Region, SelectionMode, Smoothing, Transform } from './selection'
import { usePlayback } from './playback'
import { download, exportPng, fileBase } from './files'

const noSelection: ReadonlySet<string> = new Set()

const tools = [
  { id: 'pen', name: 'ペン', key: 'B', icon: Pencil },
  { id: 'eraser', name: '消しゴム', key: 'E', icon: Eraser },
  { id: 'select', name: '選択', key: 'V', icon: Scan },
  { id: 'hand', name: '移動', key: 'H', icon: Hand },
] as const

export function App() {
  const [history, dispatch] = useReducer(reduce, undefined, () => makeHistory(initialProject()))
  const { project, index } = history.present
  const [tool, setTool] = useState<Tool>('pen')
  const [mode, setMode] = useState<SelectionMode>('rectangle')
  const [selection, setSelection] = useState<{ frameId: string; ids: ReadonlySet<string>; region: Region | null } | null>(null)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [cleanupError, setCleanupError] = useState('')
  const [cleanup, setCleanup] = useState<(CleanupResult & { frame: Frame; input: CleanupInput }) | null>(null)
  const cleanupRequest = useRef<AbortController | null>(null)
  const [candidate, setCandidate] = useState<Smoothing | null>(null)
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
  const selected = !playing && tool === 'select' && selection?.frameId === frame.id ? selection.ids : noSelection
  const selectedStrokes = useMemo(() => frame.strokes.filter(stroke => selected.has(stroke.id)), [frame, selected])
  const preview = useMemo(() => candidate === null || playing || !selected.size ? null
    : smoothLines(frame.strokes, selected, candidate), [frame, selected, candidate, playing])
  const aiPreview = useMemo(() => {
    if (!cleanup || cleanup.frame !== frame || playing) return null
    return stageCleanup(frame, cleanup.input.targets, cleanup.input.polygon, cleanup.candidates[cleanup.active].strokes)
  }, [cleanup, frame, playing])
  const brush = tool === 'eraser' ? 'eraser' : 'pen'
  const onStroke = useCallback((frameId: string, stroke: Stroke) => dispatch({ type: 'stroke', frameId, stroke }), [])

  const resetCleanup = useCallback(() => {
    cleanupRequest.current?.abort()
    cleanupRequest.current = null
    setCleanupBusy(false)
    setCleanup(null)
    setCleanupError('')
  }, [])

  useEffect(() => () => cleanupRequest.current?.abort(), [])

  function clearSelection() {
    resetCleanup()
    setSelection(null)
    setCandidate(null)
  }

  function changeTool(next: Tool) {
    if (next !== tool) clearSelection()
    setTool(next)
  }

  function selectLines(ids: Iterable<string>, region?: Region) {
    if (playing || candidate !== null) return
    resetCleanup()
    const next = new Set(ids)
    setSelection(next.size ? { frameId: frame.id, ids: next, region: region ?? null } : null)
  }

  async function runCleanup(mode: CleanupMode, strength: number, token: string) {
    if (playing || cleanupRequest.current || !selection || !selectedStrokes.some(stroke => !stroke.locked)) return
    setCleanup(null)
    setCleanupError('')
    setCleanupBusy(true)
    const request = new AbortController()
    cleanupRequest.current = request
    try {
      const { prepareCleanup, generateCleanup } = await import('./cleanup')
      request.signal.throwIfAborted()
      const input = prepareCleanup(frame, project.canvas, selected, selection.region)
      const candidates = await generateCleanup(input, mode, strength, token, request.signal)
      if (cleanupRequest.current === request) setCleanup({ frame, input, mode, candidates, active: 0 })
    } catch (error) {
      if (cleanupRequest.current === request) {
        setCleanupError(error instanceof Error ? error.message : '清書候補を取得できませんでした。')
        request.abort()
      }
    } finally {
      if (cleanupRequest.current === request) {
        cleanupRequest.current = null
        setCleanupBusy(false)
      }
    }
  }

  function applyCleanup() {
    if (playing || cleanup?.frame !== frame || !aiPreview?.originals.length) return
    dispatch({ type: 'edit-lines', source: frame, strokes: aiPreview.strokes, archive: archiveRoughs(aiPreview.originals) })
    selectLines(cleanup.candidates[cleanup.active].strokes.map(stroke => stroke.id))
  }

  function commitLines(strokes: Stroke[]) {
    if (!playing && tool === 'select' && strokes !== frame.strokes) {
      dispatch({ type: 'edit-lines', source: frame, strokes })
    }
  }

  function transform(value: Transform) {
    if (candidate !== null || cleanupBusy || cleanup) return
    const next = transformLines(frame.strokes, selected, value)
    if (next !== frame.strokes) setSelection(current => current && { ...current, region: null })
    commitLines(next)
  }

  function removeLines() {
    if (candidate !== null || playing || cleanupBusy || cleanup) return
    commitLines(deleteLines(frame.strokes, selected))
    selectLines(selectedStrokes.filter(stroke => stroke.locked).map(stroke => stroke.id))
  }

  function changeFrame(position: number) {
    playback.cancel()
    if (position !== index || playing) clearSelection()
    selectIndex(position)
  }

  function togglePlay() {
    if (playing) playback.stop()
    else {
      clearSelection()
      playback.play(index)
    }
  }

  function historyAction(type: 'undo' | 'redo') {
    if (playing) return
    clearSelection()
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
      clearSelection()
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
      if (key === 'b') changeTool('pen')
      if (key === 'e') changeTool('eraser')
      if (key === 'h') changeTool('hand')
      if (key === 'v' && !playing) changeTool('select')
      if (key === 'escape' && (cleanupBusy || cleanup || cleanupError)) resetCleanup()
      else if (key === 'escape' && candidate !== null) setCandidate(null)
      else if (key === 'escape') clearSelection()
      if ((key === 'delete' || key === 'backspace') && selected.size && candidate === null && !cleanupBusy && !cleanup) {
        event.preventDefault()
        removeLines()
      }
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
                title={`${label} (${key})`} disabled={id === 'select' && playing} onClick={() => changeTool(id)}><Icon /><span>{label}</span></button>
            ))}
          </div>
          <label className="toolbar-color" title="描画色を選択"><span style={{ background: color }} />
            <input aria-label="描画色" type="color" value={color} onChange={event => setColor(event.target.value)} />
            色
          </label>
          <div className="tool-group history-tools">
            <button title="元に戻す (Ctrl/⌘ Z)" aria-label="元に戻す" disabled={playing || !history.past.length} onClick={() => historyAction('undo')}><Undo2 /><span>戻す</span></button>
            <button title="やり直す (Ctrl/⌘ Shift Z)" aria-label="やり直す" disabled={playing || !history.future.length} onClick={() => historyAction('redo')}><Redo2 /><span>進む</span></button>
          </div>
        </aside>
        <Stage key={boardKey} board={project.canvas} frame={frame} previous={project.frames[shown - 1]}
          next={project.frames[shown + 1]} onion={onion} tool={tool} size={sizes[brush]} color={color}
          playing={playing} space={space} onStroke={onStroke} mode={mode} selected={selected}
          preview={aiPreview?.strokes ?? (cleanupBusy ? frame.strokes : preview)} onSelect={selectLines} onMove={(dx, dy) => transform({ dx, dy })} />
        <Inspector tool={tool} size={sizes[brush]} setSize={size => setSizes({ ...sizes, [brush]: size })}
          color={color} setColor={setColor} onion={onion} setOnion={setOnion}
          lines={{
            mode, setMode, playing, strokes: selectedStrokes, candidate, choose: setCandidate,
            clear: clearSelection, transform, remove: removeLines,
            cleanup: {
              busy: cleanupBusy, result: cleanup, error: cleanupError,
              canStart: !playing && selectedStrokes.some(stroke => !stroke.locked),
              generate: (mode, strength, token) => void runCleanup(mode, strength, token),
              choose: active => setCleanup(current => current && { ...current, active }),
              apply: applyCleanup, cancel: resetCleanup,
            },
            apply: () => {
              if (preview) commitLines(preview)
              setCandidate(null)
            },
            duplicate: () => {
              const copies = duplicateLines(frame.strokes, selected)
              commitLines(copies.strokes)
              selectLines(copies.ids)
            },
            style: value => commitLines(editSelected(frame.strokes, selected, stroke =>
              (value.color === undefined || value.color === stroke.color) && (value.size === undefined || value.size === stroke.size)
                ? stroke : { ...stroke, ...value })),
            lock: locked => commitLines(editSelected(frame.strokes, selected, stroke =>
              Boolean(stroke.locked) === locked ? stroke : { ...stroke, locked }, true)),
          }} />
      </main>
      <Timeline board={project.canvas} frames={project.frames} index={shown} fps={project.fps} loop={loop}
        playing={playing} select={changeFrame} togglePlay={togglePlay} toggleLoop={() => setLoop(value => !value)}
        setFps={value => { playback.stop(); dispatch({ type: 'fps', value }) }}
        edit={type => { if (!playing) { clearSelection(); dispatch({ type }) } }} />
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
