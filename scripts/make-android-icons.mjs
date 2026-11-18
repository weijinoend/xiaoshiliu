import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'assets', 'icon.png')
const foregroundPath = path.join(root, 'assets', 'icon-foreground.png')
const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res')

const findOpaqueBounds = (png) => {
  const { width, height, data } = png
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[((y * width + x) << 2) + 3]
      if (alpha > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, width, height }
  }
  return {
    minX,
    minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  }
}

const sampleBilinear = (png, x, y) => {
  const { width, height, data } = png
  const clampedX = Math.max(0, Math.min(width - 1, x))
  const clampedY = Math.max(0, Math.min(height - 1, y))
  const x0 = Math.floor(clampedX)
  const y0 = Math.floor(clampedY)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const tx = clampedX - x0
  const ty = clampedY - y0

  const out = [0, 0, 0, 0]
  const w00 = (1 - tx) * (1 - ty)
  const w10 = tx * (1 - ty)
  const w01 = (1 - tx) * ty
  const w11 = tx * ty

  const i00 = (y0 * width + x0) << 2
  const i10 = (y0 * width + x1) << 2
  const i01 = (y1 * width + x0) << 2
  const i11 = (y1 * width + x1) << 2

  for (let c = 0; c < 4; c++) {
    out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11
  }
  return out
}

const renderLogoCanvas = (
  source,
  bounds,
  canvasW,
  canvasH,
  logoRatio,
  shape,
  background = [255, 255, 255]
) => {
  const dst = new PNG({ width: canvasW, height: canvasH })
  const [backgroundR, backgroundG, backgroundB] = background
  const baseDim = Math.min(canvasW, canvasH)
  const maxDim = Math.max(bounds.width, bounds.height)
  const targetDim = baseDim * logoRatio
  const drawW = (bounds.width / maxDim) * targetDim
  const drawH = (bounds.height / maxDim) * targetDim
  const offsetX = (canvasW - drawW) / 2
  const offsetY = (canvasH - drawH) / 2
  const radius = shape === 'rounded' ? baseDim * 0.22 : baseDim / 2
  const centerX = (canvasW - 1) / 2
  const centerY = (canvasH - 1) / 2

  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      let maskAlpha = 255
      if (shape === 'circle') {
        const dist = Math.hypot(x - centerX, y - centerY)
        if (dist > radius) {
          maskAlpha = dist < radius + 1 ? Math.round((1 - (dist - radius)) * 255) : 0
        }
      } else if (shape === 'rounded') {
        const minX = Math.min(x, canvasW - 1 - x)
        const minY = Math.min(y, canvasH - 1 - y)
        if (minX < radius && minY < radius) {
          const dist = Math.hypot(radius - minX, radius - minY)
          if (dist > radius) {
            maskAlpha = dist < radius + 1 ? Math.round((1 - (dist - radius)) * 255) : 0
          }
        }
      }

      const idx = (y * canvasW + x) << 2
      if (shape === 'transparent') {
        dst.data[idx] = 0
        dst.data[idx + 1] = 0
        dst.data[idx + 2] = 0
        dst.data[idx + 3] = 0
      } else {
        dst.data[idx] = backgroundR
        dst.data[idx + 1] = backgroundG
        dst.data[idx + 2] = backgroundB
        dst.data[idx + 3] = maskAlpha
      }

      const lx = x - offsetX
      const ly = y - offsetY
      if (lx >= -0.5 && lx <= drawW - 0.5 && ly >= -0.5 && ly <= drawH - 0.5) {
        const sx = bounds.minX + (lx / drawW) * bounds.width
        const sy = bounds.minY + (ly / drawH) * bounds.height
        const [r, g, b, a] = sampleBilinear(source, sx, sy)
        const srcA = (a / 255) * (maskAlpha / 255)
        if (shape === 'transparent') {
          dst.data[idx] = Math.round(r)
          dst.data[idx + 1] = Math.round(g)
          dst.data[idx + 2] = Math.round(b)
          dst.data[idx + 3] = Math.round(a)
        } else if (maskAlpha > 0) {
          const bgA = maskAlpha / 255
          const outA = srcA + bgA * (1 - srcA)
          if (outA > 0) {
            dst.data[idx] = Math.round((r * srcA + backgroundR * bgA * (1 - srcA)) / outA)
            dst.data[idx + 1] = Math.round(
              (g * srcA + backgroundG * bgA * (1 - srcA)) / outA
            )
            dst.data[idx + 2] = Math.round(
              (b * srcA + backgroundB * bgA * (1 - srcA)) / outA
            )
            dst.data[idx + 3] = Math.round(outA * 255)
          }
        }
      }
    }
  }

  return PNG.sync.write(dst)
}

const source = PNG.sync.read(readFileSync(sourcePath))
const bounds = findOpaqueBounds(source)
const foregroundSource = PNG.sync.read(readFileSync(foregroundPath))
const foregroundBounds = findOpaqueBounds(foregroundSource)

const densities = [
  ['mipmap-mdpi', 48, 108],
  ['mipmap-hdpi', 72, 162],
  ['mipmap-xhdpi', 96, 216],
  ['mipmap-xxhdpi', 144, 324],
  ['mipmap-xxxhdpi', 192, 432],
]

for (const [dirName, legacySize, adaptiveSize] of densities) {
  const dir = path.join(resDir, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'ic_launcher.png'),
    renderLogoCanvas(source, bounds, legacySize, legacySize, 0.98, 'rounded', [42, 16, 34])
  )
  writeFileSync(
    path.join(dir, 'ic_launcher_round.png'),
    renderLogoCanvas(source, bounds, legacySize, legacySize, 0.96, 'circle', [42, 16, 34])
  )
  writeFileSync(
    path.join(dir, 'ic_launcher_foreground.png'),
    renderLogoCanvas(
      foregroundSource,
      foregroundBounds,
      adaptiveSize,
      adaptiveSize,
      0.62,
      'transparent'
    )
  )
}

const valuesDir = path.join(resDir, 'values')
mkdirSync(valuesDir, { recursive: true })
writeFileSync(
  path.join(valuesDir, 'ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2A1022</color>\n</resources>\n`
)

for (const entry of readdirSync(resDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('drawable')) {
    continue
  }
  const splashPath = path.join(resDir, entry.name, 'splash.png')
  if (!existsSync(splashPath)) {
    continue
  }
  const existing = PNG.sync.read(readFileSync(splashPath))
  writeFileSync(
    splashPath,
    renderLogoCanvas(source, bounds, existing.width, existing.height, 0.28, 'rect')
  )
}

console.log('Generated Android icons and splash screens for Little Pomegranate from', sourcePath)
