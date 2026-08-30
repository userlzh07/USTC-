# -*- coding: utf-8 -*-
"""
USTC 教务数据爬虫 v2 → ustc_dataset.json → 学业规划器 v2「数据导入」
====================================================================

接口考古结论（2026-08 实测）
----------------------------
全校公开数据在 catalog.ustc.edu.cn（课程目录，无需登录教务账号）：
  GET /api/teach/semester/list                 全部学期
  GET /api/teach/lesson/list-for-teach/{学期id}  该学期全部开课(一次全量, ~3MB,
                                              含 上课时间/周次/教师/院系/学分)
  GET /api/teach/program/tree                  全部培养方案(院系→专业→年级)
  GET /api/teach/program/info/{方案id}          培养方案详情(模块树+课程+学分)
  GET /api/teach/course/search?keyword=xx       按关键字搜课程

个人数据在 jw.ustc.edu.cn（需登录，本脚本只做"慢速+少量"的尝试，失败不影响公开部分）：
  我的课表 /for-std/course-table (页面里带 stdId) → /ws/course-table/std/{stdId}?semester=xx
  成绩     /for-std/grade-sheet  (页面里带 stdId) → /ws/grade-sheet/std/{stdId}
  若接口路径对不上，脚本会把原始响应存到 crawler/debug/ 并提示你用 F12 校对。

使用
----
  python ustc_crawler.py                       # 只抓公开目录(推荐, 不碰账号)
  python ustc_crawler.py --list-programs       # 看全部培养方案列表
  python ustc_crawler.py --program-id 1234     # 抓指定培养方案详情
  python ustc_crawler.py --semester 2026年秋季  # 指定学期(默认最新)
  python ustc_crawler.py --with-personal       # 附加个人成绩/已选课(需要 cookie.txt)

防封措施（个人数据部分）
------------------------
  · 只用你自己的会话；请求间隔 6~12 秒随机抖动，全程串行
  · 浏览器同款 headers + Referer 链，先逛首页再进功能页（模拟真人动线）
  · 遇 401/302/429 立即收手；连续 3 次失败终止；总请求数预算默认 ≤ 12
  · 抓不到就明说，绝不重试轰炸 —— 个人成绩永远可以手动粘贴导入兜底
"""

import argparse
import json
import os
import random
import re
import sys
import time

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

CATALOG = "https://catalog.ustc.edu.cn"
JW = "https://jw.ustc.edu.cn"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# ---------- 防封节流 ----------
MIN_GAP, MAX_GAP = 6.0, 12.0     # 请求间隔(秒)，公开接口也一视同仁地慢
BUDGET = {"n": 0, "max": 12}     # 个人数据请求预算
DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")
_consec_fail = 0


def nap(a=MIN_GAP, b=MAX_GAP):
    t = random.uniform(a, b)
    print(f"    … 休息 {t:.1f}s（慢就是快）")
    time.sleep(t)


def headers(referer=None, xhr=False):
    h = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*" if xhr else
                  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
        "Connection": "keep-alive",
    }
    if referer:
        h["Referer"] = referer
    if xhr:
        h["X-Requested-With"] = "XMLHttpRequest"
    return h


def polite(session, method, url, *, referer=None, xhr=False, data=None,
           budget=False, timeout=40, save_as=None):
    """慢速串行请求；失败退避重试一次；连挂 3 次抛异常终止。"""
    global _consec_fail
    nap()
    for attempt in (1, 2):
        try:
            r = session.request(method, url, headers=headers(referer, xhr),
                                data=data, timeout=timeout)
            if r.status_code in (429, 503):          # 被限流 → 大退避后重试一次
                wait = 45 * attempt
                print(f"    [!] {r.status_code} 限流，退避 {wait}s")
                time.sleep(wait)
                continue
            _consec_fail = 0
            if save_as:
                os.makedirs(DEBUG_DIR, exist_ok=True)
                with open(os.path.join(DEBUG_DIR, save_as), "wb") as f:
                    f.write(r.content)
            return r
        except requests.RequestException as e:
            _consec_fail += 1
            print(f"    [!] 请求失败({attempt}/2): {e}")
            if _consec_fail >= 3:
                raise RuntimeError("连续失败 3 次，为安全起见终止爬取")
            time.sleep(20 * attempt)
    raise RuntimeError(f"请求失败: {url}")


