// Tiny, dependency-free generators for test documents: text PDFs (Helvetica, WinAnsi) and DOCX files.
// Used by e2e/full-scenarios.mjs to build resumes for many job profiles without checked-in binaries.
import zlib from "node:zlib";

// ------------------------------------------------------------------ PDF

const WIN_ANSI = { "–": 0o226, "—": 0o227, "•": 0o225, "’": 0o222, "“": 0o223, "”": 0o224 };

function pdfString(s) {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (WIN_ANSI[ch] !== undefined) out += "\\" + WIN_ANSI[ch].toString(8).padStart(3, "0");
    else if (code >= 32 && code < 127) out += ch;
    else if (code >= 160 && code <= 255) out += "\\" + code.toString(8).padStart(3, "0"); // Latin-1 (é, ñ, ü …)
    else out += "?";
  }
  return out;
}

/** Text-only PDF. `pages` is an array of arrays of lines; a single array of lines is split at ~55 lines per page. */
export function makePdf(linesOrPages, { padBytes = 0 } = {}) {
  let pages = Array.isArray(linesOrPages[0]) ? linesOrPages : [];
  if (!pages.length) {
    const lines = [];
    for (const raw of linesOrPages) {
      let line = raw;
      while (line.length > 100) {
        const cut = line.lastIndexOf(" ", 100) > 0 ? line.lastIndexOf(" ", 100) : 100;
        lines.push(line.slice(0, cut));
        line = "  " + line.slice(cut + 1);
      }
      lines.push(line);
    }
    for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
    if (!pages.length) pages = [[]];
  }
  const objs = []; // index = object number - 1
  const add = (s) => (objs.push(s), objs.length);
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const fontB = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids = [];
  for (const pl of pages) {
    let y = 800;
    let stream = "";
    for (const line of pl) {
      const bold = line.trim() && line === line.toUpperCase() && /[A-Z]/.test(line);
      stream += `BT /${bold ? "F2" : "F1"} 10 Tf 45 ${y} Td (${pdfString(line)}) Tj ET\n`;
      y -= 13;
    }
    const content = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R /F2 ${fontB} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  if (padBytes > 0) body += "%" + "x".repeat(padBytes) + "\n"; // a comment: still a valid PDF, just large
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

// ------------------------------------------------------------------ ZIP / DOCX

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc >>> 0, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** DOCX with one paragraph per line; lines in ALL CAPS (or starting with "# ") become Heading 1. */
export function makeDocx(lines, { macro = false } = {}) {
  const paras = lines.map((l) => {
    const heading = l.startsWith("# ") || (l.trim() && l === l.toUpperCase() && /\p{Lu}/u.test(l));
    const text = l.startsWith("# ") ? l.slice(2) : l;
    const ppr = heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : "";
    return `<w:p>${ppr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;
  const entries = [
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: "word/document.xml", data: doc },
    { name: "word/styles.xml", data: styles },
  ];
  if (macro) entries.push({ name: "word/vbaProject.bin", data: Buffer.from("not really vba") });
  return zip(entries);
}
