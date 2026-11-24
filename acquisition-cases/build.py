"""acquisition-cases 생성기.

data/*.json(조사 묶음별 원자료) + data/insights.json(종합 해석)을 읽어
  - cases.json   : 합친 데이터 (출처 번호 포함)
  - index.html   : 보기 편한 한 페이지 (필터·검색, 인쇄 시 PDF 레이아웃)
  - README.md    : GitHub에서 바로 읽는 요약
을 만든다. PDF는 index.html을 Chrome headless로 인쇄한다(README 참고).

사용: python3 build.py
"""
from __future__ import annotations

import html
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

CHANNEL_TYPES = [
    "입소문·추천", "직접 영업", "대리점·리셀러·파트너", "제휴·번들", "검색 광고", "SNS·디지털 광고",
    "TV·옥외 등 매스 광고", "콘텐츠·SEO", "커뮤니티", "무료 플랜·무료 제공", "제품 내 바이럴", "교육·이벤트",
    "오프라인 홍보", "공공·지원사업", "리워드·프로모션", "앱마켓·플랫폼 노출", "PR·언론", "기존 사용자 기반",
]
RELIABILITY = {
    "filing": "공시", "survey": "설문·통계", "third_party": "제3자", "interview": "인터뷰",
    "company_claim": "회사 발표", "hypothesis": "추정",
}
CASE_ALIASES = {"하이오더": "kt하이오더"}
FRESHNESS = {
    "updated": ("최신판 있음", "#dcfce7", "#166534"), "covered": ("더 최신 자료 있음", "#dcfce7", "#166534"),
    "no_newer": ("최신판 없음", "#fef3c7", "#92400e"), "historical": ("과거 시점 수치", "#f3f4f6", "#374151"),
    "one_off": ("단발 연구", "#f3f4f6", "#374151"),
}
REFRESH_GROUP_PREFIX = "최신 자료 보강"
SEGMENT_ORDER = ["소상공인 SaaS", "양면 플랫폼", "B2C 앱", "B2B SaaS", "통계"]


def esc(value: object) -> str:
    return html.escape(str(value or ""))


def norm_channel(value: str) -> str:
    """조사 묶음마다 표기가 조금씩 다르므로 정해진 유형으로 맞춘다."""
    v = (value or "").replace(" ", "")
    for t in CHANNEL_TYPES:
        if t.replace(" ", "") == v:
            return t
    aliases = {
        "대리점": "대리점·리셀러·파트너", "파트너": "대리점·리셀러·파트너", "리셀러": "대리점·리셀러·파트너",
        "입소문": "입소문·추천", "추천": "입소문·추천", "영업": "직접 영업", "무료": "무료 플랜·무료 제공",
        "SNS": "SNS·디지털 광고", "디지털광고": "SNS·디지털 광고", "검색": "검색 광고", "TV": "TV·옥외 등 매스 광고",
        "콘텐츠": "콘텐츠·SEO", "SEO": "콘텐츠·SEO", "커뮤니티": "커뮤니티", "제휴": "제휴·번들", "번들": "제휴·번들",
        "바이럴": "제품 내 바이럴", "교육": "교육·이벤트", "오프라인": "오프라인 홍보", "공공": "공공·지원사업",
        "지원사업": "공공·지원사업", "리워드": "리워드·프로모션", "프로모션": "리워드·프로모션", "앱마켓": "앱마켓·플랫폼 노출",
        "플랫폼": "앱마켓·플랫폼 노출", "PR": "PR·언론", "언론": "PR·언론", "기존": "기존 사용자 기반",
    }
    for key, target in aliases.items():
        if key in v:
            return target
    return value or "기타"


def norm_reliability(value: str) -> str:
    v = (value or "").lower()
    for key in RELIABILITY:
        if key in v:
            return key
    return "hypothesis" if not v else v


def norm_segment(value: str) -> str:
    for s in SEGMENT_ORDER:
        if s.replace(" ", "") in (value or "").replace(" ", ""):
            return s
    return value or "기타"


