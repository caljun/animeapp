import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'

export const checkpoint = 'v1-5-pruned-emaonly-fp16.safetensors'
export const controlnet = 'control_v11p_sd15_scribble_fp16.safetensors'
const size = 512
const limit = 2_000_000
const styles = [
  'faithful tracing, preserve the original silhouette and pose exactly, keep all important contours',
  'confident smooth ink contours, simplify overlapping sketch lines, precise clean joins',
  'strongly clean shaky contours and irregular joins, simplify construction lines, preserve the pose and composition',
]

export function buildWorkflow(image, variant, strength, seed = randomBytes(4).readUInt32LE()) {
  const control = [1.22, 1.06, 0.94][variant]
  const denoise = [0.43, 0.55, 0.65][variant] + (strength - 55) / 500
  const node = (class_type, inputs) => ({ class_type, inputs })
  return {
    '1': node('CheckpointLoaderSimple', { ckpt_name: checkpoint }),
    '2': node('LoadImage', { image }),
    '3': node('ImageInvert', { image: ['2', 0] }),
    '4': node('ControlNetLoader', { control_net_name: controlnet }),
    '5': node('CLIPTextEncode', { clip: ['1', 1], text: `monochrome anime animation cel cleanup, precise black ink lines on plain white paper, thin contours, ${styles[variant]}` }),
    '6': node('CLIPTextEncode', { clip: ['1', 1], text: 'color, gray fill, shading, hatching, text, watermark, crop, new details, background, perspective change, blurred line' }),
    '7': node('ControlNetApplyAdvanced', { positive: ['5', 0], negative: ['6', 0], control_net: ['4', 0], image: ['3', 0], strength: control, start_percent: 0, end_percent: 1, vae: ['1', 2] }),
    '8': node('VAEEncode', { pixels: ['2', 0], vae: ['1', 2] }),
    '9': node('KSampler', { model: ['1', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['8', 0], seed, steps: 20, cfg: 5.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise }),
    '10': node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] }),
    '11': node('PreviewImage', { images: ['10', 0] }),
  }
}

function squarePng(value) {
  if (typeof value !== 'string' || value.length > limit) return null
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return null
  const bytes = Buffer.from(match[1], 'base64')
  return bytes.length >= 33 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a'
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === size
    && bytes.readUInt32BE(20) === size ? bytes : null
}

