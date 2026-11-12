#!/usr/bin/env node
// Dev-only: renders the band's pills with the sample data from the task
// into a static HTML page, for a quick visual check in light and dark.
// Each pill is also rendered inside an <iframe srcdoc> with no wrapper
// html/body, which is the closest a plain browser gets to reproducing the
// mod runtime's "isInteractive" sandboxed frame - that's where the white
// corner artifact showed up, and where the background:transparent fix
// needs to actually hold.
// Not part of the mod itself. Kept in sync by hand with hooks/register.js.

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
}

const PILL_THEME = {
  five_hour: { bgLight: '#e4f5ef', fgLight: '#0b4a37', bgDark: '#113a30', fgDark: '#9be9cf' },
  seven_day: { bgLight: '#efe7fb', fgLight: '#4a2d7a', bgDark: '#2c1f45', fgDark: '#d2bdf7' },
  input: { bgLight: '#fbe9e7', fgLight: '#7a2b1f', bgDark: '#3a1f1a', fgDark: '#ffab91' },
  output: { bgLight: '#e8f5e9', fgLight: '#1e4a22', bgDark: '#1b3a1e', fgDark: '#a5d6a7' },
  cache: { bgLight: '#e3f0fb', fgLight: '#163f66', bgDark: '#152c3f', fgDark: '#90caf9' },
  cost: { bgLight: '#fdf3d8', fgLight: '#6b5215', bgDark: '#3a2f10', fgDark: '#f4d78a' },
}

// Kept byte-for-byte in sync with hooks/register.js's pillSvg.
function pillSvg({ uid, theme, icon, label, big, sub, barPercent, markerPercent, color, title, width, height }) {
  const hasBar = barPercent != null
  const w = width ?? (hasBar ? 104 : 72)
  const h = height ?? (hasBar ? 30 : 20)
  const padX = 6
  const barW = w - padX * 2
  const fillW = hasBar ? Math.round((Math.max(0, Math.min(100, barPercent)) / 100) * barW) : 0
  const markerX = markerPercent != null ? padX + Math.round((Math.max(0, Math.min(100, markerPercent)) / 100) * barW) : null
  const bg = 'bg_' + uid
  const fg = 'fg_' + uid
  const track = 'track_' + uid
  const marker = 'marker_' + uid

  const row1Y = hasBar ? 10 : Math.round(h / 2) + 3
  const barY = hasBar ? 16 : 0
  const row2Y = hasBar ? 26 : 0

  let bar = ''
  if (hasBar) {
    bar =
      '<rect x="' + padX + '" y="' + barY + '" width="' + barW + '" height="3" rx="1.5" class="' + track + '"/>' +
      '<rect x="' + padX + '" y="' + barY + '" width="' + fillW + '" height="3" rx="1.5" fill="' + color + '"/>'
    if (markerX != null) {
      bar += '<line x1="' + markerX + '" y1="' + (barY - 2) + '" x2="' + markerX + '" y2="' + (barY + 3) + '" class="' + marker + '"/>'
    }
  }

  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" style="background:transparent">' +
    '<title>' + escapeXml(title) + '</title>' +
    '<style>' +
    ':root,html,body,svg{background:transparent !important}' +
    '.' + bg + '{fill:' + theme.bgLight + '} .' + fg + '{fill:' + theme.fgLight + '} .' + track + '{fill:' + theme.bgLight + ';opacity:.55}' +
    ' .' + marker + '{stroke:' + theme.fgLight + ';opacity:.6;stroke-width:1}' +
    '@media (prefers-color-scheme: dark){' +
    '.' + bg + '{fill:' + theme.bgDark + '} .' + fg + '{fill:' + theme.fgDark + '} .' + track + '{fill:' + theme.bgDark + ';opacity:.55}' +
    ' .' + marker + '{stroke:' + theme.fgDark + ';opacity:.7}' +
    '}' +
    'text{font-family:"SF Mono",Menlo,Consolas,monospace}' +
    '</style>' +
    '<rect x="0.5" y="0.5" width="' + (w - 1) + '" height="' + (h - 1) + '" rx="' + Math.round(h / 3) + '" class="' + bg + '"/>' +
    '<text x="' + padX + '" y="' + row1Y + '" font-size="8" class="' + fg + '">' + escapeXml(icon) + ' ' + escapeXml(label) + '</text>' +
    '<text x="' + (w - padX) + '" y="' + row1Y + '" font-size="8.5" font-weight="700" text-anchor="end" class="' + fg + '">' + escapeXml(big) + '</text>' +
    bar +
    (hasBar && sub ? '<text x="' + (w - padX) + '" y="' + row2Y + '" font-size="7" text-anchor="end" class="' + fg + '">' + escapeXml(sub) + '</text>' : '') +
    '</svg>'
  )
}