# ---------- 学期 ----------

def pick_semester(semesters, want):
    """want 可以是 '2026年秋季学期' / '2026' / None。
    默认：优先正在进行的学期；其次 60 天内即将开始的；再退到最新。"""
    if want:
        for s in reversed(semesters):        # 从新到旧匹配，"2026"优先命中秋季而非夏季
            if want in (s.get("nameZh"), s.get("code")) or want in s.get("nameZh", ""):
                return s
        raise SystemExit(f"没找到学期 {want}（用 --list-semesters 看看）")
    today = time.strftime("%Y-%m-%d")
    def d(s):
        return s.get("start", "9999") > today            # 未开始
    for s in semesters:                                   # 在读
        if s.get("start", "") <= today <= s.get("end", ""):
            return s
    upcoming = [s for s in semesters if d(s) and s.get("start", "") <=
                time.strftime("%Y-%m-%d", time.localtime(time.time() + 60 * 86400))]
    if upcoming:
        return upcoming[0]
    for s in semesters:
        if s.get("isLast"):
            return s
    return semesters[-1]


def season_of(name):
    for k in ("夏", "春", "秋"):
        if k in name:
            return k
    return ""


def term_name(name):
    """'2026年秋季学期' → '2026秋'；跨年春学期归入起始年份。"""
    m = re.match(r"(\d{4})年(.)季", name or "")
    return m.group(1) + m.group(2) if m else (name or "未知")


# ---------- 时间解析 ----------
# "2304: 2(3,4);2304: 4(6,7)" / "1~15周 2304 :2(3,4) 何志成"
DAY_CN = {1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日"}


def parse_time_text(txt):
    if not txt:
        return []
    out = []
    for seg in str(txt).split(";"):
        m = re.search(r"(\d)\s*\(\s*([\d,\s]+?)\s*\)", seg)
        if not m:
            continue
        day = int(m.group(1))
        periods = [int(x) for x in re.findall(r"\d+", m.group(2))]
        if 1 <= day <= 7 and periods:
            out.append(f"{DAY_CN[day]}{min(periods)}-{max(periods)}节" if len(periods) > 1
                       else f"{DAY_CN[day]}{periods[0]}节")
    # 去重保序
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x); uniq.append(x)
    return uniq


# ---------- 公开目录：开课 ----------

def fetch_lessons(sess, sem):
    print(f"[*] 抓取全部开课：{sem['nameZh']} (id={sem['id']})")
    r = polite(sess, "GET", f"{CATALOG}/api/teach/lesson/list-for-teach/{sem['id']}",
               referer=f"{CATALOG}/query/lesson", xhr=True, save_as="lessons.json")
    lessons = r.json()
    term = term_name(sem["nameZh"])
    courses = {}      # id -> course dict
    offerings = []
    for L in lessons:
        course = L.get("course") or {}
        cid = str(course.get("code") or L.get("id"))
        teachers = "、".join(t.get("cn", "") for t in (L.get("teacherAssignmentList") or []) if t.get("cn"))
        dtp = L.get("dateTimePlaceText") or ""
        slots = parse_time_text(dtp)
        c = courses.setdefault(cid, {
            "id": cid, "name": course.get("cn") or cid, "credits": L.get("credits"),
            "seasons": [], "slots": [],
            "note": f"{(L.get('openDepartment') or {}).get('cn') or ''}·{teachers}".strip("·"),
        })
        if slots and not c["slots"]:
            c["slots"] = slots
        offerings.append({
            "id": cid, "term": term, "teacher": teachers,
            "time": ";".join(slots),          # v2 规划器可直接解析的格式
            "seats": f"{L.get('stdCount')}/{L.get('limitCount')}",
            "code": L.get("code"),            # 教学班号
        })
    print(f"    开课 {len(lessons)} 条 / 课程 {len(courses)} 门")
    return courses, {term: offerings}


# ---------- 公开目录：培养方案 ----------

