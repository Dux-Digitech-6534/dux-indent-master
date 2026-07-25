// Dux Procurement Portal app icon — the official DUX "DX" brand mark (white)
// on the DUX design-system iris->cyan gradient. Produces adaptive (fg+bg) +
// legacy sources for @capacitor/assets, plus a standalone app-icon.png, and a
// splash source. Brand mark comes from the DUX Design System handoff.
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const OUT = path.join(__dirname, 'assets')
const MARK = path.join(__dirname, 'brand', 'dux-mark-white.png') // white DX glyph, transparent bg
fs.mkdirSync(OUT, { recursive: true })

const S = 1024
const gradSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#5C4DE6"/>' +
  '<stop offset="0.55" stop-color="#4F9FD8"/>' +
  '<stop offset="1" stop-color="#0E9C8B"/></linearGradient></defs>' +
  `<rect width="${S}" height="${S}" fill="url(#g)"/></svg>`

const transparent = () => sharp({ create: { width: S, height: S, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
const gradient = () => sharp(Buffer.from(gradSvg))

;(async () => {
  // legacy/round icon: mark ~58% width, centered on gradient
  const markLegacy = await sharp(MARK).resize({ width: Math.round(S * 0.58) }).png().toBuffer()
  // adaptive foreground: keep inside ~66% safe zone -> ~50% width, centered on transparent
  const markFg = await sharp(MARK).resize({ width: Math.round(S * 0.50) }).png().toBuffer()

  // Full-size composited icon (gradient + mark), reused for legacy + app-icon.
  const iconOnly = await gradient().composite([{ input: markLegacy, gravity: 'center' }]).png().toBuffer()

  await gradient().png().toFile(path.join(OUT, 'icon-background.png'))
  await transparent().composite([{ input: markFg, gravity: 'center' }]).png().toFile(path.join(OUT, 'icon-foreground.png'))
  await sharp(iconOnly).toFile(path.join(OUT, 'icon-only.png'))
  await sharp(iconOnly).resize(512, 512).png().toFile(path.join(OUT, 'app-icon.png'))

  // splash: white mark centered on the dark canvas
  const SP = 2732
  const markSplash = await sharp(MARK).resize({ width: Math.round(SP * 0.26) }).png().toBuffer()
  const dark = () => sharp({ create: { width: SP, height: SP, channels: 4, background: { r: 11, g: 14, b: 23, alpha: 1 } } })
  await dark().composite([{ input: markSplash, gravity: 'center' }]).png().toFile(path.join(OUT, 'splash.png'))
  await dark().composite([{ input: markSplash, gravity: 'center' }]).png().toFile(path.join(OUT, 'splash-dark.png'))

  console.log('ICONS_DONE')
})().catch((e) => { console.error('ICON_ERR', e.message); process.exit(1) })
