"""competitors/ 조사 결과(JSON·MD)를 공유용 HTML 4개로 만든다. PDF 인쇄와 final/ 복사는 final.sh가 한다.

1. 쿠핀 경쟁사 조사          ← plus.json, on.json
2. 경쟁사 광고 조회          ← tracking/ads.md + ads.json(출처) + 캡처
3. 경쟁사 분석 툴 조사       ← tracking/listening.md + listening.json(출처) + 캡처
4. 경쟁사 정보 수집 법적 검토 ← tracking/legal.md + legal.json(방식별 상세·출처)
"""
from __future__ import annotations

import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "reports"
TRACK = ROOT / "tracking"

# acquisition-cases/doc_common.py와 같은 톤의 스타일
CSS = """
@page{size:A4;margin:13mm 13mm}
body{font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#111827;font-size:11.3px;line-height:1.55;margin:0}
header{border-bottom:3px solid #111827;padding-bottom:8px;margin-bottom:10px}.eyebrow{font-size:10.5px;color:#6b7280;letter-spacing:.04em}
h1{font-size:22px;margin:2px 0 4px}h2{font-size:15px;margin:16px 0 6px;break-after:avoid}h3{font-size:12px;margin:10px 0 4px;break-after:avoid}
.lead{margin:0;color:#374151}.muted{color:#6b7280}code{font-size:10px;background:#f3f4f6;padding:0 3px;border-radius:3px}
.answer{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:4px 14px 6px;margin-bottom:6px}.answer li{margin:3px 0}
table{width:100%;border-collapse:collapse;margin:4px 0 8px}th,td{border:1px solid #e5e7eb;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-size:10.5px}
tr{break-inside:avoid}thead{display:table-header-group}
blockquote{margin:6px 0;background:#fff7ed;border-left:3px solid #f59e0b;padding:4px 10px}
.note{background:#f9fafb;border-left:3px solid #9ca3af;padding:4px 8px;margin:6px 0}
.tag{font-size:9.8px;background:#e0e7ff;color:#3730a3;border-radius:999px;padding:0 6px;white-space:nowrap}
.tag.in{background:#fef3c7;color:#92400e}
sup a{color:#2563eb;text-decoration:none;font-size:9px}
ol.src{font-size:9.6px;color:#374151;padding-left:22px}ol.src li{margin:2px 0;break-inside:avoid}ol.src q{color:#6b7280}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:8px}.shots figure{margin:0;border:1px solid #e5e7eb;border-radius:6px;padding:4px;break-inside:avoid}
.shots img{width:100%;max-height:260px;object-fit:cover;object-position:top}.shots figcaption{font-size:9.8px;color:#6b7280}
"""


def esc(v: object) -> str:
    return html.escape("" if v is None else str(v))


# ---------- 출처 번호 ----------
class Sources:
    """URL 하나에 번호 하나. 같은 URL의 인용은 모아서 출처 목록에 보여 준다."""

    def __init__(self) -> None:
        self.ids: dict[str, int] = {}
        self.quotes: dict[str, list[str]] = {}

    def cite(self, url: str, quote: str | None = None) -> int:
        n = self.ids.setdefault(url, len(self.ids) + 1)
        if quote and quote not in self.quotes.setdefault(url, []):
            self.quotes[url].append(quote)
        return n

    def sup(self, evidence: list[dict]) -> str:
        nums = sorted({self.cite(e["url"], e.get("quote")) for e in evidence if e.get("url")})
        return "".join(f'<sup><a href="#s{n}">[{n}]</a></sup>' for n in nums)

    def html(self) -> str:
        items = []
        for url, n in sorted(self.ids.items(), key=lambda x: x[1]):
            qs = self.quotes.get(url, [])[:3]
            qhtml = "".join(f"<br><q>{esc(q[:220])}</q>" for q in qs)
            items.append(f'<li id="s{n}" value="{n}"><a href="{esc(url)}">{esc(url)}</a>{qhtml}</li>')
        return f'<h2>출처</h2><p class="muted">각 출처 아래 인용은 조사 때 원문에서 그대로 옮긴 문장입니다(출처당 최대 3개).</p><ol class="src">{"".join(items)}</ol>'