def fetch_program_tree(sess):
    print("[*] 抓取培养方案目录（院系→专业→年级）")
    r = polite(sess, "GET", f"{CATALOG}/api/teach/program/tree",
               referer=f"{CATALOG}/plan", xhr=True, save_as="program_tree.json")
    tree = r.json()
    out = []
    for dept in tree.values():
        for major in (dept.get("majors") or {}).values():
            for p in (major.get("programs") or []):
                out.append({
                    "id": p["id"], "name": p.get("nameZh"),
                    "grade": p.get("grade"), "trainType": p.get("trainType"),
                    "major": major.get("nameZh"), "dept": dept.get("nameZh"),
                })
    print(f"    共 {len(out)} 份培养方案")
    return out


def module_type(self_node):
    name = (self_node.get("nameZh") or self_node.get("type") or "")
    if "自由选修" in name or "第二课堂" in name:
        return "free"
    subs = self_node.get("requiredSubModuleNum") or 0
    if subs:
        return "container"
    if "选修" in name:
        return "pool"
    return "required"


def convert_module(node):
    """EAMS moduleTree 节点 → 规划器 v2 模块。"""
    s = node.get("self") or {}
    name = s.get("nameZh") or s.get("type") or "模块"
    mtype = module_type(s)
    courses = []
    for c in (s.get("courses") or []):
        co = c.get("course") or {}
        if not co.get("code"):
            continue
        seasons = [x for x in re.findall(r"[春夏秋]", co.get("seasons") or "")]
        courses.append({
            "id": str(co["code"]), "name": co.get("nameZh") or str(co["code"]),
            "credits": co.get("credits"), "seasons": seasons,
        })
    mod = {"name": name, "credits": s.get("requiredCredits"), "type": mtype, "courses": courses}
    kids = [convert_module(k) for k in (node.get("children") or [])]
    # 课程和子模块并存时，把课程包成独立子模块，保证学分核算干净
    if courses and kids:
        leaf_type = "pool" if mtype == "pool" else "required"
        mod["type"] = "container"
        mod["credits"] = None
        kids.insert(0, {"name": name + "·课程", "credits": s.get("requiredCredits"),
                        "type": leaf_type, "courses": courses})
    elif courses and not kids:
        # 叶子：按课程数/要求门数判断 pool
        n = s.get("requiredCourseNum") or 0
        if mtype == "required" and n and len(courses) > n:
            mtype = "pool"
        mod["type"] = mtype
    mod["subs"] = kids
    return mod


def fetch_program(sess, pid):
    print(f"[*] 抓取培养方案详情 id={pid}")
    r = polite(sess, "GET", f"{CATALOG}/api/teach/program/info/{pid}",
               referer=f"{CATALOG}/program", xhr=True, save_as=f"program_{pid}.json")
    info = r.json()
    mt = info.get("moduleTree") or []
    modules = [convert_module(m) for m in mt]

    # 毕业论文 & 总学分
    thesis = None
    total = 0.0

    def walk(m):
        nonlocal total, thesis
        if m.get("subs"):
            for k in m["subs"]:
                walk(k)
            return
        if "论文" in (m.get("name") or ""):
            thesis = {"name": m["name"], "credits": m.get("credits") or 8}
            return
        if m.get("type") in ("required", "pool") and m.get("credits"):
            total += m["credits"]
    for m in modules:
        walk(m)
    # 顶层本身是叶子的情况
    if not modules and mt:
        modules = [convert_module({"self": mt[0].get("self"), "children": mt[0].get("children")})]
    if not thesis:
        thesis = {"name": "毕业论文", "credits": 8}
    total += thesis["credits"]
    major = (info.get("major") or {}).get("nameZh") or ""
    grade = info.get("grade") or ""
    name = f"{major}培养方案（{grade}级{info.get('trainType') or ''}）".strip()
    return {
        "name": name, "total": round(total, 1), "freePool": True,
        "thesis": thesis, "modules": modules,
        "_meta": {"grade": grade, "major": major,
                  "department": (info.get("department") or {}).get("nameZh")},
    }


# ---------- 个人数据（可选，慢速，失败不影响公开部分） ----------

