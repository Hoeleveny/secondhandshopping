# 校园二手集市 —— 校园二手交易平台

面向校内用户的多角色二手闲置交易网站。B/S 架构，线上完成信息撮合、线下当面自提完成交易。

- **前端**：原生 HTML + CSS + JavaScript（ES Module，无框架、无打包器；fetch 调接口，切换页面不整页刷新）
- **后端**：Python Flask + Flask-SQLAlchemy + JWT(flask-jwt-extended) + bcrypt
- **数据库**：MySQL 8（InnoDB，utf8mb4），共 14 张表
- **地图**：腾讯地图 JS API（GCJ-02）；未配置 key 时自动降级为 canvas 自绘校园示意图

需求与设计依据见 [PRD-v2.0.md](PRD-v2.0.md)、[功能文档.md](功能文档.md)、[数据库字段归纳.md](数据库字段归纳.md)。
自测结果见 [docs/验收报告.md](docs/验收报告.md)。

---

## 一、快速开始

```bat
:: 1. 建虚拟环境并装依赖（已装好可跳过）
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt

:: 2. 建库建表（首次）
.venv\Scripts\python.exe manage.py init-db

:: 3. 写入示例数据
.venv\Scripts\python.exe manage.py reset-demo

:: 4. 启动
start.bat
```

浏览器打开 <http://127.0.0.1:5000>。

## 二、演示账号

密码统一为 `123456`。

| 用户名 | 昵称 | 注册身份 |
|--------|------|----------|
| `admin` | 平台管理员 | 管理员（登录页需选「管理员」身份） |
| `buyer1` | 李小明 | 买家 |
| `buyer2` | 王芳 | 买家 |
| `seller1` | 陈同学 | 卖家 |
| `seller2` | 刘同学 | 卖家 |
| `seller3` | 赵同学 | 卖家 |

> **身份说明**：注册时选的买家/卖家**只是登录后的默认视角**，不是权限。普通用户登录后可用顶栏
> 滑块钮在「买家 ⇄ 卖家」之间自由切换，同一账号既能买也能卖；管理员必须在登录页选择「管理员」
> 身份并用管理员账号登录，登录后不显示滑块钮、也不可切换。真正的权限判断在接口层。
>
> 游客（未登录）可以浏览首页、搜索与筛选、比价、商品详情、交流广场；下单、收藏、发布等操作
> 会引导登录。

## 三、常用命令

| 命令 | 作用 |
|------|------|
| `manage.py init-db` | 按 `sql/schema.sql` 建表（幂等，会重建表） |
| `manage.py reset-demo` | 清空业务数据并重新写入示例数据（＝后台「重置示例数据」） |
| `manage.py check` | 环境自检：依赖、模块、MySQL、表结构与约定修正 |
| `manage.py run` | 启动开发服务器（等同 `start.bat`） |
| `start.bat` | 一键启动 |

## 四、自检工具（都可重复运行）

| 命令 | 检查内容 | 最近结果 |
|------|----------|----------|
| `.venv\Scripts\python.exe manage.py check` | 依赖 / 项目模块 / MySQL 连接 / 14 张表 / 三处表结构修正是否落地 | 全部通过 |
| `.venv\Scripts\python.exe tools\smoke_test.py` | 后端接口冒烟测试（需服务已启动） | **114 项通过** |
| `node tools\check_frontend.mjs` | 前端 ES Module 的 import 路径与具名导出是否对得上 | 20 个模块正常 |
| `node tools\e2e_check.mjs --shots` | 无头 Chrome 把每个页面跑一遍：查 JS 报错、接口失败、空白页，并截图 | **27 个页面 0 问题** |
| `node tools\acceptance_check.mjs --reset` | **PRD 第 10 章 23 条验收标准**逐条核对（界面真实点击 + 接口核对） | **23 / 23 通过** |
| `node tools\make_acceptance_report.mjs` | 把验收结果 JSON 转成 `docs/验收报告.md` | — |

> 跑 `e2e_check.mjs` / `acceptance_check.mjs` 需要本机有 Chrome 或无头 Edge；可通过环境变量
> `CHROME_PATH` 指定浏览器路径，`APP_BASE` 指定站点地址。

## 五、目录结构