# ---------- 작은 마크다운 변환기 (tracking/*.md가 쓰는 문법만) ----------
def inline(s: str) -> str:
    s = esc(s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    return s


def md_to_html(md: str, drop_title: bool = True) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    list_stack: list[tuple[int, str]] = []  # (indent, tag)

    def close_lists(to_indent: int = -1) -> None:
        while list_stack and list_stack[-1][0] > to_indent:
            out.append(f"</{list_stack.pop()[1]}>")

    while i < len(lines):
        line = lines[i]
        if drop_title and line.startswith("# "):
            i += 1
            continue
        if not line.strip():
            close_lists()
            i += 1
            continue
        if line.startswith("|"):
            close_lists()
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], [r for r in rows[1:] if not re.fullmatch(r"[-: ]*", "".join(r))]
            th = "".join(f"<th>{inline(c)}</th>" for c in head)
            tb = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{tb}</tbody></table>")
            continue
        m = re.match(r"(#{2,4}) (.*)", line)
        if m:
            close_lists()
            lvl = min(len(m.group(1)), 3)
            out.append(f"<h{lvl}>{inline(m.group(2))}</h{lvl}>")
            i += 1
            continue
        if line.startswith("> "):
            close_lists()
            out.append(f"<blockquote>{inline(line[2:])}</blockquote>")
            i += 1
            continue
        m = re.match(r"( *)([-*]|\d+\.) (.*)", line)
        if m:
            indent, tag = len(m.group(1)), ("ol" if m.group(2)[0].isdigit() else "ul")
            if not list_stack or indent > list_stack[-1][0]:
                out.append(f"<{tag}>")
                list_stack.append((indent, tag))
            else:
                close_lists(indent)
                if not list_stack or list_stack[-1][0] < indent:
                    out.append(f"<{tag}>")
                    list_stack.append((indent, tag))
            out.append(f"<li>{inline(m.group(3))}</li>")
            i += 1
            continue
        if list_stack and line.startswith(" "):  # 목록 항목의 이어지는 줄
            out[-1] = out[-1][:-5] + " " + inline(line.strip()) + "</li>"
            i += 1
            continue
        close_lists()
        out.append(f"<p>{inline(line)}</p>")
        i += 1
    close_lists()
    return "\n".join(out)


def page(title: str, eyebrow: str, lead: str, body: str) -> str:
    return (
        f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{esc(title)}</title><style>{CSS}</style></head><body>'
        f'<header><div class="eyebrow">{esc(eyebrow)}</div><h1>{esc(title)}</h1><p class="lead">{lead}</p></header>{body}</body></html>'
    )


def shots(items: list[tuple[str, str]]) -> str:
    figs = "".join(
        f'<figure><img src="../tracking/shots/{esc(p)}"><figcaption>{esc(cap)}</figcaption></figure>'
        for p, cap in items
        if (TRACK / "shots" / p).exists()
    )
    return f'<div class="shots">{figs}</div>'


# ---------- 1. 경쟁사 목록 ----------
def strip_urls(s: str) -> str:
    """본문 문장 안의 URL은 빼고(출처 목록이 따로 있음) 남은 괄호·콜론을 정리한다."""
    s = re.sub(r"\(?https?://[^\s)]+\)?", "", s)
    return re.sub(r"\s*[:;]\s*$", "", s).replace("( ;", "(").replace(" )", ")").strip()


def competitor_section(d: dict, src: Sources, label: str) -> str:
    core = {c["name"]: c["reason"] for c in d["core"]}
    rows = []
    for c in sorted(d["competitors"], key=lambda c: (c["name"] not in core, c["type"] != "직접")):
        ev = c["evidence"]
        typ = f'<span class="tag{" in" if c["type"] == "간접" else ""}">{esc(c["type"])}</span>'
        star = " ★" if c["name"] in core else ""
        scale = esc(c["scale"]) + (f' <span class="muted">({esc(c["scale_source"])})</span>' if c.get("scale_source") else "") if c.get("scale") else '<span class="muted">공개 근거 없음</span>'
        pricing = esc(c["pricing"]) if c.get("pricing") else '<span class="muted">공개 근거 없음</span>'
        rows.append(
            f"<tr><td><b>{esc(c['name'])}</b>{star}<br>{typ} <span class='muted'>{esc(c['company'])}</span></td>"
            f"<td>{esc(c['what_it_does'])}{src.sup(ev)}</td><td>{esc(c['overlap'])}<br><span class='muted'>다른 점: {esc(c['difference'])}</span></td>"
            f"<td>{pricing}</td><td>{scale}</td></tr>"
        )
    core_li = "".join(f"<li><b>{esc(n)}</b> — {esc(r)}</li>" for n, r in core.items())
    excl = "".join(f"<li><b>{esc(e['name'])}</b> — {esc(strip_urls(e['reason']))}</li>" for e in d.get("excluded", []))
    return (
        f"<h2>{label} 경쟁사 {len(d['competitors'])}곳</h2>"
        f"<h3>우선 추적할 핵심 {len(core)}곳 (★)</h3><ul>{core_li}</ul>"
        "<table><thead><tr><th style='width:17%'>서비스</th><th style='width:27%'>하는 일</th><th style='width:28%'>쿠핀과 겹치는 점</th><th>요금</th><th style='width:13%'>규모</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table>"
        + (f"<h3>목록에서 뺀 서비스</h3><ul>{excl}</ul>" if excl else "")
    )


