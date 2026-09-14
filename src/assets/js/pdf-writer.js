/**
 * Minimal, dependency-free PDF 1.7 writer for image documents.
 *
 * - JPEG data is embedded as-is (DCTDecode), so originals keep 100% of their quality.
 * - Raw RGB pixels are embedded losslessly with FlateDecode.
 * - Output is streamed into Blob parts, so large documents don't need one huge buffer.
 */

const encoder = new TextEncoder();

/** Page sizes in PDF points (1/72 inch), portrait orientation. */
export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  legal: [612, 1008],
  a3: [841.89, 1190.55],
  a5: [419.53, 595.28],
};

export const MARGINS = { none: 0, small: 20, large: 40 };

const MAX_PAGE_PT = 14400; // PDF implementation limit (200 inches)

/* ------------------------------------------------------------------ JPEG */

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function readExifOrientation(b, tiff, end) {
  if (tiff + 8 > end) return 1;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) =>
    (le ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) break;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

/**
 * Reads the frame header and EXIF orientation of a JPEG.
 * @param {Uint8Array} b
 * @returns {{width:number,height:number,components:number,precision:number,sof:number,adobe:boolean,orientation:number}|null}
 */
export function parseJpeg(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let orientation = 1;
  let adobe = false;
  let frame = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const start = i + 4;
    const end = Math.min(b.length, i + 2 + len);
    if (len < 2) break;

    if (marker === 0xe1 && len >= 16 && b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 && b[start + 3] === 0x66) {
      orientation = readExifOrientation(b, start + 6, end);
    } else if (marker === 0xee && len >= 7 && b[start] === 0x41 && b[start + 1] === 0x64 && b[start + 2] === 0x6f && b[start + 3] === 0x62 && b[start + 4] === 0x65) {
      adobe = true;
    } else if (SOF_MARKERS.has(marker) && !frame && start + 6 <= b.length) {
      frame = {
        sof: marker,
        precision: b[start],
        height: (b[start + 1] << 8) | b[start + 2],
        width: (b[start + 3] << 8) | b[start + 4],
        components: b[start + 5],
      };
    }
    i += 2 + len;
  }
  return frame && frame.width > 0 && frame.height > 0 ? { ...frame, adobe, orientation } : null;
}

/** True when a parsed JPEG can be copied into the PDF byte-for-byte. */
export function isJpegEmbeddable(info) {
  return (
    !!info &&
    (info.sof === 0xc0 || info.sof === 0xc1 || info.sof === 0xc2) &&
    info.precision === 8 &&
    (info.components === 1 || info.components === 3 || info.components === 4)
  );
}

/** Maps pure-rotation EXIF orientations to clockwise degrees. Mirrored values return null. */
export function exifRotation(orientation) {
  return { 1: 0, 3: 180, 6: 90, 8: 270 }[orientation] ?? null;
}

/* ---------------------------------------------------------------- layout */

/**
 * Computes the page size and where the image goes on it.
 * imgW/imgH are the displayed pixel dimensions (after rotation).
 */
export function layoutPage({ imgW, imgH, pageSize = 'a4', orientation = 'auto', margin = 'small', fit = 'contain' }) {
  const m = MARGINS[margin] ?? 0;

  if (pageSize === 'fit') {
    let w = imgW * 0.75; // 96 px per inch -> 72 pt per inch
    let h = imgH * 0.75;
    const scale = Math.min(1, (MAX_PAGE_PT - 2 * m) / w, (MAX_PAGE_PT - 2 * m) / h);
    w *= scale;
    h *= scale;
    return { pageWidth: w + 2 * m, pageHeight: h + 2 * m, box: { x: m, y: m, w, h }, clip: null };
  }

  const [shortSide, longSide] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
  const landscape = orientation === 'landscape' || (orientation === 'auto' && imgW > imgH);
  const pageWidth = landscape ? longSide : shortSide;
  const pageHeight = landscape ? shortSide : longSide;
  const bw = pageWidth - 2 * m;
  const bh = pageHeight - 2 * m;
  const scale = fit === 'cover' ? Math.max(bw / imgW, bh / imgH) : Math.min(bw / imgW, bh / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return {
    pageWidth,
    pageHeight,
    box: { x: m + (bw - w) / 2, y: m + (bh - h) / 2, w, h },
    clip: fit === 'cover' ? { x: m, y: m, w: bw, h: bh } : null,
  };
}

/** Transformation matrix that draws the unit-square image into box, rotated clockwise. */
export function placementMatrix(rotation, { x, y, w, h }) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, -h, w, 0, x, y + h];
    case 180:
      return [-w, 0, 0, -h, x + w, y + h];
    case 270:
      return [0, h, -w, 0, x + w, y];
    default:
      return [w, 0, 0, h, x, y];
  }
}

