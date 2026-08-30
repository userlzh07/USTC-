/* ============ v2 审计引擎：对任意数量、任意结构的培养方案做完成度核算 ============
   模块节点: {id, name, credits, type: container|required|pool|free, courses:[{id, alt?}], subs:[]}
   - container: 仅作分组，不计学分要求（学分由子模块承担）
   - required:  叶子要求 credits 学分，未修满显示缺口
   - pool:      选修池，要求 credits，超出部分折算自由选修
   - free:      自由选修桶，要求 = plan.total - 其他叶子要求 - 论文（自动算） */

const Audit = (() => {

  const crOf = (id) => { const c = Model.course(id); return c ? c.credits : 0; };
  const nameOf = (id) => { const c = Model.course(id); return c ? c.name : id; };

  /* 模块内一门的命中情况: {id, alt} x taken */
  function hitCourse(c, taken) {
    if (taken[c.id]) return { t: taken[c.id], alt: false };
    if (c.alt && taken[c.alt]) return { t: taken[c.alt], alt: true };
    return null;
  }

  /* ---------- 递归求值一个模块 ----------
     boardTerm: { term -> [{id, plan, term}] }（"pool" 键 = 待选池，不计入） */
  function evalNode(node, taken, boardTerm) {
    const res = {
      id: node.id, name: node.name, type: node.type || "required",
      credits: node.credits || 0, doneCr: 0, planCr: 0,
      items: [], subs: [], surplus: 0,
      hasPool: node.type === "pool", freeNode: node.type === "free"
    };
    if (res.freeNode) return res;                       // free 在方案层统一核算

    // 已修
    node.courses.forEach(c => {
      const h = hitCourse(c, taken);
      if (h) {
        res.doneCr += crOf(h.t.id);
        res.items.push({
          id: c.id, name: nameOf(c.id), credits: crOf(c.id), state: "done",
          altNote: h.alt ? `以「${nameOf(c.alt)}」替代` : ""
        });
      }
    });
    // 已排（板上有学期的）
    Object.keys(boardTerm).forEach(term => {
      if (term === "pool") return;
      boardTerm[term].forEach(b => {
        const mc = node.courses.find(c => c.id === b.id);
        if (!mc) return;
        const t = taken[b.id];
        if (t) return;                                   // 已修不再算计划
        res.planCr += crOf(b.id);
        res.items.push({ id: b.id, name: nameOf(b.id), credits: crOf(b.id), state: "planned", term });
      });
    });
    // 缺课程项
    node.courses.forEach(c => {
      if (hitCourse(c, taken)) return;
      if (res.items.some(it => it.id === c.id && it.state === "planned")) return;
      const co = Model.course(c.id);
      res.items.push({
        id: c.id, name: co ? co.name : (c.name || c.id), credits: co ? co.credits : 0,
        state: "missing", altNote: c.alt ? `可用「${nameOf(c.alt)}」替代` : ""
      });
    });

    if (node.subs) node.subs.forEach(sub => res.subs.push(evalNode(sub, taken, boardTerm)));

    if (node.type === "pool") {
      res.surplus = Math.max(0, res.doneCr + res.planCr - (node.credits || 0));
      if (node.credits > 0 && res.doneCr + res.planCr < node.credits - 0.01)
        res.items.push({ id: "GAP", name: "选修池还差学分", credits: +(node.credits - res.doneCr - res.planCr).toFixed(1), state: "gap" });
    }
    if (node.type === "required" && (node.credits || 0) > 0) {
      const remain = node.credits - res.doneCr - res.planCr;
      if (remain > 0.01) res.items.push({ id: "GAP", name: "学分缺口", credits: +remain.toFixed(1), state: "gap" });
    }
    return res;
  }

  /* ---------- 单方案审计 ---------- */
  function auditPlan(plan, taken, boardTerm, allTaken) {
    const mods = plan.modules.map(m => evalNode(m, taken, boardTerm));

    // 是否有论文模块（决定 free 扣不扣论文学分）
    let hasThesisModule = false;
    Model.walkModules(plan.modules, m => {
      if (/论文|毕业设计/.test(m.name)) hasThesisModule = true;
      m.courses.forEach(c => { if (/^THESIS/i.test(c.id)) hasThesisModule = true; });
    });
    const thesisCr = hasThesisModule ? 0 : ((plan.thesis && plan.thesis.credits) || 0);

    // 其他叶子要求合计（free 模块除外）
    let leafReq = 0;
    Model.walkModules(plan.modules, m => {
      if (m.subs && m.subs.length) return;
      if (m.type === "required" || m.type === "pool") leafReq += m.credits || 0;
    });
    // 主修毕业总要求取 max(167, 方案要求)（全校最低 167；辅修/小方案不抬）
    const effTotal = U.reqFloor(plan.total);
    const freeReq = effTotal > 0 ? Math.max(0, effTotal - leafReq - thesisCr) : 0;

    // 池超额
    let poolSurplus = 0;
    (function sp(n) { if (n.type === "pool") poolSurplus += n.surplus || 0; (n.subs || []).forEach(sp); })({ type: "root", subs: mods });

    // 模块内出现的课程 id 集合
    const moduleIds = new Set();
    Model.walkModules(plan.modules, m => m.courses.forEach(c => { moduleIds.add(c.id); if (c.alt) moduleIds.add(c.alt); }));

    // 散课（已修但不属于任何模块）→ 自由选修
    let leftover = 0, pending = 0;
    const freeItems = [];
    allTaken.forEach(t => {
      if (t.track !== plan.id) return;
      if (moduleIds.has(t.id)) return;
      const cr = crOf(t.id);
      if (t.inprogress) { pending += cr; freeItems.push({ id: t.id, name: nameOf(t.id), credits: cr, state: "planned", note: "待出分" }); }
      else { leftover += cr; freeItems.push({ id: t.id, name: nameOf(t.id), credits: cr, state: "done", note: t.note || "" }); }
    });

    // 板上已排但不在任何模块的课（自定义方案 / 自由拖排）→ 自由选修计划学分
    let boardFree = 0;
    Object.keys(boardTerm).forEach(term => {
      if (term === "pool") return;
      boardTerm[term].forEach(b => {
        if (moduleIds.has(b.id)) return;
        if (allTaken.some(t => t.track === plan.id && t.id === b.id)) return;
        boardFree += crOf(b.id);
      });
    });

    const freeDone = leftover;            // 散课实修学分全算（池超额已在池模块内计入，避免重复）
    const freeMeta = {
      credits: freeReq, doneCr: freeDone,
      planCr: Math.max(0, freeReq - freeDone - boardFree),
      items: freeItems,
      note: (poolSurplus ? `含选修池超额折算 ${U.fmt(poolSurplus)} 分` : "")
        + (pending ? ` · 待出分 ${U.fmt(pending)} 分` : "")
        + (boardFree ? ` · 已排 ${U.fmt(boardFree)} 分` : "")
    };
    // 把方案里的 free 模块填充为核算结果（多个 free 取第一个，其余清零）；没有就补一个合成节点
    let freeNode = null;
    const freeRes = mods.filter(m => m.type === "free");
    if (freeRes.length) {
      Object.assign(freeRes[0], freeMeta);
      freeNode = freeRes[0];
      freeRes.slice(1).forEach(m => Object.assign(m, { credits: 0, doneCr: 0, planCr: 0, items: [], note: "" }));
    } else {
      freeNode = Object.assign({ id: "free", name: "自由选修", type: "free", subs: [], surplus: 0, hasPool: false, freeNode: true }, freeMeta);
      mods.push(freeNode);
    }

    // 汇总（free 节点已带核算值，walk 统一处理，不重复加）
    let req = 0, done = 0, planCr = 0;
    const walk = (n) => {
      if (n.type === "free") { req += n.credits || 0; done += n.doneCr || 0; planCr += n.planCr || 0; return; }
      if (n.subs && n.subs.length) { n.subs.forEach(walk); return; }
      if ((n.credits || 0) > 0) { req += n.credits || 0; done += n.doneCr; planCr += n.planCr; }
    };
    mods.forEach(walk);

    return { plan, mods, freeNode, totals: { req, done, plan: planCr }, poolSurplus, leftover, pending, freeReq };
  }

  /* ---------- 全量运行 ---------- */
  function run(ds) {
    const takenByPlan = {};
    ds.taken.forEach(t => {
      if (!t.track) return;
      (takenByPlan[t.track] = takenByPlan[t.track] || {})[t.id] = t;
    });
    const boardByPlan = {};
    ds.board.forEach(b => {
      if (!b.plan) return;
      const k = b.term || "pool";
      const m = (boardByPlan[b.plan] = boardByPlan[b.plan] || {});
      (m[k] = m[k] || []).push(b);
    });
    const out = { plans: {} };
    ds.plans.forEach(plan => {
      out.plans[plan.id] = auditPlan(plan, takenByPlan[plan.id] || {}, boardByPlan[plan.id] || {}, ds.taken);
    });
    return out;
  }

  function planGPA(ds, planId) {
    let cr = 0, pts = 0;
    ds.taken.forEach(t => {
      if (t.track !== planId || t.gp == null) return;
      const c = crOf(t.id); cr += c; pts += c * t.gp;
    });
    return cr ? pts / cr : null;
  }

  function creditsDone(ds, planId) {
    let cr = 0;
    ds.taken.forEach(t => { if (t.track === planId && !t.inprogress) cr += crOf(t.id); });
    return cr;
  }

  return { run, planGPA, creditsDone, crOf, nameOf };
})();
