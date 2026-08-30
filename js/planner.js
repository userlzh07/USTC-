/* ============ v2 排课板引擎：未来学期分区 + 待选池 + 冲突检测 + 一键排课 ============ */

const Planner = (() => {

  const terms = (ds) => ds.settings.futureTerms;
  const season = (t) => U.seasonOf(t) || "";

  /* ---------- 板视图: {planId: {term: [item]}, pool: [item]} ---------- */
  function view(ds) {
    const v = { pool: [] };
    ds.plans.forEach(p => { v[p.id] = {}; terms(ds).forEach(t => v[p.id][t] = []); });
    ds.board.forEach((b, idx) => {
      const item = enrich(ds, b, idx);
      if (!v[b.plan]) return;                       // 方案已删除
      if (b.term && v[b.plan][b.term]) v[b.plan][b.term].push(item);
      else v.pool.push(item);
    });
    return v;
  }

  function enrich(ds, b, idx) {
    const c = Model.course(b.id) || { name: b.id, credits: 0 };
    return {
      key: b.plan + "|" + b.id, id: b.id, plan: b.plan, term: b.term, idx,
      name: c.name, credits: c.credits, slots: c.slots || [], seasons: c.seasons || [],
      note: c.note || "", selected: !!b.selected, thesis: !!b.thesis,
      kind: b.thesis ? "thesis" : b.selected ? "selected" : "candidate"
    };
  }

  /* ---------- 补全：把"必修未排/论文"加进板（不动已有安排） ---------- */
  function topUp(ds) {
    const takenIds = new Set(ds.taken.map(t => t.id));        // 已修即不再规划
    // 移除板上已修的课（含备选池/已排的），避免"已修还挂在规划池里"
    ds.board = ds.board.filter(b => !takenIds.has(b.id));
    const inBoard = new Set(ds.board.map(b => b.id + "@" + b.plan));
    const added = [];
    const T = terms(ds);

    ds.plans.forEach(plan => {
      const a = Audit.run(ds).plans[plan.id];
      (function walk(n) {
        n.subs.forEach(walk);
        n.items.forEach(it => {
          if (it.state === "missing" && it.id !== "GAP") {
            const k = it.id + "@" + plan.id;
            if (!inBoard.has(k) && !takenIds.has(it.id)) {
              ds.board.push({ id: it.id, plan: plan.id, term: null });
              inBoard.add(k); added.push(it.name);
            }
          }
        });
      })({ subs: a.mods, items: [] });
      // 论文：优先复用方案模块里已有的论文课程 id，避免双计
      if (plan.thesis) {
        let tid = null;
        Model.walkModules(plan.modules, m => m.courses.forEach(c => {
          const name = (Model.course(c.id) || {}).name || "";
          if (!tid && (/^THESIS/i.test(c.id) || /论文|毕业设计/.test(name) || /论文|毕业设计/.test(m.name))) tid = c.id;
        }));
        if (!tid) {
          tid = "THESIS-" + plan.id;
          Model.ensureCourse(tid, { name: plan.thesis.name || "毕业论文", credits: plan.thesis.credits || 8 });
        }
        if (!inBoard.has(tid + "@" + plan.id) && !takenIds.has(tid)) {
          ds.board.push({ id: tid, plan: plan.id, term: T[T.length - 1], thesis: true });
        }
      }
    });
    return added;
  }

  /* ---------- 一键排课（保留"已选"，其余重新分配） ---------- */
  /* 毕业最低 167 分（全校口径），所以方案总要求一律取 max(167, 方案要求)。
     只排到"够毕业"为止：必修全排（都是必须），选修池只补到缺口，不超额堆课。 */
  function autoPlan(ds) {
    const T = terms(ds);
    ds.board = ds.board.filter(b => b.selected);
    topUp(ds);

    const audit = Audit.run(ds);
    const load = {}; T.forEach(t => load[t] = 0);
    ds.board.forEach(b => { if (b.term && load[b.term] != null) load[b.term] += Audit.crOf(b.id); });
    const cap = (ds.settings.warnLoad || 28) - 4;

    const pickTerm = (course) => {
      const seasons = course.seasons || [];
      const ok = T.filter(t => !seasons.length || seasons.includes(season(t)));
      const pool = ok.length ? ok : T;
      const sorted = pool.slice().sort((a, b) =>
        ((seasons.length && seasons.includes(season(b))) ? 1 : 0) - ((seasons.length && seasons.includes(season(a))) ? 1 : 0) ||
        load[a] - load[b] || T.indexOf(a) - T.indexOf(b));
      for (const t of sorted) if (load[t] < cap) return t;
      return sorted[0];
    };
    const takenIds = (pid) => new Set(ds.taken.filter(t => t.track === pid).map(t => t.id));

    ds.plans.forEach(plan => {
      const a = audit.plans[plan.id];
      const taken = takenIds(plan.id);
      // 递归：required 叶子全排；pool 叶子只补缺口(need)；container/free 往下走
      const auditByMod = (origMod, audMod) => {
        if (origMod.subs && origMod.subs.length) {
          (origMod.subs || []).forEach((orig, i) => auditByMod(orig, (audMod.subs || [])[i] || audMod));
          return;
        }
        // 叶子
        if (origMod.type === "required") {
          (origMod.courses || []).forEach(c => {
            if (taken.has(c.id)) return;
            const b = ds.board.find(x => x.plan === plan.id && x.id === c.id && !x.term && !x.selected && !x.thesis);
            if (!b) return;
            const cc = Model.course(c.id) || {};
            b.term = pickTerm(cc);
            load[b.term] += cc.credits || 0;
          });
        } else if (origMod.type === "pool") {
          const need = (origMod.credits || 0) - (audMod.doneCr || 0) - (audMod.planCr || 0);
          let remain = need;
          (origMod.courses || []).forEach(c => {
            if (remain <= 0.01) return;
            if (taken.has(c.id)) return;
            const b = ds.board.find(x => x.plan === plan.id && x.id === c.id && !x.term && !x.selected && !x.thesis);
            if (!b) return;
            const cc = Model.course(c.id) || {};
            b.term = pickTerm(cc);
            load[b.term] += cc.credits || 0;
            remain -= cc.credits || 0;
          });
        }
        // free / 其他类型叶子：不在这里排
      };
      (plan.modules || []).forEach((m, i) => auditByMod(m, (a.mods || [])[i] || a));
    });
    return load;
  }

  /* ---------- 负载 ---------- */
  function loads(ds) {
    const l = { total: {}, byPlan: {} };
    terms(ds).forEach(t => { l.total[t] = 0; l.byPlan[t] = {}; });
    ds.board.forEach(b => {
      if (!b.term || l.total[b.term] == null) return;
      const cr = Audit.crOf(b.id);
      l.total[b.term] += cr;
      l.byPlan[b.term][b.plan] = (l.byPlan[b.term][b.plan] || 0) + cr;
    });
    return l;
  }

  /* ---------- 时间冲突（一个学期内；tolerate=允许同时上课重叠的门数-1） ----------
     同一时段被超过 1+tolerate 门课占用 → 该时段全部课程标红 */
  function conflicts(ds, term, tolerate) {
    const allowed = 1 + (tolerate | 0);
    const list = ds.board.filter(b => b.term === term)
      .map(b => ({ b, c: Model.course(b.id) }))
      .filter(x => x.c && x.c.slots && x.c.slots.length);
    const slotMap = {};                       // "d-p" -> [courseId]
    const nameOf = {};
    list.forEach(({ b, c }) => {
      nameOf[b.id] = c.name;
      c.slots.forEach(s => {
        for (let p = s.s; p <= s.e; p++) {
          const k = s.d + "-" + p;
          (slotMap[k] = slotMap[k] || []).push(b.id);
        }
      });
    });
    const flagged = new Set();
    const clashGroups = [];
    Object.entries(slotMap).forEach(([k, ids]) => {
      if (ids.length > allowed) {
        ids.forEach(id => flagged.add(id));
        if (ids.length > 1) clashGroups.push([...new Set(ids)].map(id => nameOf[id]).join(" ↔ "));
      }
    });
    const flags = {};
    [...flagged].forEach(id => flags[id] = true);
    return { flags, pairs: [...new Set(clashGroups)] };
  }

  /* ---------- 警告 ---------- */
  function warnings(ds) {
    const out = [];
    const l = loads(ds);
    const audit = Audit.run(ds);
    const tol = ds.settings.conflictTolerate | 0;
    terms(ds).forEach(t => {
      const c = conflicts(ds, t, tol);
      if (Object.keys(c.flags).length)
        out.push({ level: "danger", text: `${t} 上课时间冲突（同时段超 ${1 + tol} 门）：${c.pairs.slice(0, 4).join("；")}${c.pairs.length > 4 ? " 等" : ""}` });
      const tot = l.total[t];
      if (tot >= (ds.settings.dangerLoad || 32)) out.push({ level: "danger", text: `${t} 合计 ${U.fmt(tot)} 分，极端超载` });
      else if (tot >= (ds.settings.warnLoad || 28)) out.push({ level: "warn", text: `${t} 合计 ${U.fmt(tot)} 分，负荷偏高` });
      ds.board.filter(b => b.term === t).forEach(b => {
        const c2 = Model.course(b.id);
        if (c2 && c2.seasons && c2.seasons.length && !c2.seasons.includes(season(t)))
          out.push({ level: "warn", text: `${t} · ${c2.name} 通常只在「${c2.seasons.join("/")}」季开课` });
      });
    });
    ds.plans.forEach(plan => {
      const a = audit.plans[plan.id];
      const req = U.reqFloor(plan.total);          // 主修毕业要求最低 167
      const remain = req - a.totals.done - a.totals.plan;
      if (plan.total > 0 && remain > 0.01)
        out.push({ level: "warn", text: `「${plan.name}」按当前安排还差 ${U.fmt(remain)} 分未落实` });
    });
    return out;
  }

  /* ---------- 毕业口径（每方案总学分） ---------- */
  function gradStatus(ds) {
    const out = {};
    ds.plans.forEach(plan => {
      let have = 0, pending = 0;
      ds.taken.forEach(t => {
        if (t.track !== plan.id) return;
        const cr = Audit.crOf(t.id);
        if (t.inprogress) pending += cr; else have += cr;
      });
      ds.board.forEach(b => {
        if (b.plan !== plan.id || !b.term) return;
        if (ds.taken.some(t => t.id === b.id && t.track === plan.id)) return;
        have += Audit.crOf(b.id);
      });
      out[plan.id] = { req: U.reqFloor(plan.total) || 0, have, pending, remain: (U.reqFloor(plan.total) || 0) - have };
    });
    return out;
  }

  /* ---------- 移动 ---------- */
  function move(ds, key, toPlan, toTerm) {
    const [plan, id] = key.split("|");
    const b = ds.board.find(x => x.plan === plan && x.id === id);
    if (!b) return null;
    if (b.thesis && toTerm == null) return null;
    if (toTerm == null) { b.term = null; return b; }
    if (!terms(ds).includes(toTerm)) return null;
    b.plan = toPlan || b.plan;
    b.term = toTerm;
    return b;
  }

  function addBoard(ds, courseId, planId, term) {
    if (ds.board.some(b => b.id === courseId && b.plan === planId)) return;
    ds.board.push({ id: courseId, plan: planId, term: term || null });
  }

  return { terms, season, view, topUp, autoPlan, loads, conflicts, warnings, gradStatus, move, addBoard, enrich };
})();