def find_std_id(html):
    m = (re.search(r"stdId['\"]?\s*[:=]\s*(\d+)", html)
         or re.search(r"/(?:for-std|ws)/[^'\"]*?/(\d{3,})", html))
    return m.group(1) if m else None


def fetch_personal(sess, sem_id, term, data, log):
    print("[*] 个人数据模式（慢速，遇阻即停）")
    std_id = None
    BUDGET["n"] = 0

    def budget_over():
        BUDGET["n"] += 1
        return BUDGET["n"] > BUDGET["max"]

    # 0. 暖场：像人一样先逛首页
    r = polite(sess, "GET", JW + "/", save_as="jw_home.html")
    if "login" in r.url or r.status_code in (401, 403):
        print("    [x] Cookie 无效或已过期（跳到登录页了）。请重新从浏览器复制 Cookie。")
        log.append("个人数据：Cookie 无效，已跳过（公开部分不受影响）")
        return

    # 1. 我的课表（含已选课+上课时间）
    try:
        r = polite(sess, "GET", JW + "/for-std/course-table",
                   referer=JW + "/", save_as="jw_course_table.html")
        std_id = find_std_id(r.text)
        print(f"    stdId = {std_id}")
        got = False
        if std_id:
            for path in (f"/ws/course-table/std/{std_id}?semester={sem_id}",
                         f"/ws/timetable/std/{std_id}?semester={sem_id}"):
                r2 = polite(sess, "GET", JW + path, referer=JW + "/for-std/course-table",
                            xhr=True, save_as="jw_timetable.json")
                if r2.status_code != 200 or not r2.text.strip().startswith(("[", "{")):
                    continue
                tt = r2.json()
                lessons = []
                if isinstance(tt, list):
                    lessons = tt
                elif isinstance(tt, dict):
                    lessons = (tt.get("timetable") or {}).get("lessons") or tt.get("lessons") or []
                for L in lessons:
                    if not isinstance(L, dict):
                        continue
                    course = L.get("course") or {}
                    cid = str(course.get("code") or L.get("id") or course.get("cn") or "")
                    if not cid:
                        continue
                    dtp = L.get("dateTimePlaceText") or ""
                    data["courses"][cid] = data["courses"].get(cid) or {
                        "id": cid, "name": course.get("cn") or cid,
                        "credits": L.get("credits"), "seasons": [], "slots": [], "note": "",
                    }
                    slots = parse_time_text(dtp)
                    if slots and not data["courses"][cid]["slots"]:
                        data["courses"][cid]["slots"] = slots
                    data["selected"].append({
                        "id": cid, "name": course.get("cn") or cid, "term": term,
                    })
                if lessons:
                    log.append(f"个人课表：+{len(lessons)} 门（接口 {path.split('?')[0]}）")
                    got = True
                    break
        if not got:
            log.append("个人课表：自动尝试的接口都没通 → 用 F12 抓一下真实接口，或在规划器里粘贴导入")
            print("    [!] 课表接口没通（原始响应已存 crawler/debug/）")
    except Exception as e:
        log.append(f"个人课表失败：{e}")

    nap()

    # 2. 成绩
    try:
        r = polite(sess, "GET", JW + "/for-std/grade-sheet",
                   referer=JW + "/", save_as="jw_grade_page.html")
        std_id = std_id or find_std_id(r.text)
        got = 0
        if std_id:
            for path in (f"/ws/grade-sheet/std/{std_id}",
                         f"/ws/grade/std/{std_id}",
                         f"/ws/score/std/{std_id}"):
                r2 = polite(sess, "GET", JW + path, referer=JW + "/for-std/grade-sheet",
                            xhr=True, save_as="jw_scores.json")
                if r2.status_code != 200 or not r2.text.strip().startswith(("[", "{")):
                    continue
                try:
                    rows = r2.json()
                except ValueError:
                    continue
                got = absorb_scores(rows, data)
                if got:
                    log.append(f"个人成绩：+{got} 门（接口 {path}）")
                    break
        if not got:
            got = absorb_scores_html(r.text, data)
            if got:
                log.append(f"个人成绩：从页面表格解析 +{got} 门（请核对）")
            else:
                log.append("个人成绩：接口没通 → 最稳的方式：成绩页面全选复制，在规划器里粘贴导入")
                print("    [!] 成绩接口没通（原始响应已存 crawler/debug/）")
    except Exception as e:
        log.append(f"个人成绩失败：{e}")


