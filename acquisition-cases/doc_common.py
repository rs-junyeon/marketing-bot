"""요약본(국내 기업 요약·마케팅 기본 개념)이 함께 쓰는 경로·스타일·헬퍼."""
from __future__ import annotations

import html
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SEGMENTS = [
    ("소상공인 SaaS", "사장님이 쓰는 매장 도구(POS·결제·CRM·쿠폰)"),
    ("양면 플랫폼", "플랫폼이 매장·판매자(공급)를 모은 방식"),
    ("B2C 앱", "소비자 앱이 이용자를 모은 방식"),
    ("B2B SaaS", "기업·사업자 대상 소프트웨어"),
]

# (서비스, 무엇이 주 채널이었나, 수치, 출처 종류)

CSS = """
    @page{size:A4;margin:13mm 13mm}
    body{font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#111827;font-size:11.3px;line-height:1.5;margin:0}
    header{border-bottom:3px solid #111827;padding-bottom:8px;margin-bottom:10px}.eyebrow{font-size:10.5px;color:#6b7280;letter-spacing:.04em}
    h1{font-size:23px;margin:2px 0 4px}h2{font-size:15px;margin:16px 0 6px;break-after:avoid}h3{font-size:11.5px;margin:0 0 4px}
    .lead{margin:0;color:#374151}.muted{color:#6b7280}code{font-size:10px;background:#f3f4f6;padding:0 3px;border-radius:3px}
    .answer{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:4px 14px 6px}.answer h2{margin-top:8px}.answer li{margin:4px 0}
    table{width:100%;border-collapse:collapse;margin:4px 0 6px}th,td{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-size:10.5px}
    tr{break-inside:avoid}
    .grid4{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}.grid4>div{border:1px solid #e5e7eb;border-radius:8px;padding:6px 8px;break-inside:avoid}
    table.bars{margin:0}table.bars td{border:none;padding:1px 4px;font-size:10.5px}table.bars td.lbl{width:46%;color:#374151}
    .bar{display:inline-block;height:9px;border-radius:2px;vertical-align:middle}
    .note{background:#f9fafb;border-left:3px solid #9ca3af;padding:4px 8px;margin:6px 0}
    .tag{font-size:10px;background:#fef3c7;color:#92400e;border-radius:999px;padding:1px 7px;vertical-align:middle}
    ol.take li{margin:4px 0}.foot{font-size:9.8px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:6px;margin-top:12px}
"""


def esc(v: object) -> str:
    return html.escape(str(v))


def bars(counter: Counter, top: int = 6, color: str = "#2563eb") -> str:
    items = counter.most_common(top)
    mx = items[0][1] if items else 1
    rows = "".join(
        f'<tr><td class="lbl">{esc(k)}</td><td><span class="bar" style="width:{int(120 * v / mx)}px;background:{color}"></span> <b>{v}</b></td></tr>'
        for k, v in items
    )
    return f'<table class="bars">{rows}</table>'
