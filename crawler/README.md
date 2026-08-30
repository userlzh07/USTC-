# USTC 教务数据抓取指南（2026-08 实测）

## ⚡ 先说结论：规划器 v2 已经把所有公开数据内置了，你不需要跑爬虫

`js/data-ustc.js` 已内置（catalog.ustc.edu.cn 公开目录，2026-08 抓取）：

| 内置内容 | 规模 |
|---|---|
| 全部开课（近 8 学期合并，含上课时间/教师/容量/开课季） | 3574 门课程 |
| 全部培养方案目录（院系→专业→年级→类型） | 1201 份 |
| 完整培养方案模块树（学分/课程/开课季/高替规则） | 1188 份 |
| 官方课程替代规则（如 量子力学A 可替 量子物理） | 1165 条 |

打开 `index.html` 即用：课程速查直接搜、培养方案页直接挑、拖课自动带时间冲突检测。
**爬虫只在想刷新数据时才需要跑**（比如下学期开课目录更新后）。

---

## 以下是数据来源与刷新方法（备查）

## 结论：全部开课和全部培养方案都在「公开课程目录」，不碰教务账号

科大把**全校公开数据**放在了一个独立的目录站：**catalog.ustc.edu.cn**
（教务系统登录页上那个绿色按钮「课程目录查询」就是它）。

| 你要找的 | 页面位置 | 接口（免登录，已实测 200） |
|---|---|---|
| **全部开课** | catalog.ustc.edu.cn/query → 「开课查询」 | `GET /api/teach/lesson/list-for-teach/{学期id}`<br>**一次请求返回整学期全部开课**（2026秋实测 2840 条 / 3.5MB），含：上课时间（如 `2304: 2(3,4)` = 周三3-4节）、周次、教师、院系、学分、容量 |
| **全部培养方案** | catalog.ustc.edu.cn/plan（或 /program） | `GET /api/teach/program/tree` —— 院系→专业→年级 共 **1201 份**方案目录<br>`GET /api/teach/program/info/{方案id}` —— 单份方案详情（模块树 + 课程 + 学分 + 开课季节） |
| 学期列表 | — | `GET /api/teach/semester/list`（2002 至今 79 个学期） |
| 院系/专业 | — | `GET /api/teach/department/college-tree`、`GET /api/teach/major/list/{院系id}` |
| 按关键字搜课 | — | `GET /api/teach/course/search?keyword=量子` |

## 需要登录的个人数据（jw.ustc.edu.cn，EAMS 框架）

| 数据 | 页面 | 接口（推断，脚本会自动尝试并留档 debug/） |
|---|---|---|
| 我的课表/已选课 | 教务系统 → 我的课表 | `/for-std/course-table` 页面内含 stdId → `/ws/course-table/std/{stdId}?semester={学期id}` |
| 成绩 | 教务系统 → 成绩查询 | `/for-std/grade-sheet` 页面内含 stdId → `/ws/grade-sheet/std/{stdId}` |

个人接口若对不上：F12 → 网络 → 点一下对应页面 → 找 XHR 请求的真实路径，改 `ustc_crawler.py` 里的候选列表。
**更稳的兜底**：成绩页面直接全选复制 → 规划器 v2「数据导入 → 粘贴解析」，秒级完成且零风险。

## 使用

```bash
pip install requests

# 只抓公开目录（推荐：不登录、不涉及你的账号）
python ustc_crawler.py --semester "2026年秋季学期" --program 大气科学
python ustc_crawler.py --list-programs          # 看全部 1201 份方案
python ustc_crawler.py --program-id 3370,3555   # 2026主修 + 2025辅修 大气科学

# 附加个人成绩/已选课（可选，慢速防封，需要 cookie.txt）
# 浏览器登录 jw.ustc.edu.cn → F12 → 网络 → 任意请求 → 请求标头 → 复制整串 Cookie
#   保存为 crawler/cookie.txt
python ustc_crawler.py --with-personal
```

生成的 `ustc_dataset.json` → 打开 规划器v2 → 数据导入 → 教务系统爬虫数据。

## 防封设计（个人数据部分）

- 只用你自己的会话，**请求间隔 6~12 秒随机**，全程串行，先逛首页再进功能页
- 浏览器同款 headers + Referer 链；个人数据请求预算默认 ≤ 12 个
- 401/302（Cookie 失效）、429/503（限流）立即收手或长退避；连续 3 次失败终止
- 每个原始响应存档到 `debug/`，方便人工核对，绝不重试轰炸
