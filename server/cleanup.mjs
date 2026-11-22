import { timingSafeEqual } from 'node:crypto'

export const model = 'gpt-image-2.5-flare'
const variants = [
  'Faithfully ink the original marks, matching the pose, placement and silhouette as closely as possible.',
  'Ink the same drawing with smooth, confident contours. Remove redundant construction lines.',
  'Correct visibly wobbly contours and awkward joins more strongly, while retaining the exact subject, pose, and framing.',
]
const png = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/
const limit = 2_000_000

function squarePng(value) {
  if (typeof value !== 'string' || value.length > limit) return null
  const match = png.exec(value)
  if (!match) return null
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a'
    || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 512
    || bytes.readUInt32BE(20) !== 512) return null
  return bytes
}

function safeToken(value, secret) {
  if (typeof value !== 'string' || value.length > 1024) return false
  const presented = Buffer.from(value)
  const expected = Buffer.from(secret)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export function createCleanupHandler(env = process.env, fetchImage = fetch) {
  return async request => {
    const headers = { 'Cache-Control': 'no-store' }
    const json = (status, body) => Response.json(body, { status, headers })
    const enabled = Boolean(env.OPENAI_API_KEY && env.KOMA_AI_ACCESS_TOKEN?.length >= 16)
    if (request.method === 'GET') return json(200, { enabled, model })
    if (request.method !== 'POST') return json(405, { error: '対応していないリクエストです。' })
    if (!enabled) return json(503, { error: 'AI 接続はサーバーに設定されていません。' })
    if (!safeToken(request.headers.get('x-koma-token'), env.KOMA_AI_ACCESS_TOKEN)) {
      return json(401, { error: '清書用アクセスコードを確認してください。' })
    }
    let input
    try {
      const chunks = []
      let size = 0
      if (request.body) for await (const chunk of request.body) {
        size += chunk.length
        if (size > limit) return json(413, { error: '入力画像が大きすぎます。' })
        chunks.push(chunk)
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return json(400, { error: '入力データを読み取れませんでした。' })
    }
    const { image, mask, rect, strength, variant } = input ?? {}
    const rough = squarePng(image), protection = squarePng(mask)
    if (!rough || !protection || image.length + mask.length > limit || !Number.isInteger(variant)
      || variant < 0 || variant >= variants.length || !Number.isInteger(strength) || strength < 1 || strength > 100
      || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > 4096 || rect.y + rect.height > 4096) {
      return json(400, { error: '選択範囲または画像の形式が不正です。' })
    }

    const form = new FormData()
    form.set('model', model)
    form.set('image', new Blob([rough], { type: 'image/png' }), 'rough.png')
    form.set('mask', new Blob([protection], { type: 'image/png' }), 'protection.png')
    form.set('prompt', [
      'Clean up the input as a monochrome animation cel line drawing. Black ink on plain white.',
      'Keep the sketch register and scale exactly. Do not center, crop, add details, shading, text, or change the framing.',
      'Edit only the transparent areas of the mask. Keep the padding white.',
      variants[variant], `Requested strength: ${strength} out of 100.`,
    ].join(' '))
    form.set('n', '1')
    form.set('size', '1024x1024')
    form.set('quality', 'low')
    form.set('background', 'opaque')
    form.set('output_format', 'webp')
    form.set('output_compression', '75')

    try {
      const result = await fetchImage('https://api.openai.com/v1/images/edits', {
        method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(150_000)]),
      })
      if (!result.ok) {
        const message = result.status === 429 ? 'AI の利用上限に達しました。時間をおいて再試行してください。'
          : result.status === 401 || result.status === 403 ? 'API キーまたはモデルの利用権限を確認してください。'
            : `画像編集サービスが応答エラーを返しました（${result.status}）。`
        return json(502, { error: message })
      }
      const data = (await result.json()).data?.[0]?.b64_json
      if (typeof data !== 'string' || data.length > 2_800_000) return json(502, { error: '画像を受け取れませんでした。' })
      const output = Buffer.from(data, 'base64')
      if (output.toString('ascii', 0, 4) !== 'RIFF' || output.toString('ascii', 8, 12) !== 'WEBP') {
        return json(502, { error: '出力画像の形式が不正です。' })
      }
      return new Response(output, { headers: { ...headers, 'Content-Type': 'image/webp' } })
    } catch {
      return json(502, { error: 'AI 接続が中断されたか、応答時間を超過しました。' })
    }
  }
}
