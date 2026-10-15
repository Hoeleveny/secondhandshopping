"""接口冒烟测试：对着本机跑着的服务逐条验证。

前置：服务已启动（start.bat 或 manage.py run），数据库已 init-db + reset-demo。

用法：
    .venv\\Scripts\\python.exe tools\\smoke_test.py
"""
import json
import sys
import urllib.error
import urllib.request
from urllib.parse import quote

BASE = "http://127.0.0.1:5000"

PASSED: list[str] = []
FAILED: list[str] = []


def call(method: str, path: str, token: str | None = None, view: str | None = None,
         body: dict | None = None, raw: bytes | None = None,
         content_type: str | None = None):
    # urllib 不会自动编码非 ASCII 字符（中文关键词会直接报错），这里先做百分号编码
    url = BASE + quote(path, safe="/?&=:%#")
    data = raw
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if content_type:
        headers["Content-Type"] = content_type
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if view:
        headers["X-View-Role"] = view
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, {"code": exc.code, "msg": payload[:200], "data": None}
    except Exception as exc:  # noqa: BLE001
        return 0, {"code": -1, "msg": repr(exc), "data": None}


def check(label: str, condition: bool, detail: str = "") -> bool:
    if condition:
        PASSED.append(label)
        print(f"[PASS] {label}")
        return True
    FAILED.append(label)
    print(f"[FAIL] {label}   {detail}")
    return False


def section(title: str) -> None:
    print(f"\n===== {title} =====")


def db_table_names() -> set[str]:
    """库里真实的表名集合（用于动态校验备份覆盖率）。"""
    import sys
    from pathlib import Path

    import pymysql

    root = str(Path(__file__).resolve().parent.parent)
    if root not in sys.path:
        sys.path.insert(0, root)

    from config import Config

    conn = pymysql.connect(
        host=Config.DB_HOST, port=int(Config.DB_PORT), user=Config.DB_USER,
        password=Config.DB_PASSWORD, database=Config.DB_NAME, charset="utf8mb4",
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = %s",
                (Config.DB_NAME,),
            )
            return {row[0] for row in cur.fetchall()}
    finally:
        conn.close()


def db_table_count() -> int:
    return len(db_table_names())


