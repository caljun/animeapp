import assert from 'node:assert/strict'
import { test } from 'node:test'
import { id, initialProject, makeHistory, parseProject, reduce } from '../src/model.ts'
import { playbackIndex } from '../src/playback.ts'

const ink = () => ({
  id: id(), color: '#242235', size: 8, tool: 'pen',
  points: [{ x: 20, y: 30, pressure: 0.6 }, { x: 40, y: 80 }],
})
const state = () => makeHistory(initialProject())
function draw(history, position = history.present.index, stroke = ink()) {
  return reduce(history, { type: 'stroke', frameId: history.present.project.frames[position].id, stroke })
}

test('starts with one blank 1920 × 1080 frame and 12 fps', () => {
  const { canvas, fps, frames } = initialProject()
  assert.deepEqual(canvas, { width: 1920, height: 1080, background: '#ffffff' })
  assert.equal(fps, 12)
  assert.equal(frames.length, 1)
  assert.deepEqual(frames[0].strokes, [])
})

test('blank and duplicated frames are independently editable', () => {
  const drawn = draw(state())
  const added = reduce(drawn, { type: 'add' })
  assert.equal(added.present.index, 1)
  assert.deepEqual(added.present.project.frames[1].strokes, [])

  const duplicated = reduce(drawn, { type: 'duplicate' })
  const [original, copy] = duplicated.present.project.frames
  assert.notEqual(original.strokes[0].id, copy.strokes[0].id)
  assert.notEqual(original.strokes[0].points[0], copy.strokes[0].points[0])
  assert.deepEqual(original.strokes[0].points, copy.strokes[0].points)
  const edited = draw(duplicated)
  assert.deepEqual(edited.present.project.frames.map(frame => frame.strokes.length), [1, 2])
})

test('undo and redo restore deleted frames, and a new edit clears redo', () => {
  const drawn = draw(state())
  const two = reduce(drawn, { type: 'add' })
  const deleted = reduce(two, { type: 'delete' })
  assert.equal(deleted.present.project.frames.length, 1)
  assert.equal(reduce(deleted, { type: 'delete' }), deleted)
  const undone = reduce(deleted, { type: 'undo' })
  assert.deepEqual(undone.present, two.present)
  assert.deepEqual(reduce(undone, { type: 'redo' }).present, deleted.present)
  assert.equal(draw(undone).future.length, 0)
})

test('project JSON round trips and the loaded project can be edited', () => {
  const edited = reduce(draw(state()), { type: 'fps', value: 24 })
  const project = edited.present.project
  const loaded = parseProject(JSON.stringify(project))
  assert.deepEqual(loaded, project)
  assert.equal(draw(makeHistory(loaded)).present.project.frames[0].strokes.length, 2)
})

test('rejects invalid JSON, empty frames, duplicate IDs, and invalid strokes', () => {
  const { project } = draw(state()).present
  for (const input of [
    '{', 'null', JSON.stringify({ ...project, version: 2 }),
    JSON.stringify({ ...project, frames: [] }),
    JSON.stringify({ ...project, frames: [...project.frames, ...project.frames] }),
    JSON.stringify({ ...project, fps: 0 }),
    JSON.stringify({ ...project, canvas: { ...project.canvas, width: 50_000 } }),
    JSON.stringify({ ...project, frames: [{ ...project.frames[0], strokes: [{ ...ink(), points: [{ x: -1, y: 0 }] }] }] }),
    JSON.stringify({ ...project, frames: [{ ...project.frames[0], strokes: [{ ...ink(), tool: 'unknown' }] }] }),
  ]) {
    assert.throws(() => parseProject(input))
  }
})

test('playback advances by elapsed time, wraps or stops at the end', () => {
  assert.equal(playbackIndex(0, 82, 12, 3, true), 0)
  assert.equal(playbackIndex(0, 84, 12, 3, true), 1)
  assert.equal(playbackIndex(1, 200, 12, 3, true), 0)
  assert.equal(playbackIndex(1, 200, 12, 3, false), 2)
})