class Sources:
    """URL → 번호. 같은 URL은 같은 번호를 쓴다."""

    def __init__(self) -> None:
        self.items: list[dict] = []
        self.index: dict[str, int] = {}

    def ref(self, url: str, title: str = "", date: str = "", reliability: str = "") -> int | None:
        url = (url or "").strip()
        if not url.startswith("http"):
            return None
        key = url.rstrip("/")
        if key not in self.index:
            self.items.append({"url": url, "title": title, "date": date, "reliability": reliability})
            self.index[key] = len(self.items)
        return self.index[key]


def load() -> tuple[list[dict], list[dict], list[dict], dict]:
    cases, stats, gaps = [], [], []
    for path in sorted(DATA.glob("[0-9]*.json")):
        raw = json.loads(path.read_text())
        group = raw.get("group") or path.stem
        for case in raw.get("cases", []):
            case["_group"] = group
            cases.append(case)
        for stat in raw.get("stats", []):
            stat["_group"] = group
            stats.append(stat)
        for gap in raw.get("gaps", []):
            gaps.append({"group": group, "text": gap})
    fresh_path = DATA / "freshness.json"
    fresh = json.loads(fresh_path.read_text())["items"] if fresh_path.exists() else {}
    for stat in stats:
        if stat.get("topic") in fresh:
            stat["freshness"] = fresh[stat["topic"]]
    missing = set(fresh) - {s.get("topic") for s in stats}
    if missing:
        raise SystemExit(f"freshness.json 항목이 통계와 맞지 않습니다: {sorted(missing)}")
    insights_path = DATA / "insights.json"
    insights = json.loads(insights_path.read_text()) if insights_path.exists() else {}
    return cases, stats, gaps, insights


def normalize(cases: list[dict], stats: list[dict], sources: Sources) -> None:
    for case in cases:
        case["segment"] = norm_segment(case.get("segment", ""))
        top = case.get("top_channel") or {}
        top["type"] = norm_channel(top.get("type", ""))
        top["numeric"] = bool(top.get("numeric"))
        case["top_channel"] = top
        for ch in case.get("channels", []):
            ch["type"] = norm_channel(ch.get("type", ""))
            for ev in ch.get("evidence", []):
                ev["reliability"] = norm_reliability(ev.get("reliability", ""))
                ev["ref"] = sources.ref(ev.get("url", ""), f'{case.get("service", "")} — {ev.get("claim", "")[:60]}', ev.get("date", ""), ev["reliability"])
    for stat in stats:
        stat["reliability"] = norm_reliability(stat.get("reliability", ""))
        stat["ref"] = sources.ref(stat.get("url", ""), stat.get("topic", ""), stat.get("date", ""), stat["reliability"])


def dedupe(cases: list[dict]) -> list[dict]:
    """여러 묶음에서 같은 서비스를 조사했으면 채널·근거를 합친다."""
    merged: dict[str, dict] = {}
    for case in cases:
        # 괄호 안 설명과 '·' 뒤 부가 서비스는 같은 서비스로 본다. 예: "토스플레이스(토스 프론트)" = "토스플레이스"
        name = re.sub(r"\(.*?\)|（.*?）", "", case.get("service") or "").split("·")[0]
        key = re.sub(r"[\s\-]|주식회사", "", name.lower())
        key = CASE_ALIASES.get(key, key)
        if key not in merged:
            merged[key] = case
            continue
        base = merged[key]
        base.setdefault("channels", []).extend(case.get("channels", []))
        if case["top_channel"].get("numeric") and not base["top_channel"].get("numeric"):
            base["top_channel"] = case["top_channel"]
        for field in ("cold_start", "failures", "scale"):
            if not base.get(field) and case.get(field):
                base[field] = case[field]
        base["_group"] = f'{base["_group"]} · {case["_group"]}'
    return list(merged.values())