/* ---------------------------------------------------------------- writer */

const num = (n) => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

function pdfText(str) {
  let hex = 'FEFF';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${offset >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`;
}

function randomHex(bytes = 16) {
  const arr = new Uint8Array(bytes);
  (globalThis.crypto || {}).getRandomValues?.(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class PdfWriter {
  #chunks = [];
  #offset = 0;
  #offsets = [];
  #pages = [];
  #next = 4; // 1 = Catalog, 2 = Pages, 3 = Info
  #meta;

  constructor({ title = 'Images', producer = 'ImageToPDF Pro', creator = 'ImageToPDF Pro' } = {}) {
    this.#meta = { title, producer, creator };
    this.#push('%PDF-1.7\n');
    this.#push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  }

  get pageCount() {
    return this.#pages.length;
  }

  #push(data) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    this.#chunks.push(bytes);
    this.#offset += bytes.byteLength;
  }

  #begin(id) {
    this.#offsets[id] = this.#offset;
    this.#push(`${id} 0 obj\n`);
  }

  /**
   * @param {object} page
   * @param {number} page.pageWidth
   * @param {number} page.pageHeight
   * @param {{x:number,y:number,w:number,h:number}} page.box  Displayed image rectangle in points.
   * @param {{x:number,y:number,w:number,h:number}|null} [page.clip]
   * @param {number} [page.rotation]  Clockwise degrees: 0, 90, 180 or 270.
   * @param {{data:Uint8Array,width:number,height:number,filter:'DCTDecode'|'FlateDecode',colorSpace:string,decode?:number[]}} page.image
   */
  addImagePage({ pageWidth, pageHeight, box, clip = null, rotation = 0, image }) {
    const imageId = this.#next++;
    const contentId = this.#next++;
    const pageId = this.#next++;

    this.#begin(imageId);
    this.#push(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter}${
        image.decode ? ` /Decode [${image.decode.join(' ')}]` : ''
      } /Length ${image.data.byteLength} >>\nstream\n`
    );
    this.#push(image.data);
    this.#push('\nendstream\nendobj\n');

    let ops = 'q\n';
    if (clip) ops += `${num(clip.x)} ${num(clip.y)} ${num(clip.w)} ${num(clip.h)} re W n\n`;
    ops += `${placementMatrix(rotation, box).map(num).join(' ')} cm\n/Im0 Do\nQ\n`;
    const content = encoder.encode(ops);
    this.#begin(contentId);
    this.#push(`<< /Length ${content.byteLength} >>\nstream\n`);
    this.#push(content);
    this.#push('\nendstream\nendobj\n');

    const colorProc = image.colorSpace === 'DeviceGray' ? '/ImageB' : '/ImageC';
    this.#begin(pageId);
    this.#push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> /ProcSet [/PDF ${colorProc}] >> /Contents ${contentId} 0 R >>\nendobj\n`
    );
    this.#pages.push(pageId);
  }

  /** Finalises the document. The writer must not be used afterwards. */
  toBlob() {
    this.#begin(2);
    this.#push(`<< /Type /Pages /Kids [${this.#pages.map((id) => `${id} 0 R`).join(' ')}] /Count ${this.#pages.length} >>\nendobj\n`);

    this.#begin(1);
    this.#push('<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>\nendobj\n');

    const now = pdfDate();
    this.#begin(3);
    this.#push(
      `<< /Title ${pdfText(this.#meta.title)} /Producer ${pdfText(this.#meta.producer)} /Creator ${pdfText(this.#meta.creator)} /CreationDate (${now}) /ModDate (${now}) >>\nendobj\n`
    );

    const xrefOffset = this.#offset;
    const size = this.#next;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id++) {
      xref += `${String(this.#offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
    }
    const id = randomHex();
    xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    this.#push(xref);

    const blob = new Blob(this.#chunks, { type: 'application/pdf' });
    this.#chunks = [];
    return blob;
  }
}
