import { id } from './model'
import type { Artboard, Frame, Point, Stroke } from './model'
import { paintStroke, surface } from './render'
import { regionPolygon, lineBounds, smoothLines } from './selection'
import type { Region } from './selection'
import { cleanupTargets } from './cleanupScope'
import { traceLineArt } from './vectorize'

const side = 512
export type CleanupMode = 'ai' | 'demo'
export type CleanupCandidate = { strokes: Stroke[]; original: string; thumbnail: string; note: string }
export type CleanupInput = ReturnType<typeof prepareCleanup>

export function prepareCleanup(frame: Frame, board: Artboard, ids: ReadonlySet<string>, region: Region | null) {
  const targets = cleanupTargets(frame, ids)
  const box = lineBounds(targets)
  if (!box) throw new Error('固定されていないペン線を選択してください。')
  const polygon = [...regionPolygon(region ?? {
    mode: 'rectangle', points: [{ x: box.left - 8, y: box.top - 8 }, { x: box.right + 8, y: box.bottom + 8 }],
  })]
  if (polygon.length > 4096) throw new Error('投げ縄が長すぎます。短い範囲で囲い直してください。')
  const minX = Math.min(...polygon.map(p => p.x)), minY = Math.min(...polygon.map(p => p.y))
  const maxX = Math.max(...polygon.map(p => p.x)), maxY = Math.max(...polygon.map(p => p.y))
  const x = Math.max(0, Math.floor(Math.max(minX, box.left - 12)))
  const y = Math.max(0, Math.floor(Math.max(minY, box.top - 12)))
  const width = Math.min(board.width, Math.ceil(Math.min(maxX, box.right + 12))) - x
  const height = Math.min(board.height, Math.ceil(Math.min(maxY, box.bottom + 12))) - y
  if (width < 1 || height < 1) throw new Error('キャンバス内の線を囲んでください。')

  const scale = (side - 24) / Math.max(width, height)
  const left = (side - width * scale) / 2, top = (side - height * scale) / 2
  const mapped = polygon.map(p => ({ x: left + (p.x - x) * scale, y: top + (p.y - y) * scale }))
  const coverage = surface(side, side)
  const mask = coverage.getContext('2d', { willReadFrequently: true })!
  mask.save()
  mask.beginPath()
  mask.rect(left, top, width * scale, height * scale)
  mask.clip()
  mask.beginPath()
  mapped.forEach((p, i) => i === 0 ? mask.moveTo(p.x, p.y) : mask.lineTo(p.x, p.y))
  mask.closePath()
  mask.fill('evenodd')
  const targetIds = new Set(targets.map(stroke => stroke.id))
  mask.setTransform(scale, 0, 0, scale, left - x * scale, top - y * scale)
  for (const stroke of frame.strokes) if (!targetIds.has(stroke.id)) {
    // Remove the protected brush footprint from the allowed mask, with a small margin.
    paintStroke(mask, { ...stroke, tool: 'eraser', size: stroke.size + 4 / scale })
  }
  mask.restore()
  const available = mask.getImageData(0, 0, side, side)
  const allowed = Uint8Array.from({ length: side * side }, (_, i) => available.data[i * 4 + 3] >= 250 ? 1 : 0)
  const protection = surface(side, side)
  const protectionCtx = protection.getContext('2d')!
  const pixels = protectionCtx.createImageData(side, side)
  for (let i = 0; i < allowed.length; i++) pixels.data[i * 4 + 3] = allowed[i] ? 0 : 255
  protectionCtx.putImageData(pixels, 0, 0)

  function renderRough(strokes: readonly Stroke[]) {
    const canvas = surface(side, side)
    const ctx = canvas.getContext('2d')!
    ctx.save()
    ctx.setTransform(scale, 0, 0, scale, left - x * scale, top - y * scale)
    for (const stroke of strokes) paintStroke(ctx, { ...stroke, color: '#000000' })
    ctx.restore()
    ctx.globalCompositeOperation = 'destination-in'
    ctx.drawImage(coverage, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, side, side)
    return canvas
  }
  const rough = renderRough(targets)
  const roughPixels = rough.getContext('2d')!.getImageData(0, 0, side, side).data
  if (!allowed.some((bit, i) => bit && roughPixels[i * 4] < 175)) {
    throw new Error('保護範囲の外に清書できる線がありません。範囲を選び直してください。')
  }
  function toBoard(p: Point) {
    return { ...p, x: x + (p.x - left) / scale, y: y + (p.y - top) / scale }
  }
  return { targets, polygon, allowed, scale, toBoard, renderRough,
    image: rough.toDataURL('image/png'), mask: protection.toDataURL('image/png'), rect: { x, y, width, height } }
}

async function extract(canvas: HTMLCanvasElement, input: CleanupInput): Promise<CleanupCandidate> {
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, side, side)
  const trace = traceLineArt(pixels.data, input.allowed, side, side)
  const strokes = trace.lines.map(line => ({
    id: id(), tool: 'pen' as const, color: input.targets[0].color,
    size: Math.max(1, Math.min(200, line.width / input.scale)),
    points: line.points.map(input.toBoard),
  }))

  // Remove out-of-scope pixels from the comparison image without altering the model response.
  for (let i = 0; i < input.allowed.length; i++) if (!input.allowed[i]) pixels.data.fill(255, i * 4, i * 4 + 4)
  canvas.getContext('2d')!.putImageData(pixels, 0, 0)
  const thumbnail = surface(128, 128)
  thumbnail.getContext('2d')!.drawImage(canvas, 0, 0, 128, 128)
  const note = !strokes.length ? '編集可能な線を抽出できませんでした。'
    : trace.truncated ? '抽出上限に達しました。一部の線が欠けています。'
      : trace.branches ? `中心線 ${strokes.length} 本 · 交差・分岐で分割しています`
        : `中心線 ${strokes.length} 本`
  return { strokes, original: canvas.toDataURL('image/webp', 0.78), thumbnail: thumbnail.toDataURL(), note }
}

export async function generateCleanup(input: CleanupInput, mode: CleanupMode, strength: number, token: string, signal: AbortSignal) {
  const selected = new Set(input.targets.map(stroke => stroke.id))
  return Promise.all([0, 1, 2].map(async variant => {
    signal.throwIfAborted()
    let canvas: HTMLCanvasElement
    if (mode === 'demo') {
      await new Promise(resolve => setTimeout(resolve, 30 * (variant + 1)))
      const adjusted = smoothLines([...input.targets], selected, variant === 0 ? 'original' : variant === 1 ? 'light' : 'strong')
      const amount = strength / 100
      canvas = input.renderRough(adjusted.map((stroke, i) => ({
        ...stroke, points: stroke.points.map((p, j) => {
          const original = input.targets[i].points[j]
          return { ...p, x: original.x + (p.x - original.x) * amount, y: original.y + (p.y - original.y) * amount }
        }),
      })))
    } else {
      const response = await fetch('/api/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Koma-Token': token }, signal,
        body: JSON.stringify({ image: input.image, mask: input.mask, rect: input.rect, strength, variant }),
      })
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error ?? '画像編集サービスに接続できませんでした。')
      }
      const image = await createImageBitmap(await response.blob())
      try {
        if (image.width !== 1024 || image.height !== 1024) throw new Error('出力のサイズが一致しません。')
        canvas = surface(side, side)
        canvas.getContext('2d')!.drawImage(image, 0, 0, side, side)
      } finally { image.close() }
    }
    signal.throwIfAborted()
    return extract(canvas, input)
  }))
}
