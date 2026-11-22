import type { Project } from './model'
import { paintFrame, surface } from './render'

export function compressIndices(pixels: Uint8Array) {
  const dictionary = new Map<number, number>()
  const output: number[] = []
  let bits = 0, buffered = 0, width = 9, next = 258
  function emit(code: number) {
    bits |= code << buffered
    buffered += width
    while (buffered >= 8) {
      output.push(bits & 255)
      bits >>>= 8
      buffered -= 8
    }
  }
  emit(256)
  let prefix = pixels[0]
  for (let i = 1; i < pixels.length; i++) {
    const value = pixels[i]
    const pair = prefix * 256 + value
    const found = dictionary.get(pair)
    if (found !== undefined) {
      prefix = found
      continue
    }
    emit(prefix)
    if (next < 4096) {
      dictionary.set(pair, next++)
      if (next > (1 << width) && width < 12) width++
    } else {
      emit(256)
      dictionary.clear()
      next = 258
      width = 9
    }
    prefix = value
  }
  emit(prefix)
  if (next === (1 << width) && width < 12) width++
  emit(257)
  if (buffered) output.push(bits)
  return Uint8Array.from(output)
}

export async function exportGif(project: Project, loop: boolean): Promise<Blob> {
  const scale = Math.min(1, 640 / Math.max(project.canvas.width, project.canvas.height))
  const width = Math.max(1, Math.round(project.canvas.width * scale))
  const height = Math.max(1, Math.round(project.canvas.height * scale))
  const canvas = surface(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const bytes = (...values: number[]) => Uint8Array.from(values)
  const le = (value: number) => [value & 255, value >> 8]
  const ascii = new TextEncoder()
  const chunks: BlobPart[] = [
    ascii.encode('GIF89a'), bytes(...le(width), ...le(height), 0xf7, 0, 0),
  ]
  const palette = new Uint8Array(256 * 3)
  for (let i = 0; i < 216; i++) {
    palette.set([Math.floor(i / 36) * 51, Math.floor(i / 6) % 6 * 51, i % 6 * 51], i * 3)
  }
  for (let i = 0; i < 40; i++) palette.fill(Math.round(i * 255 / 39), (216 + i) * 3, (217 + i) * 3)
  chunks.push(palette)
  if (loop) chunks.push(bytes(0x21, 0xff, 11), ascii.encode('NETSCAPE2.0'), bytes(3, 1, 0, 0, 0))
  const indices = new Uint8Array(width * height)
  for (const [index, frame] of project.frames.entries()) {
    // Yield between frames so input and progress indicators can repaint.
    if (index % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    paintFrame(ctx, frame, project.canvas)
    const pixels = ctx.getImageData(0, 0, width, height).data
    for (let i = 0, j = 0; i < indices.length; i++, j += 4) {
      const r = pixels[j], g = pixels[j + 1], b = pixels[j + 2]
      const qr = Math.round(r / 51), qg = Math.round(g / 51), qb = Math.round(b / 51)
      const gray = Math.round((r + g + b) / 3 * 39 / 255)
      const shade = Math.round(gray * 255 / 39)
      const cubeError = (r - qr * 51) ** 2 + (g - qg * 51) ** 2 + (b - qb * 51) ** 2
      const grayError = (r - shade) ** 2 + (g - shade) ** 2 + (b - shade) ** 2
      indices[i] = cubeError <= grayError ? qr * 36 + qg * 6 + qb : 216 + gray
    }
    const delay = Math.round((index + 1) * 100 / project.fps) - Math.round(index * 100 / project.fps)
    chunks.push(bytes(0x21, 0xf9, 4, 0, ...le(delay), 0, 0))
    chunks.push(bytes(0x2c, 0, 0, 0, 0, ...le(width), ...le(height), 0, 8))
    const compressed = compressIndices(indices)
    for (let i = 0; i < compressed.length; i += 255) {
      const block = compressed.slice(i, i + 255)
      chunks.push(bytes(block.length), block)
    }
    chunks.push(bytes(0))
  }
  chunks.push(bytes(0x3b))
  return new Blob(chunks, { type: 'image/gif' })
}
