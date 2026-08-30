/* ============ 打包内置数据 v2（全量） ============
   输入: tools/debug/*.json （fetch-all-programs.py / fetch-extra.py 抓取的公开数据）
   输出: js/data-ustc.js
     courses    [编号, 名称, 学分, 上课时间(已归一化), 教师, 院系, 容量, 开课季]
                时间取最新学期；季节 = 开课学期 ∪ 各培养方案标注
     programTree [方案id, 方案名, 年级, 类型, 专业, 院系]
     programs    {方案id: {t:总学分, h:[论文名,学分]|0, r:压缩树}}
                树节点 {n:名称池下标, c:学分, t:type, k:[[课程号, 高替?]], s:[子节点]}
     pool        模块名池（树节点 n 下标引用）
     subPairs    [[高替课, 被替课]] （958 组官方替代规则） */
const fs = require("fs");
const path = require("path");

const DBG = path.join(__dirname, "debug");
const read = (f) => JSON.parse(fs.readFileSync(path.join(DBG, f), "utf8"));

/* ---------- 学期与开课时间 ---------- */
const semesters = read("semesters.json");
const semMeta = new Map(semesters.map(s => [s.id, s]));
const semFiles = [];
for (const f of fs.readdirSync(DBG)) {
  const m = f.match(/^lessons(?:_(\d+))?\.json$/);
  if (!m) continue;
  const sid = m[1] ? +m[1] : semesters[semesters.length - 1].id;
  semFiles.push({ sid, f, meta: semMeta.get(sid) || { nameZh: "?" } });
}
semFiles.sort((a, b) => a.sid - b.sid);          // 旧→新，新学期覆盖旧学期