def cite(ref: int | None) -> str:
    return f'<a class="cite" href="#s{ref}">[{ref}]</a>' if ref else ""


def fresh_badge(stat: dict) -> str:
    f = stat.get("freshness")
    if not f:
        return ""
    label, bg, fg = FRESHNESS[f["status"]]
    note = f' <span class="muted">{esc(f["note"])}</span>' if f.get("note") else ""
    return f'<br><span class="badge" style="background:{bg};color:{fg}">{label}</span>{note}'


def best_evidence(case: dict) -> list[dict]:
    """주 채널 근거 중 수치가 있는 것을 우선해 2개까지."""
    top = case["top_channel"]["type"]
    evs = [ev for ch in case.get("channels", []) if ch["type"] == top for ev in ch.get("evidence", [])]
    evs.sort(key=lambda e: (not e.get("figure"), e["reliability"] == "hypothesis"))
    return evs[:2]


CSS = """
:root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f8fafc;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:var(--ink);background:#fff;line-height:1.55;font-size:14px}
main{max-width:1180px;margin:0 auto;padding:32px 28px 80px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:20px;margin:40px 0 12px;padding-top:8px;border-top:2px solid var(--ink)}h3{font-size:16px;margin:24px 0 8px}
.meta,.muted{color:var(--muted);font-size:12.5px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:14px 0 4px;font-size:13px}nav.toc a{color:var(--accent);text-decoration:none}
.tldr{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:14px 18px;margin:18px 0}.tldr li{margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.kpi{border:1px solid var(--line);border-radius:10px;padding:10px 12px}.kpi b{font-size:22px;display:block}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6;font-weight:600}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;background:#eef2ff;color:#3730a3;margin:1px 2px 1px 0;white-space:nowrap}
.badge.num{background:#dcfce7;color:#166534}.badge.seg{background:#f3f4f6;color:#374151}.badge.rel{background:#fff7ed;color:#9a3412}
.bar{height:10px;background:var(--accent);border-radius:3px;display:inline-block;vertical-align:middle}
.filters{position:sticky;top:0;background:#fff;z-index:5;padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filters select,.filters input{font:inherit;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px}.filters input{flex:1;min-width:180px}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff}.card h4{margin:0 0 4px;font-size:15px}
.card .sum{margin:6px 0}.card dl{margin:6px 0 0;display:grid;grid-template-columns:78px 1fr;gap:3px 8px;font-size:12.5px}.card dt{color:var(--muted)}.card dd{margin:0}
.card details{margin-top:6px;font-size:12.5px}.card details li{margin:3px 0}
.lesson{background:var(--bg);border-radius:8px;padding:6px 8px;margin-top:6px;font-size:12.5px}
a.cite{color:var(--accent);text-decoration:none;font-size:11px;margin-left:1px}
ol.src{font-size:11.5px;color:#374151;padding-left:28px;word-break:break-all}ol.src li{margin:2px 0}
.print-note{display:none;color:#6b7280;font-size:11px}.pattern{border-left:4px solid var(--accent);padding:6px 12px;margin:10px 0;background:var(--bg)}
@media print{
  main{padding:0;max-width:none}.filters,nav.toc{display:none}
  .cards{grid-template-columns:1fr 1fr;gap:6px}.card{break-inside:avoid;padding:6px 8px;font-size:10.5px}.card details{display:none}.card dl{font-size:10.5px}
  .print-note{display:block!important}ol.src{column-count:2;column-gap:16px;font-size:8.5px}ol.src li{break-inside:avoid}
  details.gaps{display:none}
  table{break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid}h2,h3{break-after:avoid}
  body{font-size:11.5px}h2{margin-top:22px}
}
@page{size:A4;margin:14mm 12mm}
"""

