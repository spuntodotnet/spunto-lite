import { isInlineMediaType } from "./task-attachments"

/**
 * How big an image is **as it will be drawn**, read from its header — so a reader can reserve the
 * right box before the bytes arrive, and a timeline does not jump when they do (RFC 0022).
 *
 * Only the four formats the API ever serves inline (`isInlineMediaType`, the download route's own test): nothing else is drawn,
 * so nothing else has proportions worth announcing. The format is read from the **bytes**, not
 * from the declared type — a browser sniffs a PNG labelled `image/jpeg` and draws it anyway, so
 * the size it ends up with is the PNG's.
 *
 * A header, never a decode: a few fixed offsets for PNG, GIF and WebP, a walk over the segment
 * markers up to the first frame for JPEG. No dependency — sharp would decode megabytes to read
 * eight. Anything it does not recognise, or that is cut short, is `null`, never a throw: this runs
 * while a turn is being stored and while a timeline is being read, and an odd file must cost its
 * own dimensions and nothing else.
 */
export type ImageDimensions = { width: number; height: number }

export function imageDimensions(buf: Buffer, mediaType: string): ImageDimensions | null {
  if (!isInlineMediaType(mediaType)) return null
  try {
    const dims = png(buf) ?? gif(buf) ?? webp(buf) ?? jpeg(buf)
    return dims && dims.width > 0 && dims.height > 0 ? dims : null
  } catch {
    // A length that points past the end, mostly — the reads below are bounds-checked by Buffer.
    return null
  }
}

function png(buf: Buffer): ImageDimensions | null {
  // Signature, then IHDR is always the first chunk: length (4), "IHDR" (4), width, height.
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("latin1", 12, 16) !== "IHDR") return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function gif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10 || !/^GIF8[79]a$/.test(buf.toString("latin1", 0, 6))) return null
  // The logical screen, which is what a browser sizes the image to.
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

function webp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null
  switch (buf.toString("latin1", 12, 16)) {
    // Lossy: a VP8 key frame, start code 9d 01 2a, then two 14-bit sizes (the top bits are scale).
    case "VP8 ":
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    // Lossless: signature 0x2f, then width-1 and height-1 packed as 14 bits each.
    case "VP8L": {
      if (buf[20] !== 0x2f) return null
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
    }
    // Extended (alpha, animation, metadata): the canvas, width-1 and height-1 on 24 bits.
    case "VP8X":
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
    default:
      return null
  }
}

/** Start-of-frame markers — every one but DHT (C4), JPG (C8) and DAC (CC), which share the range. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let orientation = 1
  let at = 2
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff) return null
    const marker = buf[at + 1]!
    // Fill bytes before a marker are legal.
    if (marker === 0xff) {
      at++
      continue
    }
    // Markers with no length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    // End of image, or start of scan with no frame before it: nothing more to learn.
    if (marker === 0xd9 || marker === 0xda) return null
    const length = buf.readUInt16BE(at + 2)
    if (length < 2) return null
    const body = at + 4
    if (marker === 0xe1 && orientation === 1 && buf.toString("latin1", body, body + 6) === "Exif\0\0") {
      orientation = exifOrientation(buf.subarray(body + 6, at + 2 + length))
    }
    if (SOF.has(marker)) {
      const height = buf.readUInt16BE(body + 1)
      const width = buf.readUInt16BE(body + 3)
      // 5 to 8 turn the picture a quarter: a browser draws it (`image-orientation: from-image`,
      // the default) with its sides swapped, and so must the box reserved for it.
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
    }
    at += 2 + length
  }
  return null
}

/** The Orientation tag (0x0112) of the first IFD of an EXIF block, or 1 when it isn't there. */
function exifOrientation(tiff: Buffer): number {
  if (tiff.length < 8) return 1
  const order = tiff.toString("latin1", 0, 2)
  if (order !== "II" && order !== "MM") return 1
  const le = order === "II"
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o))
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o))
  if (u16(2) !== 42) return 1
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return 1
    // A SHORT, so its value sits in the first two bytes of the value field.
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}
