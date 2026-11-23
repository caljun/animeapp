import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildWorkflow, checkpoint, controlnet, createCleanupHandler } from '../server/cleanup.mjs'
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
const pngHeader = Buffer.alloc(33)
Buffer.from('89504e470d0a1a0a', 'hex').copy(pngHeader)
pngHeader.write('IHDR', 12)
pngHeader.writeUInt32BE(512, 16)
pngHeader.writeUInt32BE(512, 20)
const png = 'data:image/png;base64,' + pngHeader.toString('base64')
const request = (variant = 0, options = {}) => new Request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers },
  body: JSON.stringify({ variant, strength: 55, image: png, rect: { x: 0, y: 0, width: 300, height: 220 } }),
  signal: options.signal,
})

test('all candidates use the requested local models, with stronger denoising from A to C', () => {
  const graphs = [0, 1, 2].map(i => buildWorkflow('koma/example.png', i, 55, 123))
  assert.equal(graphs[0]['1'].inputs.ckpt_name, checkpoint)
  assert.equal(graphs[0]['4'].inputs.control_net_name, controlnet)
  assert.equal(graphs[0]['3'].class_type, 'ImageInvert')
  assert.deepEqual(graphs[0]['9'].inputs.latent_image, ['8', 0])
  assert.ok(graphs[0]['9'].inputs.denoise < graphs[1]['9'].inputs.denoise)
  assert.ok(graphs[1]['9'].inputs.denoise < graphs[2]['9'].inputs.denoise)
})

test('the bridge reports local models and uploads, queues and reads a candidate', async () => {
  const routes = []
  const handler = createCleanupHandler({}, async (address, options) => {
    assert.ok(address.startsWith('http://127.0.0.1:8188/'))
    const path = new URL(address).pathname
    routes.push(path)
    if (path.includes('/object_info/')) {
      const name = path.split('/').at(-1)
      const [field, model] = name === 'CheckpointLoaderSimple' ? ['ckpt_name', checkpoint] : ['control_net_name', controlnet]
      return Response.json({ [name]: { input: { required: { [field]: [[model]] } } } })
    }
    if (path === '/upload/image') {
      assert.equal(options.body.get('image').type, 'image/png')
      return Response.json({ name: 'koma-123.png', subfolder: 'koma' })
    }
    if (path === '/prompt') {
      assert.equal(JSON.parse(options.body).prompt['2'].inputs.image, 'koma/koma-123.png')
      return Response.json({ prompt_id: 'job' })
    }
    if (path === '/history/job') return Response.json({ job: { outputs: { 11: { images: [{ filename: 'candidate.png', subfolder: '' }] } } } })
    if (path === '/view') return new Response(pngHeader, { headers: { 'Content-Type': 'image/png' } })
    throw Error(path)
  })
  assert.deepEqual(await (await handler(new Request(url))).json(), { enabled: true })
  assert.equal((await handler(request(0, { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status, 403)
  assert.equal((await handler(request(9))).status, 400)
  assert.deepEqual(Buffer.from(await (await handler(request())).arrayBuffer()), pngHeader)
  assert.deepEqual(routes.slice(-4), ['/upload/image', '/prompt', '/history/job', '/view'])
  const offline = createCleanupHandler({}, async () => { throw new TypeError('connection refused') })
  assert.equal((await (await offline(new Request(url))).json()).enabled, false)
  assert.equal((await offline(request())).status, 502)
})

test('cancellation deletes and interrupts only the submitted job', async () => {
  const controller = new AbortController()
  const stopped = []
  const handler = createCleanupHandler({}, async (address, options) => {
    const path = new URL(address).pathname
    if (path === '/upload/image') return Response.json({ name: 'koma-123.png', subfolder: 'koma' })
    if (path === '/prompt') return Response.json({ prompt_id: 'owned' })
    if (path === '/history/owned') {
      controller.abort()
      return Response.json({})
    }
    stopped.push([path, JSON.parse(options.body)])
    return new Response(null)
  })
  assert.equal((await handler(request(0, { signal: controller.signal }))).status, 502)
  assert.deepEqual(stopped, [['/queue', { delete: ['owned'] }], ['/interrupt', { prompt_id: 'owned' }]])
})
