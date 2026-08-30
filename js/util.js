/* ============ v2 工具层：DOM辅助 / ZIP(docx)解压 / 时间解析 / CSV ============ */

const U = (() => {

  const ENT = { "&": "&" + "amp;", "<": "&" + "lt;", ">": "&" + "gt;", '"': "&" + "quot;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ENT[c]);
  const fmt = (n) => (n == null || isNaN(n)) ? "0" : (Number.isInteger(+n) ? String(+n) : (+n).toFixed(1));
  const uid = (p) => p + Math.random().toString(36).slice(2, 8);

  /* 毕业总学分最低 167（全校口径）：主修方案(要求=100+)取 max(167, 要求)；辅修/自定义小方案不抬 */
  const MIN_GRAD = 167;
  function reqFloor(total) {
    const t = +total || 0;
    return t >= 100 ? Math.max(MIN_GRAD, t) : t;
  }

  /* ---------- 下载 / CSV ---------- */
  function dl(name, content, mime) {
    const blob = new Blob(["\uFEFF" + content], { type: mime });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
  }
  const csv = (rows) => rows.map(r => r.map(v => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");

  /* ---------- 学期 ---------- */
  // "2026秋" -> {year:2026, season:"秋"}；"3秋" -> {idx:3, season:"秋"}
  function parseTerm(t) {
    const m = String(t || "").match(/^(20\d{2}|(\d))\s*[春夏秋]$/);
    if (!m) return null;
    return m[2] != null ? { grade: +m[2], season: t.slice(-1) } : { year: +m[1], season: t.slice(-1) };
  }
  const seasonOf = (t) => { const p = parseTerm(t); return p ? p.season : null; };

  /* ---------- 上课时间 ----------
     支持: "一3-4" "周一第3,4节" "星期三 6-8节(单周)" "1-2节" "三6-8;五1-2"
     返回 [{d:1..7, s:3, e:4}]；无法解析返回 [] */
  function parseSlots(str) {
    const out = [];
    if (!str) return out;
    const dayMap = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
      "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7 };
    String(str).split(/[;；,，、\s]+/).forEach(seg => {
      seg = seg.replace(/周|星期|第|节|\(|\)|（|）|单周|双周|全周/g, "");
      const m = seg.match(/^([一二三四五六日天1-7])\s*(\d+)\s*[-–—~]\s*(\d+)$/) || seg.match(/^([一二三四五六日天1-7])\s*(\d+)$/);
      if (!m) return;
      const d = dayMap[m[1]], s = +m[2], e = m[3] ? +m[3] : s;
      if (d && s >= 1 && s <= 14 && e >= s) out.push({ d, s, e });
    });
    return out;
  }
  const DAY_CN = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  function slotsText(slots) {
    if (!slots || !slots.length) return "";
    return slots.map(x => `${DAY_CN[x.d]}${x.s === x.e ? x.s : x.s + "-" + x.e}节`).join(" ");
  }
  function slotsOverlap(a, b) {
    return a.d === b.d && a.s <= b.e && b.s <= a.e;
  }

  /* ---------- ZIP(docx) —— 纯浏览器解压，无依赖 ----------
     docx = zip 包；用 DecompressionStream("deflate-raw") 解压 word/document.xml */
  async function unzipDocx(arrayBuffer, wanted = "word/document.xml") {
    const dv = new DataView(arrayBuffer);
    let eocd = -1;
    for (let i = dv.byteLength - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的 docx/zip 文件");
    const u8 = new Uint8Array(arrayBuffer);
    const td = new TextDecoder();
    let ptr = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(ptr, true) !== 0x02014b50) break;
      const method = dv.getUint16(ptr + 10, true);
      const compSize = dv.getUint32(ptr + 20, true);
      const nameLen = dv.getUint16(ptr + 28, true), extraLen = dv.getUint16(ptr + 30, true), cmtLen = dv.getUint16(ptr + 32, true);
      const lfhOff = dv.getUint32(ptr + 42, true);
      const name = td.decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));
      if (name === wanted) {
        const nl = dv.getUint16(lfhOff + 26, true), el = dv.getUint16(lfhOff + 28, true);
        const off = lfhOff + 30 + nl + el;
        const raw = u8.subarray(off, off + compSize);
        if (method === 0) return td.decode(raw);
        if (method === 8 && typeof DecompressionStream !== "function")
          throw new Error("浏览器太旧，不支持在线解压 docx，请改用「粘贴文本」方式导入");
        const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return td.decode(await new Response(stream).arrayBuffer());
      }
      ptr += 46 + nameLen + extraLen + cmtLen;
    }
    throw new Error("docx 中找不到 " + wanted + "（旧版 .doc 请先用 Word 另存为 .docx）");
  }

  /* docx document.xml -> 顺序块列表 [{type:'p'|'tbl', text?, rows?}]
     row = {cells:[{text, span, vMerge:'restart'|'cont'|null}]} */
  function docxBlocks(xml) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const body = doc.getElementsByTagName("w:body")[0];
    const cellText = (tc) => {
      let t = "";
      Array.from(tc.getElementsByTagName("w:t")).forEach(x => t += x.textContent);
      return t.replace(/\u00a0/g, " ").trim();
    };
    const blocks = [];
    Array.from(body.children).forEach(node => {
      if (node.tagName === "w:p") {
        blocks.push({ type: "p", text: cellText(node) });
      } else if (node.tagName === "w:tbl") {
        const rows = [];
        Array.from(node.getElementsByTagName("w:tr")).forEach(tr => {
          const cells = [];
          Array.from(tr.getElementsByTagName("w:tc")).forEach(tc => {
            const tcPr = tc.getElementsByTagName("w:tcPr")[0];
            let span = 1, vMerge = null;
            if (tcPr) {
              const gs = tcPr.getElementsByTagName("w:gridSpan")[0];
              if (gs) span = +gs.getAttribute("w:val") || 1;
              const vm = tcPr.getElementsByTagName("w:vMerge")[0];
              if (vm) vMerge = vm.getAttribute("w:val") === "restart" ? "restart" : "cont";
            }
            cells.push({ text: cellText(tc), span, vMerge });
          });
          rows.push({ cells });
        });
        blocks.push({ type: "tbl", rows });
      }
    });
    return blocks;
  }

  /* ---------- 简易事件 ---------- */
  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  return { esc, fmt, uid, dl, csv, parseTerm, seasonOf, parseSlots, slotsText, slotsOverlap, DAY_CN, reqFloor, MIN_GRAD, unzipDocx, docxBlocks, debounce };
})();
