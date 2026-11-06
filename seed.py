"""示例数据（种子数据）。

内容：管理员 + 演示用户、5 个分类与小类、校园地点库、16 件不同状态的商品、
订单与互评、收藏、交流广场帖子/评论/点赞、举报、以物换物。

用法：
    .venv\\Scripts\\python.exe seed.py          # 清空业务数据后重新写入
    from seed import seed_all; seed_all()       # 在代码里调用（管理员「重置示例数据」）

说明：
- 所有演示账号密码统一为 123456，便于验收演示。
- 校园地点经纬度为 GCJ-02 示例坐标（腾讯地图坐标系），可由管理员在
  「管理后台 → 基础数据」里修改成自己学校的真实坐标。
"""
from datetime import datetime, timedelta

from extensions import db
from models import (
    CampusPlace,
    Category,
    Favorite,
    Order,
    Post,
    PostComment,
    PostLike,
    Product,
    ProductImage,  # noqa: F401  (保留：后续生成示例图时会用到)
    Report,
    Review,
    Subcategory,
    SwapOffer,
    User,
)

DEMO_PASSWORD = "123456"

# ----------------------------------------------------------------- 分类与小类
CATEGORIES = [
    ("教材", "📚", 1, ["公共课教材", "专业课教材", "考研资料", "英语四六级"]),
    ("数码", "📱", 2, ["手机", "笔记本电脑", "平板", "耳机", "键盘鼠标"]),
    ("生活用品", "💡", 3, ["台灯", "收纳", "水壶", "小电器"]),
    ("运动", "🚲", 4, ["自行车", "球类", "健身器材", "运动鞋"]),
    ("其他", "📦", 5, ["票券", "乐器", "手办", "其他"]),
]

# ----------------------------------------------------------------- 校园地点
# 基准点：示例校园（GCJ-02）。东为正 lng，北为正 lat。
BASE_LNG, BASE_LAT = 114.4140000, 30.5110000
PLACES = [
    ("图书馆", "图书馆", 0.0004, 0.0006, 1),
    ("图书馆南门", "图书馆", 0.0004, -0.0002, 2),
    ("第一教学楼", "教学楼", -0.0012, 0.0010, 3),
    ("第二教学楼", "教学楼", -0.0008, 0.0016, 4),
    ("学生一食堂", "食堂", 0.0016, 0.0002, 5),
    ("学生二食堂", "食堂", 0.0012, -0.0009, 6),
    ("1 号宿舍楼", "宿舍", -0.0020, -0.0006, 7),
    ("3 号宿舍楼", "宿舍", -0.0024, 0.0004, 8),
    ("田径运动场", "运动场", 0.0026, 0.0012, 9),
    ("东区篮球场", "运动场", 0.0020, -0.0016, 10),
    ("大学生活动中心", "其他", 0.0002, 0.0018, 11),
    ("菜鸟驿站（校门口）", "其他", -0.0030, -0.0012, 12),
]

# ----------------------------------------------------------------- 演示用户
# (用户名, 昵称, 注册身份)
USERS = [
    ("admin", "平台管理员", "admin"),
    ("buyer1", "李小明", "buyer"),
    ("buyer2", "王芳", "buyer"),
    ("seller1", "陈同学", "seller"),
    ("seller2", "刘同学", "seller"),
    ("seller3", "赵同学", "seller"),
]

