"""接口层：蓝图注册。

新增一个模块时，在 BLUEPRINT_MODULES 里加名字，并让该模块导出 `bp` 即可。
尚未实现的模块会被自动跳过，方便逐模块开发。
"""
FOREIGN_BLUEPRINT_MODULES = (
    "auth",        # M01 用户认证
    "catalog",     # 分类 / 小类 / 校园地点 / 全局枚举（公开只读）
    "products",    # M02/M03/M04/M09 首页、搜索筛选、商品详情、发布管理
    "compare",     # M05 比价
    "orders",      # M06 下单与订单
    "favorites",   # M07 我的收藏
    "reviews",     # M08 评价与评分
    "reports",     # M10 举报
    "swaps",       # M12 以物换物
    "posts",       # M13 交流广场
    "admin",       # M10/M11 管理后台、数据看板、基础数据、备份恢复
)


def register_blueprints(app) -> None:
    from importlib import import_module

    for name in FOREIGN_BLUEPRINT_MODULES:
        try:
            module = import_module(f"api.{name}")
        except ModuleNotFoundError:
            continue  # 该模块还没写，跳过
        bp = getattr(module, "bp", None)
        if bp is not None:
            app.register_blueprint(bp)