def absorb_scores(rows, data):
    """兼容若干返回结构，尽力吸收成绩列表。"""
    if isinstance(rows, dict):
        for k in ("rows", "items", "list", "data", "gradeSheet"):
            if k in rows and isinstance(rows[k], list):
                rows = rows[k]
                break
        else:
            # 形如 {学期: [成绩...]} 的结构
            flat = []
            for v in rows.values():
                if isinstance(v, list):
                    flat.extend(v)
            rows = flat
    n = 0
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        name = (row.get("courseName") or row.get("kcmc") or row.get("name") or "")
        if not name:
            continue
        score = row.get("totalScore") or row.get("score") or row.get("cj")
        gp = row.get("gp") or row.get("jd") or row.get("gpa")
        term = row.get("semesterName") or row.get("xnxq") or ""
        tm = re.match(r"(\d{4})年?(.)季", str(term))
        data["scores"].append({
            "id": str(row.get("courseCode") or row.get("kcbh") or name),
            "name": name,
            "credits": float(row.get("credits") or row.get("xf") or 0) or None,
            "term": (tm.group(1) + tm.group(2)) if tm else str(term),
            "score": float(score) if score and re.match(r"^\d+(\.\d+)?$", str(score)) else None,
            "gp": float(gp) if gp and re.match(r"^\d+(\.\d+)?$", str(gp)) else None,
            "pass": str(score) in ("通过", "合格", "优", "良", "中", "及格"),
        })
        n += 1
    return n