# ----------------------------------------------------------------- 商品
# (卖家, 分类, 小类, 名称, 价格, 成色, 状态, 浏览量, 默认自提点, 描述)
PRODUCTS = [
    ("seller1", "教材", "公共课教材", "高等数学（同济第七版）上下册", 25.00, "九成新", "on_sale", 132,
     "图书馆南门", "无笔记、无划线，书角略微磨损，内页干净。可拆开单卖。"),
    ("seller1", "教材", "考研资料", "考研英语一历年真题解析（2020-2025）", 45.00, "八成新", "on_sale", 88,
     "第二教学楼", "做过的部分已用铅笔擦除，答案册全新。"),
    ("seller2", "教材", "公共课教材", "大学物理实验报告册（全新未用）", 12.00, "全新", "sold", 41,
     "第一教学楼", "买重了，全新没用过。"),
    ("seller1", "数码", "耳机", "小米蓝牙耳机 Air2 SE", 79.00, "九成新", "on_sale", 210,
     "学生一食堂", "用了两个月，音质正常，包含充电盒。"),
    ("seller2", "数码", "平板", "iPad 第九代 64G WiFi 版", 1250.00, "八成新", "sold", 530,
     "图书馆", "屏幕无划痕，边角有轻微磕碰，送保护壳和钢化膜。"),
    ("seller3", "数码", "键盘鼠标", "罗技 K380 蓝牙键盘", 105.00, "九成新", "on_sale", 96,
     "3 号宿舍楼", "三模连接，键帽无磨损，含原装电池。"),
    ("seller2", "数码", "笔记本电脑", "联想小新 Air14 笔记本", 2100.00, "八成新", "off_shelf", 402,
     "图书馆", "配置 i5/16G/512G，电池健康度 86%。因换新机出售。"),
    ("seller3", "生活用品", "台灯", "护眼台灯（可调色温亮度）", 35.00, "九成新", "on_sale", 74,
     "1 号宿舍楼", "三档色温无极调光，USB 供电，含说明书。"),
    ("seller1", "生活用品", "收纳", "宿舍收纳箱三件套", 18.00, "八成新", "on_sale", 55,
     "3 号宿舍楼", "两个大号一个中号，可叠放，无异味。"),
    ("seller3", "生活用品", "小电器", "美的电热水壶 1.5L", 39.00, "九成新", "sold", 120,
     "学生二食堂", "304 不锈钢内胆，已除垢清洗。"),
    ("seller2", "运动", "自行车", "捷安特 ATX 山地自行车", 480.00, "七成新及以下", "on_sale", 288,
     "东区篮球场", "毕业出，车况良好，前后刹车刚换过，送车锁和打气筒。"),
    ("seller1", "运动", "球类", "斯伯丁篮球 7 号", 65.00, "八成新", "on_sale", 63,
     "东区篮球场", "室内外通用，气密性良好，打了半年。"),
    ("seller3", "运动", "健身器材", "哑铃一对 5kg（包胶）", 55.00, "九成新", "off_shelf", 37,
     "田径运动场", "包胶无磕碰，可拆片。"),
    ("seller2", "其他", "乐器", "民谣吉他 41 寸（含琴包）", 320.00, "八成新", "on_sale", 165,
     "大学生活动中心", "云杉面板，手感不错，送变调夹、拨片和备用弦。"),
    ("seller3", "其他", "票券", "校园音乐节门票 2 张", 15.00, "全新", "on_sale", 22,
     "大学生活动中心", "本周六晚 19:00，有事去不了，原价转。"),
    ("seller1", "生活用品", "水壶", "保温杯 500ml", 8.00, "全新", "on_sale", 19,
     "菜鸟驿站（校门口）", "全新未拆封，颜色为浅绿。"),
    # ---------------- 2026-10-18 追加的演示商品（用户要求"更多示例商品"）----------------
    ("seller1", "教材", "专业课教材", "数据结构（C 语言版）第 3 版", 30.00, "九成新", "on_sale", 96,
     "图书馆", "课后习题只做了前四章，其余全新，无划线。"),
    ("seller2", "教材", "英语四六级", "大学英语四级真题集（含听力音频）", 18.00, "八成新", "on_sale", 74,
     "第二教学楼", "做过两套，配套听力二维码仍可扫。"),
    ("seller3", "教材", "专业课教材", "计算机网络（自顶向下方法）", 42.00, "九成新", "on_sale", 88,
     "第一教学楼", "无笔记，书脊完好。"),
    ("seller1", "教材", "考研资料", "考研数学复习全书（数一）", 36.00, "八成新", "on_sale", 63,
     "图书馆南门", "重点章节有荧光笔标注，不影响阅读。"),
    ("seller2", "教材", "公共课教材", "线性代数（第六版）", 15.00, "九成新", "on_sale", 48,
     "第一教学楼", "只翻过前两章，无笔记。"),
    ("seller2", "数码", "手机", "红米 Note 12（8+256G）", 620.00, "八成新", "on_sale", 310,
     "学生一食堂", "屏幕有细微使用痕迹，无维修记录，含原装充电器。"),
    ("seller3", "数码", "手机", "iPhone 12 128G 白色", 1850.00, "九成新", "on_sale", 640,
     "图书馆", "电池健康度 88%，无锁，已恢复出厂设置。"),
    ("seller1", "数码", "键盘鼠标", "罗技 M590 静音鼠标", 45.00, "九成新", "on_sale", 52,
     "3 号宿舍楼", "静音按键，蓝牙双模，含接收器。"),
    ("seller2", "数码", "耳机", "索尼 WH-CH520 头戴耳机", 180.00, "八成新", "on_sale", 143,
     "大学生活动中心", "耳罩无掉皮，续航正常。"),
    ("seller3", "数码", "平板", "华为 MatePad 11 保护壳 + 键盘", 70.00, "全新", "on_sale", 38,
     "菜鸟驿站（校门口）", "买错尺寸，全新未拆。"),
    ("seller3", "数码", "键盘鼠标", "机械键盘 87 键（青轴）", 130.00, "八成新", "on_sale", 92,
     "3 号宿舍楼", "键帽略油，附赠拔键器与备用键帽。"),
    ("seller1", "生活用品", "收纳", "桌面置物架（三层）", 22.00, "九成新", "on_sale", 41,
     "1 号宿舍楼", "免打孔安装，承重不错。"),
    ("seller2", "生活用品", "小电器", "小熊电煮锅 1.2L", 45.00, "九成新", "on_sale", 118,
     "学生二食堂", "带蒸笼，已彻底清洗，宿舍可用。"),
    ("seller3", "生活用品", "水壶", "不锈钢保温壶 1.5L", 25.00, "八成新", "on_sale", 33,
     "3 号宿舍楼", "保温 8 小时以上，内胆无水垢。"),
    ("seller1", "生活用品", "台灯", "USB 夹式阅读灯", 12.00, "九成新", "on_sale", 27,
     "图书馆南门", "三档亮度，可夹床头或书桌。"),
    ("seller2", "生活用品", "收纳", "床帘 + 支架一套", 35.00, "九成新", "on_sale", 51,
     "3 号宿舍楼", "遮光床帘，支架完好，拆卸方便。"),
    ("seller2", "生活用品", "收纳", "全身镜（可挂墙）", 30.00, "八成新", "on_sale", 46,
     "1 号宿舍楼", "搬寝室带不走，边框有轻微划痕。"),
    ("seller3", "运动", "运动鞋", "耐克跑鞋 42 码", 210.00, "七成新及以下", "on_sale", 196,
     "田径运动场", "鞋底有明显磨损，鞋面干净，已清洗。"),
    ("seller1", "运动", "球类", "羽毛球拍两支（含球）", 60.00, "九成新", "on_sale", 57,
     "东区篮球场", "碳素拍，送一筒训练球。"),
    ("seller2", "运动", "健身器材", "瑜伽垫（加厚 10mm）", 28.00, "九成新", "on_sale", 44,
     "田径运动场", "附收纳带，无破损。"),
    ("seller3", "运动", "自行车", "折叠自行车 20 寸", 320.00, "八成新", "off_shelf", 152,
     "3 号宿舍楼", "折叠方便，放宿舍不占地，刹车灵敏。"),
    ("seller1", "运动", "球类", "足球 5 号（手缝）", 40.00, "八成新", "on_sale", 35,
     "东区篮球场", "耐磨，打过几次，气足。"),
    ("seller2", "运动", "球类", "乒乓球拍一对", 32.00, "九成新", "on_sale", 26,
     "东区篮球场", "附三只训练球，胶皮还新。"),
    ("seller2", "其他", "乐器", "尤克里里 23 寸", 95.00, "九成新", "on_sale", 71,
     "大学生活动中心", "含调音器、拨片与琴包。"),
    ("seller3", "其他", "手办", "EVA 初号机模型（已拼装）", 88.00, "九成新", "on_sale", 134,
     "菜鸟驿站（校门口）", "拼装完成只摆拍过一次，无缺件。"),
    ("seller1", "其他", "手办", "高达 MG 独角兽", 160.00, "八成新", "on_sale", 88,
     "3 号宿舍楼", "有轻微掉漆，附备用贴纸。"),
    ("seller2", "其他", "票券", "校园话剧社演出票 1 张", 10.00, "全新", "on_sale", 16,
     "大学生活动中心", "周四晚 19:30，教室冲突去不了。"),
    ("seller3", "其他", "其他", "多肉盆栽两盆（含花盆）", 15.00, "九成新", "on_sale", 29,
     "1 号宿舍楼", "好养活，已断水一周，搬走自取。"),
    ("seller1", "其他", "其他", "毕业季行李纸箱 5 个", 20.00, "全新", "on_sale", 12,
     "菜鸟驿站（校门口）", "加厚五层，未拆封。"),
    ("seller3", "其他", "乐器", "电子琴 61 键", 260.00, "八成新", "off_shelf", 187,
     "大学生活动中心", "音色正常，送琴架与延音踏板。"),
    # ---------------- 2026-10-18 第二批：再补 54 件（清单到 100 件，覆盖全部 21 个小类）----------------
    # 教材 10 件
    ("seller1", "教材", "公共课教材", "概率论与数理统计（浙大第五版）", 18.00, "九成新", "on_sale", 57,
     "第一教学楼", "只做了课后奇数题，答案写在草稿纸上，书上干净。"),
    ("seller2", "教材", "公共课教材", "马克思主义基本原理（2023 版）", 10.00, "八成新", "on_sale", 41,
     "第二教学楼", "划了重点线，考试周用过一学期。"),
    ("seller3", "教材", "专业课教材", "数据库系统概论（第 6 版）", 28.00, "九成新", "on_sale", 66,
     "图书馆", "无笔记，附赠自己整理的复习提纲。"),
    ("seller1", "教材", "专业课教材", "操作系统概念（第 9 版）", 35.00, "八成新", "on_sale", 44,
     "图书馆南门", "书角有点卷，内页无划线。"),
    ("seller2", "教材", "考研资料", "考研政治核心考点背诵手册", 22.00, "九成新", "on_sale", 71,
     "第二教学楼", "只背了前两章，其余全新，含思维导图。"),
    ("seller3", "教材", "考研资料", "考研英语写作模板与范文", 15.00, "八成新", "on_sale", 39,
     "图书馆", "自己补充了几句模板，其它干净。"),
    ("seller1", "教材", "英语四六级", "英语六级词汇闪过", 12.00, "九成新", "on_sale", 33,
     "第一教学楼", "只翻过一轮，无笔记。"),
    ("seller2", "教材", "英语四六级", "四级听力专项训练（含音频）", 16.00, "八成新", "on_sale", 27,
     "第二教学楼", "做过两套听力，配套音频二维码可扫。"),
    ("seller3", "教材", "公共课教材", "大学英语综合教程 2", 14.00, "九成新", "on_sale", 30,
     "第一教学楼", "课后练习有铅笔痕迹，可擦除。"),
    ("seller1", "教材", "专业课教材", "计算机组成原理（唐朔飞）", 32.00, "八成新", "off_shelf", 52,
     "图书馆", "经典教材，笔记较多，适合复习用。"),
    # 数码 14 件
    ("seller2", "数码", "手机", "华为 nova 9 手机 128G", 780.00, "八成新", "on_sale", 210,
     "学生一食堂", "屏幕贴膜有气泡，机身无磕碰，含原装充电器。"),
    ("seller3", "数码", "笔记本电脑", "戴尔灵越 14 笔记本", 1850.00, "七成新及以下", "on_sale", 330,
     "图书馆", "i5/8G/512G，键盘有使用痕迹，电池约 4 小时。"),
    ("seller1", "数码", "平板", "小米平板 5（6+128G）", 780.00, "九成新", "on_sale", 260,
     "3 号宿舍楼", "屏幕无划痕，送磁吸保护壳和手写笔。"),
    ("seller2", "数码", "耳机", "漫步者无线耳机 X2", 65.00, "九成新", "on_sale", 88,
     "学生二食堂", "充电盒有细微划痕，续航正常。"),
    ("seller3", "数码", "键盘鼠标", "罗技 G102 游戏鼠标", 78.00, "八成新", "on_sale", 95,
     "3 号宿舍楼", "线缆完好，左右键无连击，灯效正常。"),
    ("seller1", "数码", "键盘鼠标", "机械键盘 87 键（红轴）", 150.00, "九成新", "on_sale", 120,
     "3 号宿舍楼", "红轴手感顺滑，附赠防尘罩。"),
    ("seller2", "数码", "手机", "iPhone SE 2 64G 黑色", 900.00, "八成新", "on_sale", 150,
     "图书馆", "电池健康度 84%，边框有轻微划痕，无维修。"),
    ("seller3", "数码", "平板", "iPad 第 10 代保护壳套装", 45.00, "全新", "on_sale", 22,
     "菜鸟驿站（校门口）", "买错尺寸，全新未拆封。"),
    ("seller1", "数码", "耳机", "索尼 MDR-ZX110 有线耳机", 60.00, "九成新", "on_sale", 48,
     "大学生活动中心", "耳罩干净，线材无破损。"),
    ("seller2", "数码", "笔记本电脑", "ThinkPad T480 商务本", 1600.00, "七成新及以下", "on_sale", 275,
     "图书馆南门", "i5/8G/256G，键盘手感好，外壳有磨损。"),
    ("seller3", "数码", "键盘鼠标", "蓝牙键盘 K580 双模", 88.00, "九成新", "on_sale", 31,
     "3 号宿舍楼", "可连两台设备，附原装电池。"),
    ("seller1", "数码", "手机", "红米 K40 8+128G", 550.00, "八成新", "on_sale", 190,
     "学生一食堂", "屏幕有细微使用痕迹，功能正常。"),
    ("seller2", "数码", "耳机", "苹果 AirPods 2 代（含充电盒）", 420.00, "八成新", "on_sale", 380,
     "图书馆", "左右耳正常，充电盒有磨损，已清洁消毒。"),
    ("seller3", "数码", "平板", "荣耀平板 8（4+128G）", 520.00, "八成新", "off_shelf", 140,
     "1 号宿舍楼", "屏幕无划痕，含保护套，因换新机下架。"),
    # 生活用品 11 件
    ("seller1", "生活用品", "台灯", "LED 台灯（三档亮度）", 28.00, "九成新", "on_sale", 52,
     "1 号宿舍楼", "USB 供电，三档亮度，含说明书。"),
    ("seller2", "生活用品", "收纳", "折叠收纳凳（可坐）", 20.00, "八成新", "on_sale", 34,
     "3 号宿舍楼", "承重不错，可折叠放床下，颜色为灰色。"),
    ("seller3", "生活用品", "收纳", "床边收纳挂袋", 12.00, "九成新", "on_sale", 26,
     "3 号宿舍楼", "可挂床沿，六格分类，无破损。"),
    ("seller1", "生活用品", "水壶", "不锈钢水杯 800ml", 15.00, "九成新", "on_sale", 44,
     "学生一食堂", "内胆无垢，盖子密封圈完好。"),
    ("seller2", "生活用品", "小电器", "宿舍小风扇（静音）", 25.00, "八成新", "on_sale", 61,
     "1 号宿舍楼", "两档风速，夜间用不吵，USB 供电。"),
    ("seller3", "生活用品", "小电器", "插排 6 位（带开关）", 18.00, "九成新", "on_sale", 39,
     "3 号宿舍楼", "线长 1.8 米，带独立开关，过载保护。"),
    ("seller1", "生活用品", "小电器", "迷你电饭煲 1.2L", 55.00, "九成新", "on_sale", 73,
     "学生二食堂", "适合宿舍，煮饭煮粥都可，已彻底清洗。"),
    ("seller2", "生活用品", "台灯", "磁吸阅读灯（USB 充电）", 22.00, "全新", "on_sale", 30,
     "图书馆", "全新未拆，磁吸底座可贴床头。"),
    ("seller3", "生活用品", "收纳", "桌面收纳盒（三层抽屉）", 16.00, "八成新", "on_sale", 25,
     "1 号宿舍楼", "放文具刚好，抽屉顺滑。"),
    ("seller1", "生活用品", "水壶", "便携保温水杯 350ml", 10.00, "九成新", "on_sale", 21,
     "图书馆南门", "小巧放书包侧袋，保温 6 小时。"),
    ("seller2", "生活用品", "小电器", "电吹风（宿舍可用）", 42.00, "八成新", "off_shelf", 58,
     "1 号宿舍楼", "低功率不跳闸，风量正常，已下架待用。"),
    # 运动 9 件
    ("seller3", "运动", "球类", "篮球 7 号（室内外两用）", 55.00, "八成新", "on_sale", 66,
     "东区篮球场", "气足，表皮轻微磨损，不影响使用。"),
    ("seller1", "运动", "球类", "排球 5 号（软式）", 38.00, "九成新", "on_sale", 29,
     "东区篮球场", "软式适合室内，打过几次。"),
    ("seller2", "运动", "球类", "网球拍一对（含球）", 85.00, "八成新", "on_sale", 41,
     "田径运动场", "拍线还紧，送三只旧球。"),
    ("seller3", "运动", "健身器材", "筋膜枪（迷你）", 95.00, "九成新", "on_sale", 112,
     "田径运动场", "四档力度，含四个按摩头，续航正常。"),
    ("seller1", "运动", "健身器材", "跳绳（可计数）", 12.00, "九成新", "on_sale", 18,
     "田径运动场", "钢丝绳可调长度，计数正常。"),
    ("seller2", "运动", "健身器材", "瑜伽球 65cm", 25.00, "八成新", "on_sale", 23,
     "田径运动场", "含打气筒，无漏气。"),
    ("seller3", "运动", "运动鞋", "李宁篮球鞋 43 码", 130.00, "七成新及以下", "on_sale", 170,
     "东区篮球场", "鞋底磨损明显，鞋面干净，已清洗。"),
    ("seller1", "运动", "自行车", "凤凰通勤自行车 26 寸", 260.00, "八成新", "on_sale", 148,
     "东区篮球场", "通勤代步够用，刹车灵敏，送车锁。"),
    ("seller2", "运动", "球类", "羽毛球拍进阶款（含拍套）", 110.00, "九成新", "on_sale", 84,
     "东区篮球场", "全碳素，拍线 25 磅，含拍套。"),
    # 其他 10 件
    ("seller3", "其他", "乐器", "尤克里里 26 寸（含琴包）", 120.00, "九成新", "on_sale", 58,
     "大学生活动中心", "音准正常，含琴包与拨片。"),
    ("seller1", "其他", "乐器", "电子琴 54 键（含琴架）", 210.00, "八成新", "on_sale", 96,
     "大学生活动中心", "送琴架与电源，个别琴键略松。"),
    ("seller2", "其他", "手办", "景品手办（五等分）", 60.00, "全新", "on_sale", 130,
     "菜鸟驿站（校门口）", "盒角有轻微压痕，本体全新未拆。"),
    ("seller3", "其他", "手办", "高达 HG 拼装模型", 75.00, "九成新", "on_sale", 88,
     "3 号宿舍楼", "已拼装，贴纸完整，附说明书。"),
    ("seller1", "其他", "票券", "校园音乐会门票 1 张", 8.00, "全新", "on_sale", 14,
     "大学生活动中心", "周五晚，班级活动冲突去不了。"),
    ("seller2", "其他", "票券", "毕业季话剧门票 2 张", 20.00, "全新", "on_sale", 19,
     "大学生活动中心", "周六下午场，连座。"),
    ("seller3", "其他", "其他", "相机 Canon EOS 200D（含镜头）", 2200.00, "八成新", "on_sale", 340,
     "图书馆", "快门数不多，含 18-55 套头与相机包。"),
    ("seller1", "其他", "其他", "拼图 1000 片（已拆未拼）", 18.00, "全新", "on_sale", 22,
     "1 号宿舍楼", "拆盒检查过没缺片，袋装保存。"),
    ("seller2", "其他", "其他", "多肉盆栽 三盆（含托盘）", 20.00, "九成新", "on_sale", 40,
     "1 号宿舍楼", "好养活，已控水，搬寝室带不走。"),
    ("seller3", "其他", "其他", "纸箱 搬家纸箱 10 个", 28.00, "全新", "on_sale", 16,
     "菜鸟驿站（校门口）", "五层加厚，未拆封，可帮忙搬到楼下。"),
]

