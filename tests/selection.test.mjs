import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialProject, makeHistory, parseProject, reduce } from '../src/model.ts'
import { deleteLines, duplicateLines, editSelected, selectLines, smoothLines, transformLines } from '../src/selection.ts'

const stroke = (id, points, props = {}) => ({ id, points, size: 8, tool: 'pen', color: '#242235', ...props })
const rectangle = (x, y, right, bottom) => ({ mode: 'rectangle', points: [{ x, y }, { x: right, y: bottom }] })
const line = stroke('ink', [{ x: 0, y: 20 }, { x: 100, y: 20 }])

test('rectangle detects crossing segments and brush edges without sampled points inside', () => {
  const eraser = { ...line, id: 'mask', tool: 'eraser' }
  assert.deepEqual(selectLines([line, eraser], rectangle(41, 15, 45, 23)), ['ink'])
  assert.deepEqual(selectLines([line], rectangle(41, 23, 45, 25)), ['ink'])
  assert.deepEqual(selectLines([line], rectangle(41, 25, 45, 30)), [])
  assert.deepEqual(selectLines([line], rectangle(41, 20, 41, 20)), [])
})

test('concave lasso detects crossing lines and respects its notch and pressure', () => {
  const lasso = { mode: 'lasso', points: [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 65, y: 90 },
    { x: 65, y: 40 }, { x: 35, y: 40 }, { x: 35, y: 90 }, { x: 10, y: 90 },
  ] }
  const hole = stroke('notch', [{ x: 45, y: 65 }, { x: 55, y: 65 }])
  const dot = stroke('dot', [{ x: 5, y: 20, pressure: 0.01 }], { size: 20 })
  assert.deepEqual(selectLines([hole, line, dot], lasso), ['ink'])
})

test('transform, duplicate, delete and style skip locked lines and preserve vector data', () => {
  const locked = { ...line, id: 'locked', locked: true }
  const ink = { ...line, points: [{ x: 0, y: 20, pressure: 0.6 }, line.points[1]] }
  const strokes = [ink, locked]
  const selected = new Set(['ink', 'locked'])
  const moved = transformLines(strokes, selected, { scale: 2, degrees: 90, dx: 10, dy: -30 })
  assert.equal(moved[1], locked)
  assert.ok(Math.abs(moved[0].points[0].x - 60) < 1e-8)
  assert.equal(moved[0].points[0].y, -110)
  assert.equal(moved[0].points[0].pressure, 0.6)
  const copied = duplicateLines(moved, selected)
  assert.equal(copied.strokes.length, 3)
  assert.notEqual(copied.strokes[2].id, ink.id)
  assert.deepEqual(deleteLines(strokes, selected), [locked])
  assert.equal(editSelected(strokes, selected, s => ({ ...s, color: '#ffffff' }))[1], locked)
  assert.equal(editSelected(strokes, selected, s => ({ ...s, locked: false }), true)[1].locked, false)
})

test('smoothing keeps originals, endpoints, pressure and locks, and bounds corrections', () => {
  const sharp = stroke('corner', [{ x: 0, y: 0 }, { x: 50, y: 90, pressure: 0.4 }, { x: 100, y: 0 }])
  const fixed = { ...sharp, id: 'fixed', locked: true }
  const strokes = [sharp, fixed]
  const ids = new Set(['corner', 'fixed'])
  const light = smoothLines(strokes, ids, 'light')
  const strong = smoothLines(strokes, ids, 'strong')
  assert.equal(smoothLines(strokes, ids, 'original'), strokes)
  assert.equal(sharp.points[1].y, 90)
  assert.equal(strong[1], fixed)
  assert.equal(strong[0].points[0], sharp.points[0])
  assert.equal(strong[0].points[2], sharp.points[2])
  assert.equal(strong[0].points[1].pressure, 0.4)
  assert.ok(strong[0].points[1].y < light[0].points[1].y)
  assert.ok(strong[0].points[1].y >= 72)
})

test('frame edits are atomic and scoped, and JSON round trips off-board geometry and locks', () => {
  const base = initialProject()
  const source = { ...base.frames[0], strokes: [line] }
  const other = { id: 'other', strokes: [{ ...line, id: 'other-ink' }] }
  const history = makeHistory({ ...base, frames: [source, other] })
  const selected = new Set(['ink'])
  const transformed = transformLines(source.strokes, selected, { dx: -30 })
  const strokes = editSelected(transformed, selected, s => ({ ...s, locked: true }))
  const action = { type: 'edit-lines', source, strokes }
  const edited = reduce(history, action)
  assert.equal(edited.present.project.frames[1], other)
  assert.equal(reduce(edited, action), edited)
  const switched = reduce(history, { type: 'select', index: 1 })
  assert.equal(reduce(switched, action), switched)
  assert.equal(reduce(edited, { type: 'undo' }).present.project.frames[0], source)
  assert.deepEqual(reduce(reduce(edited, { type: 'undo' }), { type: 'redo' }).present, edited.present)
  assert.deepEqual(parseProject(JSON.stringify(edited.present.project)), edited.present.project)
  const bad = { ...base, frames: [{ ...source, strokes: [{ ...line, locked: 'yes' }] }] }
  assert.throws(() => parseProject(JSON.stringify(bad)))
})
