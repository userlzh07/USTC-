/* ============ v2 数据层：数据集模型 / 本地持久化 ============
   v2 核心思想：不再写死任何人个人数据。培养方案、成绩、排课时间都来自导入，
   首次使用自动汇入公共开课目录（js/data-ustc.js），不含任何个人方案或成绩。 */

const Model = (() => {

  const LS_KEY = "ustc-planner-v2-ds";

  function emptyDataset() {
    const y = new Date().getFullYear();
    const m = new Date().getMonth() + 1;
    const curTerm = (m >= 9 || m === 1) ? y + "秋" : (y - 1) + "春";   // 无夏季学期
    const enroll = y - 2;                       // 默认按大三推算，可在设置里改
    return {
      version: 3,
      meta: { name: "我的学业规划", studentDesc: "", updatedAt: Date.now() },
      settings: {
        futureTerms: ["2026秋", "2027春", "2027秋", "2028春"],
        warnLoad: 28, dangerLoad: 32, conflictTolerate: 0,
        enrollYear: enroll,
        currentTerm: curTerm
      },
      plans: [], courses: {}, taken: [], board: []
    };
  }

  /* ================= 持久化 ================= */

  function guessCurrentTerm() {
    const y = new Date().getFullYear();
    const m = new Date().getMonth() + 1;
    if (m >= 9 || m === 1) return y + "秋";
    return (y - 1) + "春";                       // 无夏季学期
  }

  let ds = null;
  let undoStack = [];
  let firstRun = false;

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && d.version === 3) {
          ds = d;
          ds.settings.conflictTolerate = ds.settings.conflictTolerate ?? 0;
          if (ds.settings.enrollYear == null) {
            ds.settings.enrollYear = new Date().getFullYear() - 2;
            ds.settings.currentTerm = guessCurrentTerm();
          }
          firstRun = false;
          return ds;
        }
      }
    } catch (e) { /* 忽略损坏数据 */ }
    firstRun = true;
    ds = emptyDataset();
    saveNow();
    return ds;
  }

  function saveNow() {
    ds.meta.updatedAt = Date.now();
    try { localStorage.setItem(LS_KEY, JSON.stringify(ds)); } catch (e) { /* 容量满 */ }
  }
  const save = U.debounce(saveNow, 400);

  function snapshot() {
    undoStack.push(JSON.stringify(ds));
    if (undoStack.length > 20) undoStack.shift();
  }
  function undo() {
    if (!undoStack.length) return false;
    ds = JSON.parse(undoStack.pop());
    saveNow();
    return true;
  }

  function replace(next) {
    snapshot();
    ds = next;
    saveNow();
  }

  /* ================= 通用查询/操作 ================= */

  const course = (id) => ds.courses[id] || null;
  const plan = (id) => ds.plans.find(p => p.id === id) || null;

  function ensureCourse(id, patch = {}) {
    let c = ds.courses[id];
    if (!c) {
      c = ds.courses[id] = {
        id, name: patch.name || id, credits: patch.credits || 0,
        seasons: [...(patch.seasons || [])], slots: [...(patch.slots || [])], note: patch.note || ""
      };
      return c;
    }
    // 已存在 → 合并（不覆盖用户已有信息）
    if (patch.name && (!c.name || c.name === id)) c.name = patch.name;
    if (patch.credits && !c.credits) c.credits = patch.credits;
    if (patch.seasons && patch.seasons.length)
      c.seasons = Array.from(new Set([...(c.seasons || []), ...patch.seasons]));
    if (patch.slots && patch.slots.length && !(c.slots || []).length) c.slots = [...patch.slots];
    if (patch.note && !c.note) c.note = patch.note;
    return c;
  }

  function addPlan(opts) {
    const colors = ["#3b82f6", "#f59e0b", "#8b5cf6", "#10b981", "#ef4444", "#0ea5e9", "#ec4899"];
    const p = {
      id: U.uid("p"), name: opts.name || "新培养方案", color: opts.color || colors[ds.plans.length % colors.length],
      total: opts.total || 0, freePool: !!opts.freePool,
      thesis: opts.thesis || null, modules: opts.modules || []
    };
    ds.plans.push(p);
    // 追认：首个方案自动吸收此前尚未归属的已修课（先导成绩、后建方案也能自动计入主修）
    if (ds.plans.length === 1) {
      ds.taken.forEach(t => { if (!t.track) t.track = p.id; });
    }
    return p;
  }

  function removePlan(id) {
    Model.snapshot();
    ds.plans = ds.plans.filter(p => p.id !== id);
    ds.taken.forEach(t => { if (t.track === id) t.track = ds.plans[0] ? ds.plans[0].id : null; });
    ds.board = ds.board.filter(b => b.plan !== id);
  }

  /* 遍历模块树 */
  function walkModules(mods, fn) {
    (mods || []).forEach(m => { fn(m); walkModules(m.subs, fn); });
  }

  /* 把课程树里的课程注册进字典 */
  function registerPlanCourses(draft) {
    Model.walkModules([draft], m => {
      m.courses.forEach(c => {
        if (c.id && !ds.courses[c.id]) ensureCourse(c.id, { name: c.name || c.id, credits: c.credits || 0, seasons: c.seasons || [] });
      });
    });
  }

  return { get ds() { return ds; }, get firstRun() { return firstRun; }, load, save, saveNow, snapshot, undo, replace, course, plan, ensureCourse, addPlan, removePlan, walkModules, registerPlanCourses, emptyDataset, LS_KEY };
})();