# ----------------------------------------------------------------- 订单
# (订单序号, 商品名, 买家, 状态, 交易说明, 自提点, 下单距今天数, 买家偏移, 卖家偏移)
ORDERS = [
    ("大学物理实验报告册（全新未用）", "buyer2", "pending", "今天下午 4 点后都行，到了微信联系。",
     "第一教学楼", 1, (0.0006, 0.0004), (-0.0009, 0.0012)),
    ("iPad 第九代 64G WiFi 版", "buyer1", "done", "校内自提，当面验机。",
     "图书馆", 9, (0.0012, -0.0006), (0.0004, 0.0006)),
    ("美的电热水壶 1.5L", "buyer2", "done", "晚饭后在食堂门口见。",
     "学生二食堂", 5, (0.0010, -0.0011), (0.0012, -0.0009)),
]

# ----------------------------------------------------------------- 评价
# (订单序号, 评价人, 被评价人, 星级, 内容)
REVIEWS = [
    (1, "buyer1", "seller2", 5, "卖家很爽快，机器和描述一致，还送了保护壳，推荐。"),
    (1, "seller2", "buyer1", 5, "买家守时，沟通顺畅，交易愉快。"),
    (2, "buyer2", "seller3", 4, "水壶成色不错，就是约的时间稍微晚了一点。"),
]

