# 校园二手集市 —— 校园二手交易平台

面向校内用户的多角色二手闲置交易网站。B/S 架构，线上完成信息撮合、线下当面自提完成交易。

- **前端**：原生 HTML + CSS + JavaScript（ES Module，无框架、无打包器；fetch 调接口，切换页面不整页刷新）
- **后端**：Python Flask + Flask-SQLAlchemy + JWT(flask-jwt-extended) + bcrypt
- **数据库**：MySQL 8（InnoDB，utf8mb4），schema.sql 定义 14 张表 + 功能迭代新增 3 张（`messages`、`product_wants`、`post_images`），当前共 17 张表
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

## 二、让网站一直挂着（推荐）

`start.bat` 是前台运行，**关掉命令行窗口服务就停了**。想让网站长期可访问，用下面这套：

| 操作 | 做什么 |
|------|--------|
| 双击 `start-service.bat` | 后台启动，**没有黑窗口**，日志写到 `logs\server.log` |
| 双击 `stop-service.bat` | 停止服务（按 5000 端口精确结束进程） |
| 看 `logs\server.log` | 访问日志与启动信息 |

**已配置登录自启**：启动文件夹里放了一个 `SecondHandShop.vbs`
（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`），每次登录 Windows 会以无窗口
方式自动把服务拉起来。不想要就把它删掉，不影响手动启动。

它和 `start.bat` 的区别在 `service.py`：关掉调试模式与热重载（不会双进程、不会因为改文件自己
重启）、开启多线程，并且**自己把输出写进 `logs\server.log`**（所以能用 `pythonw.exe` 无窗口跑）。

> 服务只监听 `127.0.0.1:5000`，即同一台电脑的浏览器可访问、局域网其他设备访问不到。
> 需要局域网访问就把 `service.py` 里的 `APP_HOST` 环境变量改成 `0.0.0.0`。

## 三、演示账号

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

## 四、常用命令

| 命令 | 作用 |
|------|------|
| `manage.py init-db` | 按 `sql/schema.sql` 建表（幂等，会重建表） |
| `manage.py migrate` | 执行 `sql/migrations/` 增量迁移（幂等，只增不删） |
| `manage.py clean-test` | 清理自动化测试残留数据 |
| `manage.py reset-demo` | 清空业务数据并重新写入示例数据（＝后台「重置示例数据」） |
| `manage.py check` | 环境自检：依赖、模块、MySQL、表结构与约定修正 |
| `manage.py run` | 启动开发服务器（等同 `start.bat`） |
| `start.bat` | 前台启动（关掉窗口就停） |
| `start-service.bat` / `stop-service.bat` | 后台常驻启动 / 停止（日志在 `logs\server.log`） |

## 五、自检工具（都可重复运行）

| 命令 | 检查内容 | 最近结果 |
|------|----------|----------|
| `.venv\Scripts\python.exe manage.py check` | 依赖 / 项目模块 / MySQL 连接 / 表结构 / 三处表结构修正是否落地 | 全部通过 |
| `.venv\Scripts\python.exe manage.py migrate` | 执行 `sql/migrations/` 下的增量迁移（幂等，只增不删） | 5 个迁移，17 张表 |
| `.venv\Scripts\python.exe manage.py clean-test` | 清理自动化测试残留（另加 `--files` 可删孤儿图片） | 无残留 |
| `.venv\Scripts\python.exe tools\smoke_test.py` | 后端接口冒烟测试（需服务已启动） | **171 项通过** |
| `node tools\check_frontend.mjs` | 前端 ES Module 的 import 路径与具名导出是否对得上 | 22 个模块正常 |
| `node tools\e2e_check.mjs --shots` | 无头 Chrome 把每个页面跑一遍：查 JS 报错、接口失败、空白页，并截图 | **27 个页面 0 问题** |
| `node tools\feature_check.mjs all` | **7 项新增功能的浏览器测试**（真实点击、真实上传文件） | **54 / 54 通过** |
| `node tools\acceptance_check.mjs` | **PRD 第 10 章 23 条验收标准**逐条核对（界面真实点击 + 接口核对） | **23 / 23 通过** |
| `node tools\make_acceptance_report.mjs` | 把验收结果 JSON 转成 `docs/验收报告.md` | — |

> ⚠️ `acceptance_check.mjs` 内部会调用「重置示例数据」，**会清空库里的业务数据**。
> 对正在使用的库请勿直接运行；若要跑，请先用 `DB_NAME` 指向一个临时库
> （验收时就是这么做的），或自行备份。`--reset` 参数同理。
>
> 跑 `e2e_check.mjs` / `acceptance_check.mjs` / `feature_check.mjs` 需要本机有 Chrome 或无头 Edge；
> 可通过环境变量 `CHROME_PATH` 指定浏览器路径，`APP_BASE` 指定站点地址。

## 六、目录结构

```
secondhandshop/
├─ app.py                 应用工厂与入口
├─ config.py              配置（数据库、JWT、上传、地图 key…）
├─ extensions.py          db / bcrypt / jwt 实例
├─ models.py              17 张表的 ORM 模型
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
├─ sql/schema.sql         17 张表的建表脚本（含注释，答辩可直接讲）
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

## 七、数据库

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