```
secondhandshop/
├─ app.py                 应用工厂与入口
├─ config.py              配置（数据库、JWT、上传、地图 key…）
├─ extensions.py          db / bcrypt / jwt 实例
├─ models.py              14 张表的 ORM 模型
├─ seed.py                示例数据
├─ backup.py              数据备份 / 恢复（导出导入 JSON）
├─ manage.py              命令行工具
├─ api/                   接口层（按模块分蓝图）
│  ├─ common.py           统一响应、登录/管理员校验、分页、地理计算
│  ├─ auth.py             M01 注册 / 登录 / 当前用户 / 退出
│  ├─ catalog.py          分类 / 小类 / 校园地点 / 全局枚举（公开）
│  ├─ products.py         M02/M03/M04/M09 首页聚合、交叉筛选、详情、发布管理、图片上传
│  ├─ compare.py          M05 比价聚合
│  ├─ orders.py           M06 下单（防超卖）、订单流转、交易定位与小地图
│  ├─ favorites.py        M07 收藏
│  ├─ reviews.py          M08 双向互评
│  ├─ reports.py          举报提交
│  ├─ swaps.py            M12 以物换物
│  ├─ posts.py            M13 交流广场
│  └─ admin.py            M10/M11 商品管理、举报审核、基础数据、看板、备份恢复
├─ static/
│  ├─ css/app.css         全部样式（绿色主题 / 三段式 / 卡片 / 表格 / 弹窗…）
│  └─ js/
│     ├─ app.js           外壳 + hash 路由 + 菜单 + 登录页
│     ├─ api.js           接口封装（自动带 JWT 与身份视角）
│     ├─ store.js         登录态与当前视角
│     ├─ data.js          枚举 / 分类 / 地点缓存
│     ├─ ui.js            Toast / Modal / 分页 / 转义 / 星级选择等
│     ├─ components.js    商品卡 / 订单卡 / 帖子条目 / 评价条目
│     └─ pages/           14 个页面模块
├─ templates/index.html   单页外壳
├─ sql/schema.sql         14 张表的建表脚本（含注释，答辩可直接讲）
├─ docs/验收报告.md        23 条验收标准的逐条证据
├─ uploads/               商品图片上传目录
├─ wheels/                离线 wheel 仓库（便于无网重装依赖）
└─ tools/
   ├─ check_env.py        环境自检
   ├─ smoke_test.py       接口冒烟测试
   ├─ check_frontend.mjs  前端 import 一致性检查
   ├─ e2e_check.mjs       无头浏览器页面巡检 + 截图
   ├─ acceptance_check.mjs 23 条验收标准
   ├─ make_acceptance_report.mjs  生成验收报告
   └─ sandbox_pip.py      受限文件沙箱下可用的 pip 包装（见第八节）
```

## 六、数据库

| 项 | 值 |
|----|-----|
| 库名 | `campus_market`（utf8mb4 / utf8mb4_unicode_ci） |
| 应用账号 | `campus` / `Campus@2026`（仅限该库，非 root） |
| 预置管理员 | `admin` / `123456` |
| 表数量 | 14 张 |

建库建账号（首次，需要 root）：

```sql
CREATE DATABASE campus_market DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'campus'@'localhost' IDENTIFIED BY 'Campus@2026';
GRANT ALL PRIVILEGES ON campus_market.* TO 'campus'@'localhost';
FLUSH PRIVILEGES;
```

连接参数可用环境变量覆盖：`DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD`。
腾讯地图 key 用 `TENCENT_MAP_KEY` 传入，**不写死在代码里**。

## 七、相对原文档已确认的修正

| 处 | 原文档 | 本项目实现 |
|----|--------|-----------|
| 1 | `products.status` 只有三态，却要求软删除 | 增加 `'deleted'` |
| 2 | 6.1 说可匿名浏览 ↔ 接口清单说全部要登录 | 浏览类接口公开，操作类要登录 |
| 3 | 地图写死腾讯地图但无 key | 地图适配层，无 key 自动降级自绘示意图 |
| 4 | 模块表写「互评」↔ 表 8 写死单向 | 双向互评，`UNIQUE(order_id, reviewer_id)` |
| 5 | `swap_offers` 有 `matched` 态却无「换给谁」字段 | 增加 `matched_offer_id` / `matched_at` |
| 6 | 三张基础表只有 GET，后台无入口 | 补齐分类/小类/校园地点增删改 + 后台页签 |
| 7 | 举报帖子无处置动作 | 审核按对象切换动作：下架商品 / 删除帖子 |
| 8 | 分类/小类/校园地点仅管理员可维护 | 落地为「管理后台 → 基础数据」页签 |

另外两处实现说明：

- `products.condition` 是 MySQL 8 保留字，所有 SQL 都必须加反引号；ORM 层用 `quoted_name` 强制加引号。
- 关键词模糊搜索在文档基础上做了超集扩展：除商品名与描述外，还匹配**分类名与小类名**，
  这样搜「教材」也能命中教材类商品。

## 八、在受限文件沙箱下开发时的两个坑（已解决）

如果本机 DSH 会话运行在 `workspace-write` 文件沙箱下，`pip` 会以两种方式失败：

1. **`tempfile.mkdtemp()` 创建的目录里无法再建文件**（`PermissionError [Errno 13]`），
   而 pip 全程用它建临时目录 → pip 必挂。
   → 用 `tools/sandbox_pip.py`：在导入 pip 前把 `mkdtemp` 换成 `os.makedirs` 实现。
2. **pip 的 HTTP 缓存目录在用户目录（工作区之外）不可写**，会让 pip **100% CPU 空转、零输出地假死**。
   → 所有 pip 命令加 `--no-cache-dir`。

完整可用的离线安装方式（本项目就是这么装起来的）：

```bat
set TMPDIR=%CD%\_build_tmp
.venv\Scripts\python.exe tools\sandbox_pip.py install --no-cache-dir ^
    --no-index --find-links wheels flask flask-sqlalchemy pymysql ^
    cryptography flask-bcrypt flask-jwt-extended
```
