# -*- coding: utf-8 -*-
"""补抓多学期开课时间 + 课程替代池（公开接口，写入 tools/debug/）"""
import json, os, random, sys, time, io
import requests

try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
except Exception:
    pass

BASE = "https://catalog.ustc.edu.cn"
HERE = os.path.dirname(os.path.abspath(__file__))
DEBUG = os.path.join(HERE, "debug")
os.makedirs(DEBUG, exist_ok=True)
HDRS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*", "Referer": BASE + "/query/lesson"}

sems = json.load(open(os.path.join(DEBUG, "semesters.json"), encoding="utf-8"))
want = ["2024年春季学期", "2024年秋季学期", "2025年春季学期", "2025年夏季学期",
        "2025年秋季学期", "2026年春季学期", "2026年夏季学期"]
for name in want:
    hit = next((s for s in sems if s.get("nameZh") == name), None)
    if not hit:
        print(f"  [跳过] {name} 不存在")
        continue
    out = os.path.join(DEBUG, f"lessons_{hit['id']}.json")
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        print(f"  已有 {name}")
        continue
    print(f"  抓取 {name} (id={hit['id']}) ...")
    r = requests.get(f"{BASE}/api/teach/lesson/list-for-teach/{hit['id']}", headers=HDRS, timeout=120)
    if r.status_code == 200:
        open(out, "wb").write(r.content)
        print(f"    {len(r.content)//1024} KB")
    else:
        print(f"    [!] {r.status_code}")
    time.sleep(random.uniform(2.5, 5))

out = os.path.join(DEBUG, "substitute_pools.json")
if not (os.path.exists(out) and os.path.getsize(out) > 10):
    print("  抓取课程替代池 ...")
    r = requests.get(f"{BASE}/api/teach/course-substitute-pool/list", headers=HDRS, timeout=60)
    print("   ", r.status_code, len(r.content))
    if r.status_code == 200:
        open(out, "wb").write(r.content)
print("done")