SCRIPT = """
const $=s=>document.querySelector(s);const cards=[...document.querySelectorAll('.card')];
function apply(){const seg=$('#f-seg').value,ch=$('#f-ch').value,num=$('#f-num').checked,q=$('#f-q').value.trim().toLowerCase();let n=0;
for(const c of cards){const ok=(!seg||c.dataset.seg===seg)&&(!ch||c.dataset.channels.includes('|'+ch+'|'))&&(!num||c.dataset.num==='1')&&(!q||c.textContent.toLowerCase().includes(q));c.style.display=ok?'':'none';if(ok)n++;}
$('#f-count').textContent=n+'개';}
['#f-seg','#f-ch','#f-num','#f-q'].forEach(s=>$(s).addEventListener('input',apply));
window.addEventListener('beforeprint',()=>cards.forEach(c=>{c.style.display=''}));
"""


def render(cases: list[dict], stats: list[dict], gaps: list[dict], insights: dict, sources: Sources) -> str:
    countries = Counter((c.get("country") or "?") for c in cases)
    numeric_cases = [c for c in cases if c["top_channel"]["numeric"]]
    top_counts = Counter(c["top_channel"]["type"] for c in cases)
    by_channel: dict[str, list[dict]] = defaultdict(list)
    for c in cases:
        by_channel[c["top_channel"]["type"]].append(c)

    parts: list[str] = []
    title = insights.get("title", "다른 서비스는 어떻게 사용자를 모았나")
    parts.append(f'<h1>{esc(title)}</h1><div class="meta">{esc(insights.get("subtitle", ""))}</div>')
    parts.append('<nav class="toc"><a href="#summary">결론</a><a href="#numeric">수치로 확인된 주 채널</a><a href="#channels">채널 유형별</a>'
                 '<a href="#stats">통계·벤치마크</a><a href="#patterns">패턴과 적용</a><a href="#cases">사례 전체</a><a href="#gaps">한계</a><a href="#sources">출처</a></nav>')

    # 결론
    parts.append('<section id="summary">')
    if insights.get("tldr"):
        parts.append('<div class="tldr"><b>한눈에 보기</b><ul>' + "".join(f"<li>{t}</li>" for t in insights["tldr"]) + "</ul></div>")
    parts.append('<div class="kpis">'
                 f'<div class="kpi"><b>{len(cases)}</b>조사한 서비스</div>'
                 f'<div class="kpi"><b>{len(numeric_cases)}</b>주 채널 수치 근거 있음</div>'
                 f'<div class="kpi"><b>{len(stats)}</b>통계·벤치마크</div>'
                 f'<div class="kpi"><b>{len(sources.items)}</b>출처</div></div>')
    parts.append(f'<p class="muted">국가: {" · ".join(f"{esc(k)} {v}" for k, v in countries.most_common())}. 신뢰도 표시: '
                 + " · ".join(f'<span class="badge rel">{v}</span>' for v in RELIABILITY.values()) + "</p></section>")

    # 수치로 확인된 주 채널
    parts.append('<h2 id="numeric">1. 어디서 가장 많이 들어왔나 — 수치로 확인된 것</h2>')
    parts.append('<table><thead><tr><th style="width:17%">서비스</th><th style="width:10%">구분</th><th style="width:14%">주 채널</th><th>근거</th></tr></thead><tbody>')
    for c in sorted(numeric_cases, key=lambda c: (c.get("country") != "KR", SEGMENT_ORDER.index(c["segment"]) if c["segment"] in SEGMENT_ORDER else 9, c.get("service", ""))):
        evs = best_evidence(c)
        ev_html = "<br>".join(f'{esc(e.get("figure") or e.get("claim"))} <span class="badge rel">{RELIABILITY.get(e["reliability"], e["reliability"])}</span>{cite(e.get("ref"))}' for e in evs) or esc(c["top_channel"].get("basis"))
        parts.append(f'<tr><td><b>{esc(c.get("service"))}</b><br><span class="muted">{esc(c.get("country"))}</span></td><td>{esc(c["segment"])}</td>'
                     f'<td><span class="badge num">{esc(c["top_channel"]["type"])}</span></td><td>{esc(c["top_channel"].get("basis"))}<br>{ev_html}</td></tr>')
    parts.append("</tbody></table>")

    # 채널 유형별
    parts.append('<h2 id="channels">2. 채널 유형별 — 어떤 채널이 주 채널이었나</h2>')
    parts.append('<p class="muted">각 서비스의 "주 채널"을 유형별로 셌습니다. 초록 배지는 수치 근거가 있는 경우입니다.</p>')
    parts.append('<table><thead><tr><th style="width:18%">채널 유형</th><th style="width:16%">서비스 수</th><th>서비스</th></tr></thead><tbody>')
    maxn = max(top_counts.values()) if top_counts else 1
    for ch, n in top_counts.most_common():
        names = " ".join(f'<span class="badge{" num" if c["top_channel"]["numeric"] else ""}">{esc(c.get("service"))}</span>' for c in by_channel[ch])
        parts.append(f'<tr><td><b>{esc(ch)}</b></td><td><span class="bar" style="width:{int(90 * n / maxn)}px"></span> {n}</td><td>{names}</td></tr>')
    parts.append("</tbody></table>")
    if insights.get("channel_notes"):
        parts.append("<ul>" + "".join(f"<li>{t}</li>" for t in insights["channel_notes"]) + "</ul>")

    # 통계
    parts.append('<h2 id="stats">3. 통계·벤치마크 — 사람들은 어디서 알게 되나</h2>')
    groups: dict[str, list[dict]] = defaultdict(list)
    for s in stats:
        groups[s.get("_group", "")].append(s)
    fresh_counts = Counter(s["freshness"]["status"] for s in stats if s.get("freshness"))
    parts.append('<p class="muted">2024년 이전 통계 ' + str(sum(fresh_counts.values())) + '개는 최신판이 있는지 다시 확인했습니다(2026-11-24): '
                 + " · ".join(f'<span class="badge" style="background:{FRESHNESS[k][1]};color:{FRESHNESS[k][2]}">{FRESHNESS[k][0]}</span> {v}' for k, v in fresh_counts.most_common())
                 + '. 최신판을 찾은 것은 맨 앞 "최신 자료 보강" 묶음에 넣었습니다.</p>')
    ordered = sorted(groups.items(), key=lambda kv: not kv[0].startswith(REFRESH_GROUP_PREFIX))
    for group, items in ordered:
        parts.append(f"<h3>{esc(group)}</h3>")
        parts.append('<table><thead><tr><th style="width:22%">주제</th><th>내용</th><th style="width:20%">핵심 수치</th><th style="width:15%">표본·날짜</th></tr></thead><tbody>')
        for s in items:
            parts.append(f'<tr><td>{esc(s.get("topic"))}</td><td>{esc(s.get("finding"))}{cite(s.get("ref"))}</td><td>{esc(s.get("figures"))}</td>'
                         f'<td>{esc(s.get("sample"))}<br><span class="muted">{esc(s.get("date"))}</span> <span class="badge rel">{RELIABILITY.get(s["reliability"], s["reliability"])}</span>{fresh_badge(s)}</td></tr>')
        parts.append("</tbody></table>")

    # 패턴
    parts.append('<h2 id="patterns">4. 공통 패턴과 쿠핀 PLUS·ON 적용 <span class="badge">해석</span></h2>')
    for p in insights.get("patterns", []):
        parts.append(f'<div class="pattern"><b>{esc(p.get("title"))}</b><br>{p.get("body", "")}<br><span class="muted">사례: {esc(p.get("cases", ""))}</span>'
                     f'<br><b>쿠핀에 적용:</b> {p.get("apply", "")}</div>')

    # 사례 카드
    parts.append('<h2 id="cases">5. 사례 전체</h2><p class="print-note">인쇄본에는 채널별 상세 근거를 생략했습니다. 근거 전체는 index.html(카드의 "채널과 근거")과 cases.json에 있습니다.</p>')
    seg_opts = "".join(f"<option>{esc(s)}</option>" for s in SEGMENT_ORDER if any(c["segment"] == s for c in cases))
    ch_opts = "".join(f"<option>{esc(t)}</option>" for t in CHANNEL_TYPES if any(ch["type"] == t for c in cases for ch in c.get("channels", [])))
    parts.append(f'<div class="filters"><select id="f-seg"><option value="">전체 구분</option>{seg_opts}</select>'
                 f'<select id="f-ch"><option value="">전체 채널</option>{ch_opts}</select>'
                 '<label><input type="checkbox" id="f-num"> 수치 근거 있는 것만</label><input id="f-q" placeholder="서비스·내용 검색"><span id="f-count" class="muted"></span></div>')
    for seg in SEGMENT_ORDER + sorted({c["segment"] for c in cases} - set(SEGMENT_ORDER)):
        seg_cases = [c for c in cases if c["segment"] == seg]
        if not seg_cases:
            continue
        parts.append(f'<h3>{esc(seg)} ({len(seg_cases)})</h3><div class="cards">')
        for c in sorted(seg_cases, key=lambda c: (not c["top_channel"]["numeric"], c.get("service", ""))):
            chans = c.get("channels", [])
            ch_set = "|" + "|".join(sorted({ch["type"] for ch in chans})) + "|"
            items = []
            for ch in chans:
                evs = "".join(f'<br><span class="muted">· {esc(e.get("claim"))}{(" — " + esc(e.get("figure"))) if e.get("figure") else ""}</span>'
                              f' <span class="badge rel">{RELIABILITY.get(e["reliability"], e["reliability"])}</span>{cite(e.get("ref"))}' for e in ch.get("evidence", []))
                items.append(f'<li><span class="badge">{esc(ch["type"])}</span> {esc(ch.get("stage"))} — {esc(ch.get("how"))}{evs}</li>')
            dl = [f'<dt>주 채널</dt><dd><span class="badge{" num" if c["top_channel"]["numeric"] else ""}">{esc(c["top_channel"]["type"])}</span> {esc(c["top_channel"].get("basis"))}</dd>']
            if c.get("scale"):
                dl.append(f'<dt>규모</dt><dd>{esc(c["scale"])}</dd>')
            if c.get("cold_start"):
                dl.append(f'<dt>콜드 스타트</dt><dd>{esc(c["cold_start"])}</dd>')
            if c.get("failures"):
                dl.append(f'<dt>실패한 것</dt><dd>{esc(c["failures"])}</dd>')
            parts.append(f'<div class="card" data-seg="{esc(c["segment"])}" data-channels="{esc(ch_set)}" data-num="{1 if c["top_channel"]["numeric"] else 0}">'
                         f'<h4>{esc(c.get("service"))} <span class="badge seg">{esc(c.get("country"))}</span></h4>'
                         f'<div class="muted">{esc(c.get("company"))} · 대상: {esc(c.get("customer"))}</div>'
                         f'<div class="sum">{esc(c.get("summary"))}</div><dl>{"".join(dl)}</dl>'
                         f'<details><summary>채널과 근거 {len(chans)}개</summary><ul>{"".join(items)}</ul></details>'
                         f'<div class="lesson"><b>쿠핀 시사점</b> {esc(c.get("lesson"))}</div></div>')
        parts.append("</div>")

    # 한계
    parts.append('<h2 id="gaps">6. 한계 — 찾지 못한 것</h2>')
    if insights.get("limits"):
        parts.append("<ul>" + "".join(f"<li>{t}</li>" for t in insights["limits"]) + "</ul>")
    parts.append("<details class=\"gaps\"><summary>조사 묶음별 상세 한계</summary><ul>" + "".join(f'<li><b>{esc(g["group"])}</b>: {esc(g["text"])}</li>' for g in gaps) + "</ul></details>")

    # 출처
    parts.append('<h2 id="sources">출처</h2><ol class="src">')
    for i, s in enumerate(sources.items, 1):
        parts.append(f'<li id="s{i}"><a href="{esc(s["url"])}">{esc(s["url"])}</a> <span class="muted">{esc(s["date"])} · {RELIABILITY.get(s["reliability"], s["reliability"])}</span></li>')
    parts.append("</ol>")
    parts.append(f'<p class="muted">{esc(insights.get("method", ""))}</p>')

    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{esc(title)}</title><style>{CSS}</style></head><body><main>{''.join(parts)}</main><script>{SCRIPT}apply();</script></body></html>")


