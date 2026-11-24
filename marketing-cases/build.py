"""marketing-cases 생성기: '다른 기업들은 마케팅을 어떻게 하나'.

data/[1-9]-*.json(조사 묶음별 원자료) + data/insights.json(종합 해석)을 읽어
  - cases.json : 합친 데이터(출처 번호 포함)
  - index.html : 한 페이지 문서(필터·검색, 인쇄하면 PDF 레이아웃)
  - README.md  : 요약
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

FUNCTIONS = [
    "브랜드 캠페인", "광고(유료 매체)", "콘텐츠·SNS", "인플루언서·크리에이터", "CRM·멤버십·리텐션", "커뮤니티",
    "콜라보·굿즈", "PR·언론", "오프라인·이벤트", "프로모션·가격", "제휴·파트너십", "교육·세미나", "영업 지원",
    "데이터·AI 활용", "조직·운영",
]
RELIABILITY = {
    "filing": "공시", "survey": "설문·통계", "third_party": "제3자", "interview": "인터뷰", "company_claim": "회사 발표",
}
GLOBAL_PREFIX = "6-"  # 해외 참고 묶음 파일 접두사


def esc(value: object) -> str:
    return html.escape(str(value or ""))


def norm_function(value: str) -> str:
    v = (value or "").replace(" ", "")
    for f in FUNCTIONS:
        if f.replace(" ", "") == v:
            return f
    for f in FUNCTIONS:  # '콘텐츠' → '콘텐츠·SNS'처럼 일부만 맞아도 맞춘다
        if any(part and part in v for part in f.replace(" ", "").split("·")):
            return f
    return "기타"


def norm_reliability(value: str) -> str:
    v = (value or "").lower()
    for key in RELIABILITY:
        if key in v:
            return key + ("_2nd" if "2차" in v else "")
    return "third_party"


def rel_label(value: str) -> str:
    base = value.replace("_2nd", "")
    return RELIABILITY.get(base, base) + (" (2차 인용)" if value.endswith("_2nd") else "")


class Sources:
    """URL → 번호. 같은 URL은 같은 번호."""

    def __init__(self) -> None:
        self.items: list[dict] = []
        self.index: dict[str, int] = {}

    def ref(self, url: str, date: str = "", reliability: str = "") -> int | None:
        url = (url or "").strip()
        if not url.startswith("http"):
            return None
        key = url.rstrip("/")
        if key not in self.index:
            self.items.append({"url": url, "date": date, "reliability": reliability})
            self.index[key] = len(self.items)
        return self.index[key]


def load() -> tuple[list[dict], list[dict], list[dict], dict]:
    companies, stats, gaps = [], [], []
    for path in sorted(DATA.glob("[0-9]*.json")):
        raw = json.loads(path.read_text())
        group = raw.get("group") or path.stem
        is_global = path.name.startswith(GLOBAL_PREFIX)
        for c in raw.get("companies", []):
            if not isinstance(c, dict):  # 통계 묶음은 회사 이름 목록만 담기도 한다
                continue
            c["_group"], c["_global"] = group, is_global
            companies.append(c)
        for s in raw.get("stats", []):
            s["_group"] = group
            stats.append(s)
        gaps += [{"group": group, "text": g} for g in raw.get("gaps", [])]
    ins = DATA / "insights.json"
    return companies, stats, gaps, (json.loads(ins.read_text()) if ins.exists() else {})


def normalize(companies: list[dict], stats: list[dict], sources: Sources) -> None:
    def fix_evidence(evs: list[dict]) -> None:
        for ev in evs:
            ev["reliability"] = norm_reliability(ev.get("reliability", ""))
            ev["ref"] = sources.ref(ev.get("url", ""), ev.get("date", ""), ev["reliability"])

    for c in companies:
        for a in c.get("activities", []):
            a["function"] = norm_function(a.get("function", ""))
            fix_evidence(a.get("evidence", []))
        fix_evidence(c.get("budget_evidence", []))
    for s in stats:
        s["reliability"] = norm_reliability(s.get("reliability", ""))
        s["ref"] = sources.ref(s.get("url", ""), s.get("date", ""), s["reliability"])


def dedupe(companies: list[dict]) -> list[dict]:
    """여러 묶음에서 같은 회사를 조사했으면 활동을 합친다(예: 스타벅스가 오프라인·CRM 묶음 둘 다에 있음)."""
    merged: dict[str, dict] = {}
    for c in companies:
        key = re.sub(r"\(.*?\)|\s|주식회사", "", (c.get("company") or "").lower()).split("·")[0]
        if key not in merged:
            merged[key] = c
            continue
        base = merged[key]
        base.setdefault("activities", []).extend(c.get("activities", []))
        base.setdefault("budget_evidence", []).extend(c.get("budget_evidence", []))
        for f in ("budget_org", "positioning", "lesson"):
            if not base.get(f) and c.get(f):
                base[f] = c[f]
        base["_group"] = f'{base["_group"]} · {c["_group"]}'
    return list(merged.values())


def cite(ref: int | None) -> str:
    return f'<a class="cite" href="#s{ref}">[{ref}]</a>' if ref else ""


def cites(evs: list[dict]) -> str:
    refs = dict.fromkeys(e.get("ref") for e in evs if e.get("ref"))  # 같은 출처 번호는 한 번만
    return "".join(cite(r) for r in refs)


def representative(pairs: list[tuple[dict, dict]], n: int) -> list[tuple[dict, dict]]:
    """수치 성과가 있는 최근 활동을 앞에, 같은 회사는 한 번만."""
    def year(a: dict) -> int:
        m = re.search(r"\d{4}", a.get("year") or "")
        return int(m.group()) if m else 0
    ranked = sorted(pairs, key=lambda ca: (not re.search(r"\d", ca[1].get("result") or ""), -year(ca[1])))
    out, seen = [], set()
    for c, a in ranked:
        if short_name(c) in seen:
            continue
        seen.add(short_name(c))
        out.append((c, a))
        if len(out) == n:
            break
    return out


def function_table(acts_kr: list[tuple[dict, dict]], uses: Counter, n_examples: int) -> str:
    rows = ['<table><thead><tr><th style="width:17%">기능</th><th style="width:12%">회사 수</th><th>대표 활동</th></tr></thead><tbody>']
    mx = max(uses.values()) if uses else 1
    for f, n in uses.most_common():
        ex = representative([(c, a) for c, a in acts_kr if a["function"] == f], n_examples)
        items = "".join(
            f'<li><b>{esc(short_name(c))}</b> {esc(a.get("name"))} ({esc(a.get("year"))}) — {esc(a.get("result") or a.get("what"))}{cites(a.get("evidence", []))}</li>'
            for c, a in ex)
        rows.append(f'<tr><td><b>{esc(f)}</b></td><td><span class="bar" style="width:{int(70 * n / mx)}px"></span> {n}</td><td><ul style="margin:0;padding-left:16px">{items}</ul></td></tr>')
    rows.append("</tbody></table>")
    return "".join(rows)


def short_name(c: dict) -> str:
    return (c.get("company") or "").split("(")[0].strip()


CSS = """
:root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f8fafc;--accent:#2563eb}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:var(--ink);line-height:1.55;font-size:14px}
main{max-width:1180px;margin:0 auto;padding:32px 28px 80px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 10px;padding-top:8px;border-top:2px solid var(--ink)}h3{font-size:16px;margin:20px 0 8px}
.meta,.muted{color:var(--muted);font-size:12.5px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0}nav.toc a{color:var(--accent);text-decoration:none;font-size:13px}
.tldr{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 18px;margin:16px 0}.tldr li{margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}.kpi{border:1px solid var(--line);border-radius:10px;padding:8px 12px}.kpi b{font-size:22px;display:block}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;background:#eef2ff;color:#3730a3;margin:1px 2px 1px 0;white-space:nowrap}
.badge.rel{background:#fff7ed;color:#9a3412}.badge.gl{background:#f3f4f6;color:#374151}
.bar{height:10px;background:var(--accent);border-radius:3px;display:inline-block;vertical-align:middle}
.filters{position:sticky;top:0;background:#fff;z-index:5;padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filters select,.filters input{font:inherit;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px}.filters input{flex:1;min-width:180px}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px}.card h4{margin:0 0 4px;font-size:15px}
.card ul{margin:6px 0 0;padding-left:18px;font-size:12.5px}.card li{margin:3px 0}
.lesson{background:var(--bg);border-radius:8px;padding:6px 8px;margin-top:6px;font-size:12.5px}
a.cite{color:var(--accent);text-decoration:none;font-size:11px;margin-left:1px}
ol.src{font-size:11.5px;color:#374151;padding-left:28px;word-break:break-all}
.pattern{border-left:4px solid var(--accent);padding:6px 12px;margin:10px 0;background:var(--bg)}
@media print{
  main{padding:0;max-width:none}.filters,nav.toc{display:none}body{font-size:11.5px}
  .cards{gap:6px}.card{break-inside:avoid;padding:7px 9px;font-size:10.5px}.card ul{font-size:10.5px}
  tr{break-inside:avoid}thead{display:table-header-group}h2,h3{break-after:avoid}
  ol.src{column-count:2;column-gap:16px;font-size:8.5px}ol.src li{break-inside:avoid}details.gaps{display:none}
}
@page{size:A4;margin:14mm 12mm}
"""

SCRIPT = """
const $=s=>document.querySelector(s);const cards=[...document.querySelectorAll('.card')];
function apply(){const g=$('#f-g').value,f=$('#f-f').value,q=$('#f-q').value.trim().toLowerCase();let n=0;
for(const c of cards){const ok=(!g||c.dataset.g===g)&&(!f||c.dataset.f.includes('|'+f+'|'))&&(!q||c.textContent.toLowerCase().includes(q));c.style.display=ok?'':'none';if(ok)n++;}
$('#f-n').textContent=n+'곳';}
['#f-g','#f-f','#f-q'].forEach(s=>$(s).addEventListener('input',apply));
window.addEventListener('beforeprint',()=>cards.forEach(c=>c.style.display=''));
"""


def render(companies: list[dict], stats: list[dict], gaps: list[dict], ins: dict, sources: Sources) -> str:
    kr = [c for c in companies if not c["_global"]]
    gl = [c for c in companies if c["_global"]]
    acts_kr = [(c, a) for c in kr for a in c.get("activities", [])]
    uses = Counter(f for c in kr for f in {a["function"] for a in c.get("activities", [])})

    p: list[str] = []
    title = ins.get("title", "다른 기업들은 마케팅을 어떻게 하나")
    p.append(f'<h1>{esc(title)}</h1><div class="meta">{esc(ins.get("subtitle", ""))}</div>')
    p.append('<nav class="toc"><a href="#sum">결론</a><a href="#func">기능별</a><a href="#group">업종별</a><a href="#stats">시장 통계</a>'
             '<a href="#pat">공통 패턴</a><a href="#cards">기업별</a><a href="#global">해외 참고</a><a href="#gaps">한계</a><a href="#src">출처</a></nav>')
    if ins.get("tldr"):
        p.append('<div class="tldr" id="sum"><b>한눈에 보기</b><ul>' + "".join(f"<li>{t}</li>" for t in ins["tldr"]) + "</ul></div>")
    n_acts = sum(len(c.get("activities", [])) for c in companies)
    p.append(f'<div class="kpis"><div class="kpi"><b>{len(kr)}</b>국내 기업</div><div class="kpi"><b>{len(gl)}</b>해외 참고</div>'
             f'<div class="kpi"><b>{n_acts}</b>마케팅 활동</div><div class="kpi"><b>{len(sources.items)}</b>출처</div></div>')
    p.append('<p class="muted">신뢰도 표시: ' + " ".join(f'<span class="badge rel">{v}</span>' for v in RELIABILITY.values())
             + ' · 해석 부분은 <span class="badge">해석</span>으로 표시했습니다.</p>')

    # 1. 기능별
    p.append('<h2 id="func">1. 마케팅 기능별 — 국내 기업이 무엇을 하나</h2>'
             f'<p class="muted">국내 기업 {len(kr)}곳 중 각 기능의 활동이 조사된 회사 수입니다. 대표 활동은 수치 성과가 있는 것을 우선했습니다.</p>')
    p.append(function_table(acts_kr, uses, 3))

    # 2. 업종별
    p.append('<h2 id="group">2. 업종별로 보면</h2>')
    by_group: dict[str, list[dict]] = defaultdict(list)
    for c in kr:
        by_group[c["_group"].split(" · ")[0]].append(c)
    for g, cs in by_group.items():
        fc = Counter(a["function"] for c in cs for a in c.get("activities", []))
        p.append(f'<h3>{esc(g)} ({len(cs)}곳)</h3><p class="muted">많이 쓴 기능: '
                 + " ".join(f'<span class="badge">{esc(f)} {n}</span>' for f, n in fc.most_common(5)) + "</p>")
        p.append('<table><thead><tr><th style="width:15%">기업</th><th style="width:30%">내세우는 것</th><th>특징</th></tr></thead><tbody>'
                 + "".join(f'<tr><td><b>{esc(short_name(c))}</b><br><span class="muted">{esc(c.get("industry"))}</span></td><td>{esc(c.get("positioning"))}</td><td>{esc(c.get("summary"))}</td></tr>' for c in cs)
                 + "</tbody></table>")
    if ins.get("group_notes"):
        p.append('<ul>' + "".join(f"<li>{t}</li>" for t in ins["group_notes"]) + "</ul>")

    # 3. 통계
    p.append('<h2 id="stats">3. 시장 통계 — 돈과 사람은 어디에 쓰이나</h2>')
    sg: dict[str, list[dict]] = defaultdict(list)
    for s in stats:
        sg[s["_group"]].append(s)
    for g, items in sg.items():
        p.append(f"<h3>{esc(g)}</h3><table><thead><tr><th style='width:22%'>주제</th><th>내용</th><th style='width:22%'>핵심 수치</th><th style='width:17%'>표본·날짜</th></tr></thead><tbody>"
                 + "".join(f'<tr><td>{esc(s.get("topic"))}</td><td>{esc(s.get("finding"))}{cite(s.get("ref"))}</td><td>{esc(s.get("figures"))}</td>'
                           f'<td>{esc(s.get("sample"))}<br><span class="muted">{esc(s.get("date"))}</span> <span class="badge rel">{rel_label(s["reliability"])}</span></td></tr>' for s in items)
                 + "</tbody></table>")

    # 4. 패턴
    p.append('<h2 id="pat">4. 공통 패턴 <span class="badge">해석</span></h2>')
    for pt in ins.get("patterns", []):
        p.append(f'<div class="pattern"><b>{esc(pt.get("title"))}</b><br>{pt.get("body", "")}<br><span class="muted">사례: {esc(pt.get("cases", ""))}</span></div>')

    # 5. 카드
    def card(c: dict) -> str:
        fs = "|" + "|".join(sorted({a["function"] for a in c.get("activities", [])})) + "|"
        acts = "".join(
            f'<li><span class="badge">{esc(a["function"])}</span> <b>{esc(a.get("name"))}</b> <span class="muted">{esc(a.get("year"))}</span> — {esc(a.get("what"))}'
            + (f' <b>→ {esc(a.get("result"))}</b>' if a.get("result") else "") + cites(a.get("evidence", [])) + "</li>"
            for a in c.get("activities", []))
        budget = f'<div class="muted" style="margin-top:4px">조직·예산: {esc(c["budget_org"])}{cites(c.get("budget_evidence", []))}</div>' if c.get("budget_org") else ""
        return (f'<div class="card" data-g="{esc(c["_group"].split(" · ")[0])}" data-f="{esc(fs)}"><h4>{esc(c.get("company"))}'
                + (' <span class="badge gl">해외</span>' if c["_global"] else "")
                + f'</h4><div class="muted">{esc(c.get("industry"))} · 대상: {esc(c.get("target"))}</div>'
                f'<div><b>내세우는 것</b> {esc(c.get("positioning"))}</div><ul>{acts}</ul>{budget}'
                f'<div class="lesson"><b>배울 점</b> {esc(c.get("lesson"))}</div></div>')

    groups = sorted({c["_group"].split(" · ")[0] for c in companies})
    p.append('<h2 id="cards">5. 기업별 상세</h2><div class="filters">'
             '<select id="f-g"><option value="">전체 묶음</option>' + "".join(f"<option>{esc(g)}</option>" for g in groups) + "</select>"
             '<select id="f-f"><option value="">전체 기능</option>' + "".join(f"<option>{esc(f)}</option>" for f in FUNCTIONS if any(a["function"] == f for c in companies for a in c.get("activities", []))) + "</select>"
             '<input id="f-q" placeholder="기업·캠페인 검색"><span id="f-n" class="muted"></span></div>')
    for g, cs in by_group.items():
        p.append(f"<h3>{esc(g)}</h3><div class='cards'>" + "".join(card(c) for c in cs) + "</div>")
    p.append(f'<h2 id="global">6. 해외 참고 사례 ({len(gl)}곳)</h2><div class="cards">' + "".join(card(c) for c in gl) + "</div>")

    p.append('<h2 id="gaps">7. 한계</h2>')
    if ins.get("limits"):
        p.append("<ul>" + "".join(f"<li>{t}</li>" for t in ins["limits"]) + "</ul>")
    p.append('<details class="gaps"><summary>조사 묶음별 상세 한계</summary><ul>' + "".join(f'<li><b>{esc(g["group"])}</b>: {esc(g["text"])}</li>' for g in gaps) + "</ul></details>")
    p.append('<h2 id="src">출처</h2><ol class="src">' + "".join(
        f'<li id="s{i}"><a href="{esc(s["url"])}">{esc(s["url"])}</a> <span class="muted">{esc(s["date"])} · {rel_label(s["reliability"])}</span></li>'
        for i, s in enumerate(sources.items, 1)) + "</ol>")
    p.append(f'<p class="muted">{esc(ins.get("method", ""))}</p>')
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{esc(title)}</title>'
            f"<style>{CSS}</style></head><body><main>{''.join(p)}</main><script>{SCRIPT}apply();</script></body></html>")


SUMMARY_CSS = """
@media print{body{font-size:10.5px}h2{margin:14px 0 6px;font-size:15px}table{font-size:10px}td,th{padding:3px 6px}
.pattern{padding:4px 10px;margin:6px 0;break-inside:avoid}.tldr{padding:6px 14px}.kpis{margin:6px 0}}
"""


def render_summary(companies: list[dict], stats: list[dict], ins: dict, sources: Sources) -> str:
    """요약본: 결론·기능별 표·공통 패턴·핵심 통계. 출처 번호는 본문(marketing-cases.pdf)과 같다."""
    kr = [c for c in companies if not c["_global"]]
    acts_kr = [(c, a) for c in kr for a in c.get("activities", [])]
    uses = Counter(f for c in kr for f in {a["function"] for a in c.get("activities", [])})
    title = ins.get("title", "다른 기업들은 마케팅을 어떻게 하나")
    p = [f'<h1>{esc(title)} — 요약</h1><div class="meta">{esc(ins.get("subtitle", ""))} 근거 전체와 출처 목록은 <code>marketing-cases.pdf</code>에 있고, [번호]는 그 문서의 출처 번호입니다.</div>']
    p.append('<div class="tldr"><b>한눈에 보기</b><ul>' + "".join(f"<li>{t}</li>" for t in ins.get("tldr", [])) + "</ul></div>")
    p.append(f'<h2>1. 국내 기업 {len(kr)}곳이 하는 마케팅 활동</h2>' + function_table(acts_kr, uses, 2))
    p.append('<h2>2. 공통 패턴 <span class="badge">해석</span></h2>')
    for pt in ins.get("patterns", []):
        p.append(f'<div class="pattern"><b>{esc(pt.get("title"))}</b><br>{pt.get("body", "")}</div>')
    key = [s for s in stats if s.get("topic") in set(ins.get("summary_stats", []))]
    if key:
        p.append('<h2>3. 국내 광고시장 숫자</h2><table><thead><tr><th style="width:26%">주제</th><th>핵심 수치</th><th style="width:20%">출처·날짜</th></tr></thead><tbody>'
                 + "".join(f'<tr><td>{esc(s["topic"])}</td><td>{esc(s.get("figures"))}{cite(s.get("ref"))}</td><td>{esc(s.get("sample"))} · {esc(s.get("date"))}</td></tr>' for s in key)
                 + "</tbody></table>")
    if ins.get("limits"):
        p.append('<h2>한계</h2><ul class="muted">' + "".join(f"<li>{t}</li>" for t in ins["limits"]) + "</ul>")
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>{esc(title)} — 요약</title>'
            f"<style>{CSS}{SUMMARY_CSS}</style></head><body><main>{''.join(p)}</main></body></html>")


def render_readme(companies: list[dict], stats: list[dict], ins: dict, sources: Sources) -> str:
    kr = [c for c in companies if not c["_global"]]
    lines = [f'# {ins.get("title", "다른 기업들은 마케팅을 어떻게 하나")}', "", ins.get("subtitle", ""), "",
             "- **요약본**: `marketing-cases-summary.pdf`(`summary.html` 인쇄) — 결론, 기능별 대표 활동, 공통 패턴, 광고시장 숫자.",
             "- **본문**: `index.html`(필터·검색), 인쇄본 `marketing-cases.pdf`.",
             "- **데이터**: `cases.json`(합친 데이터), `data/*.json`(묶음별 원자료), `data/insights.json`(해석).", "",
             "```bash", 'python3 build.py && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-pdf-header-footer \\',
             '  --print-to-pdf=marketing-cases.pdf "file://$PWD/index.html"', "# 요약본은 summary.html → marketing-cases-summary.pdf", "```", "", "## 한눈에 보기", ""]
    lines += [f"- {re.sub('<[^>]+>', '', t)}" for t in ins.get("tldr", [])]
    lines += ["", f"국내 기업 {len(kr)}곳 · 해외 참고 {len(companies) - len(kr)}곳 · 통계 {len(stats)}개 · 출처 {len(sources.items)}개", "",
              "| 기업 | 묶음 | 기능 |", "|---|---|---|"]
    for c in companies:
        fs = ", ".join(sorted({a["function"] for a in c.get("activities", [])}))
        lines.append(f'| {c.get("company")} | {c["_group"]} | {fs} |')
    return "\n".join(lines) + "\n"


def main() -> None:
    companies, stats, gaps, ins = load()
    sources = Sources()
    normalize(companies, stats, sources)
    companies = dedupe(companies)
    (ROOT / "cases.json").write_text(json.dumps({"companies": companies, "stats": stats, "gaps": gaps, "sources": sources.items}, ensure_ascii=False, indent=1))
    (ROOT / "index.html").write_text(render(companies, stats, gaps, ins, sources))
    (ROOT / "summary.html").write_text(render_summary(companies, stats, ins, sources))
    (ROOT / "README.md").write_text(render_readme(companies, stats, ins, sources))
    kr = [c for c in companies if not c["_global"]]
    print(f"companies={len(companies)} kr={len(kr)} stats={len(stats)} sources={len(sources.items)}")
    print("functions(kr):", Counter(f for c in kr for f in {a['function'] for a in c.get('activities', [])}).most_common())
    print("unmapped:", sum(a["function"] == "기타" for c in companies for a in c.get("activities", [])))


if __name__ == "__main__":
    main()
