# -*- coding: utf-8 -*-
"""
抓取 catalog.ustc.edu.cn 全部培养方案详情（公开接口，无需登录）
- 断点续传：debug/program_{id}.json 已存在的跳过，可反复运行直到全部完成
- 礼貌抓取：并发2、每请求随机间隔，404/失败记录跳过不重试轰炸
输出：crawler/debug/program_{id}.json 供 tools/build-ustc-data.js 打包内置
"""
import json
import os
import random
import sys
import time
import io
import threading
import queue

import requests

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
except Exception:
    pass

BASE = "https://catalog.ustc.edu.cn"
HERE = os.path.dirname(os.path.abspath(__file__))
DEBUG = os.path.join(HERE, "debug")
os.makedirs(DEBUG, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
HDRS = {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
        "Referer": BASE + "/program"}

lock = threading.Lock()
stats = {"ok": 0, "skip": 0, "fail": 0, "fail_ids": []}


def ensure_base():
    """学期表 / 全部开课 / 方案目录（若缺失才抓）。"""
    def grab(path, fname):
        p = os.path.join(DEBUG, fname)
        if os.path.exists(p) and os.path.getsize(p) > 100:
            print(f"  已有 {fname}")
            return
        print(f"  抓取 {fname} ...")
        r = requests.get(BASE + path, headers=HDRS, timeout=60)
        r.raise_for_status()
        with open(p, "wb") as f:
            f.write(r.content)
        time.sleep(random.uniform(1.5, 3))
    print("[*] 基础数据")
    grab("/api/teach/semester/list", "semesters.json")
    sems = json.load(open(os.path.join(DEBUG, "semesters.json"), encoding="utf-8"))
    today = time.strftime("%Y-%m-%d")
    sem = next((s for s in sems if s.get("start", "") <= today <= s.get("end", "")), None) \
        or next((s for s in sems if s.get("isLast")), None) or sems[-1]
    if not os.path.exists(os.path.join(DEBUG, "lessons.json")):
        print(f"  抓取全部开课 {sem['nameZh']} ...")
        r = requests.get(f"{BASE}/api/teach/lesson/list-for-teach/{sem['id']}", headers=HDRS, timeout=120)
        r.raise_for_status()
        with open(os.path.join(DEBUG, "lessons.json"), "wb") as f:
            f.write(r.content)
        time.sleep(random.uniform(1.5, 3))
    else:
        print("  已有 lessons.json")
    grab("/api/teach/program/tree", "program_tree.json")


def worker(q):
    while True:
        try:
            pid = q.get_nowait()
        except queue.Empty:
            return
        out = os.path.join(DEBUG, f"program_{pid}.json")
        if os.path.exists(out) and os.path.getsize(out) > 200:
            with lock:
                stats["skip"] += 1
            q.task_done()
            continue
        try:
            r = requests.get(f"{BASE}/api/teach/program/info/{pid}", headers=HDRS, timeout=60)
            if r.status_code == 200 and len(r.content) > 200:
                with open(out, "wb") as f:
                    f.write(r.content)
                with lock:
                    stats["ok"] += 1
                    done = stats["ok"] + stats["skip"] + stats["fail"]
                    if done % 25 == 0:
                        print(f"    进度 {done}（新{stats['ok']} 跳{stats['skip']} 失败{stats['fail']}）")
            else:
                with lock:
                    stats["fail"] += 1
                    stats["fail_ids"].append((pid, r.status_code))
        except Exception as e:
            with lock:
                stats["fail"] += 1
                stats["fail_ids"].append((pid, str(e)[:60]))
        time.sleep(random.uniform(0.9, 2.2))
        q.task_done()


def main():
    ensure_base()
    tree = json.load(open(os.path.join(DEBUG, "program_tree.json"), encoding="utf-8"))
    ids = []
    for dept in tree.values():
        for major in (dept.get("majors") or {}).values():
            for p in (major.get("programs") or []):
                ids.append(p["id"])
    ids = sorted(set(ids))
    print(f"[*] 共 {len(ids)} 份培养方案，开始抓取（并发2，可随时 Ctrl+C 后重跑续传）")
    q = queue.Queue()
    for i in ids:
        q.put(i)
    threads = [threading.Thread(target=worker, args=(q,), daemon=True) for _ in range(2)]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    dt = time.time() - t0
    print(f"\n[✓] 完成：新抓 {stats['ok']}，已存在 {stats['skip']}，失败 {stats['fail']}，用时 {dt/60:.1f} 分钟")
    if stats["fail_ids"]:
        print("    失败清单（可重跑本脚本重试）:")
        for pid, why in stats["fail_ids"][:20]:
            print(f"      {pid}: {why}")
    # 保存失败清单
    with open(os.path.join(DEBUG, "_failures.json"), "w", encoding="utf-8") as f:
        json.dump(stats["fail_ids"], f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
