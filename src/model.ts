export type Point = { x: number; y: number; pressure?: number }
export type StrokeTool = 'pen' | 'eraser'
export type Stroke = { id: string; points: Point[]; color: string; size: number; tool: StrokeTool; locked?: boolean }
export type Frame = { id: string; strokes: Stroke[] }
export type Artboard = { width: number; height: number; background: string }
export type Project = { version: 1; name: string; canvas: Artboard; fps: number; frames: Frame[] }
export type Editor = { project: Project; index: number }
export type History = { past: Editor[]; present: Editor; future: Editor[] }
export type Action =
  | { type: 'load'; project: Project }
  | { type: 'select'; index: number }
  | { type: 'stroke'; frameId: string; stroke: Stroke }
  | { type: 'edit-lines'; source: Frame; strokes: Stroke[] }
  | { type: 'add' | 'duplicate' | 'delete' | 'undo' | 'redo' }
  | { type: 'fps'; value: number }
  | { type: 'rename'; value: string }

export const COORDINATE_LIMIT = 10_000_000
export const MAX_FRAMES = 1000
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024
export const id = () => crypto.randomUUID()
const blank = (): Frame => ({ id: id(), strokes: [] })

export const initialProject = (): Project => ({
  version: 1, name: '無題のアニメーション', canvas: { width: 1920, height: 1080, background: '#ffffff' },
  fps: 12, frames: [blank()],
})

export const makeHistory = (project: Project): History => ({
  past: [], present: { project, index: 0 }, future: [],
})

export function reduce(state: History, action: Action): History {
  const { present, past, future } = state
  const { project, index } = present
  const frames = project.frames
  const commit = (next: Editor): History => ({ past: [...past.slice(-79), present], present: next, future: [] })
  const setFrames = (next: Frame[], selected = index) => commit({
    project: { ...project, frames: next }, index: selected,
  })

  switch (action.type) {
    case 'load': return makeHistory(action.project)
    case 'undo': return past.length ? {
      past: past.slice(0, -1), present: past[past.length - 1], future: [present, ...future],
    } : state
    case 'redo': return future.length ? {
      past: [...past, present], present: future[0], future: future.slice(1),
    } : state
    case 'select': return action.index === index || !frames[action.index] ? state : {
      ...state, present: { project, index: action.index },
    }
    case 'stroke': {
      const target = frames.findIndex(frame => frame.id === action.frameId)
      return target < 0 ? state : setFrames(frames.map((frame, position) => position === target
        ? { ...frame, strokes: [...frame.strokes, action.stroke] } : frame))
    }
    case 'edit-lines':
      return frames[index] !== action.source || action.strokes === action.source.strokes ? state
        : setFrames(frames.map((frame, position) => position === index ? { ...frame, strokes: action.strokes } : frame))
    case 'add':
    case 'duplicate': {
      if (frames.length >= MAX_FRAMES) return state
      const next = blank()
      if (action.type === 'duplicate') {
        next.strokes = frames[index].strokes.map(stroke => ({
          ...stroke, id: id(), points: stroke.points.map(point => ({ ...point })),
        }))
      }
      return setFrames([...frames.slice(0, index + 1), next, ...frames.slice(index + 1)], index + 1)
    }
    case 'delete':
      return frames.length === 1 ? state : setFrames(frames.filter((_, position) => position !== index), Math.min(index, frames.length - 2))
    case 'fps':
      return integer(action.value, 1, 60) && action.value !== project.fps
        ? commit({ index, project: { ...project, fps: action.value } }) : state
    case 'rename': {
      const name = action.value.trim().slice(0, 100)
      return name && name !== project.name ? commit({ index, project: { ...project, name } }) : state
    }
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const hex = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128

export function parseProject(json: string): Project {
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('JSON を読み取れませんでした。') }
  const invalid = () => new Error('対応する KOMA Studio プロジェクト形式ではありません。')
  if (!record(value) || value.version !== 1 || typeof value.name !== 'string' || !value.name.trim()
    || value.name.length > 100 || !integer(value.fps, 1, 60) || !record(value.canvas)
    || !integer(value.canvas.width, 1, 4096) || !integer(value.canvas.height, 1, 4096)
    || !hex(value.canvas.background) || !Array.isArray(value.frames)
    || value.frames.length < 1 || value.frames.length > MAX_FRAMES) throw invalid()

  const { width, height, background } = value.canvas
  const ids = new Set<string>()
  function unique(key: unknown): key is string {
    if (!validId(key) || ids.has(key)) return false
    ids.add(key)
    return true
  }
  const frames: Frame[] = value.frames.map(frame => {
    if (!record(frame) || !unique(frame.id) || !Array.isArray(frame.strokes)) throw invalid()
    const strokes: Stroke[] = frame.strokes.map(stroke => {
      if (!record(stroke) || !unique(stroke.id) || (stroke.tool !== 'pen' && stroke.tool !== 'eraser')
        || (stroke.locked !== undefined && typeof stroke.locked !== 'boolean')
        || !hex(stroke.color) || !finite(stroke.size, 1, 200)
        || !Array.isArray(stroke.points) || !stroke.points.length) throw invalid()
      const points: Point[] = stroke.points.map(point => {
        if (!record(point) || !finite(point.x, -COORDINATE_LIMIT, COORDINATE_LIMIT) || !finite(point.y, -COORDINATE_LIMIT, COORDINATE_LIMIT)
          || (point.pressure !== undefined && !finite(point.pressure, 0, 1))) throw invalid()
        return { x: point.x, y: point.y, ...(point.pressure === undefined ? {} : { pressure: point.pressure }) }
      })
      return { id: stroke.id, tool: stroke.tool, color: stroke.color, size: stroke.size, points, ...(stroke.locked === undefined ? {} : { locked: stroke.locked }) }
    })
    return { id: frame.id, strokes }
  })
  return { version: 1, name: value.name, fps: value.fps, canvas: { width, height, background }, frames }
}
