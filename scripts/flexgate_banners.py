
# -*- coding: utf-8 -*-
"""生成 FlexGate 宣传图（1920x520）。视觉取自插件内的 2170x60 精炼长条。"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1920, 520
FONT_CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_MONO = "/System/Library/Fonts/Menlo.ttc"
F_MONO = ImageFont.truetype(FONT_MONO, 20, index=0)
F_MONO_B = ImageFont.truetype(FONT_MONO, 20, index=1)

def cjk(size, weight=6):
    return ImageFont.truetype(FONT_CJK, size, index=2 if weight == 6 else 0)

BG_TOP = (10, 14, 12)
BG_BOT = (17, 22, 18)
FG = (237, 242, 236)
MUTED = (141, 155, 144)
GREEN = (180, 233, 197)
LIME = (215, 249, 121)
AMBER = (237, 193, 132)
RED = (240, 147, 133)
DIV = (43, 54, 46)
STRIP_BG = (16, 21, 18)
CARD_BG = (19, 25, 21)
CARD_EDGE = (45, 58, 48)

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def base_canvas(glow=(1.0, 0.15, 0.16), strength=26):
    img = Image.new("RGB", (W, H), BG_TOP)
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(BG_TOP, BG_BOT, y / (H - 1)))
    glow_img = Image.new("L", (W // 4, H // 4), 0)
    gd = ImageDraw.Draw(glow_img)
    gx, gy, gr = int(W * glow[0] / 4), int(H * glow[1] / 4), int(W * glow[2] / 4)
    for i in range(gr, 0, -3):
        gd.ellipse([gx - i, gy - i * 0.5, gx + i, gy + i * 0.5],
                   fill=int(strength * (1 - i / gr) ** 2))
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(34)).resize((W, H), Image.LANCZOS)
    tint = Image.new("RGB", (W, H), (56, 118, 84))
    mask = glow_img.point(lambda v: min(255, int(v * 1.7)))
    return Image.composite(tint, img, mask)

def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def text(d, xy, s, font, fill, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)

def chip(d, xy, s, font, fg=GREEN, border=(70, 92, 78)):
    x, y = xy
    tw = d.textlength(s, font=font)
    w = tw + 34
    rrect(d, [x, y, x + w, y + 34], 17, fill=CARD_BG, outline=border)
    text(d, (x + 17, y + 16), s, font, fg, "lm")
    return w

MODEL = {
    "name": "X1 Carbon", "connection": "云端在线",
    "task": "Benchy 小船", "activity": "打印中",
    "layer": "47", "total": "88", "progress": "62", "remaining": "1h 12m",
    "nozzle": "214", "nozzle_t": "220", "bed": "60", "bed_t": "60",
    "fans": [("风扇 1", "40%"), ("风扇 2", "0%")],
    "slots": [
        {"id": "1:0", "exists": "有料", "color": "#F2C94C", "material": "PLA", "remaining": "68%"},
        {"id": "1:1", "exists": "有料", "color": "#4A8FE7", "material": "PETG", "remaining": "41%"},
        {"id": "1:2", "absent": True},
        {"id": "1:3", "exists": "有料", "color": "#E86A6A", "material": "ABS", "remaining": "82%"},
    ],
    "updated": "20:11:42", "fault": "无故障",
}

SEGMENTS = {"A": (0, 680), "B": (680, 1450), "C": (1450, 2170)}

def draw_strip(d, ox, oy, s, m):
    def R(x, y, w, h, c):
        d.rectangle([ox + x * s, oy + y * s, ox + (x + w) * s, oy + (y + h) * s], fill=c)
    def T(v, x, y, size, c, weight=6):
        f = cjk(max(6, int(round(size * s))), weight)
        d.text((ox + x * s, oy + y * s), v, font=f, fill=c, anchor="lm")
    def dot(x, y, c, r=2.5):
        d.ellipse([ox + (x - r) * s, oy + (y - r) * s, ox + (x + r) * s, oy + (y + r) * s], fill=c)
    def label(v, x):
        T(v, x, 14, 12, MUTED, 0)
    R(0, 0, 2170, 60, STRIP_BG)
    R(0, 0, 3, 60, GREEN)
    T(m["name"], 22, 18, 21, FG, 6)
    dot(25, 43, GREEN)
    T(m["connection"], 36, 43, 12, MUTED, 0)
    R(180, 13, 1, 34, DIV)
    label("当前任务", 202)
    T(m["task"], 282, 14, 14, FG, 5)
    T(m["activity"], 202, 40, 18, GREEN, 6)
    T(m["layer"], 312, 40, 17, FG, 5)
    T("/", 373, 40, 14, MUTED, 0)
    T(m["total"], 390, 40, 17, FG, 5)
    T("层", 461, 40, 12, MUTED, 0)
    R(490, 13, 1, 34, DIV)
    T(m["progress"], 512, 27, 39, GREEN, 6)
    T("%", 516 + 62, 33, 17, MUTED, 0)
    R(514, 53, 139, 2, DIV)
    R(514, 53, 139 * int(m["progress"]) / 100, 2, GREEN)
    R(680, 13, 1, 34, DIV)
    label("预计剩余", 704)
    T(m["remaining"], 704, 39, 26, FG, 5)
    R(870, 13, 1, 34, DIV)
    label("喷嘴 / 目标", 893)
    T(m["nozzle"], 893, 39, 26, FG, 5)
    T("/", 963, 40, 16, MUTED, 0)
    T(m["nozzle_t"], 978, 40, 16, FG, 5)
    label("热床 / 目标", 1080)
    T(m["bed"], 1080, 39, 26, FG, 5)
    T("/", 1136, 40, 16, MUTED, 0)
    T(m["bed_t"], 1151, 40, 16, FG, 5)
    R(1240, 13, 1, 34, DIV)
    for i, (lb, val) in enumerate(m["fans"]):
        x = 1262 + i * 94
        label(lb, x)
        T(val, x, 39, 20, FG, 5)
    R(1450, 13, 1, 34, DIV)
    label("AMS", 1472)
    for i, slot in enumerate(m["slots"]):
        x = 1472 + i * 122
        if slot.get("absent"):
            R(x, 28, 5, 22, DIV)
            T(slot["id"], x + 12, 28, 10, MUTED, 0)
            T("空", x + 68, 28, 10, MUTED, 0)
            T("—", x + 12, 46, 15, MUTED, 0)
        else:
            R(x, 28, 5, 22, slot["color"])
            T(slot["id"], x + 12, 28, 10, MUTED, 0)
            T(slot["exists"], x + 68, 28, 10, MUTED, 0)
            T(slot["material"], x + 12, 46, 14, FG, 5)
            T(slot["remaining"], x + 68, 46, 12, FG, 5)
    R(1980, 13, 1, 34, DIV)
    label("最近设备上报", 2002)
    T(m["updated"], 2002, 35, 17, MUTED, 5)
    T(m["fault"], 2002, 53, 10, MUTED, 0)

_FULL = {}

def strip_full(scale=3.0):
    key = round(scale, 3)
    if key in _FULL:
        return _FULL[key]
    img = Image.new("RGB", (int(2170 * scale), int(60 * scale)), STRIP_BG)
    draw_strip(ImageDraw.Draw(img), 0, 0, scale, MODEL)
    _FULL[key] = img
    return img

def paste_segment(img, seg, scale, xy):
    x0, x1 = SEGMENTS[seg]
    crop = strip_full(scale).crop((int(x0 * scale), 0, int(x1 * scale), int(60 * scale)))
    img.paste(crop, xy)
    return crop.size

def build_hero(out):
    img = base_canvas((0.92, 0.5, 0.3), 30)
    d = ImageDraw.Draw(img)
    px, py = 1596, 52
    mint = (44, 66, 54)
    d.rounded_rectangle([px, py + 34, px + 220, py + 196], radius=16, outline=mint, width=2)
    d.line([(px + 24, py + 88), (px + 196, py + 88)], fill=mint, width=2)
    d.rounded_rectangle([px + 38, py + 108, px + 182, py + 160], radius=6, outline=(58, 84, 66), width=2)
    d.ellipse([px + 78, py - 12, px + 142, py + 52], outline=(58, 84, 66), width=2)
    d.ellipse([px + 104, py + 14, px + 116, py + 26], fill=(58, 84, 66))
    for i in range(3):
        d.ellipse([px + 54 + i * 20, py + 174, px + 63 + i * 20, py + 183], fill=mint)
    text(d, (px + 110, py + 206), "Direct Draw · 2170 × 60", cjk(13, 0), (92, 112, 96), "ma")

    chip(d, (96, 62), "Flexbar 插件  ·  FlexDesigner 1.3.0+", cjk(19, 0))
    text(d, (96, 150), "Bambu Monitor", cjk(76), FG)
    text(d, (96, 246), "在 Flexbar 上监控 Bambu Lab 打印机的云端状态与打印进度", cjk(29, 0), MUTED)

    s = 0.82
    x0, y0 = 96, 316
    wpx, hpx = int(2170 * s), int(60 * s)
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rounded_rectangle([x0 - 7, y0 - 7, x0 + wpx + 7, y0 + hpx + 7], radius=16, fill=(120, 226, 170, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(11))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    rrect(d, [x0, y0, x0 + wpx, y0 + hpx], 10, outline=(52, 68, 55), width=2)
    paste_segment(img, "A", s, (x0, y0))
    paste_segment(img, "B", s, (x0 + int(SEGMENTS["A"][1] * s), y0))
    paste_segment(img, "C", s, (x0 + int(SEGMENTS["B"][1] * s), y0))
    d = ImageDraw.Draw(img)

    tags = ["云端直连", "断线不清零", "AMS 槽位", "旧值标记", "国区 / 全球"]
    tx = 96
    for t in tags:
        tw = d.textlength(t, font=cjk(15, 0))
        rrect(d, [tx, 400, tx + tw + 26, 430], 8, fill=(17, 23, 19), outline=(40, 52, 43))
        text(d, (tx + 13, 415), t, cjk(15, 0), (150, 168, 156), "lm")
        tx += tw + 26 + 14

    d.line([(96, 448), (1824, 448)], fill=(34, 44, 37), width=1)
    text(d, (96, 476), "只读监控  ·  云端直连  ·  国区 / 全球账号  ·  无需局域网 IP", cjk(20, 0), GREEN, "lm")
    text(d, (1824, 476), "v0.7.0", F_MONO, MUTED, "rm")
    img.save(os.path.join(out, "banner-01-hero.png"))

def build_detail(out):
    img = base_canvas((0.7, 0.9, 0.36), 22)
    d = ImageDraw.Draw(img)
    text(d, (96, 58), "一条长条，读出全部状态", cjk(46), FG)
    text(d, (96, 128), "石墨黑底 + 薄荷绿进度，按实际字宽截断；离线不清零，旧值逐项标记「旧」", cjk(21, 0), MUTED)

    rows = [
        ("A", 164, "设备 · 连接", ["自定义设备名始终占首段；", "云端连接与整机在线状态分开判定"]),
        ("B", 276, "任务 · 进度 · 温度", ["当前任务、层数、百分比与预计剩余；", "喷嘴与热床各自带目标值与小标题"]),
        ("C", 388, "风扇 · AMS · 上报", ["AMS 按实际机型上报槽位，空槽只显示「空」，", "不编造材质与余量；最近上报时间独立保留"]),
    ]
    strip_w = 1120
    for seg, y, title, descs in rows:
        x0, x1 = SEGMENTS[seg]
        scale = strip_w / (x1 - x0)
        hpx = int(60 * scale)
        rrect(d, [96, y, 96 + strip_w, y + hpx], 8, fill=(13, 17, 14), outline=(44, 56, 46), width=2)
        paste_segment(img, seg, scale, (96, y))
        d = ImageDraw.Draw(img)
        text(d, (1240, y + 20), title, cjk(20), GREEN, "lm")
        for j, line in enumerate(descs):
            text(d, (1240, y + 52 + j * 26), line, cjk(15, 0), MUTED, "lm")
    img.save(os.path.join(out, "banner-02-detail.png"))

def build_setup(out):
    img = base_canvas((0.12, 0.05, 0.36), 24)
    d = ImageDraw.Draw(img)
    text(d, (96, 60), "三步开始，不用填 IP", cjk(46), FG)
    text(d, (96, 132), "本机浏览器后台登录，只连接当前账号设备列表中已验证的那台打印机", cjk(21, 0), MUTED)

    steps = [
        ("01", "进入后台", "设置页点击「进入后台」，选择中国大陆或全球区域"),
        ("02", "完成登录", "本机浏览器登录并过验证码，令牌只进系统钥匙串"),
        ("03", "放进 Flexbar", "选中绑定打印机，把「打印机状态」按键拖到屏幕"),
    ]
    bx, by, bw, bh, gap = 96, 196, 548, 166, 36
    for i, (num, title, desc) in enumerate(steps):
        x = bx + i * (bw + gap)
        rrect(d, [x, by, x + bw, by + bh], 14, fill=CARD_BG, outline=CARD_EDGE, width=2)
        text(d, (x + 26, by + 36), num, F_MONO_B, LIME, "la")
        text(d, (x + 76, by + 42), title, cjk(27), FG, "lm")
        text(d, (x + 26, by + 104), desc, cjk(18, 0), MUTED)
        if i < 2:
            ax = x + bw + 9
            d.line([(ax, by + bh / 2), (ax + 16, by + bh / 2)], fill=(78, 102, 85), width=2)
            d.polygon([(ax + 16, by + bh / 2 - 5), (ax + 16, by + bh / 2 + 5), (ax + 26, by + bh / 2)], fill=(78, 102, 85))

    rrect(d, [96, 396, 1824, 452], 12, fill=(22, 30, 23), outline=(74, 100, 80), width=1)
    text(d, (116, 424), "无需局域网 IP   ·   无需设备接入码   ·   只读：不提供暂停、停止、调温与耗材操作", cjk(20), GREEN, "lm")
    text(d, (1804, 424), "FlexGate GET 一键安装", cjk(17, 0), LIME, "rm")
    text(d, (96, 484), "本机后台仅监听 127.0.0.1，API 使用随机令牌；日志与诊断信息脱敏", cjk(15, 0), MUTED, "lm")
    img.save(os.path.join(out, "banner-03-setup.png"))

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "docs", "flexgate")
os.makedirs(out, exist_ok=True)
build_hero(out)
build_detail(out)
build_setup(out)
print("ok")