# ----------------------------------------------------------------- 收藏
FAVORITES = [
    ("buyer1", "高等数学（同济第七版）上下册"),
    ("buyer1", "小米蓝牙耳机 Air2 SE"),
    ("buyer1", "民谣吉他 41 寸（含琴包）"),
    ("buyer2", "捷安特 ATX 山地自行车"),
    ("buyer2", "护眼台灯（可调色温亮度）"),
]

# ----------------------------------------------------------------- 帖子
POSTS = [
    ("seller1", "安利", "图书馆三楼靠窗的自习位太香了",
     "下午有阳光但不晒，插座就在桌边，桌子也大，摊开两本书加电脑完全够用。想安静复习的同学可以早点去占位。"),
    ("buyer1", "避雷", "别买某宝 9.9 包邮的充电宝",
     "上周图便宜买了一个，用两次就鼓包了，现在只能退货。这种带电池的东西还是买正规品牌吧，二手也要看成色和批次。"),
    ("seller2", "闲聊", "有一起打羽毛球的吗",
     "每周二、四晚上 7 点在体育馆，目前固定 4 个人，还差 1-2 个，水平一般般，纯娱乐。"),
    ("buyer2", "求助", "求推荐便宜好用的宿舍台灯",
     "预算 50 以内，主要晚上看书用，希望能调光，不要闪眼睛的那种。有同学用过不错的型号吗？"),
]