async function readBody(request) {
  const chunks = []
  let received = 0
  if (request.body) for await (const chunk of request.body) {
    received += chunk.length
    if (received > limit) throw new RangeError()
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createCleanupHandler(env = process.env, fetchComfy = fetch, pollDelay = 750) {
  const port = env.KOMA_COMFY_PORT ?? '8188'
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('KOMA_COMFY_PORT が不正です。')
  const endpoint = `http://127.0.0.1:${port}`
  let active = 0
  const comfy = (route, options) => fetchComfy(endpoint + route, options)
  const post = (route, body, signal) => comfy(route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  })
  async function modelOptions(node, field, signal) {
    const response = await comfy(`/object_info/${node}`, { signal })
    if (!response.ok) throw new Error()
    return (await response.json())[node]?.input?.required?.[field]?.[0] ?? []
  }

  return async request => {
    const headers = { 'Cache-Control': 'no-store' }
    const json = (status, body) => Response.json(body, { status, headers })
    const origin = request.headers.get('origin')
    const host = request.headers.get('host')
    if (request.headers.get('sec-fetch-site') === 'cross-site'
      || (origin && origin !== `http://${host}` && origin !== `https://${host}`)) {
      return json(403, { error: '同じローカル画面から清書を実行してください。' })
    }
    if (request.method === 'GET') {
      try {
        const signal = AbortSignal.timeout(2500)
        const [checkpoints, controls] = await Promise.all([
          modelOptions('CheckpointLoaderSimple', 'ckpt_name', signal),
          modelOptions('ControlNetLoader', 'control_net_name', signal),
        ])
        const enabled = checkpoints.includes(checkpoint) && controls.includes(controlnet)
        return json(200, { enabled, ...(enabled ? {} : { reason: 'ComfyUI に必要な2つのモデルがありません。' }) })
      } catch {
        return json(200, { enabled: false, reason: 'ローカルの ComfyUI を起動してください。' })
      }
    }
    if (request.method !== 'POST') return json(405, { error: '対応していないリクエストです。' })
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return json(415, { error: '入力画像の形式が不正です。' })
    }
    let input
    try { input = await readBody(request) }
    catch (error) { return json(error instanceof RangeError ? 413 : 400, { error: '入力画像を読み取れませんでした。' }) }
    const { image, rect, variant, strength } = input ?? {}
    const rough = squarePng(image)
    if (!rough || !Number.isInteger(variant) || variant < 0 || variant > 2
      || !Number.isInteger(strength) || strength < 1 || strength > 100 || !rect
      || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width < 1 || rect.height < 1
      || rect.x + rect.width > 4096 || rect.y + rect.height > 4096) {
      return json(400, { error: '選択範囲または画像の形式が不正です。' })
    }
    if (active >= 3) return json(429, { error: '清書を処理中です。少し待ってから再試行してください。' })
    active++
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(900_000)])
    let promptId, completed = false
    try {
      const form = new FormData()
      form.set('image', new Blob([rough], { type: 'image/png' }), `koma-${randomUUID()}.png`)
      form.set('subfolder', 'koma')
      const uploaded = await comfy('/upload/image', { method: 'POST', body: form, signal })
      if (!uploaded.ok) throw new Error('ComfyUI にラフを渡せませんでした。')
      const { name, subfolder } = await uploaded.json()
      if (typeof name !== 'string' || subfolder !== 'koma' || !/^koma-[\da-f-]+\.png$/i.test(name)) throw new Error('ラフの保存先が不正です。')
      signal.throwIfAborted()
      // Obtain the ID even if the client cancels just as ComfyUI accepts the prompt.
      const queued = await post('/prompt', { prompt: buildWorkflow(`${subfolder}/${name}`, variant, strength) }, AbortSignal.timeout(10_000))
      if (!queued.ok) throw new Error('ComfyUI が清書を受け付けませんでした。モデルと起動ログを確認してください。')
      promptId = (await queued.json()).prompt_id
      if (typeof promptId !== 'string' || !/^[\w-]+$/.test(promptId)) throw new Error('清書の処理番号を受け取れませんでした。')
      while (true) {
        signal.throwIfAborted()
        const history = await comfy(`/history/${promptId}`, { signal })
        if (!history.ok) throw new Error('清書の進捗を確認できませんでした。')
        const entry = (await history.json())[promptId]
        if (entry) {
          completed = true
          const output = entry.outputs?.['11']?.images?.[0]
          if (!output || entry.status?.status_str === 'error') {
            throw new Error('ComfyUI での画像生成に失敗しました。起動ログを確認してください。')
          }
          const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: 'temp' })
          const file = await comfy(`/view?${query}`, { signal })
          if (!file.ok || !file.headers.get('content-type')?.startsWith('image/png')) throw new Error('生成画像を読み取れませんでした。')
          return new Response(file.body, { headers: { ...headers, 'Content-Type': 'image/png' } })
        }
        await wait(pollDelay, undefined, { signal })
      }
    } catch (error) {
      const message = signal.aborted ? 'ローカル清書を中断したか、待ち時間を超過しました。'
        : error instanceof TypeError ? 'ComfyUI に接続できません。起動状況を確認してください。' : error.message
      return json(502, { error: message })
    } finally {
      active--
      if (promptId && !completed) {
        // Delete a queued job first, then interrupt only that job if it started.
        const stop = AbortSignal.timeout(2500)
        await post('/queue', { delete: [promptId] }, stop).catch(() => {})
        await post('/interrupt', { prompt_id: promptId }, stop).catch(() => {})
      }
    }
  }
}
