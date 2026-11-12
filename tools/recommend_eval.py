"""推荐离线评估：单阶段（baseline）vs 两阶段（full）（2026-10-18 第五批）。

为什么这样做（Netflix 那套评估纪律的最小版）：
- **不用全量历史去"预测"历史**。对每个用户，把**最后一个浏览会话**留作测试集，
  用 `as_of=最后一个会话开始前 1 秒` 让接口只用更早的行为推荐，避免信息泄漏；
- 指标：Precision@5、NDCG@10（二值相关）；没有命中就没有分。
- 只评"演示账号里行为够多"的用户（≥2 个会话、≥5 次商品浏览），其他人样本不足不参与平均。

用法：
    .venv\\Scripts\\python.exe tools\\recommend_eval.py
    .venv\\Scripts\\python.exe tools\\recommend_eval.py --top 10 --json _build_tmp/recommend_eval.json
"""
import argparse
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pymysql  # noqa: E402

from config import Config  # noqa: E402

BASE = "http://127.0.0.1:5000"
SESSION_GAP = timedelta(minutes=30)
PRODUCT_PREFIX = "/product/"


def http_json(method, path, token=None, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = "Bearer " + token
    url = BASE + urllib.parse.quote(path, safe="/?&=:%#")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return json.loads(exc.read().decode("utf-8"))


def login(username, password="123456", role=None):
    body = {"username": username, "password": password}
    if role:
        body["role"] = role
    return (http_json("POST", "/api/auth/login", body=body).get("data") or {}).get("token")


def load_histories(conn):
    """{user_id: [(created_at, product_id), ...]}（按时间升序，只取商品页浏览）。"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT user_id, page, created_at FROM user_activities "
            "WHERE kind='page' AND page LIKE '/product/%' "
            "ORDER BY user_id, created_at"
        )
        rows = cur.fetchall()
    out = defaultdict(list)
    for uid, page, at in rows:
        try:
            pid = int(page[len(PRODUCT_PREFIX):])
        except (TypeError, ValueError):
            continue
        out[uid].append((at, pid))
    return out


def split_sessions(items):
    """按 30 分钟间隔切成会话列表。"""
    sessions, current, last = [], [], None
    for at, pid in items:
        if last is not None and (at - last) > SESSION_GAP:
            sessions.append(current)
            current = []
        current.append((at, pid))
        last = at
    if current:
        sessions.append(current)
    return sessions


def on_sale_ids(conn, ids):
    if not ids:
        return set()
    placeholders = ",".join(["%s"] * len(ids))
    with conn.cursor() as cur:
        cur.execute(
            f"SELECT id FROM products WHERE status='on_sale' AND id IN ({placeholders})",
            tuple(ids),
        )
        return {row[0] for row in cur.fetchall()}


def precision_at_k(recs, truth, k=5):
    top = recs[:k]
    hits = sum(1 for pid in top if pid in truth)
    return hits / max(1, min(k, len(truth)))


def ndcg_at_k(recs, truth, k=10):
    dcg = 0.0
    for i, pid in enumerate(recs[:k], start=1):
        if pid in truth:
            dcg += 1.0 / math.log2(i + 1)
    ideal = sum(1.0 / math.log2(i + 1) for i in range(1, min(len(truth), k) + 1))
    return dcg / ideal if ideal else 0.0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--top", type=int, default=10, help="取推荐前 N 件（默认 10）")
    parser.add_argument("--json", default="", help="把明细另存为 JSON")
    args = parser.parse_args()

    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT), user=Config.DB_USER,
        password=Config.DB_PASSWORD, database=Config.DB_NAME, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, username, role FROM users")
            users = {uid: (name, role) for uid, name, role in cur.fetchall()}

        histories = load_histories(conn)
        rows, skipped = [], []
        for uid, items in histories.items():
            name, role = users.get(uid, ("?", ""))
            sessions = split_sessions(items)
            if len(sessions) < 2 or len(items) < 5:
                skipped.append((name, len(items), len(sessions), "会话/浏览数不足"))
                continue
            last = sessions[-1]
            truth = on_sale_ids(conn, {pid for _at, pid in last})
            if not truth:
                skipped.append((name, len(items), len(sessions), "最后一会话的商品已不在售"))
                continue
            as_of = (last[0][0] - timedelta(seconds=1)).strftime("%Y-%m-%d %H:%M:%S")
            token = login(name, role=None if role != "admin" else "admin")
            if not token:
                skipped.append((name, len(items), len(sessions), "登录失败（可能被禁/改密）"))
                continue

            line = {"user": name, "views": len(items), "truth": len(truth), "as_of": as_of}
            for mode in ("baseline", "full"):
                resp = http_json(
                    "GET",
                    f"/api/products/recommend?limit={args.top}&mode={mode}"
                    f"&as_of={urllib.parse.quote(as_of)}",
                    token=token,
                )
                data = resp.get("data") or {}
                recs = [x["id"] for x in (data.get("list") or [])]
                line[mode] = {
                    "recs": recs,
                    "p5": round(precision_at_k(recs, truth, 5), 3),
                    "ndcg10": round(ndcg_at_k(recs, truth, 10), 3),
                    "hits": len(set(recs) & truth),
                }
            rows.append(line)

        print(f"可评估用户 {len(rows)} 个（跳过 {len(skipped)} 个）")
        print(f"{'用户':<10}{'浏览':>4}{'测试集':>6}{'base P@5':>10}{'full P@5':>10}"
              f"{'base NDCG':>10}{'full NDCG':>11}")
        for line in rows:
            print(f"{line['user']:<10}{line['views']:>4}{line['truth']:>6}"
                  f"{line['baseline']['p5']:>10}{line['full']['p5']:>10}"
                  f"{line['baseline']['ndcg10']:>10}{line['full']['ndcg10']:>11}")
        if rows:
            mean = {m: {key: round(sum(x[m][key] for x in rows) / len(rows), 3)
                        for key in ("p5", "ndcg10")}
                    for m in ("baseline", "full")}
            mean["base_hits"] = round(sum(x["baseline"]["hits"] for x in rows) / len(rows), 2)
            mean["full_hits"] = round(sum(x["full"]["hits"] for x in rows) / len(rows), 2)
            print(f"\n平均：baseline P@5={mean['baseline']['p5']} NDCG@10={mean['baseline']['ndcg10']}"
                  f" 命中 {mean['base_hits']} 件 | full P@5={mean['full']['p5']}"
                  f" NDCG@10={mean['full']['ndcg10']} 命中 {mean['full_hits']} 件")
            better = mean["full"]["ndcg10"] > mean["baseline"]["ndcg10"]
            verdict = "两阶段更好" if better else (
                "持平" if mean["full"]["ndcg10"] == mean["baseline"]["ndcg10"] else "两阶段更差")
            print(f"结论：{verdict}（NDCG@10 差值 "
                  f"{round(mean['full']['ndcg10'] - mean['baseline']['ndcg10'], 3)}）；"
                  f"可评估用户只有 {len(rows)} 个，样本小，结论仅供参考")
        else:
            print("没有可评估用户：行为数据不足以做留一验证")

        if skipped:
            print("\n跳过：")
            for name, n, s, why in skipped:
                print(f"  {name:<10} 浏览 {n:<3} 会话 {s} —— {why}")

        if args.json:
            payload = {"generated_at": str(__import__("datetime").datetime.now())[:19],
                       "rows": rows, "skipped": skipped}
            Path(args.json).parent.mkdir(parents=True, exist_ok=True)
            Path(args.json).write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                                       encoding="utf-8")
            print(f"\n明细已写入 {args.json}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