# (帖子序号, 评论人, 内容)
COMMENTS = [
    (0, "buyer2", "同意，三楼比二楼安静多了。"),
    (0, "seller3", "补充一句：四楼最近装修，别去。"),
    (1, "seller3", "感谢提醒，我正好在看便宜的。"),
    (2, "buyer1", "我报名！不过这周四有课，周二来。"),
    (3, "seller3", "我这儿有个闲置的护眼台灯，可以看看我的商品。"),
]

# (帖子序号, 点赞人)
LIKES = [
    (0, "buyer1"), (0, "buyer2"), (0, "seller2"), (0, "seller3"),
    (1, "buyer2"), (1, "seller1"),
    (2, "buyer1"), (2, "seller1"), (2, "seller2"),
    (3, "seller1"),
]

# ----------------------------------------------------------------- 举报
# (类型, 目标名, 举报人, 理由)
REPORTS = [
    ("product", "校园音乐节门票 2 张", "buyer1", "价格欺诈：怀疑是黄牛票，要求核实票源。"),
    ("post", "别买某宝 9.9 包邮的充电宝", "seller3", "其他：帖子内容带有明显引流嫌疑。"),
]

# ----------------------------------------------------------------- 以物换物
# (发起人, 商品名, 标题, 估价)
SWAPS = [
    ("seller1", "高等数学（同济第七版）上下册", "高数教材换考研资料", 25.00),
    ("seller3", "宿舍收纳箱三件套", "收纳箱换小台灯", 22.00),
    ("seller2", "斯伯丁篮球 7 号", "篮球换羽毛球拍", 65.00),
    ("seller1", "保温杯 500ml", "全新保温杯换小风扇", 9.00),
]