function barColor(percentUsed) {
  if (percentUsed >= 90) return '#c62828'
  if (percentUsed >= 70) return '#f9a825'
  return '#2e7d32'
}

const PILLS = [
  {
    svg: pillSvg({
      uid: 'five_hour', theme: PILL_THEME.five_hour, icon: '⏱', label: '5h', big: '20%',
      sub: '⏳ 2h 40m', barPercent: 20, markerPercent: 100 - ((2 * 60 + 40) / (5 * 60)) * 100,
      color: barColor(20), title: '5h window: 20.0% used, resets in 2h 40m',
    }),
    w: 104, h: 30,
  },
  {
    svg: pillSvg({
      uid: 'seven_day', theme: PILL_THEME.seven_day, icon: '\u{1F4C5}', label: '7d', big: '58%',
      sub: '⏳ 1d 7h', barPercent: 58, markerPercent: 100 - ((1 * 24 + 7) / (7 * 24)) * 100,
      color: barColor(58), title: '7d window: 58.0% used, resets in 1d 7h',
    }),
    w: 104, h: 30,
  },
  { svg: pillSvg({ uid: 'input', theme: PILL_THEME.input, icon: '↑', label: 'in', big: '15.6k', title: 'Input tokens: 15600' }), w: 72, h: 20 },
  { svg: pillSvg({ uid: 'output', theme: PILL_THEME.output, icon: '↓', label: 'out', big: '3.0k', title: 'Output tokens: 3000' }), w: 72, h: 20 },
  { svg: pillSvg({ uid: 'cache', theme: PILL_THEME.cache, icon: '≡', label: 'cache', big: '954.2k', title: 'Tokens read from cache: 954200' }), w: 72, h: 20 },
  { svg: pillSvg({ uid: 'cost', theme: PILL_THEME.cost, icon: '$', label: 'cost', big: '$4.32', title: 'Session cost: $4.32 (at API list price)' }), w: 72, h: 20 },
]

const inlineRow = PILLS.map((p) => p.svg).join('')
const iframeRow = PILLS
  .map((p) => `<iframe class="pillframe" style="width:${p.w}px;height:${p.h}px" srcdoc="${escapeXml(p.svg)}"></iframe>`)
  .join('')

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; background: #2b2b2b; color: #eee; }
  h3, p { color: #eee; }
  .band { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 10px; background: #1e1e1e; border-radius: 8px; margin: 16px 0; }
  .pillframe { border: 0; display: block; background: transparent; }
</style>
</head>
<body>
  <h3>usage-band — sample data, dark app background (#1e1e1e)</h3>
  <p>Row 1: plain inline &lt;svg&gt; (the "absent isInteractive" / image path). Row 2: each pill inside its own &lt;iframe srcdoc&gt; with no wrapper html/body - the closest a plain browser gets to the mod runtime's isInteractive sandboxed frame, which is where the white-corner bug showed up.</p>
  <div class="band">${inlineRow}</div>
  <div class="band">${iframeRow}</div>
</body>
</html>`

process.stdout.write(html)
