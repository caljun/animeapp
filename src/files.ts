import type { Artboard, Frame } from './model'
import { paintFrame, surface } from './render'

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export function fileBase(name: string) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.+$/, '') || 'koma-project'
}

export function exportPng(frame: Frame, board: Artboard): Promise<Blob> {
  const canvas = surface(board.width, board.height)
  paintFrame(canvas.getContext('2d')!, frame, board)
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('PNG を書き出せませんでした。')), 'image/png')
  })
}