const DAY_CN = { 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日" };
function normTime(txt) {
  const out = [];
  if (!txt) return out;
  for (const seg of String(txt).split(";")) {
    const m = seg.match(/(\d)\s*\(\s*([\d,\s]+?)\s*\)/);
    if (!m) continue;
    const day = +m[1];
    const ps = (m[2].match(/\d+/g) || []).map(Number).filter(x => x >= 1 && x <= 14);
    if (day >= 1 && day <= 7 && ps.length)
      out.push(ps.length > 1 ? `${DAY_CN[day]}${Math.min(...ps)}-${Math.max(...ps)}节` : `${DAY_CN[day]}${ps[0]}节`);
  }
  return [...new Set(out)];
}

/* course 聚合: 每门课跨所有学期/培养方案合并 */
const C = new Map();   // code -> {name, credits, seasons:Set, time, teacher, dept, seats}
const touch = (code) => {
  if (!C.has(code)) C.set(code, { name: "", credits: null, seasons: new Set(), time: "", teacher: "", dept: "", seats: "" });
  return C.get(code);
};

const seasonOfName = (n) => /秋/.test(n) ? "秋" : /春/.test(n) ? "春" : /夏/.test(n) ? "夏" : "";
let lessonCount = 0;
for (const { f, meta } of semFiles) {
  const season = seasonOfName(meta.nameZh || "");
  for (const L of read(f)) {
    const co = L.course || {};
    const code = String(co.code || L.id);
    if (!co.code) continue;
    lessonCount++;
    const c = touch(code);
    if (co.cn) c.name = c.name || co.cn;
    if (L.credits != null) c.credits = c.credits ?? L.credits;
    if (season) c.seasons.add(season);
    const time = normTime(L.dateTimePlaceText).join(";");
    if (time) {                                   // 新学期的时间覆盖旧学期
      c.time = time;
      c.teacher = (L.teacherAssignmentList || []).map(t => t.cn).filter(Boolean).join("、");
      c.dept = (L.openDepartment || {}).cn || "";
      c.seats = `${L.stdCount ?? ""}/${L.limitCount ?? ""}`;
    }
  }
}
console.log(`开课记录 ${lessonCount} 条 / ${semFiles.length} 个学期`);

/* ---------- 培养方案 ---------- */
const tree = read("program_tree.json");
const programTree = [];
for (const dept of Object.values(tree)) {
  for (const major of Object.values(dept.majors || {})) {
    for (const p of (major.programs || [])) {
      programTree.push([p.id, p.nameZh || "", String(p.grade || ""), p.trainType || "", major.nameZh || "", dept.nameZh || ""]);
    }
  }
}

const namePool = [];
const nameIdx = new Map();
const ni = (n) => {
  if (!nameIdx.has(n)) { nameIdx.set(n, namePool.length); namePool.push(n); }
  return nameIdx.get(n);
};

const creditTally = new Map();   // code -> Map(credits -> count)（培养方案里的学分更权威）
let packedPrograms = 0, skippedPrograms = 0;

function packCourse(pc) {
  const co = pc.course || {};
  if (!co.code) return null;
  const code = String(co.code);
  const c = touch(code);
  if (co.nameZh && !c.name) c.name = co.nameZh;
  if (co.credits != null) {
    if (!creditTally.has(code)) creditTally.set(code, new Map());
    const t = creditTally.get(code);
    t.set(co.credits, (t.get(co.credits) || 0) + 1);
  }
  (String(co.seasons || "").match(/[春夏秋]/g) || []).forEach(s => c.seasons.add(s));
  return code;
}

function packNode(node) {
  const s = node.self || {};
  const name = s.nameZh || s.type || "模块";
  let type = /自由选修|第二课堂/.test(name) ? "free"
    : (s.requiredSubModuleNum || 0) ? "container"
    : /选修/.test(name) ? "pool" : "required";
  const k = [];
  for (const pc of (s.courses || [])) {
    const code = packCourse(pc);
    if (code) k.push([code]);
  }
  const subs = (node.children || []).map(packNode).filter(Boolean);
  if (k.length && subs.length) {
    const leaf = { n: ni(name + "·课程"), c: s.requiredCredits, t: type === "pool" ? "pool" : "required", k };
    return { n: ni(name), c: null, t: "container", s: [leaf, ...subs] };
  }
  if (type === "required" && k.length && s.requiredCourseNum && k.length > s.requiredCourseNum) type = "pool";
  const nd = { n: ni(name), c: s.requiredCredits, t: type };
  if (k.length) nd.k = k;
  if (subs.length) nd.s = subs;
  return nd;
}

function sumLeaf(nd) {
  let t = 0;
  if (nd.s && nd.s.length) { nd.s.forEach(x => t += sumLeaf(x)); return t; }
  if ((nd.t === "required" || nd.t === "pool") && nd.c) t += nd.c;
  return t;
}
function findThesis(nd) {
  if (nd.s && nd.s.length) { for (const x of nd.s) { const r = findThesis(x); if (r) return r; } return null; }
  return (/论文|毕业设计/.test(namePool[nd.n]) && nd.c) ? nd : null;
}

const programs = {};
for (const f of fs.readdirSync(DBG)) {
  const m = f.match(/^program_(\d+)\.json$/);
  if (!m) continue;
  const pid = m[1];
  let info;
  try { info = read(f); } catch (e) { skippedPrograms++; continue; }
  if (!info || !info.moduleTree || !info.moduleTree.length) { skippedPrograms++; continue; }
  try {
    const rootNodes = info.moduleTree.map(packNode);
    const leafReq = Math.round(rootNodes.reduce((a, nd) => a + sumLeaf(nd), 0) * 10) / 10;
    const th = rootNodes.map(findThesis).find(Boolean);
    let total = leafReq;
    const official = +info.requiredCredits || 0;
    if (official > total && official >= 30) total = official;    // 官方总数更大 → 以官方为准（方案缺行兜底）
    const entry = { t: Math.round(total * 10) / 10, r: rootNodes.length === 1 ? rootNodes[0] : { n: ni((info.major || {}).nameZh || "培养方案"), c: null, t: "container", s: rootNodes } };
    entry.h = th ? [namePool[th.n], th.c] : 0;
    programs[pid] = entry;
    packedPrograms++;
  } catch (e) { skippedPrograms++; console.log(`  [跳过] ${pid}: ${e.message}`); }
}
console.log(`培养方案打包 ${packedPrograms} 份 / 跳过 ${skippedPrograms}`);

/* ---------- 替代池 → [高替, 被替] ---------- */
let subPairs = [];
try {
  const pools = read("substitute_pools.json");
  for (const g of pools) {
    for (const hi of (g.substituteCourses || [])) {
      if (!(hi || {}).code) continue;
      for (const lo of (g.originalCourses || [])) {
        if ((lo || {}).code && lo.code !== hi.code) subPairs.push([String(hi.code), String(lo.code)]);
      }
    }
  }
  subPairs = subPairs.filter(([hi, lo], i) => !subPairs.some(([h2, l2], j) => j < i && h2 === hi && l2 === lo));
  // 把替代关系写进模块课程 alt：被替课 → 高替课
  const lo2hi = new Map();
  for (const [hi, lo] of subPairs) if (!lo2hi.has(lo)) lo2hi.set(lo, hi);
  for (const entry of Object.values(programs)) {
    (function walk(nd) {
      if (nd.k) nd.k.forEach(pair => {
        const hi = lo2hi.get(pair[0]);
        if (hi && hi !== pair[0]) pair[1] = hi;
      });
      if (nd.s) nd.s.forEach(walk);
    })(entry.r);
  }
} catch (e) { console.log("替代池解析失败（跳过）:", e.message); subPairs = []; }
console.log(`替代规则 ${subPairs.length} 条`);

/* ---------- 课程学分定稿（方案众数 > 开课） ---------- */
for (const [code, tally] of creditTally) {
  const c = C.get(code);
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  if (best != null) c.credits = best;
}

/* ---------- 输出 ---------- */
const courses = [...C.entries()].map(([code, c]) =>
  [code, c.name || code, c.credits ?? 0, c.time, c.teacher, c.dept, c.seats, [...c.seasons].sort((a, b) => "夏春秋".indexOf(a) - "夏春秋".indexOf(b)).join("")]);

const data = {
  builtAt: new Date().toISOString().slice(0, 10),
  semester: (() => { const s = semesters[semesters.length - 1]; const m = (s.nameZh || "").match(/^(\d{4})年(.)季/); return m ? m[1] + m[2] : s.nameZh; })(),
  semesterName: semesters[semesters.length - 1].nameZh,
  semesterId: semesters[semesters.length - 1].id,
  courses, programTree, programs, pool: namePool, subPairs
};

const js = `/* ============ 内置数据：catalog.ustc.edu.cn 公开目录（${data.builtAt} 全量抓取） ============
   重新生成: python tools/fetch-all-programs.py && python tools/fetch-extra.py && node tools/build-ustc-data.js
   courses:    [编号,名称,学分,上课时间,教师,院系,容量,开课季] × ${courses.length}（${semFiles.length} 学期开课合并）
   programTree:[id,方案名,年级,类型,专业,院系] × ${programTree.length}
   programs:   ${packedPrograms} 份完整方案 {t:总学分, h:论文, r:压缩树}（节点 n=名称池下标, k=课程[号,高替?]）
   subPairs:   官方课程替代规则 × ${subPairs.length} */
const USTC_DATA = ${JSON.stringify(data)};
`;
fs.writeFileSync(path.join(__dirname, "..", "js", "data-ustc.js"), js);
console.log(`\njs/data-ustc.js: ${(js.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  courses=${courses.length}（带时间 ${courses.filter(c => c[3]).length}）programTree=${programTree.length} programs=${packedPrograms} subPairs=${subPairs.length}`);