# ================================================================= 写入逻辑
def wipe() -> None:
    """按外键依赖顺序清空全部业务数据。"""
    for model in (
        Report, Review, Favorite, SwapOffer, PostLike, PostComment, Order, Post,
        ProductImage, Product, CampusPlace, Subcategory, Category, User,
    ):
        db.session.query(model).delete()
    db.session.commit()
    db.session.execute(db.text("ALTER TABLE users AUTO_INCREMENT = 1"))
    for table in ("categories", "subcategories", "campus_places", "products",
                  "orders", "reviews", "reports", "swap_offers", "posts",
                  "post_comments", "post_likes", "favorites", "product_images"):
        db.session.execute(db.text(f"ALTER TABLE {table} AUTO_INCREMENT = 1"))
    db.session.commit()


def seed_all(reset: bool = True) -> dict:
    """写入示例数据，返回统计信息。"""
    if reset:
        wipe()

    # ---- 用户 ----
    users: dict[str, User] = {}
    for username, nickname, role in USERS:
        u = User(username=username, nickname=nickname, role=role, credit=5.0)
        u.set_password(DEMO_PASSWORD)
        db.session.add(u)
        users[username] = u
    db.session.flush()

    # ---- 分类与小类 ----
    subs: dict[tuple[str, str], Subcategory] = {}
    cats: dict[str, Category] = {}
    for name, icon, sort, sub_names in CATEGORIES:
        c = Category(name=name, icon=icon, sort=sort)
        db.session.add(c)
        db.session.flush()
        cats[name] = c
        for sub_name in sub_names:
            s = Subcategory(category_id=c.id, name=sub_name)
            db.session.add(s)
            db.session.flush()
            subs[(name, sub_name)] = s

    # 商品编号的「分类码」= 大类字母码 + 小类在大类内的序号。
    # 必须在建商品之前就位，否则生成编号时会退化成用 id 补零（如 0100-…）。
    from tools.backfill_product_code import assign_category_codes, assign_subcategory_seqs

    assign_category_codes()
    assign_subcategory_seqs()

    # ---- 校园地点 ----
    places: dict[str, CampusPlace] = {}
    for name, ptype, dx, dy, sort in PLACES:
        p = CampusPlace(
            name=name, type=ptype, sort=sort,
            lng=round(BASE_LNG + dx, 7), lat=round(BASE_LAT + dy, 7),
        )
        db.session.add(p)
        db.session.flush()
        places[name] = p

    # ---- 商品 ----
    import product_code as pc  # 商品编号生成器（与发布接口同一套实现）

    now = datetime.now()
    base_time = now - timedelta(days=30)
    products: dict[str, Product] = {}
    for idx, (seller, cat, sub, name, price, cond, status, views, place, desc) in enumerate(PRODUCTS):
        p = Product(
            seller_id=users[seller].id,
            category_id=cats[cat].id,
            subcategory_id=subs[(cat, sub)].id,
            name=name, price=price, condition=cond, status=status, views=views,
            description=desc, default_place_id=places[place].id,
            created_at=base_time + timedelta(days=idx, hours=idx * 2),
            updated_at=base_time + timedelta(days=idx, hours=idx * 2),
        )
        # product_code 是 NOT NULL，必须在 INSERT（下面的 flush）之前算好。
        # 生成器只读「该卖家已落库的编号」，此时前面几件都已 flush，顺序正确。
        p.product_code = pc.assign_for(users[seller], p)
        db.session.add(p)
        db.session.flush()
        products[name] = p

    # ---- 订单（商品状态与订单联动）----
    orders: dict[int, Order] = {}
    for idx, (pname, buyer, status, note, place, days_ago, buyer_off, seller_off) in enumerate(ORDERS):
        p = products[pname]
        p.status = "sold"
        created = now - timedelta(days=days_ago, hours=2)
        order = Order(
            order_no=f"CM{created:%Y%m%d%H%M%S}{idx + 1:04d}",
            product_id=p.id,
            buyer_id=users[buyer].id,
            seller_id=p.seller_id,
            price=p.price,
            product_snapshot=snapshot(p),
            status=status,
            trade_note=note,
            meet_place_id=places[place].id,
            buyer_lng=round(BASE_LNG + buyer_off[0], 7),
            buyer_lat=round(BASE_LAT + buyer_off[1], 7),
            seller_lng=round(BASE_LNG + seller_off[0], 7),
            seller_lat=round(BASE_LAT + seller_off[1], 7),
            created_at=created,
            finished_at=created + timedelta(hours=6) if status == "done" else None,
        )
        db.session.add(order)
        db.session.flush()
        orders[idx + 1] = order

    # ---- 评价 ----
    for order_idx, reviewer, reviewee, rating, content in REVIEWS:
        order = orders[order_idx]
        db.session.add(Review(
            order_id=order.id, product_id=order.product_id,
            reviewer_id=users[reviewer].id, reviewee_id=users[reviewee].id,
            rating=rating, content=content,
            created_at=(order.finished_at or order.created_at) + timedelta(hours=1),
        ))

    # ---- 收藏 ----
    for username, pname in FAVORITES:
        db.session.add(Favorite(user_id=users[username].id, product_id=products[pname].id))

    # ---- 帖子 / 评论 / 点赞 ----
    posts = []
    for idx, (author, tag, title, content) in enumerate(POSTS):
        post = Post(
            author_id=users[author].id, title=title, content=content, tag=tag,
            created_at=now - timedelta(days=len(POSTS) - idx, hours=idx * 3),
        )
        db.session.add(post)
        db.session.flush()
        posts.append(post)
    for post_idx, author, content in COMMENTS:
        db.session.add(PostComment(
            post_id=posts[post_idx].id, author_id=users[author].id, content=content,
        ))
    for post_idx, username in LIKES:
        db.session.add(PostLike(post_id=posts[post_idx].id, user_id=users[username].id))

    # ---- 举报 ----
    for target_type, target_name, reporter, reason in REPORTS:
        kwargs = {"reporter_id": users[reporter].id, "reason": reason, "status": "pending"}
        if target_type == "product":
            kwargs["product_id"] = products[target_name].id
        else:
            kwargs["post_id"] = next(p.id for p in posts if p.title == target_name)
        db.session.add(Report(**kwargs))

    # ---- 以物换物 ----
    for username, pname, title, estimate in SWAPS:
        db.session.add(SwapOffer(
            user_id=users[username].id, product_id=products[pname].id,
            title=title, estimate_price=estimate, status="open",
        ))

    db.session.commit()

    # 商品编号是 NOT NULL 且由「发布接口」生成，种子数据是直接插库的，所以这里
    # 必须补一次回填（同时把大类字母码、小类序号、卖家码、订单快照一并补上）。
    # 不回填的话：INSERT 会因为 product_code 为 NULL 而失败，示例数据整体灌不进去。
    from tools.backfill_product_code import run as backfill_codes

    backfill_codes(verbose=False)

    stats = {
        "users": User.query.count(),
        "categories": Category.query.count(),
        "subcategories": Subcategory.query.count(),
        "campus_places": CampusPlace.query.count(),
        "products": Product.query.count(),
        "products_on_sale": Product.query.filter_by(status="on_sale").count(),
        "orders": Order.query.count(),
        "reviews": Review.query.count(),
        "favorites": Favorite.query.count(),
        "posts": Post.query.count(),
        "comments": PostComment.query.count(),
        "likes": PostLike.query.count(),
        "reports": Report.query.count(),
        "swaps": SwapOffer.query.count(),
    }
    return stats


