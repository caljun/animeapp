import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCleanupHandler, model } from '../server/cleanup.mjs'
import { archiveRoughs, cleanupTargets, stageCleanup } from '../src/cleanupScope.ts'
import { initialProject, makeHistory, parseProject, reduce } from '../src/model.ts'
import { transformLines } from '../src/selection.ts'
import { traceLineArt } from '../src/vectorize.ts'

test('traces a branching centerline and masks ink outside scope', () => {
  const width = 48, height = 48
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  const allowed = new Uint8Array(width * height).fill(1)
  function ink(x, y) { pixels.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3) }
  for (let x = 4; x < 42; x++) for (let y = 20; y < 25; y++) ink(x, y)
  for (let x = 20; x < 25; x++) for (let y = 5; y < 40; y++) ink(x, y)
  ink(32, 32)
  for (let y = 0; y < height; y++) allowed[y * width + 34] = 0
  const result = traceLineArt(pixels, allowed, width, height)
  assert.ok(result.branches > 0)
  assert.ok(result.lines.some(line => line.width >= 3))
  assert.ok(result.lines.every(line => line.points.every(point => Math.floor(point.x) !== 34)))
  assert.ok(result.lines.every(line => line.points.every(point => point.x !== 32.5 || point.y !== 32.5)))
})

test('regional apply preserves other lines and frames, serializes original archive, and undoes atomically', () => {
  const make = (id, y, locked) => ({ id, tool: 'pen', color: '#333333', size: 5, locked, points: [{ x: 2, y }, { x: 140, y }] })
  const rough = make('rough', 25, false), fixed = make('fixed', 28, true), other = make('other', 70, false)
  const generated = make('new', 24, false)
  const project = initialProject()
  const frame = { ...project.frames[0], strokes: [rough, fixed, other] }
  const extra = { id: 'extra', strokes: [] }
  const history = makeHistory({ ...project, frames: [frame, extra] })
  const polygon = [{ x: 30, y: 12 }, { x: 70, y: 12 }, { x: 70, y: 38 }, { x: 30, y: 38 }]
  const targets = cleanupTargets(frame, new Set(['rough', 'fixed']))
  assert.deepEqual(targets, [rough])
  const preview = stageCleanup(frame, targets, polygon, [generated])
  assert.deepEqual(frame.strokes, [rough, fixed, other])
  const state = reduce(history, { type: 'edit-lines', source: frame, strokes: preview.strokes, archive: archiveRoughs(preview.originals) })
  const updated = state.present.project.frames[0]
  assert.equal(updated.strokes[2], fixed)
  assert.equal(updated.strokes[3], other)
  assert.equal(state.present.project.frames[1], extra)
  assert.deepEqual(updated.roughs[0].points, rough.points)
  assert.equal(updated.strokes[1].clips[0].mode, 'outside')
  assert.equal(updated.strokes[0].clips[0].mode, 'inside')
  assert.deepEqual(parseProject(JSON.stringify(state.present.project)), state.present.project)
  const moved = transformLines(updated.strokes, new Set(['new']), { dx: 10 })
  assert.equal(moved[0].clips[0].polygon[0].x, 40)
  assert.deepEqual(reduce(state, { type: 'undo' }).present, history.present)
  const stale = reduce(history, { type: 'select', index: 1 })
  assert.equal(reduce(stale, { type: 'edit-lines', source: frame, strokes: preview.strokes }), stale)
})

const url = 'http://localhost/api/cleanup'
const env = { OPENAI_API_KEY: 'server-test-key', KOMA_AI_ACCESS_TOKEN: 'tests-only-access-token' }
const proto = Buffer.alloc(33)
Buffer.from('89504e470d0a1a0a', 'hex').copy(proto)
proto.write('IHDR', 12)
proto.writeUInt32BE(512, 16)
proto.writeUInt32BE(512, 20)
const png = 'data:image/png;base64,' + proto.toString('base64')
const request = (token, variant = 0) => new Request(url, {
  method: 'POST', headers: { 'X-Koma-Token': token },
  body: JSON.stringify({ variant, strength: 55, image: png, mask: png, rect: { x: 0, y: 0, width: 300, height: 220 } }),
})

test('API protects paid requests, forwards distinct prompts and fails without fabricating an image', async () => {
  const disabled = createCleanupHandler({})
  assert.deepEqual(await (await disabled(new Request(url))).json(), { enabled: false, model })
  assert.equal((await disabled(request(env.KOMA_AI_ACCESS_TOKEN))).status, 503)
  const prompts = []
  const validOutput = Buffer.from('RIFFxxxxWEBP').toString('base64')
  const handler = createCleanupHandler(env, async (target, options) => {
    assert.equal(target, 'https://api.openai.com/v1/images/edits')
    assert.equal(options.headers.Authorization, 'Bearer server-test-key')
    assert.equal(options.body.get('model'), model)
    assert.equal(options.body.get('mask').type, 'image/png')
    prompts.push(options.body.get('prompt'))
    return Response.json({ data: [{ b64_json: validOutput }] })
  })
  assert.equal((await handler(request('invalid'))).status, 401)
  assert.equal((await handler(request(env.KOMA_AI_ACCESS_TOKEN, 7))).status, 400)
  for (let i = 0; i < 3; i++) assert.equal((await handler(request(env.KOMA_AI_ACCESS_TOKEN, i))).headers.get('Content-Type'), 'image/webp')
  assert.equal(new Set(prompts).size, 3)
  const failure = createCleanupHandler(env, async () => new Response(null, { status: 429 }))
  assert.equal((await failure(request(env.KOMA_AI_ACCESS_TOKEN))).status, 502)
})