def build_competitors() -> str:
    plus = json.loads((ROOT / "plus.json").read_text())
    on = json.loads((ROOT / "on.json").read_text())
    src = Sources()
    mn = plus.get("meeting_names", {})
    meet = "".join(
        f"<li><b>{esc(k)}</b> → {esc(v.get('official_name'))}"
        + (f" ({esc(v['company'])})" if v.get("company") else "")
        + (src.sup([{"url": v["evidence_url"]}]) if v.get("evidence_url") else "")
        + "</li>"
        for k, v in mn.items()
    )
    summary = (
        '<div class="answer"><ul>'
        f"<li><b>쿠핀 PLUS</b>(사장님용) 핵심 경쟁사: {esc(', '.join(c['name'] for c in plus['core']))}</li>"
        f"<li><b>쿠핀 ON</b>(소비자용) 핵심 경쟁사: {esc(', '.join(c['name'] for c in on['core']))}</li>"
        "<li>회의에서 나온 기프티쇼 비즈·기프티업은 실제 서비스지만, 동네 가게가 직접 쿠폰을 보내는 쿠핀 PLUS와는 결이 달라 <b>간접 경쟁</b>으로 분류했습니다.</li>"
        "<li>ON 쪽 동네방네는 '결제한 할인을 QR 쿠폰으로 보관해 한 달 동안 쓰는' 구조를 웹에서 안내하고 있어 핵심 재검토 후보입니다(실제 앱 제공 여부는 미확인).</li>"
        "</ul></div>"
    )
    notes = "".join(f"<li>{esc(strip_urls(n))}</li>" for n in plus["notes"] + on["notes"])
    body = (
        summary
        + f"<h2>회의에서 나온 이름 확인</h2><ul>{meet}</ul>"
        + competitor_section(plus, src, "쿠핀 PLUS")
        + competitor_section(on, src, "쿠핀 ON")
        + f"<h2>조사 범위와 한계</h2><ul>{notes}</ul>"
        + src.html()
    )
    lead = (
        "쿠핀 PLUS(소상공인이 손님에게 쿠폰을 보내는 SaaS)와 쿠핀 ON(소비자가 동네 매장 쿠폰을 찾아 받거나 사는 앱)의 국내 경쟁 서비스입니다. "
        f"조사일 {esc(plus['checked_at'])}, 공식 사이트·약관·앱 마켓·언론 원문 기준. 회사가 스스로 밝힌 수치는 '회사 발표'로 표시했습니다."
    )
    return page("쿠핀 PLUS·ON 경쟁사 조사", "알에스팀 마케팅 봇 · 경쟁사 역추적 준비", lead, body)


# ---------- 2~4. tracking 문서 ----------
def tool_sources(tools: list[dict], src: Sources) -> str:
    """툴마다 근거 출처 번호를 붙인 짧은 표. 본문(MD)에는 번호가 없어서 여기서 이어 준다."""
    rows = "".join(f"<tr><td>{esc(t['tool'])}</td><td>{src.sup(t.get('evidence', []))}</td></tr>" for t in tools)
    return f"<h2>툴별 근거 출처</h2><table><thead><tr><th style='width:40%'>툴</th><th>출처 번호</th></tr></thead><tbody>{rows}</tbody></table>"


