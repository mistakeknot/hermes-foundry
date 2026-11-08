// Resolve a CSS color string (hex, rgb(), oklch(), named, ...) to a 0xRRGGBB number so three.js can use the host's theme.

/** Pure fast path for the forms that need no browser: #rgb, #rrggbb and rgb()/rgba() with plain numbers. */
export function parseSimpleColor(input: string): number | null {
  const s = input.trim().toLowerCase()
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return parseInt(m[1].split('').map((c) => c + c).join(''), 16)
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s)
  if (m) return parseInt(m[1], 16)
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/.exec(s)
  if (m) {
    const c = (v: string) => Math.max(0, Math.min(255, Math.round(parseFloat(v))))
    return (c(m[1]) << 16) | (c(m[2]) << 8) | c(m[3])
  }
  return null
}

let probe: CanvasRenderingContext2D | null | undefined

/** Resolve any CSS color the browser understands; null when it is empty or invalid. */
export function resolveCssColor(input: string): number | null {
  const s = (input ?? '').trim()
  if (!s) return null
  const simple = parseSimpleColor(s)
  if (simple !== null) return simple
  if (probe === undefined) {
    try { probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true }) } catch { probe = null }
  }
  if (!probe) return null
  // An invalid color leaves fillStyle unchanged, so try it against two different sentinels and require the same answer.
  const read = (sentinel: string): number | null => {
    probe!.fillStyle = sentinel
    probe!.fillStyle = s
    probe!.clearRect(0, 0, 1, 1)
    probe!.fillRect(0, 0, 1, 1)
    const d = probe!.getImageData(0, 0, 1, 1).data
    return d[3] === 0 ? null : (d[0] << 16) | (d[1] << 8) | d[2]
  }
  try {
    const a = read('#010203'), b = read('#fdfeff')
    return a !== null && a === b ? a : null
  } catch { return null }
}

/** Perceived brightness 0..1 of a 0xRRGGBB color. */
export function luminance(hex: number): number {
  return (0.2126 * ((hex >> 16) & 255) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255
}
