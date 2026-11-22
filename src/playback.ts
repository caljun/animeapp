import { useEffect, useState } from 'react'

export function playbackIndex(start: number, elapsed: number, fps: number, count: number, loop: boolean) {
  const absolute = start + Math.floor(elapsed * fps / 1000)
  return loop ? absolute % count : Math.min(count - 1, absolute)
}

export function usePlayback(fps: number, count: number, loop: boolean, select: (index: number) => void) {
  const [start, setStart] = useState<number | null>(null)
  const [preview, setPreview] = useState(0)
  const playing = start !== null
  useEffect(() => {
    if (start === null) return
    const first = start
    let handle: number
    const time = performance.now()
    function tick(now: number) {
      const elapsed = Math.max(0, now - time)
      const position = playbackIndex(first, elapsed, fps, count, loop)
      setPreview(position)
      if (!loop && first + Math.floor(elapsed * fps / 1000) >= count) {
        select(position)
        setStart(null)
      } else {
        handle = requestAnimationFrame(tick)
      }
    }
    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [start, fps, count, loop, select])

  return {
    playing, preview,
    play(index: number) {
      const first = !loop && index === count - 1 ? 0 : index
      setPreview(first)
      setStart(first)
    },
    stop() {
      if (playing) select(preview)
      setStart(null)
    },
    cancel() { setStart(null) },
  }
}
