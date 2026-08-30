/* ============ v2 解析层：培养方案docx / 成绩单文本·CSV / 爬虫JSON ============ */

const Parse = (() => {

  /* ================= 一、培养方案 docx ================= */

  // 识别"模块头"行: 单元格里带 要求学分/要求门数/通过子模块
  function parseReqText(t) {
    const cr = t.match(/要求学分[::]\s*([0-9.]+|无)/);
    const cnt = t.match(/要求门数[::]\s*(\d+|无)/);
    const subs = t.match(/通过子模块[::]\s*(\d+|无)/);
    return {
      credits: cr ? (cr[1] === "无" ? null : parseFloat(cr[1])) : null,
      count: cnt ? (cnt[1] === "无" ? null : +cnt[1]) : null,
      hasSubs: !!subs,
      name: t.split(/要求学分/)[0].replace(/[::：]\s*$/, "").trim()
    };
  }

  // 课程行: [编号, 名称(可能带序号), 必修/选修, 学时, 学分, 部门, 学期, 备注]
  function tryCourseRow(cells) {
    const texts = cells.map(c => c.text);
    if (texts.length < 3) return null;
    // 表头行
    if (/课程编号|课程名称/.test(texts[0] + texts[1])) return null;
    let idx = -1;
    if (/^(必修|选修|限选|任选)/.test(texts[2] || "")) idx = 2;
    else { for (let i = 0; i < texts.length; i++) if (/^(必修|选修|限选|任选)/.test(texts[i])) { idx = i; break; } }
    if (idx < 2) return null;
    const nameCell = texts[1] || "";
    const name = nameCell.replace(/^\s*\d{1,2}\s+/, "").trim();   // 去掉合并序号列带出的前缀数字
    // 学分 = idx-1（学时列）后面；学时可能是 "60/40"、"院系安排20（理论）..."
    let credits = NaN;
    for (let i = idx + 1; i < texts.length; i++) {
      const v = parseFloat(texts[i]);
      if (!isNaN(v) && v > 0 && v <= 12) { credits = v; break; }
    }
    if (isNaN(credits) || !name) return null;
    const seasons = [];
    const termCell = texts[idx + 4] || texts[texts.length - 2] || "";
    (termCell.match(/[春夏秋]/g) || []).forEach(s => { if (!seasons.includes(s)) seasons.push(s); });
    return { id: (texts[0] || "").trim(), name, credits, seasons };
  }

  // 任意一行兜底: 找 学分(0.5-12的数) + 最长中文单元格
  function tryLooseRow(cells) {
    const texts = cells.map(c => c.text).filter(t => t);
    if (texts.length < 2) return null;
    let credits = NaN, name = "";
    texts.forEach(t => { const v = parseFloat(t); if (!isNaN(v) && v > 0 && v <= 12 && isNaN(credits) && !/\d{4}/.test(t)) credits = v; });
    texts.forEach(t => { if (/[\u4e00-\u9fa5]/.test(t) && t.length > name.length) name = t; });
    if (isNaN(credits) || !name) return null;
    const seasons = [];
    texts.forEach(t => (t.match(/[春夏秋]/g) || []).forEach(s => { if (!seasons.includes(s)) seasons.push(s); }));
    return { id: "", name: name.replace(/^\s*\d{1,2}\s+/, "").trim(), credits, seasons };
  }

  /* docx -> {plan, courseN, looseCount}  plan 为递归模块树:
     {name, credits, type:'container'|'required'|'pool'|'free', courses:[{id,name,credits,seasons}], subs:[]}
     要点：教务系统导出的模块头单元格是纵向合并的，会与课程行出现在同一行，
     所以按"单元格"判断模块头（vMerge 延续的单元格视为不存在），一行可同时含新模块头+课程 */
  function parsePlanDocx(xml, fallbackName) {
    const blocks = U.docxBlocks(xml);
    const root = { name: fallbackName || "导入的培养方案", credits: null, type: "container", courses: [], subs: [] };
    let stack = [root];
    let firstHeading = "";
    let looseCount = 0;

    const isHeaderCell = (t) => /要求学分|要求门数|通过子模块/.test(t);

    for (const b of blocks) {
      if (b.type === "p") {
        if (!firstHeading && b.text && b.text.length <= 40 && /培养方案|课程设置|一览表|教学计划/.test(b.text)) firstHeading = b.text;
        continue;
      }
      for (const row of b.rows) {
        // 本行新出现的模块头单元格（vMerge 延续的不算新头）
        const eff = row.cells.filter(c => !(c.vMerge === "cont"));
        const newHeaders = eff.filter(c => c.vMerge !== "cont" && isHeaderCell(c.text));
        for (const h of newHeaders) {
          const req = parseReqText(h.text);
          const node = {
            name: req.name || "未命名模块",
            credits: req.credits,
            type: (req.credits == null && !/要求门数[::]\s*\d/.test(h.text)) ? "container"
              : /自由选修|第二课堂/.test(req.name) ? "free"
              : (/选修/.test(req.name) || /选修|限选/.test(h.text)) ? "pool"
              : "required",
            courses: [], subs: [],
            _decl: req.hasSubs ? null : undefined,   // 后面从文本里取子模块数
            _seen: 0
          };
          const decl = h.text.match(/通过子模块[::]\s*(\d+)/);
          if (node.type === "container") node._decl = decl ? +decl[1] : null;
          if (node.type !== "container" && req.hasSubs) { node._reqDisplay = node.credits; node.type = "container"; node._decl = decl ? +decl[1] : null; }
          // 出栈：声明的子模块已满，或顶层是已有内容的叶子
          while (stack.length > 1) {
            const top = stack[stack.length - 1];
            if (top._decl != null && top._decl > 0 && top._seen >= top._decl) { stack.pop(); continue; }
            if (top.type !== "container" && (top.courses.length > 0 || top.subs.length > 0)) { stack.pop(); continue; }
            break;
          }
          const parent = stack[stack.length - 1];
          parent.subs.push(node);
          if (parent._decl != null) parent._seen++;
          stack.push(node);
        }
        // 剩余单元格找课程行
        const rest = eff.filter(c => !newHeaders.includes(c));
        if (!rest.length) continue;
        let c = tryCourseRow(rest);
        if (!c) c = tryLooseRow(rest);
        if (c) {
          if (!c.id) looseCount++;
          stack[stack.length - 1].courses.push(c);
        }
      }
    }

    if (firstHeading) root.name = firstHeading.trim() || root.name;

    // 归一化：
    //  1) required 但课程总学分 > 要求学分 → pool（如"计算机通修 门数1 课程2门"）
    //  2) 有子模块的节点 → 容器；未被子模块覆盖的余额生成一个"其余"缺口叶（能兜住教务系统导出缺行的情况）
    (function normalize(n) {
      n.subs.forEach(normalize);
      if (n.type === "required" && n.credits != null && n.courses.length > 1 &&
          n.courses.reduce((a, c) => a + c.credits, 0) > n.credits + 0.01) n.type = "pool";
      if (n.type === "container" && !n.subs.length && n.courses.length) {
        n.type = "pool";
        if (n.credits == null) n.credits = n.courses.reduce((a, c) => a + c.credits, 0);
      }
      if (n.subs.length && n.type !== "free") {
        const childSum = (function cs(x) {
          let s = 0;
          x.subs.forEach(c => { s += (c.subs && c.subs.length) ? cs(c) : ((c.type === "required" || c.type === "pool") ? (c.credits || 0) : 0); });
          return s + (x.courses || []).reduce((a, c) => a + (c.credits || 0), 0);
        })(n);
        n._reqDisplay = n._reqDisplay ?? n.credits;
        const rest = +(((n.credits || 0) - childSum).toFixed(1));
        if (rest > 0.01) n.subs.push({ id: U.uid("m"), name: n.name + "·其余", credits: rest, type: "required", courses: [], subs: [] });
        n.type = "container";
      }
      delete n._decl; delete n._seen;
    })(root);

    let courseN = 0;
    (function cnt(n) { courseN += n.courses.length; n.subs.forEach(cnt); })(root);
    return { plan: root, courseN, looseCount };
  }

  /* ================= 二、成绩单（粘贴文本 / CSV） ================= */

  function scoreToGPA(score) {
    if (score == null) return null;
    if (score >= 95) return 4.3; if (score >= 90) return 4.0; if (score >= 85) return 3.7;
    if (score >= 82) return 3.3; if (score >= 78) return 3.0; if (score >= 75) return 2.7;
    if (score >= 72) return 2.3; if (score >= 68) return 2.0; if (score >= 64) return 1.5;
    if (score >= 60) return 1.0; return 0;
  }
  /* ---------- 成绩单（粘贴文本）：适配真实格式 ----------
     「课程名+编号连写」「学时/学分/绩点/成绩 四列」「等级成绩 A+/A/B+」「通过制」「学期头」
     双模式：
       A) 真实格式（教务导出）：第2列是学时(≥10整数) → 按列位置取值  学时/学分/绩点/成绩
       B) 旧格式（空格分隔）：第2列是课程名 →  first列=编号/名称, 其余启发式
     名称/编号连写的拆分一律走「课程库名称兜底」（resolveNameCode）。 */
  const GRADE = { "A+": 4.3, "A": 4.0, "A-": 3.7, "B+": 3.3, "B": 3.0, "B-": 2.7, "C+": 2.3, "C": 2.0, "C-": 1.7, "D+": 1.3, "D": 1.0, "F": 0 };
  const isGrade = (t) => /^[ABCD][+\-]?$|^F$/.test(String(t).trim());
  const isPassWord = (t) => /^(通过|合格|优|良|中|及格|免修|代修)$/.test(String(t).trim());
  const looksLikeHours = (v) => Number.isInteger(v) && v >= 10 && v <= 500;

  /* 课程库快照：全局 USTC_DATA + 当前数据集已注册的课程 */
  function courseLib() {
    const lib = [];
    if (typeof USTC_DATA !== "undefined" && USTC_DATA.courses) {
      for (const c of USTC_DATA.courses) lib.push({ id: String(c[0]), name: String(c[1]) });
    }
    try {
      if (Model.ds && Model.ds.courses) {
        Object.values(Model.ds.courses).forEach(c => { if (c && c.id && c.name) lib.push({ id: String(c.id), name: String(c.name) }); });
      }
    } catch (e) { /* 无 Model 环境不回溯 */ }
    return lib;
  }

  /* 课程名+编号连写 → {name,id}。按课程库兜底拆：已知编号后缀最长最完整优先，名称优先匹配库内课程 */
  function resolveNameCode(cell) {
    const t = String(cell).trim();
    const lib = courseLib();
    const byId = new Map();
    lib.forEach(c => { if (!byId.has(c.id)) byId.set(c.id, c); });
    const ids = [...byId.keys()].sort((a, b) => b.length - a.length);
    const knownName = (nm) => lib.some(c => c.name === nm);
    const cands = [];
    const add = (name, id) => {
      name = String(name).trim().replace(/[·\s]+$/, "");
      if (!name || !id) return;
      cands.push({ name, id, known: knownName(name), len: id.length });
    };
    for (const id of ids) if (t.endsWith(id) && t.length > id.length) add(t.slice(0, -id.length), id);
    for (const c of lib) if (t === (c.name + c.id)) cands.push({ name: c.name, id: c.id, known: true, len: c.id.length });
    if (cands.length) {
      cands.sort((a, b) => (b.known - a.known) || (b.len - a.len));
      return { name: cands[0].name, id: cands[0].id };
    }
    const m = t.match(/^(.*?)([A-Za-z0-9][A-Za-z0-9.\-]*)$/);
    if (m && m[1] && m[2]) return { name: m[1].trim(), id: m[2] };
    return { name: t, id: "" };
  }

  /* 按列位置解析真实格式（N≥4）：[名称+编号, 学时, 学分, 绩点, 成绩/等级/通过] */
  function parseByPosition(cells, curTerm) {
    const { name, id } = resolveNameCode(cells[0]);
    if (!name) return null;
    let credits = null, score = null, gp = null, pass = false, inprogress = false;
    const rest = cells.slice(1);
    // 学分列=第3列（下标2）
    const creditCell = rest[1];
    const cv = creditCell != null ? parseFloat(String(creditCell)) : NaN;
    credits = (!isNaN(cv) && cv > 0 && cv <= 12) ? cv : null;
    // 绩点列=第4列（下标3）：等级或小数/整数绩点
    const gpCell = rest.length > 2 ? String(rest[2]).trim() : "";
    if (isGrade(gpCell)) gp = GRADE[gpCell];
    else {
      const gv = parseFloat(gpCell);
      if (!isNaN(gv) && gv >= 1 && gv <= 4.3) gp = gv;
    }
    // 成绩列=第5列（下标4）：百分 / 等级 / 通过 / 进行中
    const scoreCell = rest.length > 3 ? String(rest[3]).trim() : "";
    const sv = parseFloat(scoreCell);
    if (isGrade(scoreCell)) { gp = GRADE[scoreCell]; }
    else if (/进行中|在修|未出分/.test(scoreCell)) inprogress = true;
    else if (isPassWord(scoreCell)) pass = true;
    else if (!isNaN(sv)) {
      if (Number.isInteger(sv) && sv > 40 && sv <= 100) score = sv;
      else if (sv >= 1 && sv <= 4.3 && gp == null) gp = sv;
    }
    if (credits == null) return null;
    return { id: id || "", name, credits, term: curTerm || "未知", score, gp, pass: pass && score == null, inprogress };
  }

  /* 旧格式启发式：[编号/名称, 名称, 学分, 成绩, 绩点(可选)] 或 ...学分 通过/进行中 */
  function parseLegacy(cells, curTerm) {
    let id = "", name = "";
    // 第0列纯 ASCII（无中文）视为编号，第1列作名称；否则第0列即名称
    if (!/[\u4e00-\u9fa5]/.test(cells[0])) { id = cells[0]; name = cells[1] || ""; }
    else { name = cells[0]; }
    if (!name) return null;
    let credits = null, score = null, gp = null, pass = false, inprogress = false;
    const rest = cells.slice(id ? 2 : 1);
    const nums = [];
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i].trim();
      if (!c) continue;
      if (/进行中|在修|未出分/.test(c)) { inprogress = true; continue; }
      if (isPassWord(c)) { pass = true; continue; }
      if (isGrade(c)) { if (gp == null) gp = GRADE[c]; continue; }
      if (/^\d+(\.\d+)?$/.test(c)) {
        const v = parseFloat(c);
        if (Number.isInteger(v) && v > 40 && v <= 100) { nums.push({ kind: "score", v }); continue; }
        nums.push({ kind: "num", v, hasDot: /\./.test(c) });
      }
    }
    // 旧格式：第一格数字(0.5-12)=学分；随后：百分=成绩，小数绩点=绩点，其余整数(1-4.3)=绩点
    for (const n of nums) {
      const { v, hasDot } = n;
      if (n.kind === "score") { if (score == null) score = v; continue; }
    }
    for (const n of nums) {
      if (n.kind === "score") continue;
      const { v, hasDot } = n;
      if (credits == null && v > 0 && v <= 12) { credits = v; continue; }
      if (v >= 1 && v <= 4.3 && gp == null && v !== credits) { gp = v; continue; }
      if (credits == null && v >= 1 && v <= 4.3) { credits = v; continue; }
    }
    if (credits == null) return null;
    return { id, name, credits, term: curTerm || "未知", score, gp, pass: pass && score == null, inprogress };
  }

  /* EAMS 已修明细（教务系统明细导出）：
     学期 | 课程名 | 编号 | 选课序号 | 学时 | 学分 | 绩点 | 成绩/等级/通过   （学期在每行第1列） */
  function parseEams(cells) {
    const term = normTerm(cells[0]);
    if (!term) return null;
    const name = cells[1] ? String(cells[1]).trim() : "";
    const id = cells[2] ? String(cells[2]).trim() : "";
    if (!name) return null;
    let credits = null, score = null, gp = null, pass = false, inprogress = false;
    const cv = parseFloat(cells[5]);
    if (!isNaN(cv) && cv > 0 && cv <= 12) credits = cv;
    const gpCell = cells[6] ? String(cells[6]).trim() : "";
    if (isGrade(gpCell)) gp = GRADE[gpCell];
    else {
      const gv = parseFloat(gpCell);
      if (!isNaN(gv) && gv >= 1 && gv <= 4.3) gp = gv;
    }
    const scoreCell = cells[7] ? String(cells[7]).trim() : "";
    if (isGrade(scoreCell)) { gp = GRADE[scoreCell]; }
    else if (/进行中|在修|未出分/.test(scoreCell)) inprogress = true;
    else if (isPassWord(scoreCell)) pass = true;
    else {
      const sv = parseFloat(scoreCell);
      if (!isNaN(sv)) { if (Number.isInteger(sv) && sv > 40 && sv <= 100) score = sv; }
    }
    if (credits == null) return null;
    return { id, name, credits, term, score, gp, pass: pass && score == null, inprogress };
  }

  function parseTranscript(text) {
    const items = [], warn = [];
    let curTerm = null;
    const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    for (const line0 of lines) {
      const line = line0.replace(/^\d+[.、]\s*/, "");
      // 表头行跳过（整格精确匹配，避免"数学分析"含"学分"被误杀）
      if (/^课程(\s|$)/.test(line) || (/(学时|学分|绩点|成绩)/.test(line) && /课程|学时/.test(line) && !/\d{2,}/.test(line))) continue;
      // 学期行（无 tab 的独立行）
      if (!line.includes("\t") && (/[春夏秋](?:季|学期|季学期)?$/.test(line) || /第[一二三四1-4]学期/.test(line)) && /20\d{2}/.test(line)) {
        const t = normTerm(line);
        if (t) { curTerm = t; continue; }
      }
      if (/平均|共\d+门|排名|学籍|奖学金|绩点排名/.test(line) && !/\t/.test(line)) continue;

      const isTab = line.includes("\t");
      let cells;
      if (isTab) {
        const arr = line.split("\t").map(c => c.trim());
        while (arr.length && arr[0] === "") arr.shift();        // 去头空列
        while (arr.length && arr[arr.length - 1] === "") arr.pop(); // 去尾空列
        cells = arr;                                            // 保留中部空列（绩点可能留空）
      } else {
        cells = line.split(/\s{2,}/).map(c => c.trim()).filter(c => c !== "");
      }
      if (!cells.length) continue;

      let it = null;
      // EAMS 明细：第1列是学期、第2列是课程名 → 按列取
      if (cells.length >= 6 && /20\d{2}/.test(cells[0]) && /[春夏秋]/.test(cells[0]) && /[\u4e00-\u9fa5]/.test(cells[1] || "")) {
        it = parseEams(cells);
        if (it && it.term) curTerm = it.term;
      }
      // 真实格式：第2列是学时(≥10整数) → 按列位置
      else if (cells.length >= 4 && looksLikeHours(parseFloat(cells[1]))) it = parseByPosition(cells, curTerm);
      else it = parseLegacy(cells, curTerm);
      if (!it) { warn.push("无法识别行: " + line0.slice(0, 50)); continue; }
      items.push(it);
    }
    const tset = new Set(items.map(i => i.term));
    return { items, termCount: tset.size, warn };
  }


  function normTerm(t) {
    const y = (String(t).match(/20\d{2}/) || [])[0];
    const s = (String(t).match(/[春夏秋]/) || [])[0] || "";
    // 夏季统一并入相邻春季（工具不设夏季学期）
    const norm = s === "夏" ? "春" : s;
    if (y && norm) return y + norm;
    if (y) {
      const seg = (String(t).match(/第([一二三四1-4])学期/) || [])[1];
      if (seg) return y + ({ "1": "秋", 一: "秋", "2": "春", 二: "春", "3": "春", 三: "春", "4": "春", 四: "春" }[seg] || "秋");
    }
    return null;
  }
  /* 表头/噪音单元格：整格精确匹配才排除（避免"数学分析"含"学分"被误杀） */
  const HEADER_STRICT = /^(课程名称|名称|课程名|课程(代码|编号|号)|学分|绩点|总?成绩|成绩[一二三]?|百分(成绩|制)?|学时|学期|学年|序号|姓名|学号|年级|专业|班级|院?系|学院|课程性质|考试|考查|补考|重修|备注|平均(成绩|分)?|排名|等级|性质|学期名)$/;
  const JUNK_ROW = /成绩单|毕业要求|学分统计|平均学分绩点|共\d+门|打印时间|学籍/;

  function parseTranscriptDocx(xml) {
    const items = [], warn = [];
    let curTerm = null, termCount = 0;
    const blocks = U.docxBlocks(xml);
    for (const b of blocks) {
      if (b.type !== "tbl") continue;
      for (const row of b.rows) {
        const cells = row.cells.map(c => c.text).filter(t => t);
        if (!cells.length) continue;
        if (cells.some(t => JUNK_ROW.test(t))) continue;
        // 学期单元格（可能独占一行，也可能在数据行里带学期列）
        const termCell = cells.map(normTerm).find(Boolean);
        if (termCell) curTerm = termCell;
        // 名称：最长的非表头中文/字母单元格
        let name = "";
        cells.forEach(t => {
          if (HEADER_STRICT.test(t.trim())) return;
          if (/[\u4e00-\u9fa5a-zA-Z]/.test(t) && t.length > name.length) name = t;
        });
        // 数字：按位置  credits → score → gp
        const nums = [];
        cells.forEach((t, i) => {
          const v = parseFloat(t);
          if (!isNaN(v) && /^\d+(\.\d+)?$/.test(t.trim())) nums.push({ v, i });
        });
        const credits = (nums.find(n => n.v > 0 && n.v <= 12) || {}).v;
        const scoreN = nums.find(n => n.v > 40 && n.v <= 100 && Number.isInteger(n.v) && (!credits || n.v !== credits));
        const gpN = [...nums].reverse().find(n => n.v >= 1 && n.v <= 4.3 && /\./.test(cells[n.i]) && (!scoreN || n.i > scoreN.i));
        const pass = cells.some(t => /^(通过|合格|优|良|中|及格)$/.test(t.trim()));
        const inprog = cells.some(t => /进行中|在修|未出分/.test(t));
        name = String(name).replace(/^\s*\d{1,3}\s+/, "").trim();
        if (!name || credits == null) {
          if (name && cells.length >= 3) warn.push("无法识别行: " + cells.join(" ").slice(0, 40));
          continue;
        }
        const score = scoreN ? scoreN.v : null;
        items.push({
          id: "", name: name.replace(/\s+/g, " "), credits,
          term: termCell || curTerm || "未知",
          score, gp: gpN ? gpN.v : (score != null ? scoreToGPA(score) : null),
          pass: pass && score == null, inprogress: inprog
        });
      }
    }
    const tset = new Set(items.map(i => i.term));
    return { items, termCount: tset.size, warn };
  }

  /* ================= 三、教务系统爬虫 JSON =================
     schema 见 samples/ustc_dataset.sample.json，允许只有部分字段 */
  function applyCrawler(ds, json) {
    const log = [];
    if (json.student) {
      ds.meta.name = json.student.name || ds.meta.name;
      ds.meta.studentDesc = [json.student.grade, json.student.major].filter(Boolean).join(" · ");
    }
    // 1) 课程字典
    (json.courses || []).forEach(c => {
      const id = c.id || U.uid("c");
      const seasons = c.seasons || (c.term ? [c.term] : []);
      const old = ds.courses[id];
      ds.courses[id] = {
        id, name: c.name || (old && old.name) || id,
        credits: +c.credits || (old && old.credits) || 0,
        seasons: Array.from(new Set([...(old && old.seasons || []), ...seasons])),
        slots: c.slots && c.slots.length ? c.slots : (c.time ? U.parseSlots(c.time) : (old && old.slots) || []),
        note: c.note || (old && old.note) || ""
      };
    });
    // 2) 培养方案（支持 plans 数组 / 旧版单个 plan）
    const planList = (Array.isArray(json.plans) && json.plans.length) ? json.plans : (json.plan ? [json.plan] : []);
    const colors = ["#3b82f6", "#f59e0b", "#8b5cf6", "#10b981", "#ef4444", "#0ea5e9", "#ec4899"];
    let firstNewPlan = null;
    planList.forEach((jsonPlan, pi) => {
      if (!jsonPlan || !jsonPlan.modules) return;
      const planId = U.uid("p");
      if (!firstNewPlan) firstNewPlan = planId;
      const mod = (m) => ({
        id: U.uid("m"), name: m.name || "模块",
        credits: m.credits ?? null,
        type: m.type || (m.credits == null ? "container" : /选修/.test(m.name) ? "pool" : "required"),
        courses: (m.courses || []).map(c => {
          const id = c.id || U.uid("c");
          ds.courses[id] = ds.courses[id] || {
            id, name: c.name || id, credits: +c.credits || 0,
            seasons: c.seasons || [], slots: c.slots || [], note: ""
          };
          if (c.seasons && c.seasons.length) {
            const cc = ds.courses[id];
            cc.seasons = Array.from(new Set([...(cc.seasons || []), ...c.seasons]));
          }
          if (c.slots && c.slots.length && !(ds.courses[id].slots || []).length) ds.courses[id].slots = c.slots;
          return { id, alt: c.alt || null };
        }),
        subs: (m.subs || []).map(mod)
      });
      ds.plans.push({
        id: planId, name: jsonPlan.name || "教务系统培养方案",
        color: jsonPlan.color || colors[(ds.plans.length + pi) % colors.length],
        total: +jsonPlan.total || 0, freePool: !!jsonPlan.freePool,
        thesis: jsonPlan.thesis || null, modules: (jsonPlan.modules || []).map(mod)
      });
      log.push(`培养方案「${jsonPlan.name}」+${(jsonPlan.modules || []).length} 个顶层模块`);
    });
    // 3) 成绩
    const firstPlan = firstNewPlan || (ds.plans[0] ? ds.plans[0].id : null);
    (json.scores || []).forEach(s => {
      let id = s.id;
      if (!id && s.name) {
        const hit = Object.values(ds.courses).find(c => c.name === s.name);
        id = hit ? hit.id : U.uid("c");
      }
      if (!id) return;
      const old = ds.courses[id];
      ds.courses[id] = ds.courses[id] || { id, name: s.name || id, credits: +s.credits || 0, seasons: [], slots: [], note: "" };
      if (old && !ds.courses[id].credits) ds.courses[id].credits = +s.credits || 0;
      const dup = ds.taken.find(t => t.id === id && t.term === (s.term || "未知"));
      if (dup) return;
      ds.taken.push({
        id, term: s.term || "未知", track: firstPlan,
        score: s.score ?? null, gp: s.gp ?? null,
        pass: s.pass || (s.score == null && s.gp == null), inprogress: !!s.inprogress, note: s.note || ""
      });
    });
    log.push(`已修成绩 +${(json.scores || []).length}`);
    // 4) 已选课 → 排课板
    (json.selected || []).forEach(s => {
      if (!s.id) return;
      if (!ds.courses[s.id]) ds.courses[s.id] = { id: s.id, name: s.name || s.id, credits: +s.credits || 0, seasons: [], slots: [], note: "" };
      if (!ds.board.find(b => b.id === s.id)) ds.board.push({ id: s.id, plan: firstPlan, term: s.term || null, selected: true });
    });
    log.push(`已选课 +${(json.selected || []).length}`);
    // 5) 排课/开课数据 → 课程时间
    if (json.offerings) {
      Object.entries(json.offerings).forEach(([term, list]) => {
        (list || []).forEach(o => {
          const c = ds.courses[o.id];
          if (!c) return;
          if (o.time && !c.slots.length) c.slots = U.parseSlots(o.time);
          if (o.season) c.seasons = Array.from(new Set([...c.seasons, o.season]));
          c.note = [c.note, o.teacher ? `开课教师:${o.teacher}` : ""].filter(Boolean).join(" · ");
        });
      });
      log.push("排课时间已合并");
    }
    return log;
  }

  /* ---------- v2 draft 工具 ---------- */

  // 把 draft 树里的课程注册进课程库（缺的补上），返回注册门数。draft 会被原地规范课程 id。
  // 兼容两种结构：解析器输出 {courses, subs} / 爬虫 draft {modules}
  function prepareDraft(draft) {
    let n = 0;
    const root = Array.isArray(draft.modules) && !draft.subs
      ? { name: draft.name, courses: [], subs: draft.modules } : draft;
    Model.walkModules([root], m => (m.courses || []).forEach(c => {
      const id = c.id || U.uid("c");
      Model.ensureCourse(id, { name: c.name || id, credits: c.credits || 0, seasons: c.seasons || [] });
      c.id = id; n++;
    }));
    return n;
  }

  // EAMS program/info JSON → v2 draft（供内置数据/测试复用，与爬虫同逻辑）
  function convertProgramInfo(info) {
    const mod = (m) => {
      const s = m.self || {};
      let type = /自由选修|第二课堂/.test(s.nameZh || s.type || "") ? "free"
        : (s.requiredSubModuleNum || 0) ? "container"
        : /选修/.test(s.nameZh || s.type || "") ? "pool" : "required";
      const courses = (s.courses || []).filter(c => (c.course || {}).code).map(c => ({
        id: String(c.course.code), name: c.course.nameZh || String(c.course.code),
        credits: c.course.credits, seasons: String(c.course.seasons || "").match(/[春夏秋]/g) || []
      }));
      const kids = (m.children || []).map(mod);
      if (courses.length && kids.length) {
        return { name: s.nameZh || s.type || "模块", credits: null, type: "container", courses: [],
          subs: [{ name: (s.nameZh || "模块") + "·课程", credits: s.requiredCredits, type: type === "pool" ? "pool" : "required", courses, subs: [] }, ...kids] };
      }
      if (courses.length && !kids.length && type === "required") {
        const need = s.requiredCourseNum || 0;
        if (need && courses.length > need) type = "pool";
      }
      return { name: s.nameZh || s.type || "模块", credits: s.requiredCredits, type, courses, subs: kids };
    };
    const modules = (info.moduleTree || []).map(mod);
    let thesis = null, total = 0;
    Model.walkModules(modules, m => {
      if (m.subs.length) return;
      if (!thesis && /论文/.test(m.name)) { thesis = { name: m.name, credits: m.credits || 8 }; return; }
      if ((m.type === "required" || m.type === "pool") && m.credits) total += m.credits;
    });
    if (!thesis) thesis = { name: "毕业论文", credits: 8 };
    total = Math.round((total + thesis.credits) * 10) / 10;
    const major = (info.major || {}).nameZh || "";
    return {
      name: `${major}培养方案（${info.grade}级${info.trainType || ""}）`.trim(),
      total, freePool: true, thesis, modules,
      _meta: { grade: info.grade, major, department: (info.department || {}).nameZh }
    };
  }

  return { parsePlanDocx, parseTranscript, parseTranscriptDocx, applyCrawler, scoreToGPA, parseReqText, tryCourseRow,
           prepareDraft, convertProgramInfo };
})();