## 八、相对原文档已确认的修正

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

## 九、在受限文件沙箱下开发时的两个坑（已解决）

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

## 十、本机 HTTPS 被拦截时的 git 配置

本机装了 HTTPS 拦截工具（Steam++ / 瓦特工具箱，证书签发者为 `SteamTools Certificate`），
它会替 github.com 等站点签发自己的证书。表现是：

- 浏览器和 Python 走 **Windows 证书store**，所以访问正常；
- **git 用的是自带的 Mozilla CA 包**，不信任这张证书，报
  `SSL certificate problem: unable to get local issuer certificate`；
- 把 git 的 SSL 后端切成 `schannel` 又想用系统凭据时，会报 `SEC_E_NO_CREDENTIALS`。

本仓库采用的解法（**只影响本仓库**，不改系统证书store，也不关闭证书校验）：

```bat
:: 1. 从 Windows 证书store里取出拦截工具的根证书，追加到 git 自带 CA 包的副本上
.venv\Scripts\python.exe tools\build_git_ca.py

:: 2. 让本仓库的 git 使用这份 CA 包（文件放在 .git 下，不会被提交、不会被清理）
git config http.sslBackend openssl
git config http.sslCAInfo .git/git-ca-bundle.crt
```

> **更彻底的解法**：在那款工具里关掉「HTTPS 拦截 / 证书劫持」功能，之后就完全不需要这套配置。
> 毕竟它替换了所有网站的证书，本身也意味着你的 HTTPS 流量都经过它。

另外，推送时 git 需要调起系统凭据助手（Git Credential Manager），它是 msys 程序、要创建信号
管道；在受限文件沙箱下会报 `couldn't create signal pipe`，需要放宽一次权限才能完成推送。

---

## 十一、功能迭代记录

在 v2.0 交付版本之上，后续按「一次只做一个功能、每个功能先写并跑通测试、再单独提交一次」的
方式迭代了 7 项功能。数据库变更全部走 `sql/migrations/` 下的**幂等增量脚本**
（`manage.py migrate` 执行，只增不删、不动已有数据），不使用会清库的 `init-db` 去「更新」。

| # | 功能 | 数据库变更 | 主要接口 / 界面 | 提交 |
|---|------|-----------|----------------|------|
| ① | 私信消息 | 新表 `messages` | `POST /api/messages`、`/conversations`、`/with/<uid>`、`/unread`；「我的消息」页 + 顶栏未读红点 + 详情页「私信卖家」 | `9dfa5fa` |
| ② | 价格区间可自定义输入 | — | 搜索页在快捷区间之外新增「最低价 / 最高价」手填框，含校验与地址栏同步 | `d70b021` |
| ③ | 商品详情「我想要」 | 新表 `product_wants` | `POST /api/products/{id}/want` 点一次标记、再点取消；详情页按钮与「N 人想要」统计、商品卡显示 | `efa9c6a` |
| ④ | 删除商品记录 / 删除订单记录 | `orders.buyer_deleted` | `DELETE /api/products/{id}/record`（有交易记录则拒绝）、`DELETE /api/orders/{id}/record`（只对买家隐藏）；「我的商品」新增「已删除」页签 | `6a80647` |
| ⑤ | 交流广场扩大帖子点击范围 | — | 整张帖子卡片可点击进详情，点赞/删除按钮不误触发 | `86637d9` |
| ⑥ | 帖子发布支持配图 | 新表 `post_images` | 发帖弹窗可多选上传、缩略图预览与移除；列表显示缩略图、详情页图集可放大 | `9434fec` |
| ⑦ | 用户资料页（昵称、头像） | `users.avatar` | `PUT /api/auth/profile`；「个人资料」页可改昵称、上传/恢复头像，顶栏与消息页同步显示 | `fe0ad4b` |
| ⑧ | 点站名回首页、左侧去掉「首页」 | — | 顶栏站名改为可点击按钮（跳 `#/home`）；四种视角左侧功能列均移除「首页」 | `4e682a9` |
| ⑨ | 「我的消息」「个人资料」移入右上角用户小框 | — | 顶栏去掉单独的消息图标，未读红点挂在头像上；小框内新增这两项（消息带未读数），与订单/收藏用分隔线区分 | `88822d1` |

**回归验证（全部完成后一次性跑通）**

```
manage.py check              环境与表结构自检        通过
tools/smoke_test.py          后端接口冒烟            171 / 171
tools/check_frontend.mjs     前端模块依赖一致性      22 个模块正常
tools/e2e_check.mjs --shots  无头浏览器跑 27 个页面   0 问题
tools/feature_check.mjs all  9 组功能浏览器测试       72 / 72
tools/acceptance_check.mjs   PRD 第 10 章 23 条验收   23 / 23（在临时库上执行）
```

**界面导航速查（调整后）**

- 回首页：点左上角站名「🌿 校园二手集市」
- 我的消息 / 个人资料：点右上角头像，在弹出的小框里
- 左侧功能列只放浏览与业务操作：游客（搜索与筛选 / 比价 / 交流广场）、买家（+我的订单 / 我的收藏 / 以物换物）、卖家（发布商品 / 我的商品 / 卖出订单 / 以物换物 / 交流广场）、管理员（管理后台 / 数据看板）


