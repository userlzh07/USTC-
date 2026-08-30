/* ============ v2 界面：导入向导 / 总览 / 已修 / 拖拽规划板 / 方案编辑 / 课程库 ============ */

const App = (() => {
  let ds = null, audit = null, view = null;
  let staging = { plan: null, scores: null, scoreText: "" };
  let ttOpen = {};                      // term -> bool 周课表展开

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ================= 初始化 ================= */
  let booted = false;
  function init() {
    if (booted) return;                       // 防 DOMContentLoaded 重复触发
    booted = true;
    ds = Model.load();
    if (Model.firstRun && typeof USTC_DATA !== "undefined") {
      /* 首次使用：自动灌入内置公开课程库（非个人数据），开箱即可搜课/拖课 */
      const payload = embCatalogPayload();
      Parse.applyCrawler(ds, payload);
      Model.saveNow();
    }
    Planner.topUp(ds);
    bindStatic();
    renderAll();
    if (Model.firstRun) toast(`已内置科大公开数据：${USTC_DATA.courses.length} 门课 · ${USTC_DATA.programTree.length} 份培养方案，去「培养方案」页挑你的方案`);
  }

  function refresh() {
    ds = Model.ds;                 // 同步引用（undo/replace/载入演示后数据集对象可能被整体替换）
    audit = Audit.run(ds);
    view = Planner.view(ds);
  }

  function renderAll() {
    refresh();
    renderHeader();
    renderSettings();
    renderImport();
    renderOverview();
    renderTaken();
    renderPlan();
    renderStruct();
    renderCatalog();
    Model.save();
    const el = $("#save-status");
    el.textContent = "● 已保存 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }

  function toast(msg) {
    let t = $("#toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add("show");
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200);
  }

  /* ================= 静态绑定 ================= */
  function bindStatic() {
    $$(".tab").forEach(btn => btn.addEventListener("click", () => {
      $$(".tab").forEach(b => b.classList.remove("active"));
      $$(".panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      $("#panel-" + btn.dataset.panel).classList.add("active");
    }));

    $("#btn-backup").addEventListener("click", () =>
      U.dl(`学业规划备份-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(ds, null, 2), "application/json"));
    $("#btn-plan-csv").addEventListener("click", exportPlanCSV);
    $("#btn-undo").addEventListener("click", () => { if (Model.undo()) { renderAll(); toast("已撤销"); } else toast("没有可撤销的操作"); });

    /* 培养方案导入 */
    bindFileDrop("#drop-plan", "#file-plan", f => handlePlanFile(f));
    $("#btn-parse-plan-text").addEventListener("click", () => {
      const text = $("#paste-plan").value.trim();
      if (!text) return toast("请先粘贴培养方案文本");
      const r = parsePlanText(text, "粘贴的方案");
      staging.plan = r; renderImport();
    });

    /* 成绩导入（CSV/TXT 粘贴 或 docx） */
    bindFileDrop("#drop-score", "#file-score", f => handleScoreFile(f));
    $("#btn-parse-score-text").addEventListener("click", () => {
      const text = $("#paste-score").value.trim();
      if (!text) return toast("请先粘贴成绩文本");
      staging.scoreText = text;
      staging.scores = Parse.parseTranscript(text);
      renderImport();
    });

    /* 爬虫 JSON */
    bindFileDrop("#drop-crawler", "#file-crawler", f => {
      const rd = new FileReader();
      rd.onload = () => {
        try {
          Model.snapshot();
          const log = Parse.applyCrawler(ds, JSON.parse(String(rd.result)));
          $("#crawler-log").innerHTML = log.map(l => `<div class="ok-text">✓ ${U.esc(l)}</div>`).join("");
          renderAll(); toast("爬虫数据已导入");
        } catch (e) { $("#crawler-log").innerHTML = `<div class="gap-text">解析失败：${U.esc(e.message)}</div>`; }
      };
      rd.readAsText(f, "utf-8");
    });

    /* 备份/重置 */
    $("#btn-restore").addEventListener("click", () => $("#file-restore").click());
    $("#file-restore").addEventListener("change", e => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = JSON.parse(String(rd.result).replace(/^\uFEFF/, ""));
          if (!d || d.version !== 3 || !Array.isArray(d.plans)) throw new Error("不是本工具的备份文件");
          Model.replace(d); renderAll(); toast("备份已恢复");
        } catch (err) { toast("恢复失败：" + err.message); }
      };
      rd.readAsText(f, "utf-8");
      e.target.value = "";
    });
    $("#btn-empty").addEventListener("click", () => { if (confirm("确定清空全部数据？清空后从零开始导入。")) { Model.replace(Model.emptyDataset()); renderAll(); } });

    /* 设置 */
    $("#btn-add-term").addEventListener("click", () => {
      const T = ds.settings.futureTerms;
      const last = T[T.length - 1] || "2026秋";
      const y = last.match(/20\d{2}/), s = last.slice(-1);
      let next;
      if (y) next = s === "秋" ? (+y[0] + 1) + "春" : y[0] + "秋";
      else next = prompt("输入学期名（如 2027秋）");
      if (!next) return;
      const inp = prompt("新学期名称：", next);
      if (inp && !T.includes(inp)) { Model.snapshot(); T.push(inp); renderAll(); }
    });
    $("#set-warn").addEventListener("change", e => { ds.settings.warnLoad = +e.target.value || 28; renderAll(); });
    $("#set-danger").addEventListener("change", e => { ds.settings.dangerLoad = +e.target.value || 32; renderAll(); });
    $("#set-enroll").addEventListener("change", e => {
      ds.settings.enrollYear = +e.target.value || ds.settings.enrollYear;
      renderAll();
    });
    $("#set-current-term").addEventListener("change", e => {
      const v = e.target.value.trim();
      if (/^20\d{2}[春秋]$/.test(v)) { ds.settings.currentTerm = v; renderAll(); }
      else toast("格式应为 2026秋 / 2026春");
    });

    /* 课程库搜索 */
    $("#cat-search").addEventListener("input", renderCatalog);

    /* 内置科大数据 */
    if (typeof USTC_DATA !== "undefined") {
      $("#btn-emb-catalog").addEventListener("click", importEmbeddedCatalog);
      $("#btn-goto-struct").addEventListener("click", () => {
        $$(".tab").forEach(b => b.classList.remove("active"));
        $$(".panel").forEach(p => p.classList.remove("active"));
        document.querySelector('[data-panel="struct"]').classList.add("active");
        $("#panel-struct").classList.add("active");
      });
    }
  }

  /* ---- 内置数据导入 ---- */
  function ustcCourseMap() {
    const m = new Map();
    if (typeof USTC_DATA !== "undefined")
      USTC_DATA.courses.forEach(([id, name, credits, time, teacher, dept, seats, seasons]) =>
        m.set(String(id), { id: String(id), name, credits: credits || 0, time: time || "",
          teacher: teacher || "", dept: dept || "", seats: seats || "",
          seasons: (seasons || "").split(""), slots: U.parseSlots(time || "") }));
    return m;
  }

  function embCatalogPayload() {
    const courses = [...ustcCourseMap().values()].map(c => ({
      id: c.id, name: c.name, credits: c.credits, seasons: c.seasons,
      time: c.time, note: [c.teacher, c.dept].filter(Boolean).join("·") + (c.seats ? `(${c.seats})` : "")
    }));
    return { courses, offerings: {}, student: { name: USTC_DATA.semesterName + " 公开开课目录" } };
  }

  function importEmbeddedCatalog(silent) {
    if (typeof USTC_DATA === "undefined") return toast("未找到内置数据");
    Model.snapshot();
    const payload = embCatalogPayload();
    const before = Object.keys(ds.courses).length;
    Parse.applyCrawler(ds, payload);
    renderAll();
    const log = $("#emb-log");
    if (log) log.innerHTML = `<div class="ok-text">✓ 已导入/更新 ${Object.keys(ds.courses).length - before} 门新课程（共 ${Object.keys(ds.courses).length} 门，含上课时间与开课季）</div>`;
    if (!silent) toast(`已导入 ${USTC_DATA.semesterName} 开课数据`);
  }

  function bindFileDrop(dropSel, fileSel, handler) {
    const zone = $(dropSel), file = $(fileSel);
    zone.addEventListener("click", () => file.click());
    file.addEventListener("change", () => { if (file.files[0]) handler(file.files[0]); file.value = ""; });
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("dragover"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", e => {
      e.preventDefault(); zone.classList.remove("dragover");
      if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
    });
  }

  /* ================= 导入页 ================= */
  function renderHeader() {
    $("#ds-info").textContent =
      (ds.meta.name || "未命名数据集") + (ds.meta.studentDesc ? " · " + ds.meta.studentDesc : "") +
      ` · ${ds.plans.length}个方案 · ${ds.taken.length}门已修 · ${Object.keys(ds.courses).length}门课程`;
  }

  function renderSettings() {
    $("#term-chips").innerHTML = ds.settings.futureTerms.map(t =>
      `<span class="chip">${U.esc(t)}<button class="cc-del" data-term-del="${U.esc(t)}" title="删除该学期">×</button></span>`).join("");
    $$("#term-chips [data-term-del]").forEach(b => b.addEventListener("click", () => {
      const t = b.dataset.termDel;
      if (ds.settings.futureTerms.length <= 1) return toast("至少保留一个学期");
      Model.snapshot();
      ds.settings.futureTerms = ds.settings.futureTerms.filter(x => x !== t);
      ds.board.forEach(b => { if (b.term === t) b.term = null; });
      renderAll();
    }));
    $("#set-warn").value = ds.settings.warnLoad;
    $("#set-danger").value = ds.settings.dangerLoad;
    $("#set-enroll").value = ds.settings.enrollYear;
    $("#set-current-term").value = ds.settings.currentTerm || "";
  }

  /* ---- 成绩单文件（csv/txt 直接读，docx 解压解析） ---- */
  async function handleScoreFile(file) {
    try {
      if (/\.docx$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        const xml = await U.unzipDocx(buf);
        staging.scores = Parse.parseTranscriptDocx(xml);
      } else {
        const text = await file.text();
        staging.scoreText = text;
        staging.scores = Parse.parseTranscript(text);
      }
      renderImport();
    } catch (e) { toast("成绩单解析失败：" + e.message); }
  }

  /* ---- 培养方案 docx / 文本 ---- */
  async function handlePlanFile(file) {
    if (!/\.docx$/i.test(file.name)) return toast("请上传 .docx 文件（旧 .doc 请先另存为 .docx）");
    try {
      const buf = await file.arrayBuffer();
      const xml = await U.unzipDocx(buf);
      staging.plan = Parse.parsePlanDocx(xml, file.name.replace(/\.docx$/i, ""));
      renderImport();
    } catch (e) { toast("解析失败：" + e.message); }
  }

  function parsePlanText(text, name) {
    const root = { name, credits: null, type: "container", courses: [], subs: [] };
    let cur = root;
    text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
      const req = Parse.parseReqText(line);
      if (/要求学分|要求门数/.test(line) && req.name) {
        const node = { name: req.name, credits: req.credits, type: req.credits == null ? "container" : /选修/.test(req.name) ? "pool" : "required", courses: [], subs: [] };
        cur.subs.push(node); cur = node; return;
      }
      const m = line.match(/^(.+?)\s+(?:^|\s)?(\d+(?:\.\d+)?)\s*分?$/);
      const cr = m ? parseFloat(m[2]) : NaN;
      const nm = m ? m[1].trim() : line;
      if (!isNaN(cr) && cr > 0 && cr <= 12 && nm) cur.courses.push({ id: "", name: nm, credits: cr, seasons: [] });
    });
    let courseN = 0;
    (function c(n) { courseN += n.courses.length; n.subs.forEach(c); })(root);
    return { plan: root, courseN, looseCount: 0 };
  }

  function planTreeOutline(n, depth, out) {
    if (depth > 2) return;
    if (n.type !== "container" || depth > 0)
      out.push(`<div class="prev-item" style="padding-left:${depth * 14}px"><span class="prev-mod">${U.esc(n.name)}</span>
        <span class="muted">${n.credits != null ? U.fmt(n.credits) + "分" : ""} ${n.type === "pool" ? "·选修池" : n.type === "free" ? "·自由选修" : ""} · ${n.courses.length}门</span></div>`);
    n.subs.forEach(s => planTreeOutline(s, depth + 1, out));
    if (depth === 0 && n.courses.length && !n.subs.length)
      n.courses.slice(0, 8).forEach(c => out.push(`<div class="prev-item" style="padding-left:14px">${U.esc(c.name)} <span class="muted">${U.fmt(c.credits)}分</span></div>`));
  }

  function renderImport() {
    const hero = $("#import-hero");
    if (hero) {
      hero.style.display = (Model.firstRun || (!ds.plans.length && !ds.taken.length)) ? "" : "none";
    }
    if (typeof USTC_DATA !== "undefined") {
      $("#emb-info").textContent = `${USTC_DATA.semesterName} · ${USTC_DATA.courses.length} 门开课 · ${USTC_DATA.programTree.length} 份培养方案 · ${USTC_DATA.builtAt} 抓取`;
      $(".emb-n-courses").textContent = USTC_DATA.courses.length;
    }
    const pv = $("#plan-preview");
    if (staging.plan) {
      const d = staging.plan;
      const outline = [];
      planTreeOutline(d.plan, 0, outline);
      pv.innerHTML = `
        <div class="prev-plain">「${U.esc(d.plan.name)}」 · 识别到 <b>${d.courseN}</b> 门课程</div>
        <div class="prev-list">${outline.join("") || '<span class="muted">未识别到模块</span>'}</div>
        ${d.looseCount ? `<div class="muted" style="margin-bottom:8px">其中 ${d.looseCount} 门未识别到课程编号，已自动生成编号</div>` : ""}
        <div class="imp-actions">
          <button id="btn-apply-plan" class="btn primary">✓ 加入培养方案</button>
          <button id="btn-cancel-plan" class="btn">取消</button>
          <span class="muted">导入后可在「培养方案」页调整模块与总学分</span>
        </div>`;
      $("#btn-apply-plan").addEventListener("click", () => { applyPlanDraft(staging.plan); staging.plan = null; });
      $("#btn-cancel-plan").addEventListener("click", () => { staging.plan = null; renderImport(); });
    } else pv.innerHTML = "";

    const sp = $("#score-preview");
    if (staging.scores) {
      const r = staging.scores;
      const planOpts = ds.plans.map((p, i) => `<option value="${p.id}">${U.esc(p.name)}</option>`).join("") || "";
      sp.innerHTML = `
        <div class="prev-plain">识别到 <b>${r.items.length}</b> 门成绩${r.termCount ? ` · ${r.termCount} 个学期` : ""}</div>
        <div class="prev-list">${r.items.slice(0, 40).map(it => `
          <div class="prev-item"><span class="chip">${U.esc(it.term || "?")}</span>${U.esc(it.name)}
            <span class="muted">${U.fmt(it.credits)}分 ${it.score != null ? it.score + "分" : it.pass ? "通过" : ""} ${it.gp != null ? "GPA" + it.gp : ""}${it.inprogress ? " ·进行中" : ""}</span></div>`).join("")}
          ${r.items.length > 40 ? `<div class="muted">…共 ${r.items.length} 条</div>` : ""}</div>
        ${r.warn.length ? `<div class="muted" style="color:#b45309">⚠ ${r.warn.length} 行未能识别（可忽略或手动在「已修课程」页添加）</div>` : ""}
        <div class="imp-actions">
          <span class="muted">计入方案：</span>
          <select id="score-track-sel" class="track-sel" style="max-width:220px">${planOpts}</select>
          <button id="btn-apply-score" class="btn primary">✓ 导入已修</button>
          <button id="btn-cancel-score" class="btn">取消</button>
        </div>`;
      $("#btn-apply-score").addEventListener("click", applyScores);
      $("#btn-cancel-score").addEventListener("click", () => { staging.scores = null; renderImport(); });
    } else sp.innerHTML = "";
  }

  function applyPlanDraft(r) {
    Model.snapshot();
    let draft = r.plan;
    if (Array.isArray(draft.modules) && !draft.subs)
      draft = { name: draft.name, total: draft.total, thesis: draft.thesis, courses: [], subs: draft.modules };
    Parse.prepareDraft(draft);                 // 注册课程
    const conv = (n) => ({
      id: U.uid("m"), name: n.name, credits: n.credits ?? null, type: n.type,
      courses: (n.courses || []).map(c => ({ id: c.id, alt: null })), subs: (n.subs || []).map(conv)
    });
    const modules = draft.subs.length ? draft.subs.map(conv) : [conv(draft)];
    let thesis = null;
    Model.walkModules(modules, m => { if (!thesis && /论文|毕业设计/.test(m.name)) thesis = { name: m.name, credits: m._reqDisplay || m.credits || 8 }; });
    let total = 0;
    Model.walkModules(modules, m => {
      if (m.subs.length || m.type === "free") return;
      if (m.type === "required" || m.type === "pool") total += m.credits || 0;
    });
    /* 源数据自带的毕业总学分（如官方 164 口径）优先于模块和 */
    if (draft.total && draft.total >= total - 0.2) total = draft.total;
    const p = Model.addPlan({ name: draft.name || "导入的方案", total: +(+total).toFixed(1), thesis, modules });
    Planner.topUp(ds);
    renderAll();
    toast(`已导入方案「${p.name}」(${U.fmt(p.total)} 分) — 记得在培养方案页核对总学分`);
  }

  function findCourseByName(name) {
    const key = String(name).replace(/\s+/g, "");
    return Object.values(ds.courses).find(c => c.name.replace(/\s+/g, "") === key);
  }

  function applyScores() {
    const r = staging.scores;
    if (!r) return;
    Model.snapshot();
    const planId = $("#score-track-sel").value || (ds.plans[0] && ds.plans[0].id);
    let n = 0, newC = 0;
    r.items.forEach(it => {
      let id = (it.id && ds.courses[it.id]) ? it.id : (findCourseByName(it.name) || {}).id;
      if (!id) { id = it.id || U.uid("c"); Model.ensureCourse(id, { name: it.name, credits: it.credits }); newC++; }
      else if (!ds.courses[id].credits) ds.courses[id].credits = it.credits;
      if (ds.taken.some(t => t.id === id && t.term === it.term)) return;
      ds.taken.push({ id, term: it.term || "未知", track: planId, score: it.score ?? null, gp: it.gp ?? null, pass: !!it.pass && it.score == null, inprogress: !!it.inprogress, note: "" });
      n++;
    });
    staging.scores = null;
    renderAll();
    toast(`已导入 ${n} 门成绩${newC ? `（${newC} 门新课程入库）` : ""}`);
  }

  /* ================= 总览 ================= */
  function nodeTotals(n) {
    let req = 0, done = 0, plan = 0;
    const walk = (x) => {
      if (x.type === "free") { req += x.credits || 0; done += x.doneCr || 0; plan += x.planCr || 0; return; }
      if (x.subs && x.subs.length) { x.subs.forEach(walk); return; }
      if ((x.credits || 0) > 0) { req += x.credits || 0; done += x.doneCr; plan += x.planCr; }
    };
    walk(n);
    return { req, done, plan };
  }

  function donut(req, done, plan, color, label, sub) {
    const R = 52, C = 2 * Math.PI * R;
    const pDone = req ? Math.min(1, done / req) : 0;
    const pPlan = req ? Math.min(1 - pDone, plan / req) : 0;
    return `
      <div class="donut-wrap">
        <svg viewBox="0 0 130 130" class="donut">
          <circle cx="65" cy="65" r="${R}" fill="none" stroke="#e8ecf3" stroke-width="14"></circle>
          <circle cx="65" cy="65" r="${R}" fill="none" stroke="${color}" stroke-width="14"
            stroke-dasharray="${(pDone * C).toFixed(1)} ${C.toFixed(1)}" stroke-linecap="round" transform="rotate(-90 65 65)"></circle>
          <circle cx="65" cy="65" r="${R}" fill="none" stroke="#f6c344" stroke-width="14"
            stroke-dasharray="${(pPlan * C).toFixed(1)} ${C.toFixed(1)}" stroke-dashoffset="${(-pDone * C).toFixed(1)}"
            stroke-linecap="round" transform="rotate(-90 65 65)"></circle>
          <text x="65" y="60" text-anchor="middle" class="donut-num">${Math.round(pDone * 100)}%</text>
          <text x="65" y="80" text-anchor="middle" class="donut-sub">${U.esc(label)}</text>
        </svg>
        <div class="donut-legend">
          <div><span class="dot" style="background:${color}"></span>已通过 <b>${U.fmt(done)}</b> / ${U.fmt(req)} 分</div>
          <div><span class="dot" style="background:#f6c344"></span>计划中 <b>${U.fmt(plan)}</b> 分</div>
          <div class="muted">${sub}</div>
        </div>
      </div>`;
  }

  function remainText(n) {
    const missing = [], planned = [], gaps = [];
    (function collect(x) {
      (x.items || []).forEach(it => {
        if (it.state === "missing") missing.push(it);
        else if (it.state === "planned") planned.push(it);
        else if (it.state === "gap") gaps.push(it);
      });
      (x.subs || []).forEach(collect);
    })(n);
    const parts = [];
    if (missing.length) parts.push("待修: " + missing.map(m => `${U.esc(m.name)}(${U.fmt(m.credits)})`).join("、"));
    if (planned.length) parts.push("已排: " + planned.map(m => `${U.esc(m.name)}(${U.fmt(m.credits)})`).join("、"));
    if (gaps.length) parts.push('<span class="gap-text">' + gaps.map(g => `${U.esc(g.name)} ${U.fmt(g.credits)}分`).join("、") + "</span>");
    return parts.length ? parts.join("<br>") : '<span class="ok-text">✓ 全部完成</span>';
  }

  function modBar(n, color, depth) {
    const t = nodeTotals(n);
    const full = t.req > 0 && t.done + t.plan >= t.req - 0.01;
    const pDone = t.req ? Math.min(1, t.done / t.req) : 0;
    const pPlan = t.req ? Math.min(1 - pDone, t.plan / t.req) : 0;
    return `
      <div class="modrow" style="margin-left:${depth * 14}px">
        <div class="modrow-head">
          <span class="modname">${U.esc(n.name)}</span>
          <span class="modnum">${U.fmt(t.done)}<span class="muted">/${U.fmt(t.req)}分</span>
            ${t.plan ? `<span class="chip chip-plan">+${U.fmt(t.plan)}</span>` : ""}${full ? ' <span class="ok-text">✓</span>' : ""}</span>
        </div>
        <div class="bar"><div class="bar-done" style="width:${(pDone * 100).toFixed(1)}%;background:${color}"></div>
          <div class="bar-plan" style="width:${(pPlan * 100).toFixed(1)}%;left:${(pDone * 100).toFixed(1)}%"></div></div>
        <div class="modrow-detail">${remainText(n)}${n.note ? ` <span class="muted">${U.esc(n.note)}</span>` : ""}</div>
      </div>`;
  }

  function renderOverview() {
    if (!ds.plans.length) {
      $("#donuts").innerHTML = `<div class="card" style="grid-column:1/-1">还没有培养方案 — 去「数据导入」页上传 docx / 爬虫 JSON / 演示数据。</div>`;
      $("#warnings").innerHTML = ""; $("#modbars").innerHTML = ""; return;
    }
    $("#donuts").innerHTML = ds.plans.map(p => {
      const a = audit.plans[p.id];
      const gpa = Audit.planGPA(ds, p.id);
      const cr = Audit.creditsDone(ds, p.id);
      return donut(a.totals.req, a.totals.done, a.totals.plan, p.color || "#3b82f6", p.name.slice(0, 8),
        `已修 ${U.fmt(cr)} 分${gpa ? ` · GPA ${gpa.toFixed(3)}` : ""}`);
    }).join("");

    const warns = Planner.warnings(ds);
    const tips = [
      { level: "info", text: "总览按「培养方案页」里的模块与总学分口径实时计算；导入 docx 后请核对总学分（含毕业论文与自由选修）" },
      { level: "info", text: "黄色=已排进未来学期的计划学分；在「未来规划」页拖动即可调整" }
    ];
    $("#warnings").innerHTML = warns.concat(tips).map(w =>
      `<div class="warn-item ${w.level}">${w.level === "danger" ? "⛔" : w.level === "warn" ? "⚠️" : "ℹ️"} ${U.esc(w.text)}</div>`).join("");

    $("#modbars").innerHTML = ds.plans.map(p => {
      const a = audit.plans[p.id];
      const rows = a.mods.map(m => modBar(m, p.color || "#3b82f6", 0)).join("");
      return `<div class="card"><h3><span class="dot" style="background:${p.color}"></span> ${U.esc(p.name)} 模块进度</h3>${rows || '<span class="muted">无模块</span>'}</div>`;
    }).join("");
  }

  /* ================= 已修课程 ================= */
  function renderTaken() {
    const chips = [];
    ds.plans.forEach(p => {
      const gpa = Audit.planGPA(ds, p.id), cr = Audit.creditsDone(ds, p.id);
      chips.push(`<span class="chip" style="border-left:3px solid ${p.color}">${U.esc(p.name)} ${U.fmt(cr)}分${gpa ? ` · GPA ${gpa.toFixed(3)}` : ""}</span>`);
    });
    chips.push(`<span class="chip">共 ${ds.taken.length} 门</span>`);
    $("#taken-summary").innerHTML = chips.join("");

    $("#taken-palette-zone").innerHTML = `
      <div class="zone-title">🔍 已修课程速查 <span class="muted">搜索（内置 ${typeof USTC_DATA !== "undefined" ? USTC_DATA.courses.length : ""} 门）→ 拖到下方学期列即记为该学期已修，成绩之后补填</span></div>
      <input id="taken-palette-search" class="inp-search" placeholder="🔍 课程名/编号，如：数学分析、大气物理">
      <div id="taken-palette-list" class="pool-row palette-list"><div class="empty">输入关键字，拖到下面的学期列</div></div>
    `;

    const groups = {};
    ds.taken.forEach(t => (groups[t.term] = groups[t.term] || []).push(t));
    const seq = pastTerms();                       // 入学秋 → 当前学期
    const known = new Set(seq);
    const extra = Object.keys(groups).filter(t => !known.has(t) && t !== "未知")
      .sort((a, b) => a.localeCompare(b));
    const order = [...seq, ...extra];              // 已修学期列（含导入产生的其他学期）
    const planOpts = (cur) => `<option value="">不计入</option>` + ds.plans.map(p =>
      `<option value="${p.id}" ${cur === p.id ? "selected" : ""}>${U.esc(p.name)}</option>`).join("");
    const emptyCol = (term, hint) => `
      <div class="sem-col taken-empty" data-taken-drop="${U.esc(term)}">
        <div class="sem-head">${U.esc(term)}<span class="muted">${hint}</span></div>
        <div class="empty">从上方拖课程进来</div>
      </div>`;

    $("#taken-grid").innerHTML = `<div class="sem-grid">` + order.map(term => {
      const list = groups[term] || [];
      const cr = list.reduce((a, t) => a + Audit.crOf(t.id), 0);
      if (!list.length) return emptyCol(term, "0 门");
      return `
        <div class="sem-col" data-taken-drop="${U.esc(term)}">
          <div class="sem-head">${U.esc(term)}<span class="muted">${list.length} 门 · ${U.fmt(cr)} 分</span></div>
          ${list.map(t => takenCard(t, planOpts)).join("")}
        </div>`;
    }).join("") + `
      <div class="sem-col taken-unsorted" data-taken-drop="未知">
        <div class="sem-head">📥 未标注学期<span class="muted">拖到这里先记着</span></div>
        ${(groups["未知"] || []).map(t => takenCard(t, planOpts, true)).join("") || '<div class="empty">从上方拖课程进来</div>'}
      </div></div>`;

    /* 拖拽目标：学期列 / 未标注区 */
    $$("[data-taken-drop]").forEach(z => {
      if (z.dataset.dndBound) return;
      z.dataset.dndBound = "1";
      z.addEventListener("dragover", e => { e.preventDefault(); z.classList.add("dragover"); });
      z.addEventListener("dragleave", () => z.classList.remove("dragover"));
      z.addEventListener("drop", e => {
        e.preventDefault(); z.classList.remove("dragover");
        const key = e.dataTransfer.getData("text/plain");
        if (!key || !key.startsWith("new|")) return;
        const id = key.slice(4);
        Model.snapshot();
        addTakenFromPalette(id, z.dataset.takenDrop);
        renderAll();
      });
    });
    mountPalette($("#taken-palette-search"), $("#taken-palette-list"), "输入关键字，拖到下面的学期列");
    bindTakenCards();

    $("#taken-add").innerHTML = `
      <input id="na-name" list="course-names-dl" placeholder="课程名称（可联想）">
      <datalist id="course-names-dl">${Object.values(ds.courses).slice(0, 800).map(c => `<option value="${U.esc(c.name)}">`).join("")}</datalist>
      <input id="na-credits" type="number" step="0.5" placeholder="学分">
      <input id="na-term" placeholder="学期 如2026春">
      <input id="na-score" type="number" placeholder="百分成绩(可空)">
      <input id="na-gp" type="number" step="0.1" placeholder="绩点(可空)">
      <select id="na-track">${planOpts(ds.plans[0] && ds.plans[0].id)}</select>
      <button id="na-btn" class="btn primary">添加</button>
      <div class="muted" style="grid-column:1/-1">成绩/绩点均可留空：留空=通过制课程、不计入 GPA；只填成绩会自动按档换算绩点</div>`;
    $("#na-name").addEventListener("change", () => {
      const hit = findCourseByName($("#na-name").value.trim());
      if (hit && !$("#na-credits").value) $("#na-credits").value = hit.credits;
    });
    $("#na-btn").addEventListener("click", () => {
      const name = $("#na-name").value.trim();
      const credits = parseFloat($("#na-credits").value);
      if (!name || isNaN(credits)) return toast("请填写课程名与学分");
      Model.snapshot();
      const hit = findCourseByName(name);
      const id = hit ? hit.id : U.uid("c");
      Model.ensureCourse(id, { name, credits });
      const score = $("#na-score").value === "" ? null : +$("#na-score").value;
      const gp = $("#na-gp").value === "" ? (score != null ? Parse.scoreToGPA(score) : null) : +$("#na-gp").value;
      ds.taken.push({ id, term: $("#na-term").value.trim() || "未知", track: $("#na-track").value || null, score, gp, pass: score == null && gp == null, inprogress: false, note: "" });
      renderAll(); toast("已添加");
    });
  }

  /* ================= 未来规划 ================= */
  function renderPlan() {
    const gs = Planner.gradStatus(ds);
    const T = Planner.terms(ds);
    const loads = Planner.loads(ds);
    const tol = ds.settings.conflictTolerate | 0;
    const confByTerm = {}; T.forEach(t => confByTerm[t] = Planner.conflicts(ds, t, tol).flags);

    $("#plan-head").innerHTML = `
      <div class="gstats">${ds.plans.map(p => {
        const g = gs[p.id];
        const remain = g.req - g.have;
        return `<div class="gstat ${remain <= 0.01 ? "ok" : "short"}">
          <span class="gs-label" style="color:${p.color}">● ${U.esc(p.name)}</span>
          <b>${U.fmt(g.have)}</b><span class="muted">/${U.fmt(g.req)}</span>
          ${remain <= 0.01 ? '<span class="ok-text">✓ 达标</span>' : `<span class="gap-text">还差 ${U.fmt(remain)}</span>`}
          ${g.pending ? `<span class="muted">（含待出分${U.fmt(g.pending)}）</span>` : ""}
        </div>`;
      }).join("") || '<span class="muted">无方案</span>'}</div>
      <div class="plan-actions">
        <button id="btn-auto" class="btn primary">🪄 一键排课</button>
        <button id="btn-topup" class="btn">补全必修到池</button>
        <button id="btn-clear" class="btn">清空安排（保留已选）</button>
        <span class="muted">容许叠课</span>
        <select id="set-conflict" class="track-sel" style="max-width:130px">
          ${[0, 1, 2, 3].map(n => `<option value="${n}" ${tol === n ? "selected" : ""}>${n === 0 ? "不允许冲突" : `同时段可叠 ${n} 门`}</option>`).join("")}
        </select>
        <span class="muted">拖动课程卡片到学期格 · 冲突/超载自动标红</span>
      </div>`;

    $("#plan-board").innerHTML = `
      <div class="plan-zone palette-zone">
        <div class="zone-title">🔍 课程速查 <span class="muted">搜索后拖到任意方案的学期格里即加入规划（内置 ${typeof USTC_DATA !== "undefined" ? USTC_DATA.courses.length + "+" : ""}课程库）</span></div>
        <input id="palette-search" class="inp-search" placeholder="🔍 课程名/编号，如：大气物理、量子、P007026">
        <div id="palette-list" class="pool-row palette-list"><div class="empty">输入关键字搜索课程（含上课时间），拖入上方学期</div></div>
      </div>
      ${ds.plans.map(p => {
      const pv = view[p.id] || {};
      return `
      <div class="plan-zone">
        <div class="zone-title"><span style="color:${p.color}">● ${U.esc(p.name)}</span>
          <span class="muted">${p.total ? U.fmt(U.reqFloor(p.total)) + " 分口径" : ""}</span></div>
        <div class="term-row">${T.map(t => termCol(p, t, pv, loads, confByTerm)).join("")}</div>
      </div>`;
    }).join("") || `<div class="plan-zone" data-empty-drop="1">
        <div class="zone-title">🧩 从这里开始</div>
        <div class="empty" style="padding:18px 0">还没有培养方案 — 在上方搜索并<b>拖一门课到这里</b>（将自动创建「我的方案（自定义）」并排入 ${U.esc(T[0] || "第一学期")}），或去「培养方案」页添加正式方案</div>
      </div>`}
      <div class="plan-zone">
        <div class="zone-title">📥 待选课程池 <span class="muted">拖到上方对应方案/学期即完成规划</span></div>
        <div class="pool-row" data-pool="1">${view.pool.map(poolChip).join("") || '<div class="empty">— 池空 —</div>'}</div>
      </div>`;

    const w = Planner.warnings(ds);
    $("#plan-warnings").innerHTML = w.length ? w.map(x =>
      `<div class="warn-item ${x.level}">${x.level === "danger" ? "⛔" : "⚠️"} ${U.esc(x.text)}</div>`).join("") :
      `<div class="warn-item info">ℹ️ 暂无预警</div>`;

    $("#btn-auto").addEventListener("click", () => { Model.snapshot(); Planner.autoPlan(ds); renderAll(); toast("已按开课学期与负荷自动排课"); });
    $("#btn-topup").addEventListener("click", () => { const a = Planner.topUp(ds); renderAll(); toast(a.length ? `补全 ${a.length} 门到池` : "没有新的必修缺口"); });
    $("#btn-clear").addEventListener("click", () => { Model.snapshot(); ds.board = ds.board.filter(b => b.selected); Planner.topUp(ds); renderAll(); });
    $("#set-conflict").addEventListener("change", e => { ds.settings.conflictTolerate = +e.target.value || 0; renderAll(); });

    bindDnD();
    bindTT();
    mountPalette($("#palette-search"), $("#palette-list"), "输入关键字搜索课程（含上课时间），拖入上方学期");
  }

  /* ---- 课程速查（两个页面共用的拖拽源） ---- */
  function paletteIndex() {
    const map = new Map();
    ustcCourseMap().forEach(c => map.set(c.id, {
      id: c.id, name: c.name, credits: c.credits, slots: c.slots,
      time: c.time, seasons: c.seasons, note: [c.teacher, c.dept].filter(Boolean).join("·")
    }));
    Object.values(ds.courses).forEach(c => {
      map.set(c.id, {
        id: c.id, name: c.name, credits: c.credits,
        slots: (c.slots && c.slots.length) ? c.slots : (map.get(c.id) || {}).slots || [],
        time: (c.slots && c.slots.length) ? U.slotsText(c.slots) : (map.get(c.id) || {}).time || "",
        seasons: (c.seasons && c.seasons.length) ? c.seasons : (map.get(c.id) || {}).seasons || [],
        note: c.note || (map.get(c.id) || {}).note || ""
      });
    });
    return map;
  }

  function paletteChip(c) {
    return `
      <div class="cc pc" draggable="true" data-drag="new|${U.esc(c.id)}" style="border-left-color:#0ea5e9;background:#0ea5e914">
        <div class="cc-main"><b>${U.esc(c.name)}</b><span class="cc-cr">${U.fmt(c.credits)}分</span></div>
        <div class="cc-sub">
          ${c.slots.length ? `<span class="cc-time">${U.esc(U.slotsText(c.slots))}</span>` : ""}
          ${c.seasons.length ? `<span class="muted">${U.esc(c.seasons.join("/"))}开</span>` : ""}
        </div>
      </div>`;
  }

  /* 在指定输入框/结果容器挂载速查面板 */
  function mountPalette(input, list, placeholder) {
    if (!input || !list || input.dataset.palBound) return;
    input.dataset.palBound = "1";
    const run = U.debounce(() => {
      const kw = (input.value || "").trim().toLowerCase();
      if (!kw) { list.innerHTML = `<div class="empty">${placeholder}</div>`; return; }
      const idx = paletteIndex();
      const hits = [];
      for (const c of idx.values()) {
        if (c.name.toLowerCase().includes(kw) || c.id.toLowerCase().includes(kw)) { hits.push(c); if (hits.length >= 40) break; }
      }
      list.innerHTML = hits.length ? hits.map(paletteChip).join("") : '<div class="empty">没找到，换个关键字（或去「课程库」页新增）</div>';
      bindDnD();
    }, 250);
    input.addEventListener("input", run);
  }

  /* 已修课程卡片（可编辑：课程名/学期/学分/成绩/绩点/删除） */
  function takenCard(t, planOpts, simple) {
    const c = Model.course(t.id) || { name: t.id, credits: 0 };
    const score = t.inprogress ? '<span class="badge gray">进行中</span>' :
      t.pass ? '<span class="badge gray">通过</span>' :
      t.score != null ? `<span class="badge ${t.score >= 90 ? "green" : t.score >= 80 ? "blue" : t.score >= 75 ? "green" : "red"}">${t.score}</span>` :
      t.gp != null ? `<span class="badge blue">${t.gp.toFixed(1)}</span>` : "";
    const p = ds.plans.find(x => x.id === t.track);
    const tk = `${t.id}|${U.esc(t.term)}`;
    const termSeq = pastTerms();
    const termOpts = Array.from(new Set([...termSeq, t.term, "未知"])).map(tm =>
      `<option value="${U.esc(tm)}" ${t.term === tm ? "selected" : ""}>${U.esc(tm)}</option>`).join("");
    const termSel = simple ? "" : `<div class="cs-field"><label>学期</label><select class="track-sel" title="学期" data-edit="term|${tk}">${termOpts}</select></div>`;
    return `<div class="cc-sem" style="border-left-color:${p ? p.color : "#cbd5e1"}">
      <div class="cs-top">
        <span class="cs-name">
          <input class="inp-edit name-edit" value="${U.esc(c.name)}" title="课程名（可改，防识别错误）" data-edit="name|${tk}">
          ${t.note ? `<div class="cc-note">${U.esc(t.note)}</div>` : ""}
        </span>
        <span class="cs-badges">${score}</span>
      </div>
      <div class="cs-grid">
        <div class="cs-field"><label>学分</label><input class="inp-edit" type="number" step="0.5" min="0" title="学分" value="${c.credits ?? ""}" data-edit="credits|${tk}"></div>
        <div class="cs-field"><label>成绩</label><input class="inp-edit" type="number" placeholder="—" title="百分成绩，留空=不填" value="${t.score ?? ""}" data-edit="score|${tk}"></div>
        <div class="cs-field"><label>绩点</label><input class="inp-edit" type="number" step="0.1" min="0" max="4.3" placeholder="—" title="绩点，留空=不计入GPA" value="${t.gp ?? ""}" data-edit="gp|${tk}"></div>
        ${termSel}
      </div>
      <div class="cs-foot">
        <select class="track-sel" data-track-id="${t.id}" data-track-term="${U.esc(t.term)}">${planOpts(t.track)}</select>
        <button class="cc-del" data-del-taken="${t.id}" data-del-term="${U.esc(t.term)}" title="删除记录">×</button>
      </div></div>`;
  }

  function bindTakenCards() {
    $$("#taken-grid [data-edit]").forEach(inp => inp.addEventListener("change", () => {
      const raw = inp.dataset.edit;
      const i2 = raw.indexOf("|");
      const field = raw.slice(0, i2);
      const rest = raw.slice(i2 + 1);
      const bar = rest.lastIndexOf("|");
      const id = rest.slice(0, bar), term = rest.slice(bar + 1);
      const t = ds.taken.find(x => x.id === id && x.term === term);
      if (!t) return;
      Model.snapshot();
      const v = inp.value;
      if (field === "name") {
        const hit = findCourseByName(v.trim());
        if (hit && hit.id !== t.id) { t.id = hit.id; }
        else Model.ensureCourse(t.id, { name: v.trim() || t.id });
        t.note = "已手动改名";
      } else if (field === "credits") {
        Model.ensureCourse(t.id, { credits: +v || 0 });
      } else if (field === "score") {
        t.score = v === "" ? null : +v;
        if (t.score != null) { t.pass = false; if (t.gp == null) t.gp = Parse.scoreToGPA(t.score); }
      } else if (field === "gp") {
        t.gp = v === "" ? null : +v;
      } else if (field === "term") {
        if (v && v !== t.term && !ds.taken.some(x => x.id === t.id && x.term === v)) t.term = v;
      }
      renderAll();
    }));
    $$("#taken-grid select[data-track-id]").forEach(sel => sel.addEventListener("change", () => {
      Model.snapshot();
      const id = sel.dataset.trackId, term = sel.dataset.trackTerm;
      const t = ds.taken.find(x => x.id === id && x.term === term);
      if (t) t.track = sel.value || null;
      renderAll();
    }));
    $$("#taken-grid [data-del-taken]").forEach(b => b.addEventListener("click", () => {
      if (!confirm("删除这条已修记录？（课程仍保留在课程库）")) return;
      Model.snapshot();
      ds.taken = ds.taken.filter(x => !(x.id === b.dataset.delTaken && x.term === b.dataset.delTerm));
      renderAll();
    }));
  }

  function ensureSomePlan() {
    if (ds.plans.length) return ds.plans[0];
    const p = Model.addPlan({ name: "我的方案（自定义）", total: 0, modules: [] });
    toast("已自动创建「我的方案（自定义）」— 可在培养方案页改名/设总学分");
    return p;
  }

  /* 已修学期序列：入学年秋 → 当前学期（按设置 enrollYear / currentTerm；无夏季学期） */
  function pastTerms() {
    const ey = +(ds.settings.enrollYear || new Date().getFullYear() - 2);
    const cur = ds.settings.currentTerm || guessCurrentTerm();
    const cy = +(String(cur).match(/20\d{2}/) || [ey])[0];
    let cs = (String(cur).match(/[春夏秋]/) || ["秋"])[0];
    if (cs === "夏") cs = "春";                    // 旧数据兼容：无夏季学期
    const out = [];
    for (let y = ey; y <= cy; y++) {
      out.push(y + "秋");
      out.push((y + 1) + "春");
    }
    const idx = { 春: 1, 秋: 0 };
    return out.filter(t => {
      const y = +t.slice(0, 4), s = t.slice(4);
      if (y > cy) return false;
      if (y === cy && idx[s] > idx[cs]) return false;
      return true;
    });
  }

  function guessCurrentTerm() {
    const y = new Date().getFullYear();
    const m = new Date().getMonth() + 1;
    if (m >= 9 || m === 1) return y + "秋";
    return (y - 1) + "春";
  }

  function addTakenFromPalette(id, term) {
    ensureCourseFromPalette(id);
    if (ds.taken.some(t => t.id === id && t.term === term)) { toast("该学期已有此课"); return; }
    ds.taken.push({
      id, term: term || "未知",
      track: ds.plans[0] ? ds.plans[0].id : null,
      score: null, gp: null, pass: true, inprogress: false, note: ""
    });
    toast(term ? `已记为 ${term} 已修（成绩可在卡片上补填）` : "已记入「未标注学期」");
  }

  function ensureCourseFromPalette(id) {
    let c = Model.course(id);
    if (!c) {
      const hit = ustcCourseMap().get(String(id));
      c = Model.ensureCourse(String(id), hit ? {
        name: hit.name, credits: hit.credits, seasons: hit.seasons, slots: hit.slots,
        note: [hit.teacher, hit.dept].filter(Boolean).join("·")
      } : { name: id });
    }
    return c;
  }

  function termCol(p, t, pv, loads, confByTerm) {
    const list = (pv[t] || []);
    const tot = loads.total[t] || 0;
    const lv = tot >= ds.settings.dangerLoad ? "danger" : tot >= ds.settings.warnLoad ? "warn" : "ok";
    const open = !!ttOpen[t];
    const nConf = Object.keys(confByTerm[t] || {}).length;
    return `
      <div class="term-col" data-term="${U.esc(t)}" data-track="${p.id}">
        <div class="term-col-head">${U.esc(t)}
          <span style="display:flex;gap:4px;align-items:center">
            ${nConf ? `<span class="load danger" title="存在上课时间冲突">${nConf}门冲突</span>` : ""}
            <span class="load ${lv}">${U.fmt(loads.byPlan[t] && loads.byPlan[t][p.id] || 0)}+${U.fmt(tot - (loads.byPlan[t] && loads.byPlan[t][p.id] || 0))} / ${U.fmt(tot)}分</span>
            <button class="tbtn" data-tt="${U.esc(t)}" title="查看周课表">📅</button>
          </span></div>
        ${list.length ? list.map(c => chip(c, t, p, confByTerm)).join("") : '<div class="empty">拖入课程</div>'}
        ${open ? timetable(t) : ""}
      </div>`;
  }

  function timetable(t) {
    const rows = [];
    const placed = ds.board.filter(b => b.term === t).map(b => ({ b, c: Model.course(b.id) })).filter(x => x.c);
    const cellMap = {};
    placed.forEach(({ b, c }) => (c.slots || []).forEach(s => {
      for (let p = s.s; p <= Math.min(s.e, 12); p++) {
        const k = s.d + "-" + p;
        (cellMap[k] = cellMap[k] || []).push(c);
      }
    }));
    let html = `<div class="tt-grid"><div></div>` + [1, 2, 3, 4, 5, 6, 7].map(d => `<div class="tt-head">${U.DAY_CN[d]}</div>`).join("") + `</div>`;
    for (let p = 1; p <= 12; p++) {
      html += `<div class="tt-grid"><div class="tt-period">${p}</div>`;
      for (let d = 1; d <= 7; d++) {
        const cs = cellMap[d + "-" + p];
        if (cs && cs.length) {
          const c = cs[0];
          const clash = cs.length > 1;
          html += `<div class="tt-course" style="background:${clash ? "#ef4444" : "#3b82f6"}" title="${U.esc(cs.map(x => x.name).join(" ↔ "))}">${U.esc(c.name.slice(0, 9))}${clash ? "<small>冲突!</small>" : ""}</div>`;
        } else html += `<div class="tt-cell"></div>`;
      }
      html += `</div>`;
    }
    return html;
  }

  function bindTT() {
    $$("[data-tt]").forEach(b => b.addEventListener("click", () => {
      const t = b.dataset.tt;
      ttOpen[t] = !ttOpen[t];
      renderPlan();
    }));
  }

  function chip(c, term, p, confByTerm) {
    const kindName = { thesis: "论文", selected: "已选", candidate: "候选" }[c.kind] || "";
    const idx = Planner.terms(ds).indexOf(term);
    const movable = !c.thesis;
    const clash = confByTerm && confByTerm[term] && confByTerm[term][c.id];
    const seasonWarn = c.seasons.length && !c.seasons.includes(Planner.season(term));
    const prev = movable && idx > 0 ? `<button class="cbtn" data-move="${c.key}|${U.esc(Planner.terms(ds)[idx - 1])}" title="前移一学期">◀</button>` : "";
    const next = movable && idx < Planner.terms(ds).length - 1 ? `<button class="cbtn" data-move="${c.key}|${U.esc(Planner.terms(ds)[idx + 1])}" title="后移一学期">▶</button>` : "";
    const out = movable ? `<button class="cbtn" data-move="${c.key}|pool" title="移回待选池">×</button>` : "";
    return `
      <div class="cc ${clash ? "conflict" : ""}" draggable="${movable}" data-drag="${c.key}" style="border-left-color:${p.color};background:${p.color}14">
        <div class="cc-main"><b>${U.esc(c.name)}</b><span class="cc-cr">${U.fmt(c.credits)}分</span></div>
        <div class="cc-sub">
          <span class="badge b-k">${kindName}</span>
          ${c.slots.length ? `<span class="cc-time">${U.esc(U.slotsText(c.slots))}</span>` : ""}
          ${seasonWarn ? '<span class="badge red" title="该学期通常不开课">开课?</span>' : ""}
        </div>
        <div class="cc-btns">${prev}${next}${out}</div>
        ${c.note ? `<div class="cc-note">${U.esc(c.note)}</div>` : ""}
      </div>`;
  }

  function poolChip(c) {
    const p = ds.plans.find(x => x.id === c.plan) || {};
    return `
      <div class="cc pc" draggable="true" data-drag="${c.key}" style="border-left-color:${p.color || "#94a3b8"};background:${(p.color || "#94a3b8")}14">
        <div class="cc-main"><b>${U.esc(c.name)}</b><span class="cc-cr">${U.fmt(c.credits)}分</span></div>
        <div class="cc-sub">
          <span class="badge b-k">${U.esc(p.name ? p.name.slice(0, 6) : "未归属")}</span>
          ${c.slots.length ? `<span class="cc-time">${U.esc(U.slotsText(c.slots))}</span>` : ""}
          ${c.seasons.length ? `<span class="muted">${U.esc(c.seasons.join("/"))}开</span>` : ""}
        </div>
        ${c.note ? `<div class="cc-note">${U.esc(c.note)}</div>` : ""}
      </div>`;
  }

  function bindDnD() {
    $$("[data-drag]").forEach(el => {
      if (el.dataset.dndBound) return;
      el.dataset.dndBound = "1";
      el.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", el.dataset.drag);
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    });
    $$(".term-col").forEach(col => {
      if (col.dataset.dndBound) return;
      col.dataset.dndBound = "1";
      col.addEventListener("dragover", e => { e.preventDefault(); col.classList.add("dragover"); });
      col.addEventListener("dragleave", () => col.classList.remove("dragover"));
      col.addEventListener("drop", e => {
        e.preventDefault(); col.classList.remove("dragover");
        const key = e.dataTransfer.getData("text/plain");
        if (!key) return;
        Model.snapshot();
        if (key.startsWith("new|")) {
          const id = key.slice(4);
          ensureCourseFromPalette(id);
          let planId = col.dataset.track;
          if (!planId || !Model.plan(planId)) planId = ensureSomePlan().id;
          Planner.addBoard(ds, id, planId, col.dataset.term);
        } else {
          Planner.move(ds, key, col.dataset.track, col.dataset.term);
        }
        renderAll();
      });
    });
    $$("[data-pool]").forEach(p => {
      if (p.dataset.dndBound) return;
      p.dataset.dndBound = "1";
      p.addEventListener("dragover", e => { e.preventDefault(); p.classList.add("dragover"); });
      p.addEventListener("dragleave", () => p.classList.remove("dragover"));
      p.addEventListener("drop", e => {
        e.preventDefault(); p.classList.remove("dragover");
        const key = e.dataTransfer.getData("text/plain");
        if (!key) return;
        Model.snapshot();
        if (key.startsWith("new|")) {
          const id = key.slice(4);
          ensureCourseFromPalette(id);
          Planner.addBoard(ds, id, ensureSomePlan().id, null);
        } else {
          Planner.move(ds, key, null, null);
        }
        renderAll();
      });
    });
    /* 空状态区：拖入第一门课 → 创建自定义方案并排入第一学期 */
    $$("[data-empty-drop]").forEach(z => {
      if (z.dataset.dndBound) return;
      z.dataset.dndBound = "1";
      z.addEventListener("dragover", e => { e.preventDefault(); z.classList.add("dragover"); });
      z.addEventListener("dragleave", () => z.classList.remove("dragover"));
      z.addEventListener("drop", e => {
        e.preventDefault(); z.classList.remove("dragover");
        const key = e.dataTransfer.getData("text/plain");
        if (!key) return;
        Model.snapshot();
        const T0 = Planner.terms(ds);
        if (key.startsWith("new|")) {
          const id = key.slice(4);
          ensureCourseFromPalette(id);
          Planner.addBoard(ds, id, ensureSomePlan().id, T0[0] || null);
        } else {
          const [, id] = key.split("|");
          const b = ds.board.find(x => x.plan === key.split("|")[0] && x.id === id);
          if (b) { b.plan = ensureSomePlan().id; b.term = T0[0] || null; }
        }
        renderAll();
      });
    });
    /* ◀▶× 快捷按钮 */
    $$("[data-move]").forEach(b => {
      if (b.dataset.dndBound) return;
      b.dataset.dndBound = "1";
      b.addEventListener("click", e => {
        e.stopPropagation();
        const raw = b.dataset.move;
        const i2 = raw.lastIndexOf("|");
        const key = raw.slice(0, i2), to = raw.slice(i2 + 1);
        Model.snapshot();
        if (to === "pool") Planner.move(ds, key, null, null);
        else Planner.move(ds, key, null, to);
        renderAll();
      });
    });
  }

  /* ================= 培养方案编辑 ================= */
  function renderStruct() {
    const wrap = $("#struct-cards");
    if (!ds.plans.length) { wrap.innerHTML = '<div class="card">暂无培养方案。去「数据导入」页上传 docx / 导入爬虫数据，或从下方内置列表添加。</div>'; }
    else wrap.innerHTML = ds.plans.map(p => structCard(p)).join("");
    wrap.innerHTML += `
      ${typeof USTC_DATA !== "undefined" ? embeddedPickerHtml() : ""}
      <button id="btn-add-plan" class="btn">➕ 新建空白培养方案</button>`;
    $("#btn-add-plan").addEventListener("click", () => {
      Model.snapshot();
      const p = Model.addPlan({ name: "新培养方案", total: 0, modules: [{ id: U.uid("m"), name: "必修课程", credits: null, type: "required", courses: [], subs: [] }] });
      renderAll(); toast("已创建，点击模块开始编辑");
    });
    if (typeof USTC_DATA !== "undefined") bindEmbeddedPicker();
    bindStructEvents();
  }

  /* ---- 内置培养方案选择器（1201 份目录 + 已抓详情可一键导入） ---- */
  function embeddedPickerHtml() {
    return `
    <details class="card" style="margin-bottom:16px" id="emb-picker">
      <summary style="cursor:pointer;font-weight:600">📚 从内置培养方案添加 <span class="muted">（catalog.ustc.edu.cn 公开目录 · ${USTC_DATA.programTree.length} 份 · ${USTC_DATA.builtAt}）</span></summary>
      <input id="emb-search" class="inp-search" style="margin:10px 0" placeholder="🔍 专业/院系/年级/类型，如：大气科学、辅修、量子信息、2025">
      <div id="emb-list" class="prev-list" style="max-height:340px"><div class="empty">输入关键字</div></div>
      <div class="muted">标 ✓ 的方案已内置完整模块树可一键导入；其余请运行 <code>python crawler/ustc_crawler.py --program-id 方案id</code> 抓取后从导入页添加。</div>
    </details>`;
  }

  function bindEmbeddedPicker() {
    const input = $("#emb-search"), list = $("#emb-list");
    const run = U.debounce(() => {
      const kw = (input.value || "").trim().toLowerCase();
      if (!kw) { list.innerHTML = '<div class="empty">输入关键字，如：大气 / 辅修 / 数学 / 2025</div>'; return; }
      const hits = [];
      for (const [id, name, grade, type, major, dept] of USTC_DATA.programTree) {
        const hay = `${name} ${grade} ${type} ${major} ${dept}`.toLowerCase();
        if (hay.includes(kw)) { hits.push([id, name, grade, type, major, dept]); if (hits.length >= 60) break; }
      }
      list.innerHTML = hits.map(([id, name, grade, type, major, dept]) => {
        const has = !!USTC_DATA.programs[id];
        return `<div class="prev-item">
          <span class="chip">${id}</span>
          <span>${U.esc(name || major)}</span>
          <span class="muted">${U.esc(dept)} · ${U.esc(String(grade))}级 · ${U.esc(type)}</span>
          ${has ? `<button class="btn primary" data-emb-add="${id}">✓ 添加</button>` : '<span class="muted">需爬虫抓取</span>'}
        </div>`;
      }).join("") || '<div class="empty">没找到</div>';
      $$("[data-emb-add]").forEach(b => b.addEventListener("click", () => importEmbeddedPlan(b.dataset.embAdd)));
    }, 250);
    input.addEventListener("input", run);
  }

  function importEmbeddedPlan(pid) {
    const draft = embeddedProgramDraft(pid);
    if (!draft) return toast("该方案详情未内置（可能有 13 份特殊方案未打包）");
    applyPlanDraft({ plan: draft, courseN: 0, looseCount: 0 });
  }

  /* 内置压缩格式 → v2 draft（名称池解码 + 官方高替规则挂 alt） */
  function embeddedProgramDraft(pid) {
    if (typeof USTC_DATA === "undefined") return null;
    const e = USTC_DATA.programs[pid];
    if (!e) return null;
    const pool = USTC_DATA.pool;
    const nameOf = (i) => typeof i === "number" ? pool[i] : i;
    const cmap = ustcCourseMap();
    const lo2hi = new Map();
    (USTC_DATA.subPairs || []).forEach(([hi, lo]) => { if (!lo2hi.has(lo)) lo2hi.set(lo, hi); });
    const conv = (nd) => ({
      name: nameOf(nd.n),
      credits: nd.c ?? null,
      type: nd.t,
      courses: (nd.k || []).map(([code, hi]) => {
        const meta = cmap.get(String(code)) || {};
        return { id: String(code), name: meta.name || code, credits: meta.credits || 0, seasons: meta.seasons || [], alt: hi || null };
      }),
      subs: (nd.s || []).map(conv)
    });
    const modules = e.r.s ? e.r.s.map(conv) : [conv(e.r)];
    const majorGuess = (USTC_DATA.programTree.find(x => String(x[0]) === String(pid)) || [])[1] || nameOf(e.r.n);
    return {
      name: majorGuess || "内置培养方案",
      total: e.t, freePool: true,
      thesis: e.h ? { name: e.h[0], credits: e.h[1] } : null,
      modules, _meta: { from: "embedded", pid }
    };
  }

  /* ---- 结构页事件绑定（从 renderStruct 拆出） ---- */
  function bindStructEvents() {
    /* 展开/收缩（点击 ▶ 或 数量徽标） */
    $$("[data-twisty]").forEach(el => el.addEventListener("click", () => {
      const id = el.dataset.twisty;
      const c = ds.settings.collapsed || (ds.settings.collapsed = {});
      c[id] = !c[id];
      Model.save();
      renderStruct();
    }));
    $$("[data-plan-name]").forEach(inp => inp.addEventListener("change", () => { Model.snapshot(); Model.plan(inp.dataset.planName).name = inp.value; renderAll(); }));
    $$("[data-plan-total]").forEach(inp => inp.addEventListener("change", () => { Model.snapshot(); Model.plan(inp.dataset.planTotal).total = +inp.value || 0; renderAll(); }));
    $$("[data-plan-thesis]").forEach(inp => inp.addEventListener("change", () => {
      Model.snapshot();
      const p = Model.plan(inp.dataset.planThesis);
      p.thesis = inp.value === "" ? null : { name: (p.thesis && p.thesis.name) || "毕业论文", credits: +inp.value || 8 };
      renderAll();
    }));
    $$("[data-plan-del]").forEach(b => b.addEventListener("click", () => {
      if (!confirm(`删除方案「${Model.plan(b.dataset.planDel).name}」？其课程保留在课程库。`)) return;
      Model.removePlan(b.dataset.planDel); renderAll();
    }));

    /* 模块编辑 */
    $$("[data-mchg]").forEach(el => el.addEventListener("change", () => {
      Model.snapshot();
      const [planId, modId, field] = el.dataset.mchg.split("|");
      const m = findModule(Model.plan(planId).modules, modId);
      if (!m) return;
      if (field === "name") m.name = el.value;
      else if (field === "credits") m.credits = el.value === "" ? null : +el.value;
      else if (field === "type") m.type = el.value;
      renderAll();
    }));
    $$("[data-madd-sub]").forEach(b => b.addEventListener("click", () => {
      Model.snapshot();
      const [planId, modId] = b.dataset.maddSub.split("|");
      const m = findModule(Model.plan(planId).modules, modId);
      if (!m) return;
      m.type = m.type === "free" ? "container" : m.type;
      m.subs.push({ id: U.uid("m"), name: "子模块", credits: null, type: "required", courses: [], subs: [] });
      renderAll();
    }));
    $$("[data-mdel]").forEach(b => b.addEventListener("click", () => {
      Model.snapshot();
      const [planId, modId] = b.dataset.mdel.split("|");
      const plan = Model.plan(planId);
      (function rm(list) {
        const i = list.findIndex(m => m.id === modId);
        if (i >= 0) { list.splice(i, 1); return true; }
        return list.some(m => rm(m.subs));
      })(plan.modules);
      renderAll();
    }));
    $$("[data-cmove]").forEach(sel => sel.addEventListener("change", () => {
      Model.snapshot();
      const [planId, modId, courseId] = sel.dataset.cmove.split("|");
      const plan = Model.plan(planId);
      const from = findModule(plan.modules, modId);
      const to = findModule(plan.modules, sel.value);
      if (!from || !to || from === to) return;
      const i = from.courses.findIndex(c => c.id === courseId);
      if (i >= 0) to.courses.push(from.courses.splice(i, 1)[0]);
      renderAll();
    }));
    $$("[data-cdel]").forEach(b => b.addEventListener("click", () => {
      Model.snapshot();
      const [planId, modId, courseId] = b.dataset.cdel.split("|");
      const m = findModule(Model.plan(planId).modules, modId);
      if (!m) return;
      m.courses = m.courses.filter(c => c.id !== courseId);
      renderAll();
    }));
    $$("[data-cadd]").forEach(sel => sel.addEventListener("change", () => {
      const [planId, modId] = sel.dataset.cadd.split("|");
      if (!sel.value) return;
      Model.snapshot();
      const m = findModule(Model.plan(planId).modules, modId);
      if (m && !m.courses.some(c => c.id === sel.value)) m.courses.push({ id: sel.value, alt: null });
      renderAll();
    }));
  }

  function findModule(mods, id) {
    for (const m of mods) { if (m.id === id) return m; const r = findModule(m.subs || [], id); if (r) return r; }
    return null;
  }
  function modulePath(mods, id, prefix) {
    for (const m of mods) {
      const p = prefix ? prefix + " / " + m.name : m.name;
      if (m.id === id) return p;
      const r = modulePath(m.subs || [], id, p);
      if (r) return r;
    }
    return null;
  }

  function structCard(p) {
    const a = audit.plans[p.id];
    const allMods = [];
    Model.walkModules(p.modules, m => allMods.push(m));
    const collapsed = ds.settings.collapsed || (ds.settings.collapsed = {});
    const treeHtml = (node, depth) => {
      const t = nodeTotals(a.mods.find(x => x.id === node.id) || { type: node.type, credits: node.credits, items: [], subs: (a.mods.find(x => x.id === node.id) || {}).subs });
      const st = t.req > 0 && t.done + t.plan >= t.req - 0.01 ? "done" : (t.done || t.plan) ? "planned" : "missing";
      const typeOpts = ["container", "required", "pool", "free"].map(tp =>
        `<option value="${tp}" ${node.type === tp ? "selected" : ""}>${{ container: "分组", required: "必修", pool: "选修池", free: "自由选修" }[tp]}</option>`).join("");
      const courseOpts = (excludeId) => `<option value="">+ 添加课程…</option>` + Object.values(ds.courses)
        .filter(c => c.id !== excludeId)
        .sort((x, y) => x.name.localeCompare(y.name, "zh"))
        .map(c => `<option value="${c.id}">${U.esc(c.name)} (${U.fmt(c.credits)})</option>`).join("");
      const hasKids = (node.subs || []).length > 0 || node.courses.length > 0;
      const isClosed = !!collapsed[node.id];
      return `
      <div class="tree-node">
        <div class="tree-head">
          ${hasKids && depth > 0 ? `<span class="twisty ${isClosed ? "closed" : ""}" data-twisty="${node.id}">▶</span>` : `<span class="tdot ${st}"></span>`}
          ${depth === 0 ? `<span class="tdot ${st}"></span>` : ""}
          <select class="type-sel" data-mchg="${p.id}|${node.id}|type">${typeOpts}</select>
          <input type="text" class="m-name-in" value="${U.esc(node.name)}" data-mchg="${p.id}|${node.id}|name">
          <input type="number" step="0.5" class="m-cred-in" placeholder="学分" value="${node.credits ?? ""}" data-mchg="${p.id}|${node.id}|credits">
          <span class="muted">${t.done || 0}${t.plan ? "+" + U.fmt(t.plan) : ""} / ${U.fmt(t.req)}分</span>
          ${hasKids ? `<span class="muted cnt-badge" data-twisty="${node.id}" title="点击展开/收缩">${node.courses.length ? node.courses.length + "门" : ""}${node.subs.length ? (node.courses.length ? "·" : "") + node.subs.length + "子" : ""}</span>` : ""}
          <button class="mbtn" data-madd-sub="${p.id}|${node.id}">+子模块</button>
          <button class="mbtn del" data-mdel="${p.id}|${node.id}">删除</button>
        </div>
        ${isClosed && depth > 0 ? "" : `
        <div class="tree-courses">
          ${node.courses.map(c => {
            const co = Model.course(c.id) || { name: c.id, credits: 0 };
            const it = findAuditItem(a, c.id);
            return `<div class="tree-course"><span class="tdot ${it || "missing"}"></span>${U.esc(co.name)}
              <span class="muted">${U.fmt(co.credits)}分</span>
              ${c.alt ? `<span class="muted">(可由 ${U.esc((Model.course(c.alt) || {}).name || c.alt)} 替代)</span>` : ""}
              <select class="track-sel" data-cmove="${p.id}|${node.id}|${c.id}" title="移动到其他模块">
                <option value="">移到…</option>${allMods.filter(m => m.id !== node.id).map(m =>
                  `<option value="${m.id}">${U.esc(modulePath(p.modules, m.id, ""))}</option>`).join("")}</select>
              <button class="cc-del" data-cdel="${p.id}|${node.id}|${c.id}">×</button>
            </div>`;
          }).join("")}
          <select class="track-sel" style="max-width:260px" data-cadd="${p.id}|${node.id}">${courseOpts()}</select>
        </div>
        ${(node.subs || []).map(s => treeHtml(s, depth + 1)).join("")}`}
      </div>`;
    };
    return `
    <div class="struct-card">
      <div class="struct-head">
        <input type="text" value="${U.esc(p.name)}" data-plan-name="${p.id}">
        <span class="muted">毕业总学分</span>
        <input type="number" step="0.5" style="width:80px" value="${p.total || ""}" data-plan-total="${p.id}">
        <span class="muted">论文学分</span>
        <input type="number" step="0.5" style="width:70px" placeholder="无" value="${p.thesis ? p.thesis.credits : ""}" data-plan-thesis="${p.id}">
        <span class="muted">已修 ${U.fmt(Audit.creditsDone(ds, p.id))} / ${U.fmt(p.total || 0)}</span>
        <button class="mbtn del" data-plan-del="${p.id}" style="margin-left:auto">删除方案</button>
      </div>
      ${(p.modules || []).map(m => treeHtml(m, 0)).join("") || '<span class="muted">无模块 — 点「新建空白培养方案」或在导入页上传 docx</span>'}
      <div class="muted" style="margin-top:8px">口径说明：分组=不计学分；选修池=修满即达标、超出折算自由选修；自由选修=总学分-其他模块-论文（自动算）</div>
    </div>`;
  }

  function findAuditItem(a, courseId) {
    let st = null;
    (function w(n) {
      (n.items || []).forEach(it => { if (it.id === courseId) st = it.state === "done" ? "done" : it.state === "planned" ? "planned" : st; });
      (n.subs || []).forEach(w);
    })({ subs: a.mods });
    return st;
  }

  /* ================= 课程库 ================= */
  function renderCatalog() {
    const kw = ($("#cat-search").value || "").trim().toLowerCase();
    const all = Object.values(ds.courses)
      .filter(c => !kw || c.name.toLowerCase().includes(kw) || c.id.toLowerCase().includes(kw))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    const list = all.slice(0, 250);
    $("#cat-table").innerHTML = `
      <table class="cat-table">
        <thead><tr><th style="width:110px">编号</th><th>课程名称</th><th style="width:64px">学分</th>
          <th style="width:90px">开课季</th><th style="width:150px">上课时间</th><th>备注</th><th style="width:50px"></th></tr></thead>
        <tbody>${list.map(c => `
          <tr>
            <td class="muted">${U.esc(c.id)}</td>
            <td><input value="${U.esc(c.name)}" data-cat="name|${c.id}"></td>
            <td><input type="number" step="0.5" value="${c.credits}" data-cat="credits|${c.id}"></td>
            <td><input value="${U.esc((c.seasons || []).join(""))}" placeholder="秋春" data-cat="seasons|${c.id}"></td>
            <td><input value="${U.esc(U.slotsText(c.slots))}" placeholder="如 周一3-4" data-cat="time|${c.id}"></td>
            <td><input value="${U.esc(c.note || "")}" data-cat="note|${c.id}"></td>
            <td><button class="cc-del" data-cat-del="${c.id}" title="从课程库删除">×</button></td>
          </tr>`).join("")}</tbody>
      </table>
      <div class="muted" style="margin-top:8px">共 ${all.length} 门${all.length > 250 ? `（显示前 250，用搜索缩小范围）` : ""} · 开课季填写「秋/春/夏」组合（如"秋春"）；上课时间用于规划页冲突检测</div>`;

    $$("[data-cat]").forEach(inp => inp.addEventListener("change", () => {
      const [field, id] = inp.dataset.cat.split("|");
      const c = Model.course(id);
      if (!c) return;
      if (field === "name") c.name = inp.value;
      else if (field === "credits") c.credits = +inp.value || 0;
      else if (field === "seasons") c.seasons = Array.from(new Set((inp.value.match(/[春夏秋]/g) || [])));
      else if (field === "time") c.slots = U.parseSlots(inp.value);
      else if (field === "note") c.note = inp.value;
      Model.save();
      const el = $("#save-status");
      el.textContent = "● 已保存 " + new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }));
    $$("[data-cat-del]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.catDel;
      const used = ds.plans.some(p => { let u = false; Model.walkModules(p.modules, m => { if (m.courses.some(c => c.id === id)) u = true; }); return u; });
      if (used && !confirm("该课程被培养方案模块引用，删除后模块会显示缺失。确定删除？")) return;
      Model.snapshot();
      delete ds.courses[id];
      ds.taken = ds.taken.filter(t => t.id !== id);
      ds.board = ds.board.filter(b => b.id !== id);
      renderAll();
    }));
  }

  /* ================= 导出 ================= */
  function exportPlanCSV() {
    const rows = [["学期", "方案", "课程名称", "学分", "状态", "上课时间", "备注"]];
    Planner.terms(ds).forEach(t => {
      ds.board.filter(b => b.term === t).forEach(b => {
        const c = Model.course(b.id) || { name: b.id, credits: 0 };
        const p = Model.plan(b.plan);
        rows.push([t, p ? p.name : "", c.name, c.credits, b.selected ? "已选" : b.thesis ? "论文" : "计划", U.slotsText(c.slots), c.note || ""]);
      });
    });
    ds.board.filter(b => !b.term).forEach(b => {
      const c = Model.course(b.id) || { name: b.id, credits: 0 };
      const p = Model.plan(b.plan);
      rows.push(["待选池", p ? p.name : "", c.name, c.credits, "候选", U.slotsText(c.slots), c.note || ""]);
    });
    const gs = Planner.gradStatus(ds);
    rows.push([]);
    ds.plans.forEach(p => rows.push([p.name, `${U.fmt(gs[p.id].have)}/${U.fmt(p.total)}`, gs[p.id].remain <= 0.01 ? "已达标" : `还差${U.fmt(gs[p.id].remain)}分`]));
    U.dl("选课规划.csv", U.csv(rows), "text/csv;charset=utf-8");
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