def build_ads() -> str:
    d = json.loads((TRACK / "ads.json").read_text())
    src = Sources()
    body = md_to_html((TRACK / "ads.md").read_text())
    body += tool_sources(d["tools"], src)
    body += "<h2>조회 화면 (일부)</h2>" + shots([
        ("ads/meta-페이히어.png", "Meta 광고 라이브러리 — 페이히어 (게재 중 약 50개)"),
        ("ads/google-토스포스쿠폰.png", "Google 광고 투명성 센터 — 토스플레이스 (33개)"),
        ("ads/meta-당근-당근비즈니스.png", "Meta — 당근비즈니스 (개업 패키지 광고)"),
        ("ads/google-도도포인트-domain.png", "Google — dodopoint.co.kr 도메인 검색 ((주) 디플랜 360)"),
    ])
    body += '<p class="muted">전체 캡처 41장은 저장소 <code>competitors/tracking/shots/ads/</code>에 있습니다.</p>' + src.html()
    lead = "Meta 광고 라이브러리와 Google 광고 투명성 센터에서 쿠핀 핵심 경쟁사 10곳을 직접 조회한 결과입니다. 조회일 2026-11-27, 로그인 없이 화면에 보인 값만 옮겼습니다."
    return page("경쟁사 광고 조회 결과", "알에스팀 마케팅 봇 · 경쟁사 역추적", lead, body)


def build_listening() -> str:
    d = json.loads((TRACK / "listening.json").read_text())
    src = Sources()
    md = (TRACK / "listening.md").read_text()
    body = md_to_html(md)
    body += tool_sources(d["tools"], src)
    body += "<h2>조회 화면 (일부)</h2>" + shots([
        ("listening/sometrend-토스플레이스.png", "썸트렌드 — 토스플레이스 7일 언급량"),
        ("listening/sometrend-단골톡.png", "썸트렌드 — 단골톡 (언급 없음)"),
        ("listening/naver-datalab-plus.png", "네이버 데이터랩 — PLUS 경쟁사 검색 추이"),
        ("listening/similarweb-payhere.in.png", "Similarweb — 차단 화면"),
    ])
    body += '<p class="muted">전체 캡처 22장은 저장소 <code>competitors/tracking/shots/listening/</code>에 있습니다.</p>' + src.html()
    lead = "경쟁사가 어디서 얼마나 언급되는지, 광고비를 얼마나 쓰는지 알려 주는 기존 툴 11개를 공식 문서로 확인하고, 로그인 없이 되는 범위에서 경쟁사를 직접 조회했습니다. 조회일 2026-11-27."
    return page("경쟁사 언급·광고 분석 툴 조사", "알에스팀 마케팅 봇 · 경쟁사 역추적", lead, body)


def build_legal() -> str:
    d = json.loads((TRACK / "legal.json").read_text())
    src = Sources()
    md = (TRACK / "legal.md").read_text()
    body = md_to_html(md)
    detail = []
    for m in d["methods"]:
        conds = "".join(f"<li>{esc(c)}</li>" for c in m["safe_conditions"])
        detail.append(
            f"<h3>{esc(m['id'])}. {esc(m['method'])} <span class='tag{' in' if m['risk'] != '낮음' else ''}'>위험 {esc(m['risk'])}</span></h3>"
            f"<p>{esc(m['why'])}{src.sup(m['evidence'])}</p><ul>{conds}</ul>"
        )
    body += "<h2>방식별 상세 근거</h2>" + "".join(detail) + src.html()
    lead = f"경쟁사 광고·언급을 모으는 방식별로 법·판례·플랫폼 약관상 제약을 정리했습니다. {esc(d['disclaimer'])}"
    return page("경쟁사 정보 수집 법적 검토", "알에스팀 마케팅 봇 · 경쟁사 역추적", lead, body)


DOCS = {
    "competitors": build_competitors,
    "ads": build_ads,
    "listening": build_listening,
    "legal": build_legal,
}

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, fn in DOCS.items():
        html_text = fn()
        left = re.findall(r"\{\{|\{c\(", html_text)
        cited = set(re.findall(r'href="#s(\d+)"', html_text))
        listed = set(re.findall(r'<li id="s(\d+)"', html_text))
        (OUT / f"{name}.html").write_text(html_text)
        print(f"{name}.html  cited={len(cited)} listed={len(listed)} uncited={len(listed - cited)} dangling={len(cited - listed)} placeholders={len(left)}")