def snapshot(product: Product) -> dict:
    """下单时冻结商品信息，商品被删除后订单仍可完整显示。"""
    return {
        "id": product.id,
        "name": product.name,
        "price": float(product.price),
        "condition": product.condition,
        "cover": product.images[0].url if product.images else None,
        "category_name": product.category.name if product.category else None,
        "category_icon": product.category.icon if product.category else "",
        "subcategory_name": product.subcategory.name if product.subcategory else None,
        "seller_nickname": product.seller.nickname if product.seller else None,
    }


if __name__ == "__main__":
    from app import create_app

    application = create_app()
    with application.app_context():
        result = seed_all(reset=True)
        print("示例数据写入完成：")
        for key, value in result.items():
            print(f"  {key:<20} {value}")

def seed_extra_products() -> dict:
    """把 PRODUCTS 里**数据库还没有的**商品补进去（按名称判重，幂等）。

    给"演示数据加量"用：不重置、不动已有数据；已有商品一件都不碰。
    """
    import product_code as pc

    from extensions import db
    from models import CampusPlace, Category, Product, Subcategory, User

    users = {u.username: u for u in User.query.all()}
    cats = {c.name: c for c in Category.query.all()}
    cat_by_id = {c.id: c for c in cats.values()}
    subs = {}
    for sub in Subcategory.query.all():
        cat = cat_by_id.get(sub.category_id)
        if cat is not None:
            subs[(cat.name, sub.name)] = sub
    places = {p.name: p for p in CampusPlace.query.all()}
    existing = {p.name for p in Product.query.all()}

    created = 0
    base_time = datetime.now() - timedelta(days=45)
    for idx, (seller, cat, sub, name, price, cond, status, views, place, desc) in enumerate(PRODUCTS):
        if name in existing:
            continue
        p = Product(
            seller_id=users[seller].id,
            category_id=cats[cat].id,
            subcategory_id=subs[(cat, sub)].id,
            name=name, price=price, condition=cond, status=status, views=views,
            description=desc, default_place_id=places[place].id,
            created_at=base_time + timedelta(days=idx, hours=idx * 2),
            updated_at=base_time + timedelta(days=idx, hours=idx * 2),
        )
        # product_code 是 NOT NULL，必须在 add/flush 之前算好（与 seed_all 保持一致）
        p.product_code = pc.assign_for(users[seller], p)
        db.session.add(p)
        db.session.flush()
        existing.add(name)
        created += 1
    db.session.commit()
    return {"created": created, "total": Product.query.count()}