def render_readme(cases: list[dict], stats: list[dict], insights: dict, sources: Sources) -> str:
    lines = [f'# {insights.get("title", "다른 서비스는 어떻게 사용자를 모았나")}', "",
             insights.get("subtitle", ""), "",
             "- **요약본(3쪽, 국내 기업 기준)**: `acquisition-summary.pdf` — 어떤 채널이 가장 많았나, 구분별 1위, 대표 수치, 쿠핀 적용. `python3 summary_kr.py`로 `summary-kr.html` 생성 후 같은 Chrome 명령으로 인쇄.",
             "- **마케팅이란(2쪽)**: `marketing-basics.pdf` — 정의, 퍼널, 채널 종류, 대상별 차이, 지표, 정보통신망법 제50조. `python3 basics.py`로 `marketing-basics.html` 생성.",
             "- **보는 법**: `index.html`을 브라우저로 열면 필터·검색이 됩니다. 인쇄본은 `acquisition-cases.pdf`.",
             "- **데이터**: `cases.json`(합친 데이터), `data/*.json`(조사 묶음별 원자료), `data/insights.json`(종합 해석).",
             "- **다시 만들기**: `python3 build.py` 후 PDF는 아래 명령.", "",
             "```bash", 'python3 build.py && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \\',
             '  --print-to-pdf=acquisition-cases.pdf "file://$PWD/index.html"', "```", "", "## 한눈에 보기", ""]
    lines += [f"- {re.sub('<[^>]+>', '', t)}" for t in insights.get("tldr", [])]
    lines += ["", f"조사 서비스 {len(cases)}곳 · 통계 {len(stats)}개 · 출처 {len(sources.items)}개", "",
              "## 수치로 확인된 주 채널", "", "| 서비스 | 구분 | 주 채널 | 근거 |", "|---|---|---|---|"]
    for c in cases:
        if c["top_channel"]["numeric"]:
            basis = (c["top_channel"].get("basis") or "").replace("|", "/")
            lines.append(f'| {c.get("service")} | {c["segment"]} | {c["top_channel"]["type"]} | {basis} |')
    lines += ["", "## 전체 사례", "", "| 서비스 | 국가 | 구분 | 주 채널 | 수치 근거 |", "|---|---|---|---|---|"]
    for c in sorted(cases, key=lambda c: (c["segment"], c.get("service", ""))):
        lines.append(f'| {c.get("service")} | {c.get("country")} | {c["segment"]} | {c["top_channel"]["type"]} | {"O" if c["top_channel"]["numeric"] else ""} |')
    return "\n".join(lines) + "\n"


def main() -> None:
    cases, stats, gaps, insights = load()
    sources = Sources()
    normalize(cases, stats, sources)
    cases = dedupe(cases)
    (ROOT / "cases.json").write_text(json.dumps({"cases": cases, "stats": stats, "gaps": gaps, "sources": sources.items}, ensure_ascii=False, indent=1))
    (ROOT / "index.html").write_text(render(cases, stats, gaps, insights, sources))
    (ROOT / "README.md").write_text(render_readme(cases, stats, insights, sources))
    print(f"cases={len(cases)} stats={len(stats)} sources={len(sources.items)} numeric={sum(c['top_channel']['numeric'] for c in cases)}")
    print("top channels:", Counter(c["top_channel"]["type"] for c in cases).most_common())


if __name__ == "__main__":
    main()
