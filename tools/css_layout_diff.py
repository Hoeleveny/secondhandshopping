"""严格比对 app.css 新旧版本的「布局类声明」，用于验证「布局零改动」。

布局类属性只要有一处不同就报出来；颜色/字体/圆角/阴影/内边距等视觉属性不管。

用法： .venv\\Scripts\\python.exe _build_tmp\\css_layout_diff.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NEW_FILE = ROOT / "static" / "css" / "app.css"

LAYOUT_PROPS = {
    "display", "position", "top", "right", "bottom", "left", "inset", "z-index",
    "float", "clear", "box-sizing",
    "width", "height", "min-width", "max-width", "min-height", "max-height",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-direction", "flex-wrap", "order",
    "grid", "grid-template-columns", "grid-template-rows", "grid-template-areas",
    "grid-column", "grid-row", "grid-area", "grid-auto-flow",
    "gap", "row-gap", "column-gap",
    "align-items", "align-content", "align-self",
    "justify-content", "justify-items", "justify-self",
    "overflow", "overflow-x", "overflow-y",
}

# 「视觉」属性里，这几个虽然不属于布局，但会改变元素几何尺寸，单独留意
GEOMETRY_VISUAL = {"padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
                   "border", "border-width", "border-top", "border-bottom", "border-left", "border-right"}


def parse(css_text: str) -> dict[str, dict[str, str]]:
    """返回 {选择器: {属性: 值}}；只保留最外层规则，忽略 @media 内部（另行处理）。"""
    css_text = re.sub(r"/\*.*?\*/", "", css_text, flags=re.S)
    blocks: dict[str, dict[str, str]] = {}

    def walk(text: str, prefix: str = ""):
        i = 0
        while i < len(text):
            brace = text.find("{", i)
            if brace == -1:
                break
            selector = text[i:brace].strip()
            # 找到配对的右括号
            depth, j = 1, brace + 1
            while j < len(text) and depth:
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                j += 1
            body = text[brace + 1:j - 1]
            if selector.startswith("@"):
                walk(body, prefix + selector + " >> ")
            else:
                key = prefix + " ".join(selector.split())
                decls = {}
                for part in body.split(";"):
                    if ":" in part:
                        prop, _, val = part.partition(":")
                        decls[prop.strip().lower()] = " ".join(val.split())
                blocks.setdefault(key, {}).update(decls)
            i = j

    walk(css_text)
    return blocks


def layout_of(decls: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in decls.items() if k in LAYOUT_PROPS}


def main() -> int:
    old_text = subprocess.run(
        ["git", "show", "HEAD:static/css/app.css"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout
    new_text = NEW_FILE.read_text(encoding="utf-8")

    old, new = parse(old_text), parse(new_text)

    missing = sorted(set(old) - set(new))
    added = sorted(set(new) - set(old))
    changed = []
    for sel in sorted(set(old) & set(new)):
        o, n = layout_of(old[sel]), layout_of(new[sel])
        for prop in sorted(set(o) | set(n)):
            if o.get(prop) != n.get(prop):
                changed.append((sel, prop, o.get(prop), n.get(prop)))

    print(f"选择器：旧 {len(old)} 个 / 新 {len(new)} 个")
    print(f"\n【消失的选择器】{len(missing)} 个")
    for s in missing:
        print(f"  - {s}")
    print(f"\n【新增的选择器】{len(added)} 个")
    for s in added:
        print(f"  + {s}")

    print(f"\n【布局声明差异】{len(changed)} 处")
    for sel, prop, ov, nv in changed:
        print(f"  * {sel} 的 {prop}: {ov!r} -> {nv!r}")

    # 顺带列出会改变几何的视觉属性差异（padding / border），供人工确认
    geo = []
    for sel in sorted(set(old) & set(new)):
        for prop in sorted(GEOMETRY_VISUAL):
            o, n = old[sel].get(prop), new[sel].get(prop)
            if o != n and (o or n):
                geo.append((sel, prop, o, n))
    print(f"\n【会改变几何的视觉属性差异（内边距/边框，规则允许）】{len(geo)} 处")
    for sel, prop, o, n in geo:
        print(f"  · {sel} 的 {prop}: {o!r} -> {n!r}")

    print("\n结论：" + ("布局声明完全一致 ✓" if not changed and not missing and not added
                     else "存在差异，见上方清单"))
    return 0 if not changed and not missing and not added else 1


if __name__ == "__main__":
    sys.exit(main())