def cleanup_test_data() -> None:
    """清掉本脚本留下的测试数据（商品 / 帖子 / 消息等）。

    商品接口只做软删除，测试数据会一直堆在库里，所以这里统一物理清理，
    避免污染演示数据；清理失败不影响测试结论。
    """
    try:
        import sys
        from pathlib import Path

        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from tools.cleanup_test_data import cleanup

        result = cleanup(verbose=False)
        total = sum(result.values())
        if total:
            print(f"\n（已清理 {total} 行测试残留数据）")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    # ---------------- 公开只读接口 ----------------
    section("公开接口（游客可访问）")
    status, res = call("GET", "/api/health")
    check("GET /api/health", status == 200 and res.get("code") == 0, str(res))

    status, res = call("GET", "/api/meta")
    meta = res.get("data") or {}
    check("GET /api/meta 返回成色/标签/举报理由",
          status == 200 and len(meta.get("conditions", [])) == 4
          and len(meta.get("post_tags", [])) == 4
          and len(meta.get("report_reasons", [])) == 5, str(res)[:200])

    status, res = call("GET", "/api/categories?with_subs=1")
    cats = res.get("data") or []
    # 不写死「等于 5 个」：管理员完全可以再建分类。改为断言初始 5 个都在、且各自带小类。
    SEED_CATS = {"教材", "数码", "生活用品", "运动", "其他"}
    cat_names = {c.get("name") for c in cats}
    check("GET /api/categories 返回初始 5 个分类且都带小类",
          status == 200 and SEED_CATS <= cat_names
          and all(c.get("subcategories") for c in cats if c.get("name") in SEED_CATS),
          f"共 {len(cats)} 个：{sorted(cat_names)}")

    status, res = call("GET", "/api/places")
    check("GET /api/places 返回 12 个校园地点",
          status == 200 and len(res.get("data") or []) == 12, str(res)[:150])

    status, res = call("GET", "/api/home")
    home = res.get("data") or {}
    check("GET /api/home 首页聚合",
          status == 200
          and SEED_CATS <= {c.get("name") for c in home.get("categories", [])}
          and len(home.get("newest", [])) <= 8, str(res)[:150])

    # ---------------- 交叉筛选 ----------------
    section("M03 数据交叉筛选")
    status, res = call("GET", "/api/products")
    data = res.get("data") or {}
    # 不写死件数：用户随时会自己发布商品。改为「列表里只有在售」+「总数与首页口径一致」
    _listed = data.get("list") or []
    _statuses = {p.get("status") for p in _listed}
    _home = call("GET", "/api/home")[1].get("data") or {}
    _on_sale = (_home.get("stats") or {}).get("on_sale")
    check("默认只返回在售商品，且总数与首页「在售」口径一致",
          status == 200 and _statuses == {"on_sale"} and data.get("total") == _on_sale,
          f"total={data.get('total')}，首页在售={_on_sale}，列表状态={_statuses}")

    status, res = call("GET", "/api/products?category_id=4&min_price=50&max_price=500&sort=price_asc")
    data = res.get("data") or {}
    items = data.get("list") or []
    check("叠加筛选：运动 + 50~500 + 价格升序",
          data.get("total") == 2 and len(items) == 2 and items[0]["price"] < items[1]["price"],
          str(data.get("list"))[:200])

    status, res = call("GET", "/api/products?keyword=教材")
    data = res.get("data") or {}
    check("关键词模糊搜索", status == 200 and data.get("total", 0) >= 1,
          f"total={data.get('total')}")

    status, res = call("GET", "/api/products?condition=全新")
    data = res.get("data") or {}
    check("按成色筛选", status == 200 and data.get("total", 0) >= 1, f"total={data.get('total')}")

    status, res = call("GET", "/api/products?page_size=5&page=2")
    data = res.get("data") or {}
    check("分页生效（第 2 页 5 条）",
          data.get("page") == 2 and len(data.get("list") or []) == 5, str(res)[:150])

    status, res = call("GET", "/api/products?sort=price_desc")
    items = (res.get("data") or {}).get("list") or []
    check("价格降序排序",
          len(items) >= 2 and items[0]["price"] >= items[-1]["price"], str(items[:1])[:150])

    # ---------------- 注册登录 ----------------
    section("M01 用户认证")
    status, res = call("POST", "/api/auth/register",
                       body={"username": "smoke_buyer", "password": "1234", "role": "buyer"})
    if res.get("code") != 0 and "已被注册" in (res.get("msg") or ""):
        status, res = call("POST", "/api/auth/login",
                           body={"username": "smoke_buyer", "password": "1234", "role": "buyer"})
    token = (res.get("data") or {}).get("token")
    check("注册 / 登录拿到 JWT", status == 200 and res.get("code") == 0 and bool(token),
          str(res)[:200])

    status, res = call("POST", "/api/auth/register",
                       body={"username": "admin2", "password": "1234", "role": "admin"})
    check("管理员不可注册", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/auth/login",
                       body={"username": "admin", "password": "123456", "role": "buyer"})
    check("管理员不能用买家身份登录", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/auth/login",
                       body={"username": "buyer1", "password": "123456", "role": "admin"})
    check("普通用户不能用管理员身份登录", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/auth/login",
                       body={"username": "admin", "password": "123456", "role": "admin"})
    admin_token = (res.get("data") or {}).get("token")
    check("管理员身份登录成功", res.get("code") == 0 and bool(admin_token), str(res)[:150])

    status, res = call("GET", "/api/auth/me", token=token)
    check("GET /api/auth/me 需登录且返回用户",
          status == 200 and (res.get("data") or {}).get("user", {}).get("username") == "smoke_buyer",
          str(res)[:200])

    status, res = call("GET", "/api/auth/me", token=token, view="seller")
    check("身份视角切换（X-View-Role: seller）",
          (res.get("data") or {}).get("view") == "seller", str(res)[:200])

    status, res = call("GET", "/api/auth/me")
    check("未登录访问 /api/auth/me 返回 401", status == 401, str(res)[:150])

    # ---------------- 商品详情与发布 ----------------
    section("M04 / M09 商品详情与发布")
    status, res = call("GET", "/api/products/1")
    d1 = res.get("data") or {}
    check("商品详情返回完整字段", status == 200 and d1.get("name") and "reviews" in d1,
          str(res)[:150])

    status, res2 = call("GET", "/api/products/1")
    check("每打开一次浏览量 +1",
          (res2.get("data") or {}).get("views") == (d1.get("views") or 0) + 1,
          f"{d1.get('views')} -> {(res2.get('data') or {}).get('views')}")

    seller_token = None
    status, res = call("POST", "/api/auth/login",
                       body={"username": "seller1", "password": "123456", "role": "seller"})
    seller_token = (res.get("data") or {}).get("token")
    check("卖家登录", bool(seller_token), str(res)[:150])

    status, res = call("POST", "/api/products", token=seller_token,
                       body={"name": "", "price": 10, "category_id": 1, "condition": "全新"})
    check("名称为空时拒绝发布", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/products", token=seller_token,
                       body={"name": "冒烟测试商品", "price": 0, "category_id": 1,
                             "condition": "全新"})
    check("价格 ≤ 0 时拒绝发布", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/products", token=seller_token,
                       body={"name": "冒烟测试商品", "price": 9.9, "category_id": 1,
                             "subcategory_id": 1, "condition": "全新",
                             "description": "自动化测试创建", "default_place_id": 1,
                             "images": []})
    new_id = (res.get("data") or {}).get("id")
    check("合法发布成功并出现在我的商品", res.get("code") == 0 and bool(new_id), str(res)[:200])

    status, res = call("GET", "/api/products/mine?status=on_sale", token=seller_token)
    names = [p["name"] for p in (res.get("data") or {}).get("list", [])]
    check("我的商品能看到刚发布的商品", "冒烟测试商品" in names, str(names)[:200])

    status, res = call("PATCH", f"/api/products/{new_id}/status", token=seller_token,
                       body={"status": "off_shelf"})
    check("下架成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{new_id}")
    check("下架后买家侧搜不到该商品",
          res.get("code") == 0 and (res.get("data") or {}).get("status") == "off_shelf",
          str(res)[:150])

    status, res = call("GET", "/api/products?keyword=冒烟测试商品")
    check("下架商品不出现在筛选结果", (res.get("data") or {}).get("total") == 0,
          str(res)[:150])

    status, res = call("PATCH", f"/api/products/{new_id}/status", token=seller_token,
                       body={"status": "on_sale"})
    check("重新上架成功", res.get("code") == 0, str(res)[:150])

    status, res = call("DELETE", f"/api/products/{new_id}", token=seller_token)
    check("删除（软删除）成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/products?keyword=冒烟测试商品")
    check("删除后彻底不在筛选结果", (res.get("data") or {}).get("total") == 0, str(res)[:150])

    # ---------------- M05 比价 ----------------
    section("M05 比价")
    status, res = call("GET", "/api/compare?category_id=2")
    cmp_data = res.get("data") or {}
    cmp_list = cmp_data.get("list") or []
    check("比价返回最低/最高/平均/件数，且最低价等于列表首项",
          status == 200 and cmp_data.get("count") == len(cmp_list) and cmp_list
          and cmp_data.get("min_price") == min(x["price"] for x in cmp_list)
          and cmp_data.get("max_price") == max(x["price"] for x in cmp_list),
          str(res)[:200])
    check("比价列表按价格升序",
          all(cmp_list[i]["price"] <= cmp_list[i + 1]["price"]
              for i in range(len(cmp_list) - 1)), str(cmp_list)[:150])

    status, res = call("GET", "/api/compare")
    check("比价未选分类时报错", res.get("code") != 0, str(res)[:120])

    # ---------------- M07 我的收藏 ----------------
    section("M07 我的收藏")
    status, res = call("POST", "/api/auth/login",
                       body={"username": "buyer1", "password": "123456", "role": "buyer"})
    buyer1 = (res.get("data") or {}).get("token")
    check("买家 buyer1 登录", bool(buyer1), str(res)[:150])

    status, res = call("GET", "/api/products?page_size=50")
    # 不能直接取「最新第一件」——用户自己发布的商品会排在最前，而它可能正是 buyer1 自己的，
    # 那样后面「我想要」的「不能对自己商品操作」断言就会走错分支。
    _me = (call("GET", "/api/auth/me", token=buyer1)[1].get("data") or {}).get("user") or {}
    _my_id = _me.get("id")
    fav_pid = next((p["id"] for p in ((res.get("data") or {}).get("list") or [])
                    if p.get("seller_id") != _my_id), None)
    check("能选到一件「非 buyer1 自己发布」的在售商品用于后续断言",
          bool(fav_pid), f"buyer1 id={_my_id}, fav_pid={fav_pid}")
    call("DELETE", f"/api/favorites/{fav_pid}", token=buyer1)  # 先清掉，保证可重复运行

    status, res = call("POST", "/api/favorites", token=buyer1, body={"product_id": fav_pid})
    check("收藏成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/favorites?page_size=50", token=buyer1)
    fav_ids = [p["id"] for p in (res.get("data") or {}).get("list", [])]
    check("收藏列表包含该商品", fav_pid in fav_ids, str(fav_ids)[:150])

    status, res = call("GET", f"/api/products/{fav_pid}", token=buyer1)
    check("商品详情 favorited 标记为真", (res.get("data") or {}).get("favorited") is True,
          str(res)[:150])

    status, res = call("DELETE", f"/api/favorites/{fav_pid}", token=buyer1)
    check("取消收藏成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/favorites?page_size=50", token=buyer1)
    fav_ids = [p["id"] for p in (res.get("data") or {}).get("list", [])]
    check("取消后收藏列表不再包含", fav_pid not in fav_ids, str(fav_ids)[:150])

    status, res = call("POST", "/api/favorites", body={"product_id": fav_pid})
    check("未登录不能收藏", status == 401, str(res)[:150])

    # ---------------- M06 下单与订单 ----------------
    section("M06 下单与订单（含事务与隐私）")

    def _new_product(name: str, price: float, token_: str | None = None) -> int | None:
        st, r = call("POST", "/api/products", token=token_ or seller_token,
                     body={"name": name, "price": price, "category_id": 1, "subcategory_id": 1,
                           "condition": "九成新", "description": "自动化冒烟测试用商品",
                           "default_place_id": 2, "images": []})
        return (r.get("data") or {}).get("id")

    p1 = _new_product("冒烟-订单完成流程", 88.0)
    check("创建订单测试商品", bool(p1), "创建失败")

    status, res = call("POST", "/api/orders", token=token,
                       body={"product_id": p1, "trade_note": "下午四点图书馆见",
                             "meet_place_id": 2})
    order_id = (res.get("data") or {}).get("id")
    check("下单成功并生成待完成订单",
          res.get("code") == 0 and bool(order_id)
          and (res.get("data") or {}).get("status") == "pending", str(res)[:200])

    status, res = call("GET", f"/api/products/{p1}")
    check("下单后商品立即变「已售」",
          (res.get("data") or {}).get("status") == "sold", str(res)[:150])

    status, res = call("POST", "/api/orders", token=buyer1,
                       body={"product_id": p1, "meet_place_id": 2})
    check("已售商品他人无法再下单（一物一件）", res.get("code") != 0, str(res)[:150])

    status, res = call("GET", "/api/orders/mine?status=pending", token=token)
    mine_ids = [o["id"] for o in (res.get("data") or {}).get("list", [])]
    check("订单出现在「我的订单」", order_id in mine_ids, str(mine_ids)[:150])

    status, res = call("GET", "/api/orders/sold", token=seller_token)
    sold_ids = [o["id"] for o in (res.get("data") or {}).get("list", [])]
    check("订单出现在卖家「卖出订单」", order_id in sold_ids, str(sold_ids)[:150])

    status, res = call("PUT", f"/api/orders/{order_id}/location", token=token,
                       body={"place_id": 1})
    check("买家更新位置（选校园地标）", res.get("code") == 0, str(res)[:150])

    status, res = call("PUT", f"/api/orders/{order_id}/location", token=seller_token,
                       body={"place_id": 5})
    check("卖家更新位置", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/orders/{order_id}/map", token=token)
    mp = res.get("data") or {}
    check("小地图：双方位置 + 直线距离 + 建议会面点",
          mp.get("can_see_location") and mp.get("buyer_location") and mp.get("seller_location")
          and (mp.get("distance_m") or 0) > 0 and bool(mp.get("suggest_place")),
          str(res)[:250])

    status, res = call("GET", f"/api/orders/{order_id}/map", token=buyer1)
    check("非订单双方看不到该订单", res.get("code") != 0, str(res)[:150])

    status, res = call("PATCH", f"/api/orders/{order_id}/complete", token=seller_token)
    check("卖家不能替买家确认完成", res.get("code") != 0, str(res)[:150])

    status, res = call("PATCH", f"/api/orders/{order_id}/complete", token=token)
    check("买家确认完成，订单变「已完成」",
          res.get("code") == 0 and (res.get("data") or {}).get("status") == "done",
          str(res)[:150])

    status, res = call("GET", f"/api/orders/{order_id}/map", token=token)
    check("交易完成后不再返回精确位置（隐私红线）",
          not (res.get("data") or {}).get("can_see_location"), str(res)[:200])

    p2 = _new_product("冒烟-取消订单流程", 66.0)
    status, res = call("POST", "/api/orders", token=token,
                       body={"product_id": p2, "meet_place_id": 1})
    order2 = (res.get("data") or {}).get("id")
    check("第二次下单成功", res.get("code") == 0 and bool(order2), str(res)[:150])

    status, res = call("PATCH", f"/api/orders/{order2}/cancel", token=seller_token)
    check("卖家不能取消买家订单", res.get("code") != 0, str(res)[:150])

    status, res = call("PATCH", f"/api/orders/{order2}/cancel", token=token)
    check("买家取消订单成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{p2}")
    check("取消后商品自动恢复「在售」",
          (res.get("data") or {}).get("status") == "on_sale", str(res)[:150])

    # ---------------- M08 评价（双向互评） ----------------
    section("M08 评价与评分")

    status, res = call("GET", "/api/reviews/pending", token=token)
    pending_ids = [o["id"] for o in (res.get("data") or [])]
    check("待评价列表包含刚完成的订单", order_id in pending_ids, str(pending_ids)[:150])

    status, res = call("POST", "/api/reviews", token=token,
                       body={"order_id": order_id, "rating": 5, "content": "冒烟测试：卖家很好"})
    check("买家评价成功", res.get("code") == 0, str(res)[:150])

    status, res = call("POST", "/api/reviews", token=token,
                       body={"order_id": order_id, "rating": 3, "content": "重复评价"})
    check("同一方不能重复评价同一订单", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/reviews", token=seller_token,
                       body={"order_id": order_id, "rating": 4, "content": "冒烟测试：买家守时"})
    check("卖家可以互评（双向互评）", res.get("code") == 0, str(res)[:150])

    status, res = call("POST", "/api/reviews", token=seller_token,
                       body={"order_id": order2, "rating": 5, "content": "未完成的订单"})
    check("未完成的订单不能评价", res.get("code") != 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{p1}/reviews")
    check("商品详情页能看到买卖双方两条评价",
          len(res.get("data") or []) == 2, str(res)[:200])

    status, res = call("GET", "/api/reviews/received", token=seller_token)
    check("卖家能查到收到的评价", (res.get("data") or {}).get("total", 0) >= 1, str(res)[:150])

    # ---------------- 清理测试数据 ----------------
    call("DELETE", f"/api/products/{p1}", token=seller_token)
    call("DELETE", f"/api/products/{p2}", token=seller_token)

    # ---------------- 举报 ----------------
    section("举报提交与审核（含帖子处置）")
    rp_product = _new_product("冒烟-被举报商品", 30.0)
    status, res = call("POST", "/api/reports", token=token,
                       body={"target_type": "product", "target_id": rp_product,
                             "reason": "虚假信息", "detail": "描述与实际不符"})
    check("提交商品举报", res.get("code") == 0, str(res)[:150])

    status, res = call("POST", "/api/reports", token=token,
                       body={"target_type": "product", "target_id": rp_product,
                             "reason": "虚假信息"})
    check("同一对象不能重复举报", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/reports", token=token,
                       body={"target_type": "product", "target_id": rp_product,
                             "reason": "无理由"})
    check("非法举报理由被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("GET", "/api/reports/mine", token=token)
    check("我提交的举报可查", (res.get("data") or {}).get("total", 0) >= 1, str(res)[:150])

    status, res = call("POST", "/api/reports", token=seller_token,
                       body={"target_type": "product", "target_id": rp_product, "reason": "其他"})
    check("不能举报自己发布的商品", res.get("code") != 0, str(res)[:150])

    status, res = call("GET", "/api/admin/reports?status=pending", token=admin_token)
    pending_reports = (res.get("data") or {}).get("list", [])
    target_report = next((r for r in pending_reports
                          if (r.get("target") or {}).get("id") == rp_product), None)
    check("管理员能看到待处理举报", target_report is not None, str(pending_reports)[:200])

    status, res = call("PATCH", f"/api/admin/reports/{target_report['id']}",
                       token=admin_token, body={"action": "handle"})
    check("核实处理 → 商品被下架", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{rp_product}")
    check("被举报商品状态变为「已下架」",
          (res.get("data") or {}).get("status") == "off_shelf", str(res)[:150])

    status, res = call("PATCH", f"/api/admin/reports/{target_report['id']}",
                       token=admin_token, body={"action": "dismiss"})
    check("已处理的举报不能重复处理", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/posts", token=seller_token,
                       body={"title": "冒烟-待举报帖子", "content": "这条帖子用于测试举报审核流程",
                             "tag": "闲聊"})
    rp_post = (res.get("data") or {}).get("id")
    status, res = call("POST", "/api/reports", token=token,
                       body={"target_type": "post", "target_id": rp_post, "reason": "其他"})
    check("提交帖子举报", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/admin/reports?status=pending", token=admin_token)
    post_report = next((r for r in (res.get("data") or {}).get("list", [])
                        if (r.get("target") or {}).get("type") == "post"), None)
    if post_report:
        call("PATCH", f"/api/admin/reports/{post_report['id']}", token=admin_token,
             body={"action": "handle"})
    status, res = call("GET", f"/api/posts/{rp_post}")
    check("举报帖子的处理动作是「删除帖子」", res.get("code") != 0, str(res)[:150])

    call("DELETE", f"/api/admin/products/{rp_product}", token=admin_token)

    # ---------------- 以物换物 ----------------
    section("M12 以物换物")
    status, res = call("POST", "/api/auth/login",
                       body={"username": "seller2", "password": "123456", "role": "seller"})
    seller2 = (res.get("data") or {}).get("token")
    check("seller2 登录", bool(seller2), str(res)[:150])

    sw_a = _new_product("冒烟-换物A(吉他)", 100.0)
    sw_b = _new_product("冒烟-换物B(篮球)", 95.0, seller2)

    status, res = call("POST", "/api/swaps", token=seller_token,
                       body={"product_id": sw_a, "title": "冒烟-换物A", "estimate_price": 100})
    offer_a = (res.get("data") or {}).get("offer", {}).get("id")
    check("发布换物 A", res.get("code") == 0 and bool(offer_a), str(res)[:150])

    status, res = call("POST", "/api/swaps", token=seller2,
                       body={"product_id": sw_b, "title": "冒烟-换物B", "estimate_price": 95})
    offer_b = (res.get("data") or {}).get("offer", {}).get("id")
    check("发布换物 B", res.get("code") == 0 and bool(offer_b), str(res)[:150])

    status, res = call("GET", f"/api/swaps/{offer_a}/matches", token=seller_token)
    match_ids = [m["id"] for m in (res.get("data") or {}).get("matches", [])]
    check("±20% 匹配能命中相近估价的换物", offer_b in match_ids, str(match_ids)[:150])

    status, res = call("POST", f"/api/swaps/{offer_a}/exchange", token=seller_token,
                       body={"target_offer_id": offer_b})
    check("发起交换即达成", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{sw_a}")
    st_a = (res.get("data") or {}).get("status")
    status, res = call("GET", f"/api/products/{sw_b}")
    st_b = (res.get("data") or {}).get("status")
    check("交换达成后双方商品都变「已售」", st_a == "sold" and st_b == "sold",
          f"{st_a} / {st_b}")

    status, res = call("POST", f"/api/swaps/{offer_a}/exchange", token=seller_token,
                       body={"target_offer_id": offer_b})
    check("已匹配的换物不能再次发起", res.get("code") != 0, str(res)[:150])

    call("DELETE", f"/api/products/{sw_a}", token=seller_token)
    call("DELETE", f"/api/products/{sw_b}", token=seller2)

    # ---------------- 交流广场 ----------------
    section("M13 交流广场")
    status, res = call("GET", "/api/posts")
    posts_data = res.get("data") or {}
    check("帖子列表游客可看且带标签统计",
          status == 200 and posts_data.get("total", 0) >= 4
          and set(posts_data.get("tag_counts", {})) == {"安利", "避雷", "闲聊", "求助"},
          str(res)[:200])

    status, res = call("GET", "/api/posts?tag=避雷")
    listed = (res.get("data") or {}).get("list", [])
    check("按标签页签筛选", listed and all(p["tag"] == "避雷" for p in listed), str(listed)[:150])

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "冒烟测试帖", "content": "用于验证发帖流程", "tag": "求助"})
    post_id = (res.get("data") or {}).get("id")
    check("发帖成功", res.get("code") == 0 and bool(post_id), str(res)[:150])

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "标签非法", "content": "x", "tag": "灌水"})
    check("非法标签被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", f"/api/posts/{post_id}/like", token=token)
    check("点赞成功", res.get("code") == 0 and (res.get("data") or {}).get("liked") is True,
          str(res)[:150])

    status, res = call("POST", f"/api/posts/{post_id}/like", token=token)
    check("再点一次取消点赞",
          (res.get("data") or {}).get("liked") is False
          and (res.get("data") or {}).get("like_count") == 0, str(res)[:150])

    status, res = call("POST", f"/api/posts/{post_id}/comments", token=seller_token,
                       body={"content": "冒烟测试评论"})
    check("评论成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/posts/{post_id}")
    check("帖子详情带评论列表",
          len((res.get("data") or {}).get("comments", [])) == 1, str(res)[:200])

    status, res = call("DELETE", f"/api/posts/{post_id}", token=seller_token)
    check("非作者不能删帖", res.get("code") != 0, str(res)[:150])

    status, res = call("DELETE", f"/api/posts/{post_id}", token=token)
    check("作者可以删除自己的帖子", res.get("code") == 0, str(res)[:150])

    # ---------------- 管理后台与看板 ----------------
    section("M10 / M11 管理后台与数据看板")
    status, res = call("GET", "/api/admin/products", token=admin_token)
    check("管理后台能看到全部商品（含已售 / 已下架）",
          (res.get("data") or {}).get("total", 0) >= 16, str(res)[:150])

    status, res = call("GET", "/api/admin/products?status=off_shelf", token=admin_token)
    check("可按状态筛选出已下架商品",
          all(p["status"] == "off_shelf" for p in (res.get("data") or {}).get("list", [])),
          str(res)[:150])

    status, res = call("GET", "/api/admin/products?status=sold", token=admin_token)
    sold_list = (res.get("data") or {}).get("list", [])
    if sold_list:
        _st, _r = call("PATCH", f"/api/admin/products/{sold_list[0]['id']}/status",
                       token=admin_token, body={"status": "off_shelf"})
        check("已售商品不允许被改成已下架（保护历史订单一致性）",
              _r.get("code") != 0, str(_r)[:150])

    status, res = call("GET", "/api/admin/stats", token=admin_token)
    stats = res.get("data") or {}
    cards = stats.get("cards") or {}
    pie_total = sum(x["count"] for x in stats.get("category_pie", []))
    bar_total = sum(stats.get("price_bars", {}).get("values", []))
    check("看板四个数字自洽（总数 = 在售+已售+已下架）",
          cards.get("total") == (cards.get("on_sale", 0) + cards.get("sold", 0)
                                 + cards.get("off_shelf", 0)), str(cards))
    check("分类占比合计与商品总数一致", pie_total == cards.get("total"),
          f"pie={pie_total} total={cards.get('total')}")
    check("价格区间合计与商品总数一致", bar_total == cards.get("total"),
          f"bars={bar_total} total={cards.get('total')}")

    status, res = call("GET", "/api/admin/stats", token=token)
    check("普通用户访问管理接口被拒", res.get("code") == 403, str(res)[:150])

    status, res = call("POST", "/api/admin/categories", token=admin_token,
                       body={"name": "冒烟分类", "icon": "🧪", "sort": 99})
    cid = (res.get("data") or {}).get("id")
    check("新增分类", res.get("code") == 0 and bool(cid), str(res)[:150])

    status, res = call("POST", "/api/admin/subcategories", token=admin_token,
                       body={"category_id": cid, "name": "冒烟小类"})
    sid = (res.get("data") or {}).get("id")
    check("新增小类", res.get("code") == 0 and bool(sid), str(res)[:150])

    status, res = call("PUT", f"/api/admin/categories/{cid}", token=admin_token,
                       body={"name": "冒烟分类改名", "icon": "🧪"})
    check("修改分类", res.get("code") == 0, str(res)[:150])

    status, res = call("POST", "/api/admin/places", token=admin_token,
                       body={"name": "冒烟地点", "type": "其他", "lng": 114.414, "lat": 30.511})
    place_id = (res.get("data") or {}).get("id")
    check("新增校园地点", res.get("code") == 0 and bool(place_id), str(res)[:150])

    status, res = call("DELETE", f"/api/admin/categories/1", token=admin_token)
    check("分类下还有商品时不允许删除", res.get("code") != 0, str(res)[:150])

    status, res = call("DELETE", f"/api/admin/subcategories/{sid}", token=admin_token)
    check("删除小类", res.get("code") == 0, str(res)[:150])
    status, res = call("DELETE", f"/api/admin/categories/{cid}", token=admin_token)
    check("删除分类", res.get("code") == 0, str(res)[:150])
    status, res = call("DELETE", f"/api/admin/places/{place_id}", token=admin_token)
    check("删除校园地点", res.get("code") == 0, str(res)[:150])

    # ---------------- 备份 / 恢复 ----------------
    section("备份 / 恢复 / 重置示例数据")
    status, res = call("POST", "/api/admin/backup", token=admin_token)
    payload = (res.get("data") or {}).get("payload")
    # 动态对比库里真实表数，避免每次加表都要改这条断言
    expected_tables = db_table_count()
    backup_tables = set((payload or {}).get("data", {}).keys())
    real_tables = db_table_names()
    check(f"备份导出 JSON 且覆盖库里全部 {expected_tables} 张表",
          res.get("code") == 0 and payload is not None and backup_tables == real_tables,
          f"备份 {len(backup_tables)} 张，实际 {len(real_tables)} 张，差集 {sorted(real_tables ^ backup_tables)}")

    status, res = call("GET", "/api/admin/backups", token=admin_token)
    check("备份文件落地到 backups/ 目录", len(res.get("data") or []) >= 1, str(res)[:150])

    if payload:
        status, res = call("POST", "/api/admin/restore", token=admin_token, body=payload)
        check("恢复数据成功", res.get("code") == 0, str(res)[:200])

        status, res = call("GET", "/api/admin/stats", token=admin_token)
        cards2 = (res.get("data") or {}).get("cards") or {}
        check("恢复后商品总数与备份前一致", cards2.get("total") == cards.get("total"),
              f"{cards2.get('total')} vs {cards.get('total')}")

    status, res = call("POST", "/api/admin/backup", token=token)
    check("普通用户不能备份", res.get("code") == 403, str(res)[:150])

    # ---------------- 功能① 私信消息 ----------------
    section("功能① 私信消息")

    status, res = call("GET", "/api/auth/me", token=token)
    me_id = (res.get("data") or {}).get("user", {}).get("id")
    status, res = call("GET", "/api/auth/me", token=seller_token)
    seller_id = (res.get("data") or {}).get("user", {}).get("id")

    status, res = call("POST", "/api/messages",
                       body={"receiver_id": seller_id, "content": "未登录发私信"})
    check("未登录不能发私信", status == 401, str(res)[:150])

    status, res = call("POST", "/api/messages", token=token,
                       body={"receiver_id": me_id, "content": "给自己发"})
    check("不能给自己发私信", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/messages", token=token,
                       body={"receiver_id": seller_id, "content": "   "})
    check("空内容被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/messages", token=token,
                       body={"receiver_id": 999999, "content": "收信人不存在"})
    check("收信人不存在被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/messages", token=token,
                       body={"receiver_id": seller_id, "content": "x" * 1001})
    check("超长内容被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/messages", token=token,
                       body={"receiver_id": seller_id, "content": "冒烟测试：你好，这件还在吗？",
                             "product_id": 1})
    msg_id = (res.get("data") or {}).get("id")
    check("发送私信成功", res.get("code") == 0 and bool(msg_id), str(res)[:150])

    status, res = call("POST", "/api/messages", token=seller_token,
                       body={"receiver_id": me_id, "content": "冒烟测试：还在的，随时可看"})
    check("对方可以回复", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/messages/unread", token=seller_token)
    check("卖家未读数为 1", (res.get("data") or {}).get("count") == 1, str(res)[:150])

    status, res = call("GET", "/api/messages/conversations", token=seller_token)
    convs = res.get("data") or []
    conv = next((c for c in convs if (c.get("user") or {}).get("id") == me_id), None)
    check("会话列表包含该对话且带未读数",
          conv is not None and conv.get("unread") == 1
          and "还在的" in (conv.get("last_message") or {}).get("content", ""), str(res)[:220])

    status, res = call("GET", f"/api/messages/with/{me_id}", token=seller_token)
    thread = (res.get("data") or {}).get("list") or []
    check("聊天记录包含双方消息", len(thread) >= 2, str(res)[:150])

    status, res = call("GET", "/api/messages/unread", token=seller_token)
    check("打开会话后未读清零", (res.get("data") or {}).get("count") == 0, str(res)[:150])

    status, res = call("GET", f"/api/messages/with/{me_id}")
    check("未登录不能看聊天记录", status == 401, str(res)[:150])

    status, res = call("GET", "/api/messages/with/999999", token=token)
    check("对方不存在时报错", res.get("code") != 0, str(res)[:150])

    # ---------------- 功能② 价格区间 自定义 ----------------
    section("功能② 价格区间自定义输入")

    status, res = call("GET", "/api/products?min_price=30&sort=price_asc&page_size=50")
    prices = [p["price"] for p in (res.get("data") or {}).get("list", [])]
    check("只填最低价：结果全部 ≥ 30",
          bool(prices) and all(p >= 30 for p in prices), str(prices)[:120])

    status, res = call("GET", "/api/products?max_price=20&page_size=50")
    prices = [p["price"] for p in (res.get("data") or {}).get("list", [])]
    check("只填最高价：结果全部 ≤ 20",
          bool(prices) and all(p <= 20 for p in prices), str(prices)[:120])

    status, res = call("GET", "/api/products?min_price=25&max_price=25&page_size=50")
    prices = [p["price"] for p in (res.get("data") or {}).get("list", [])]
    check("最低价 = 最高价：只返回该价位的商品",
          bool(prices) and all(p == 25.0 for p in prices), str(prices)[:120])

    status, res = call("GET", "/api/products?min_price=80&max_price=130&page_size=50")
    prices = [p["price"] for p in (res.get("data") or {}).get("list", [])]
    check("自定义区间 80~130：结果都落在区间内",
          bool(prices) and all(80 <= p <= 130 for p in prices), str(prices)[:120])

    status, res = call("GET", "/api/products?min_price=100&max_price=50")
    check("最低价大于最高价：返回空结果而不是报错",
          res.get("code") == 0 and (res.get("data") or {}).get("total") == 0, str(res)[:150])

    # ---------------- 功能③ 我想要 ----------------
    section("功能③ 我想要")

    status, res = call("POST", "/api/auth/login",
                       body={"username": "buyer2", "password": "123456", "role": "buyer"})
    buyer2 = (res.get("data") or {}).get("token")
    check("买家 buyer2 登录（用于验证多人都想要）", bool(buyer2), str(res)[:150])

    # 归一化：先取消掉上一次测试可能留下的「我想要」，保证断言可重复
    for account_token in (buyer1, buyer2):
        _st, _r = call("GET", f"/api/products/{fav_pid}", token=account_token)
        if (_r.get("data") or {}).get("wanted"):
            call("POST", f"/api/products/{fav_pid}/want", token=account_token)

    status, res = call("GET", f"/api/products/{fav_pid}")
    want_before = (res.get("data") or {}).get("want_count")

    status, res = call("POST", f"/api/products/{fav_pid}/want")
    check("未登录不能点「我想要」", status == 401, str(res)[:150])

    status, res = call("POST", f"/api/products/{fav_pid}/want", token=seller_token)
    check("不能对自己发布的商品点「我想要」", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", f"/api/products/{fav_pid}/want", token=buyer1)
    check("点「我想要」成功且人数 +1",
          res.get("code") == 0 and (res.get("data") or {}).get("wanted") is True
          and (res.get("data") or {}).get("want_count") == (want_before or 0) + 1,
          f"之前 {want_before} → 现在 {(res.get('data') or {}).get('want_count')}")

    status, res = call("GET", f"/api/products/{fav_pid}", token=buyer1)
    check("详情页能读到「已想要」状态与人数",
          (res.get("data") or {}).get("wanted") is True
          and (res.get("data") or {}).get("want_count") == (want_before or 0) + 1,
          str(res)[:200])

    status, res = call("POST", f"/api/products/{fav_pid}/want", token=buyer2)
    check("第二个人也想要，人数累加",
          (res.get("data") or {}).get("want_count") == (want_before or 0) + 2,
          str(res)[:150])

    status, res = call("GET", f"/api/products/{fav_pid}/wants")
    check("想要名单接口返回人数与列表",
          res.get("code") == 0 and (res.get("data") or {}).get("count") == (want_before or 0) + 2,
          str(res)[:150])

    status, res = call("POST", f"/api/products/{fav_pid}/want", token=buyer1)
    check("再点一次取消「我想要」，人数 -1",
          (res.get("data") or {}).get("wanted") is False
          and (res.get("data") or {}).get("want_count") == (want_before or 0) + 1,
          str(res)[:150])

    # 清理：把 buyer2 的那次也取消掉，避免污染演示数据
    status, res = call("POST", f"/api/products/{fav_pid}/want", token=buyer2)
    check("重复点击不会产生重复记录（取消后回到初始人数）",
          (res.get("data") or {}).get("want_count") == (want_before or 0),
          f"期望 {want_before}，实际 {(res.get('data') or {}).get('want_count')}")

    status, res = call("POST", "/api/products/999999/want", token=buyer1)
    check("对不存在的商品点「我想要」报错", res.get("code") != 0, str(res)[:150])

    # ---------------- 功能④ 删除记录 ----------------
    section("功能④ 卖家删商品记录 / 买家删订单记录")

    # --- A. 无交易记录的商品：可彻底删除 ---
    pa = _new_product("冒烟-商品记录删除", 11.0)
    status, res = call("DELETE", f"/api/products/{pa}/record", token=seller_token)
    check("在售商品不允许直接彻底删记录", res.get("code") != 0, str(res)[:180])

    call("DELETE", f"/api/products/{pa}", token=seller_token)          # 先软删除
    status, res = call("GET", "/api/products/mine?status=deleted&page_size=50", token=seller_token)
    ids = [p["id"] for p in (res.get("data") or {}).get("list", [])]
    check("软删除的商品出现在「已删除」页签", pa in ids, str(ids)[:120])

    status, res = call("GET", "/api/products/mine?status=all&page_size=50", token=seller_token)
    ids = [p["id"] for p in (res.get("data") or {}).get("list", [])]
    check("「全部」页签不再包含已删除商品", pa not in ids, str(ids)[:120])

    status, res = call("DELETE", f"/api/products/{pa}/record", token=buyer1)
    check("别人的商品记录不能删", res.get("code") != 0, str(res)[:150])

    status, res = call("DELETE", f"/api/products/{pa}/record")
    check("未登录不能删商品记录", status == 401, str(res)[:150])

    status, res = call("DELETE", f"/api/products/{pa}/record", token=seller_token)
    check("无交易记录的商品可彻底删除", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", f"/api/products/{pa}")
    check("彻底删除后商品已不存在", res.get("code") != 0, str(res)[:150])

    # --- B. 有交易记录的商品：拒绝彻底删除 ---
    pb = _new_product("冒烟-有订单不能删", 22.0)
    call("POST", "/api/orders", token=token, body={"product_id": pb, "meet_place_id": 1})
    call("DELETE", f"/api/products/{pb}", token=seller_token)          # 软删除
    status, res = call("DELETE", f"/api/products/{pb}/record", token=seller_token)
    check("有交易记录的商品拒绝彻底删除（要保留历史订单）",
          res.get("code") != 0 and "交易记录" in (res.get("msg") or ""), str(res)[:180])

    # --- C. 买家删除订单记录 ---
    pc = _new_product("冒烟-订单记录删除", 33.0)
    _st, _res = call("POST", "/api/orders", token=token,
                     body={"product_id": pc, "meet_place_id": 1})
    order = (_res.get("data") or {})

    status, res = call("DELETE", f"/api/orders/{order['id']}/record", token=token)
    check("「待完成」订单不能删除记录", res.get("code") != 0, str(res)[:180])

    call("PATCH", f"/api/orders/{order['id']}/complete", token=token)
    status, res = call("DELETE", f"/api/orders/{order['id']}/record", token=seller_token)
    check("卖家不能删买家的订单记录", res.get("code") != 0, str(res)[:150])

    status, res = call("DELETE", f"/api/orders/{order['id']}/record", token=token)
    check("买家删除自己的订单记录成功", res.get("code") == 0, str(res)[:150])

    status, res = call("GET", "/api/orders/mine?page_size=50", token=token)
    ids = [o["id"] for o in (res.get("data") or {}).get("list", [])]
    check("删除后买家「我的订单」不再显示该订单", order["id"] not in ids, str(ids)[:120])

    status, res = call("GET", "/api/orders/sold?page_size=50", token=seller_token)
    ids = [o["id"] for o in (res.get("data") or {}).get("list", [])]
    check("卖家「卖出订单」仍然保留这条记录", order["id"] in ids, str(ids)[:120])

    status, res = call("DELETE", f"/api/orders/{order['id']}/record", token=token)
    check("同一条订单不能重复删除记录", res.get("code") != 0, str(res)[:150])

    # ---------------- 功能⑥ 帖子配图 ----------------
    section("功能⑥ 帖子配图")

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "冒烟-配图帖子", "content": "带两张图的测试帖",
                             "tag": "闲聊", "images": ["post-a.png", "post-b.png"]})
    post_id = (res.get("data") or {}).get("id")
    check("发帖可以带配图", res.get("code") == 0 and bool(post_id), str(res)[:180])

    status, res = call("GET", f"/api/posts/{post_id}")
    images = (res.get("data") or {}).get("images") or []
    check("帖子详情返回配图且顺序正确",
          images == ["post-a.png", "post-b.png"], str(images)[:150])

    status, res = call("GET", "/api/posts?keyword=冒烟-配图帖子")
    first = ((res.get("data") or {}).get("list") or [{}])[0]
    check("帖子列表里也带配图（用于显示缩略图）",
          (first.get("images") or []) == ["post-a.png", "post-b.png"],
          str(first.get("images"))[:150])

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "冒烟-无图帖子", "content": "不带图",
                             "tag": "闲聊", "images": []})
    check("不配图也能正常发帖",
          res.get("code") == 0 and (res.get("data") or {}).get("images") == [],
          str(res)[:150])

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "冒烟-图太多", "content": "超出上限",
                             "tag": "闲聊", "images": [f"x{i}.png" for i in range(20)]})
    check("配图超过上限被拒", res.get("code") != 0, str(res)[:150])

    status, res = call("POST", "/api/posts", token=token,
                       body={"title": "冒烟-图片参数非法", "content": "images 不是数组",
                             "tag": "闲聊", "images": "not-a-list"})
    check("配图参数格式非法被拒", res.get("code") != 0, str(res)[:150])

    # ---------------- 功能⑦ 个人资料（昵称 / 头像）----------------
    section("功能⑦ 个人资料")

    # 用测试账号 smoke_buyer，避免改到演示账号的资料
    status, res = call("PUT", "/api/auth/profile", body={"nickname": "改个名"})
    check("未登录不能改资料", status == 401, str(res)[:150])

    status, res = call("PUT", "/api/auth/profile", body={"nickname": ""}, token=token)
    check("昵称不能为空", res.get("code") != 0, str(res)[:150])

    status, res = call("PUT", "/api/auth/profile", body={"nickname": "x" * 21}, token=token)
    check("昵称不能超过 20 个字符", res.get("code") != 0, str(res)[:150])

    status, res = call("PUT", "/api/auth/profile", body={"nickname": "冒烟改名人"}, token=token)
    check("修改昵称成功",
          res.get("code") == 0 and (res.get("data") or {}).get("nickname") == "冒烟改名人",
          str(res)[:180])

    status, res = call("GET", "/api/auth/me", token=token)
    check("/api/auth/me 能读到新昵称",
          (res.get("data") or {}).get("user", {}).get("nickname") == "冒烟改名人",
          str(res)[:180])

    status, res = call("PUT", "/api/auth/profile",
                       body={"avatar": "avatar-test.png"}, token=token)
    check("设置头像成功",
          res.get("code") == 0 and (res.get("data") or {}).get("avatar") == "avatar-test.png",
          str(res)[:180])

    status, res = call("GET", "/api/auth/me", token=token)
    check("/api/auth/me 能读到头像",
          (res.get("data") or {}).get("user", {}).get("avatar") == "avatar-test.png",
          str(res)[:180])

    status, res = call("PUT", "/api/auth/profile", body={"avatar": ""}, token=token)
    check("可以恢复成默认头像（avatar 置空）",
          res.get("code") == 0 and not (res.get("data") or {}).get("avatar"),
          str(res)[:180])

    status, res = call("PUT", "/api/auth/profile", body={"nickname": "冒烟改名人"}, token=token)
    check("资料没有变化时给出友好提示而不是报错",
          res.get("code") == 0, str(res)[:150])

    # ---------------- 商品编号 product_code ----------------
    section("商品编号 product_code")

    import re as _re

    code_re = _re.compile(r"^[A-Z0-9]{2}\d{2}-\d{4}-\d{6}-\d{5}$")

    def _publish(name, price, category_id=1, subcategory_id=1, token_=None):
        _st, r = call("POST", "/api/products", token=token_ or seller_token,
                      body={"name": name, "price": price, "category_id": category_id,
                            "subcategory_id": subcategory_id, "condition": "九成新",
                            "description": "商品编号测试用", "default_place_id": 2, "images": []})
        return r.get("data") or {}

    a = _publish("冒烟-编号A", 12.0)
    b = _publish("冒烟-编号B", 13.0)
    check("发布商品自动生成商品编号（格式 22 位四段）",
          bool(code_re.match(a.get("product_code") or "")),
          f"编号={a.get('product_code')!r}")
    check("两件商品编号互不相同",
          a.get("product_code") != b.get("product_code"),
          f"{a.get('product_code')} vs {b.get('product_code')}")

    pa, pb = (a.get("product_code") or "").split("-"), (b.get("product_code") or "").split("-")
    check("同一卖家的卖家码一致、流水号递增 1",
          len(pa) == 4 and pa[1] == pb[1] and int(pb[3]) == int(pa[3]) + 1,
          f"{a.get('product_code')} / {b.get('product_code')}")

    c = _publish("冒烟-编号无小类", 14.0, category_id=2, subcategory_id=None)
    check("分类码取大类字母码，无小类时小类段为 00",
          (c.get("product_code") or "").startswith("DG00-"),
          f"编号={c.get('product_code')!r}（数码应为 DG，无小类应为 00）")

    d = _publish("冒烟-编号换分类", 15.0, category_id=3, subcategory_id=None)
    check("换个大类，分类码随之变化",
          (d.get("product_code") or "").startswith("LF"),
          f"编号={d.get('product_code')!r}（生活用品应为 LF）")

    # 不可变：改名 + 改分类都不重算
    before = d.get("product_code")
    _st, r = call("PUT", f"/api/products/{d['id']}", token=seller_token,
                  body={"name": "冒烟-编号改过名", "price": 16.0, "category_id": 1,
                        "subcategory_id": 1, "condition": "九成新",
                        "description": "改名并改分类", "default_place_id": 2, "images": [],
                        "product_code": "HACK-0000-000000-99999"})
    check("编辑商品（含改分类、且前端硬塞编号）都不改变原编号",
          (r.get("data") or {}).get("product_code") == before,
          f"编辑前 {before!r} -> 编辑后 {(r.get('data') or {}).get('product_code')!r}")

    _st, r = call("GET", f"/api/products/{a['id']}")
    check("商品详情返回商品编号",
          (r.get("data") or {}).get("product_code") == a.get("product_code"),
          str(r)[:150])

    _st, r = call("GET", "/api/products/mine?page_size=50", token=seller_token)
    mine = {p["id"]: p.get("product_code") for p in (r.get("data") or {}).get("list", [])}
    check("「我的商品」列表带商品编号", mine.get(a["id"]) == a.get("product_code"), str(mine)[:150])

    _st, r = call("GET", f"/api/admin/products?keyword={a['product_code'][:8]}",
                  token=admin_token)
    ids = [p["id"] for p in (r.get("data") or {}).get("list", [])]
    check("管理后台可按编号前缀搜索到该商品", a["id"] in ids, f"搜到 {ids[:6]}")

    _o = call("POST", "/api/orders", token=token,
              body={"product_id": b["id"], "meet_place_id": 2})[1].get("data") or {}
    check("下单时把商品编号写进订单快照",
          (_o.get("product") or {}).get("product_code") == b.get("product_code")
          and _o.get("product_code") == b.get("product_code"),
          f"快照编号={( _o.get('product') or {}).get('product_code')!r}")

    # 大类字母码的维护与校验
    _st, r = call("POST", "/api/admin/categories", token=admin_token,
                  body={"name": "冒烟编号分类", "icon": "🧪", "sort": 99, "code": "XYZ"})
    check("字母码不是 2 位时被拒", r.get("code") != 0, str(r)[:150])

    _st, r = call("POST", "/api/admin/categories", token=admin_token,
                  body={"name": "冒烟编号分类", "icon": "🧪", "sort": 99, "code": "TA"})
    check("字母码与其他分类重复时被拒", r.get("code") != 0, str(r)[:150])

    _st, r = call("POST", "/api/admin/categories", token=admin_token,
                  body={"name": "冒烟编号分类", "icon": "🧪", "sort": 99, "code": "ZZ"})
    new_cat = r.get("data") or {}
    check("字母码合法时新增分类成功且回显字母码",
          r.get("code") == 0 and new_cat.get("code") == "ZZ", str(r)[:150])
    if new_cat.get("id"):
        _st, r = call("POST", "/api/products", token=seller_token,
                      body={"name": "冒烟-新分类商品", "price": 9.0,
                            "category_id": new_cat["id"], "subcategory_id": None,
                            "condition": "九成新", "description": "用新分类发布",
                            "default_place_id": 2, "images": []})
        _new_pid = (r.get("data") or {}).get("id")
        check("新分类的商品编号用上了新配的字母码",
              ((r.get("data") or {}).get("product_code") or "").startswith("ZZ00-"),
              f"编号={(r.get('data') or {}).get('product_code')!r}")
        # 顺序很重要：分类名下有商品记录（哪怕是软删除的）就删不掉分类，
        # 所以要先把商品记录彻底删掉，再删分类。
        _st, r = call("DELETE", f"/api/products/{_new_pid}", token=seller_token)
        _st, r = call("DELETE", f"/api/products/{_new_pid}/record", token=seller_token)
        _st, r = call("DELETE", f"/api/admin/categories/{new_cat['id']}", token=admin_token)
        check("测试用分类已清理（否则会污染分类数量）", r.get("code") == 0, str(r)[:150])

    # ---------------- 需求①：管理员交易监管 + 操作日志 ----------------
    section("需求① 管理员交易监管与动态监控")

    def _logs(**params):
        q = "&".join(f"{k}={v}" for k, v in params.items())
        _s, rr = call("GET", f"/api/admin/logs?{q}", token=admin_token)
        return rr.get("data") or {}

    def _has_log(action, needle):
        data = _logs(action=action, page_size=50)
        return any(needle in (item.get("summary") or "") for item in data.get("list") or [])

    # 发布 → 编辑 → 都应有日志
    _st, r = call("POST", "/api/products", token=seller_token,
                  body={"name": "冒烟-交易监管商品", "price": 30.0, "category_id": 1,
                        "subcategory_id": 1, "condition": "九成新",
                        "description": "交易监管测试用", "default_place_id": 2, "images": []})
    tp = r.get("data") or {}
    check("发布商品后日志里出现「发布商品」且带上商品编号",
          _has_log("product_create", tp.get("product_code") or "×"),
          f"商品编号={tp.get('product_code')}")

    _st, r = call("PUT", f"/api/products/{tp['id']}", token=seller_token,
                  body={"name": "冒烟-交易监管商品", "price": 28.0, "category_id": 1,
                        "subcategory_id": 1, "condition": "九成新",
                        "description": "改了价格", "default_place_id": 2, "images": []})
    check("编辑商品后日志里出现「编辑商品」",
          _has_log("product_update", tp.get("product_code") or "×"), str(r)[:120])

    _st, r = call("PATCH", f"/api/products/{tp['id']}/status", token=seller_token,
                  body={"status": "off_shelf"})
    check("下架商品后日志里出现「下架商品」",
          _has_log("product_off", tp.get("name") or "×"), str(r)[:120])
    call("PATCH", f"/api/products/{tp['id']}/status", token=seller_token, body={"status": "on_sale"})

    # 下单 → 进行中的交易
    _st, r = call("POST", "/api/orders", token=token,
                  body={"product_id": tp["id"], "meet_place_id": 2})
    order_a = (r.get("data") or {}).get("id")
    check("下单后日志里出现「下单」", _has_log("order_create", tp.get("product_code") or "×"),
          str(r)[:120])

    _st, r = call("GET", "/api/admin/orders", token=admin_token)
    data = r.get("data") or {}
    ids = [o["id"] for o in data.get("list") or []]
    stats = data.get("stats") or {}
    check("管理员默认能看到「进行中」的交易列表",
          r.get("code") == 0 and order_a in ids, f"total={data.get('total')}, ids={ids[:5]}")
    row = next((o for o in data.get("list") or [] if o["id"] == order_a), {})
    check("交易行带上商品名称、商品编号与已进行时长",
          row.get("product_name") and row.get("product_code") == tp.get("product_code")
          and isinstance(row.get("elapsed_minutes"), int),
          str(row)[:200])
    check("交易总览含进行中/涉及商家/最长挂单/今日新增",
          all(k in stats for k in
              ("pending", "sellers_in_trade", "longest_pending_minutes", "today_orders")),
          str(stats))

    _st, r = call("GET", f"/api/admin/orders?keyword={tp['product_code']}", token=admin_token)
    hit = [o["id"] for o in (r.get("data") or {}).get("list") or []]
    check("管理员可按商品编号搜到这笔交易", order_a in hit, f"命中 {hit[:5]}")

    _st, r = call("GET", "/api/admin/orders?status=不存在的状态", token=admin_token)
    check("非法交易状态取值被拒", r.get("code") != 0, str(r)[:120])
    _st, r = call("GET", "/api/admin/orders", token=buyer1)
    check("普通用户看不到交易监管接口（403）", r.get("code") != 0, str(r)[:120])
    _st, r = call("GET", "/api/admin/logs", token=buyer1)
    check("普通用户看不到操作日志接口（403）", r.get("code") != 0, str(r)[:120])

    # 管理员强制取消
    _st, r = call("PATCH", f"/api/orders/{order_a}/cancel", token=admin_token)
    check("管理员可强制取消进行中的交易", r.get("code") == 0, str(r)[:150])
    _st, r = call("GET", f"/api/products/{tp['id']}")
    check("强制取消后商品恢复在售", (r.get("data") or {}).get("status") == "on_sale",
          str(r)[:150])
    check("强制取消留下了可区分的日志（admin_order_cancel）",
          _has_log("admin_order_cancel", "管理员强制取消"), "")

    # 管理员标记完成
    _st, r = call("POST", "/api/orders", token=token,
                  body={"product_id": tp["id"], "meet_place_id": 2})
    order_b = (r.get("data") or {}).get("id")
    _st, r = call("PATCH", f"/api/orders/{order_b}/complete", token=admin_token)
    check("管理员可标记交易完成", r.get("code") == 0, str(r)[:150])
    _st, r = call("GET", f"/api/products/{tp['id']}")
    check("标记完成后商品保持已售（不会回到在售）",
          (r.get("data") or {}).get("status") == "sold", str(r)[:150])
    check("标记完成留下了可区分的日志（admin_order_complete）",
          _has_log("admin_order_complete", "管理员标记完成"), "")

    # 时间线顺序与筛选
    logs = _logs(page_size=20).get("list") or []
    check("动态监控按时间倒序（最新一条排在最前）",
          len(logs) >= 2 and logs[0]["created_at"] >= logs[1]["created_at"],
          f"{logs[0]['created_at'] if logs else '?'} vs {logs[1]['created_at'] if len(logs) > 1 else '?'}")
    only = _logs(action="product_create", page_size=50).get("list") or []
    check("动态监控可按动作筛选（筛 product_create 只剩该动作）",
          bool(only) and all(item["action"] == "product_create" for item in only),
          f"共 {len(only)} 条，动作集合={ {i['action'] for i in only} }")
    check("日志带「动作中文名 + 操作人」便于阅读",
          all(item.get("action_text") and item.get("nickname") is not None for item in only[:3]),
          str(only[:1])[:200])

    # ---------------- 清理本脚本产生的测试数据 ----------------
    cleanup_test_data()

    # ---------------- 汇总 ----------------
    print(f"\n===== 结果：通过 {len(PASSED)} 项，失败 {len(FAILED)} 项 =====")
    if FAILED:
        print("失败项：")
        for name in FAILED:
            print("  -", name)
    return 0 if not FAILED else 1


if __name__ == "__main__":
    sys.exit(main())
