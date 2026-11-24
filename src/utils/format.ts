const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

const toDate = (value: string | number | Date): Date | null => {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export const formatDate = (
  value: string | number | Date,
  separator: '/' | '-' = '-'
): string | null => {
  const date = toDate(value)
  if (!date) {
    return null
  }
  return [pad(date.getFullYear(), 4), pad(date.getMonth() + 1), pad(date.getDate())].join(separator)
}

export const monthKey = (value: string | number | Date): string | null => {
  const date = toDate(value)
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}` : null
}

/** 生成图片 Blob 的常用扩展名；动画 GIF 必须保留 .gif，不能落成静态 PNG 文件名。 */
export const imageExtensionFromMime = (mimeType: string): string => {
  const mime = mimeType.toLowerCase()
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    return 'jpg'
  }
  if (mime.includes('webp')) {
    return 'webp'
  }
  if (mime.includes('gif')) {
    return 'gif'
  }
  if (mime.includes('svg')) {
    return 'svg'
  }
  return 'png'
}