def absorb_scores_html(html, data):
    """最后兜底：从 /for-std/grade-sheet 页面 HTML 表格里抠成绩。"""
    n = 0
    for m in re.finditer(r"<tr[^>]*>(.*?)</tr>", html, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip()
                 for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", m.group(1), re.S)]
        if len(cells) < 4:
            continue
        name = next((c for c in cells if re.search(r"[\u4e00-\u9fa5]{3,}", c) and "学期" not in c), "")
        nums = [c for c in cells if re.match(r"^\d+(\.\d+)?$", c)]
        if not name or not nums:
            continue
        credits = next((float(x) for x in nums if 0 < float(x) <= 12), None)
        data["scores"].append({"id": "", "name": name, "credits": credits,
                               "term": "未知", "score": None, "gp": None, "pass": False})
        n += 1
    return n


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description="USTC 教务数据爬虫 v2（公开目录 + 可选个人数据）")
    ap.add_argument("--semester", help="学期，如 '2026年秋季学期' 或 '2026'；默认最新学期")
    ap.add_argument("--list-semesters", action="store_true", help="只列出学期")
    ap.add_argument("--list-programs", action="store_true", help="只列出全部培养方案")
    ap.add_argument("--program-id", help="抓取指定培养方案详情(可多个, 逗号分隔)")
    ap.add_argument("--program", help="按名称模糊匹配培养方案(如 '大气科学'), 自动抓匹配到的")
    ap.add_argument("--with-personal", action="store_true",
                    help="附加抓取个人成绩/已选课（需 cookie.txt，慢速防封）")
    ap.add_argument("--out", default="ustc_dataset.json", help="输出文件名")
    args = ap.parse_args()

    sess = requests.Session()
    sess.headers.update({"User-Agent": UA})

    data = {
        "student": {},
        "courses": {},        # 课程字典 id -> course（输出时转数组）
        "scores": [],         # 个人成绩
        "selected": [],       # 已选课
        "plans": [],          # 培养方案（v2 支持多方案）
        "offerings": {},      # 学期 → 开课列表(含时间)
        "_source": "catalog.ustc.edu.cn 公开目录 + jw.ustc.edu.cn 个人数据(可选)",
        "_fetchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    log = []

    # 1) 学期表
    print("[*] 读取学期列表（公开接口，不涉及账号）")
    r = polite(sess, "GET", f"{CATALOG}/api/teach/semester/list", xhr=True, save_as="semesters.json")
    semesters = r.json()
    print(f"    共 {len(semesters)} 个学期（2002 至今）")
    if args.list_semesters:
        for s in semesters[-12:]:
            print(f"      id={s['id']:<4} {s['nameZh']}")
        return
    sem = pick_semester(semesters, args.semester)
    term = term_name(sem["nameZh"])
    print(f"    选定：{sem['nameZh']} (id={sem['id']})")

    # 2) 全部开课（1 个请求拿全量）
    courses, offerings = fetch_lessons(sess, sem)
    data["courses"].update(courses)          # 课程字典（含上课时间）
    data["offerings"].update(offerings)

    # 3) 培养方案目录
    tree = fetch_program_tree(sess)

    if args.list_programs:
        for p in tree:
            print(f"      id={p['id']:<5} {p['dept']} / {p['major']} / {p['grade']}级 / {p['trainType']} — {p['name']}")
        return

    # 4) 挑培养方案抓详情
    pids = []
    if args.program_id:
        pids = [int(x) for x in str(args.program_id).split(",") if x.strip().isdigit()]
    elif args.program:
        hits = [p for p in tree if args.program in (p["name"] or "") or args.program in (p["major"] or "")]
        for h in hits[:6]:
            print(f"      匹配: id={h['id']} {h['dept']} / {h['major']} / {h['grade']}级 — {h['name']}")
        if len(hits) > 6:
            print(f"      …共 {len(hits)} 个匹配，只抓前 6 个（用 --program-id 精确指定）")
        pids = [h["id"] for h in hits[:6]]
    else:
        print("    (未指定培养方案 — 用 --list-programs 查看全部，--program '大气科学' 或 --program-id 1234 抓取)")
    for pid in pids:
        nap()
        try:
            plan = fetch_program(sess, pid)
            data["plans"].append(plan)
            log.append(f"培养方案「{plan['name']}」模块 {len(plan['modules'])} 个 · 总学分 {plan['total']}")
            # 培养方案里的课程并进课程字典（补开课季节，保留已抓到的上课时间/教师）
            def reg(m):
                for c in m.get("courses", []):
                    old = data["courses"].get(c["id"]) or {}
                    data["courses"][c["id"]] = {
                        "id": c["id"], "name": c["name"] or old.get("name"),
                        "credits": c["credits"] if c.get("credits") is not None else old.get("credits"),
                        "seasons": sorted(set(c.get("seasons") or []) | set(old.get("seasons") or []),
                                          key="夏春秋".index),
                        "slots": old.get("slots", []),
                        "note": old.get("note", ""),
                    }
                for k in m.get("subs", []):
                    reg(k)
            for m in plan["modules"]:
                reg(m)
        except Exception as e:
            log.append(f"培养方案 {pid} 抓取失败：{e}")

    # 5) 可选：个人数据
    if args.with_personal:
        cookie = ""
        for cf in (os.path.join(os.path.dirname(os.path.abspath(__file__)), "cookie.txt"), "cookie.txt"):
            if os.path.exists(cf):
                cookie = open(cf, encoding="utf-8").read().strip()
                break
        if not cookie:
            print("\n[!] --with-personal 需要 cookie.txt：浏览器登录 jw.ustc.edu.cn → F12 → 网络 → "
                  "任意请求 → 请求标头 → 复制整串 Cookie 保存到 crawler/cookie.txt")
            log.append("个人数据：未找到 cookie.txt，已跳过")
        else:
            sess.headers["Cookie"] = cookie
            fetch_personal(sess, sem["id"], term, data, log)

    # 6) 收尾：课程字典 → 数组
    data["courses"] = list(data["courses"].values())

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    kb = os.path.getsize(out) // 1024
    print(f"\n[✓] 已生成 {out} ({kb} KB)")
    print(f"    课程 {len(data['courses'])} 门 · 开课学期 {list(data['offerings'])} · 培养方案 {len(data['plans'])} 份")
    for line in log:
        print("    · " + line)
    print("    打开 规划器v2 → 数据导入 → 教务系统爬虫数据 → 选择该 JSON")


if __name__ == "__main__":
    main()
