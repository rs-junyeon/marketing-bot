"""automation-tools 생성기: '마케팅 자동화는 무엇을, 어떤 툴로 하나'.

data/[1-9]-*.json(영역별 원자료) + data/insights.json(종합 해석)을 읽어
  - tools.json   : 합친 데이터(출처 번호 포함)
  - index.html   : 본문(영역별 업무 지도·툴 카탈로그·활용 사례·통계, 필터·검색)
  - summary.html : 회의용 요약본
  - README.md    : 요약
을 만든다. PDF는 Chrome headless로 인쇄한다(README 참고).

사용: python3 build.py
"""
from __future__ import annotations

import html
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

AREAS = [
    "콘텐츠·SNS·브랜드 캠페인", "데이터·AI 활용", "CRM·멤버십·리텐션", "광고·프로모션",
    "교육·고객 사례·영업 지원", "성과 측정", "통합 플랫폼·AI 에이전트",
]
RELIABILITY = {
    "vendor_doc": "툴 공식 문서", "company_claim": "회사 발표", "third_party": "제3자", "interview": "인터뷰",
    "survey": "설문·통계", "filing": "공시",
}
VENDOR_REL = {"vendor_doc", "company_claim"}


def esc(value: object) -> str:
    return html.escape(str(value or ""))


def rel_label(value: str) -> str:
    return RELIABILITY.get(value, value)


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


def load() -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict], list[dict]]:
    tasks, tools, cases, stats, gaps, usage = [], [], [], [], [], []
    for path in sorted(DATA.glob("[0-9]*.json")):
        raw = json.loads(path.read_text())
        group = raw.get("group") or path.stem
        for t in raw.get("tasks", []):
            t["_area"] = group
            tasks.append(t)
        for t in raw.get("tools", []):  # 국내 보강 묶음(8~)은 영역을 섞으므로 항목의 area를 우선한다
            t["_areas"] = [t.get("area") if t.get("area") in AREAS else group]
            t["_zero"] = any("stage" in u for u in raw.get("use_cases", []))  # 초기·소규모 사례 묶음에서 온 툴
            tools.append(t)
        for u in raw.get("use_cases", []):
            u["_area"] = u.get("area") if u.get("area") in AREAS else group
            u["_file"] = path.stem
            cases.append(u)
        for s in raw.get("stats", []):
            s["_group"] = group
            stats.append(s)
        usage += raw.get("usage", [])  # 해외 툴의 국내 사용 근거(11-kr-usage.json)
        gaps += [{"group": group, "text": g} for g in raw.get("gaps", [])]
    return tasks, tools, cases, stats, gaps, usage


def domestic_only(cases: list[dict], stats: list[dict]) -> None:
    """국내 버전: 활용 사례는 국내 기업 것(툴 국적 무관), 통계는 국내 조사만 남긴다. 툴 범위는 split_by_kr_usage가 정한다."""
    cases[:] = [u for u in cases if u.get("company_origin") == "국내"]
    stats[:] = [s for s in stats if s.get("region") == "국내"]


def split_zero(cases: list[dict]) -> tuple[list[dict], list[dict]]:
    """초기·소규모(제로베이스) 사례(12~14번 묶음, stage 필드가 있음)를 따로 뗀다. 이 사례는 국내 우선·해외 보충이라 국내 필터를 거치지 않는다."""
    zero = [u for u in cases if "stage" in u]
    zero.sort(key=lambda u: (u.get("company_origin") != "국내", not has_number(u.get("result", ""))))
    return zero, [u for u in cases if "stage" not in u]


def zero_table(cases: list[dict], tools: list[dict]) -> str:
    head = ('<tr><th style="width:13%">기업</th><th style="width:15%">시작할 때 상태</th><th style="width:12%">툴</th>'
            '<th>어떻게 자동화했나</th><th style="width:20%">결과</th></tr>')
    rows = []
    for u in cases:
        origin = ' <span class="badge gl">해외</span>' if u.get("company_origin") == "해외" else ""
        period = f' <span class="muted" style="font-size:1em">({esc(u["period"])})</span>' if u.get("period") else ""
        base = f'<br><span class="muted" style="font-size:1em">도입 전: {esc(u["baseline"])}</span>' if u.get("baseline") else ""
        rows.append(f'<tr><td><b>{esc(u.get("company"))}</b>{origin}</td><td>{esc(u.get("stage"))}{base}</td>'
                    f'<td>{esc(u.get("tool"))}{tool_origin_mark(u.get("tool", ""), tools)}</td>'
                    f'<td>{esc(u.get("what"))}{cites(u.get("evidence", []))}</td>'
                    f'<td>{esc(u.get("result") or "—")}{period}{vendor_mark(u.get("evidence", []))}</td></tr>')
    return f"<table><thead>{head}</thead><tbody>{''.join(rows)}</tbody></table>"


def pick_zero(cases: list[dict], per_file: int = 4) -> list[dict]:
    """요약본용: 묶음(국내 B2C·국내 B2B·해외)마다 수치 결과가 있고 제3자 근거가 있는 사례를 먼저 골라 per_file개씩."""
    by_file: dict[str, list[dict]] = defaultdict(list)
    for u in cases:
        by_file[u.get("_file", "")].append(u)
    return [u for f in sorted(by_file) for u in ranked_cases(by_file[f], per_file)]  # 같은 툴은 묶음당 한 번만


ZERO_NOTE = ("사용자·고객이 없거나 적은 상태에서 자동화로 신규 유입·첫 고객을 만든 사례입니다. 국내 사례를 먼저 찾고, 부족한 부분은 해외 사례로 보충해 "
             '<span class="badge gl">해외</span>로 표시했습니다. 대부분 운영자 본인이나 툴 회사가 쓴 글이라 독립 검증이 안 된 수치입니다.')


def same_tool(a: str, b: str) -> bool:
    ka, kb = tool_key(a), tool_key(b)
    return bool(ka and kb) and (ka in kb or kb in ka)


def attach_kr_usage(tools: list[dict], usage: list[dict], cases: list[dict]) -> None:
    """해외 툴에 국내 사용 근거를 붙인다: 국내 사용 근거 조사(usage) + 이 조사의 국내 기업 활용 사례."""
    for t in tools:
        t["_kr_usage"] = [g for g in usage if same_tool(g.get("tool", ""), t["name"])]
        kr_cases = [u for u in cases if u.get("company_origin") == "국내" and same_tool(u.get("tool", ""), t["name"])]
        if kr_cases:
            t["_kr_usage"].append({"signal": "국내 고객사", "summary": "국내 사용 기업: " + ", ".join(dict.fromkeys(u["company"] for u in kr_cases)),
                                   "evidence": [e for u in kr_cases for e in u.get("evidence", [])][:2]})


WEAK_SIGNAL = "한국어·국내 채널 지원"  # 한국어 UI·도움말만 있는 것은 '국내에서 많이 쓰인다'는 근거로 보지 않는다


def strong_signal(g: dict) -> bool:
    return any(x.strip() and x.strip() != WEAK_SIGNAL for x in (g.get("signal") or "").split(";"))


def split_by_kr_usage(tools: list[dict]) -> list[dict]:
    """국내 버전 툴 목록: 국내 툴 + 국내 사용 근거(국내 고객사·한국 지사·파트너·국내 사용 통계)가 있는 해외 툴. 나머지 해외 툴은 반환(본문에 이름만 적는다)."""
    dropped = [t for t in tools if t.get("origin") == "해외" and not any(strong_signal(g) for g in t.get("_kr_usage", []))]
    tools[:] = [t for t in tools if t not in dropped]
    return dropped


def tool_origin_mark(name: str, tools: list[dict]) -> str:
    """사례 표에서 국내 기업이 해외 툴을 쓴 경우를 표시한다."""
    k = tool_key(name)
    for t in tools:
        tk = tool_key(t["name"])
        if tk and (tk in k or k in tk):
            return ' <span class="badge gl">해외 툴</span>' if t.get("origin") == "해외" else ""
    return ""


def tool_key(name: str) -> str:
    return re.sub(r"\(.*?\)|\s|[·.\-]", "", (name or "").lower())


def dedupe_tools(tools: list[dict]) -> list[dict]:
    """여러 영역에서 같은 툴을 조사했으면 하나로 합친다(예: HubSpot이 CRM·영업 지원·통합 플랫폼에 모두 있음)."""
    merged: dict[str, dict] = {}
    for t in tools:
        key = tool_key(t.get("name", ""))
        if key not in merged:
            merged[key] = t
            continue
        base = merged[key]
        base["_areas"] = list(dict.fromkeys(base["_areas"] + t["_areas"]))
        base["tasks"] = list(dict.fromkeys(base.get("tasks", []) + t.get("tasks", [])))
        base["features"] = list(dict.fromkeys(base.get("features", []) + t.get("features", [])))
        base["evidence"] = base.get("evidence", []) + t.get("evidence", [])
        for f in ("korea", "pricing", "users", "problem"):
            if not base.get(f) and t.get(f):
                base[f] = t[f]
    return list(merged.values())


def dedupe_cases(cases: list[dict]) -> list[dict]:
    """여러 묶음에서 같은 기업·같은 툴 사례를 조사했으면 근거가 많은 쪽 하나만 남긴다(예: 토스 Intelligent Message)."""
    best: dict[tuple[str, str], dict] = {}
    for u in cases:
        key = (tool_key(u.get("company", "")), tool_key(u.get("tool", "")))
        if key not in best or len(u.get("evidence", [])) > len(best[key].get("evidence", [])):
            best[key] = u
    return [u for u in cases if best.get((tool_key(u.get("company", "")), tool_key(u.get("tool", "")))) is u]


def normalize(tools: list[dict], cases: list[dict], stats: list[dict], sources: Sources, zero: list[dict] | None = None) -> None:
    def fix(evs: list[dict]) -> None:
        for ev in evs:
            ev["ref"] = sources.ref(ev.get("url", ""), ev.get("date", ""), ev.get("reliability", ""))

    for t in tools:
        fix(t.get("evidence", []))
        for g in t.get("_kr_usage", []):
            fix(g.get("evidence", []))
    for u in cases + (zero or []):
        fix(u.get("evidence", []))
    for s in stats:
        s["ref"] = sources.ref(s.get("url", ""), s.get("date", ""), s.get("reliability", ""))


def cite(ref: int | None) -> str:
    return f'<a class="cite" href="#s{ref}">[{ref}]</a>' if ref else ""


def cites(evs: list[dict]) -> str:
    refs = dict.fromkeys(e.get("ref") for e in evs if e.get("ref"))
    return "".join(cite(r) for r in refs)


def vendor_mark(evs: list[dict]) -> str:
    """근거가 모두 툴 회사·사용 기업 발표면 표시한다."""
    if evs and all(e.get("reliability") in VENDOR_REL for e in evs):
        return ' <span class="badge rel">회사 발표</span>'
    return ""


def has_number(text: str) -> bool:
    return bool(re.search(r"\d", text or ""))


CSS = """
:root{--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--bg:#f8fafc;--accent:#2563eb;--auto:#dcfce7;--human:#fef3c7}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:var(--ink);line-height:1.55;font-size:14px}
main{max-width:1180px;margin:0 auto;padding:32px 28px 80px}
h1{font-size:26px;margin:0 0 6px}h2{font-size:20px;margin:36px 0 10px;padding-top:8px;border-top:2px solid var(--ink)}h3{font-size:16px;margin:20px 0 8px}
.meta,.muted{color:var(--muted);font-size:12.5px}
nav.toc{display:flex;flex-wrap:wrap;gap:6px 14px;margin:12px 0}nav.toc a{color:var(--accent);text-decoration:none;font-size:13px}
.tldr{background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:12px 18px;margin:16px 0}.tldr li{margin:4px 0}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}.kpi{border:1px solid var(--line);border-radius:10px;padding:8px 12px}.kpi b{font-size:22px;display:block}
table{width:100%;border-collapse:collapse;font-size:12.5px;margin:8px 0 14px}th,td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{background:#f3f4f6}
td.auto{background:#f0fdf4}td.human{background:#fffbeb}th.auto{background:var(--auto)}th.human{background:var(--human)}
.badge{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;background:#eef2ff;color:#3730a3;margin:1px 2px 1px 0;white-space:nowrap}
.badge.rel{background:#fff7ed;color:#9a3412}.badge.kr{background:#dcfce7;color:#166534}.badge.gl{background:#f3f4f6;color:#374151}
.filters{position:sticky;top:0;background:#fff;z-index:5;padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.filters select,.filters input{font:inherit;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px}.filters input{flex:1;min-width:180px}
.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:12px 14px;font-size:12.5px}.card h4{margin:0 0 4px;font-size:15px}
.card ul{margin:4px 0 0;padding-left:18px}.card li{margin:2px 0}
.split{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px}.split div{border-radius:8px;padding:5px 8px}
.split .a{background:#f0fdf4}.split .h{background:#fffbeb}
a.cite{color:var(--accent);text-decoration:none;font-size:11px;margin-left:1px}
ol.src{font-size:11.5px;color:#374151;padding-left:28px;word-break:break-all}
.pattern{border-left:4px solid var(--accent);padding:6px 12px;margin:10px 0;background:var(--bg)}
.dir{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}.dir b.t{font-size:14.5px}
.q{border-left:4px solid #f59e0b;background:#fffbeb;padding:6px 12px;margin:8px 0}
@media print{
  main{padding:0;max-width:none}.filters,nav.toc{display:none}body{font-size:11px}
  table{break-inside:auto;font-size:10.5px}td,th{padding:4px 6px}tr{break-inside:avoid}thead{display:table-header-group}h2,h3{break-after:avoid}
  .cards{gap:6px}.card{break-inside:avoid;padding:7px 9px;font-size:10.2px}.card h4{font-size:12.5px}
  ol.src{column-count:2;column-gap:16px;font-size:8.5px}ol.src li{break-inside:avoid}details.gaps{display:none}
  .pattern,.dir,.q{break-inside:avoid}
}
@page{size:A4;margin:14mm 12mm}
"""

SCRIPT = """
const $=s=>document.querySelector(s);const cards=[...document.querySelectorAll('.card.tool')];
function apply(){const a=$('#f-a').value,o=$('#f-o').value,q=$('#f-q').value.trim().toLowerCase();let n=0;
for(const c of cards){const ok=(!a||c.dataset.a.includes('|'+a+'|'))&&(!o||c.dataset.o===o)&&(!q||c.textContent.toLowerCase().includes(q));c.style.display=ok?'':'none';if(ok)n++;}
$('#f-n').textContent=n+'개';}
['#f-a','#f-o','#f-q'].forEach(s=>$(s).addEventListener('input',apply));
window.addEventListener('beforeprint',()=>cards.forEach(c=>c.style.display=''));
"""


def task_table(tasks: list[dict], compact: bool = False) -> str:
    """업무 지도: 업무 | 해결하는 문제 | 자동화 방식 | 기계가 하는 것 | 사람이 하는 것 | 대표 툴."""
    if compact:
        head = ('<tr><th style="width:13%">업무</th><th style="width:27%">어떻게 자동화하나</th>'
                '<th class="auto" style="width:22%">자동</th><th class="human" style="width:20%">사람</th><th>대표 툴</th></tr>')
        body = "".join(
            f'<tr><td><b>{esc(t.get("task"))}</b></td><td>{esc(t.get("how"))}</td><td class="auto">{esc(t.get("automation_scope"))}</td>'
            f'<td class="human">{esc(t.get("human_scope"))}</td><td>{esc(", ".join(t.get("tools", [])[:5]) or "—")}</td></tr>' for t in tasks)
    else:
        head = ('<tr><th style="width:11%">업무</th><th style="width:17%">해결하는 문제</th><th style="width:20%">어떻게 자동화하나</th>'
                '<th class="auto" style="width:18%">자동으로 하는 것</th><th class="human" style="width:17%">사람이 하는 것</th><th>대표 툴</th></tr>')
        body = "".join(
            f'<tr><td><b>{esc(t.get("task"))}</b></td><td>{esc(t.get("problem"))}</td><td>{esc(t.get("how"))}</td>'
            f'<td class="auto">{esc(t.get("automation_scope"))}</td><td class="human">{esc(t.get("human_scope"))}</td>'
            f'<td>{esc(", ".join(t.get("tools", [])) or "—")}</td></tr>' for t in tasks)
    return f"<table><thead>{head}</thead><tbody>{body}</tbody></table>"


def tool_card(t: dict) -> str:
    areas = "|" + "|".join(t["_areas"]) + "|"
    origin = t.get("origin", "")
    feats = "".join(f"<li>{esc(f)}</li>" for f in t.get("features", [])[:6])
    extra = []
    if t.get("_kr_usage"):
        extra.append("<b>국내 사용</b> " + " · ".join(f'{esc(g.get("summary"))}{cites(g.get("evidence", []))}' for g in t["_kr_usage"]))
    if t.get("korea"):
        extra.append(f'<b>국내</b> {esc(t["korea"])}')
    if t.get("pricing"):
        extra.append(f'<b>요금</b> {esc(t["pricing"])}')
    return (f'<div class="card tool" data-a="{esc(areas)}" data-o="{esc(origin)}"><h4>{esc(t.get("name"))} '
            f'<span class="badge {"kr" if origin == "국내" else "gl"}">{esc(origin)}</span> <span class="badge">{esc(t.get("type"))}</span></h4>'
            f'<div class="muted">{esc(t.get("vendor"))} · 업무: {esc(", ".join(t.get("tasks", [])))}</div>'
            f'<div><b>해결하는 문제</b> {esc(t.get("problem"))}</div><div><b>누가 쓰나</b> {esc(t.get("users"))}</div>'
            f'<ul>{feats}</ul>'
            f'<div class="split"><div class="a"><b>자동</b> {esc(t.get("automation_scope"))}</div><div class="h"><b>사람</b> {esc(t.get("human_scope"))}</div></div>'
            + (f'<div class="muted" style="margin-top:4px">{" · ".join(extra)}</div>' if extra else "")
            + f'<div style="margin-top:2px">{cites(t.get("evidence", []))}{vendor_mark(t.get("evidence", []))}</div></div>')


def case_table(cases: list[dict], tools: list[dict], with_scope: bool = True) -> str:
    head = '<tr><th style="width:13%">기업</th><th style="width:13%">툴</th><th style="width:12%">업무</th><th>어떻게 썼나</th>'
    head += ('<th class="human" style="width:16%">사람이 한 것</th>' if with_scope else "") + '<th style="width:20%">결과</th></tr>'
    rows = []
    for u in cases:
        rows.append(f'<tr><td><b>{esc(u.get("company"))}</b></td><td>{esc(u.get("tool"))}{tool_origin_mark(u.get("tool", ""), tools)}</td><td>{esc(u.get("task"))}</td>'
                    f'<td>{esc(u.get("what"))}{cites(u.get("evidence", []))}</td>'
                    + (f'<td class="human">{esc(u.get("human_scope"))}</td>' if with_scope else "")
                    + f'<td>{esc(u.get("result") or "—")}{vendor_mark(u.get("evidence", []))}</td></tr>')
    return f"<table><thead>{head}</thead><tbody>{''.join(rows)}</tbody></table>"


def ranked_cases(cases: list[dict], n: int | None = None) -> list[dict]:
    """수치 결과가 있는 사례 → 제3자 근거가 있는 사례 순. n을 주면 대표 사례만: 같은 툴은 한 번만, n개까지."""
    ranked = sorted(cases, key=lambda u: (not has_number(u.get("result", "")),
                                          all(e.get("reliability") in VENDOR_REL for e in u.get("evidence", []))))
    if n is None:
        return ranked
    out, seen = [], set()
    for u in ranked:
        k = tool_key(u.get("tool", ""))
        if k in seen:
            continue
        seen.add(k)
        out.append(u)
        if len(out) == n:
            break
    return out


def insight_blocks(ins: dict) -> str:
    p = []
    if ins.get("patterns"):
        p.append('<h3>무엇이 보이나 <span class="badge">해석</span></h3>')
        p += [f'<div class="pattern"><b>{esc(pt.get("title"))}</b><br>{pt.get("body", "")}</div>' for pt in ins["patterns"]]
    if ins.get("directions"):
        p.append('<h3>범용 마케팅 자동화 서비스 방향 후보 <span class="badge">가설</span></h3>')
        for d in ins["directions"]:
            p.append(f'<div class="dir"><b class="t">{esc(d.get("title"))}</b><br>{d.get("body", "")}'
                     f'<div class="split"><div class="a"><b>자동</b> {esc(d.get("automation", ""))}</div><div class="h"><b>사람</b> {esc(d.get("human", ""))}</div></div>'
                     f'<div class="muted" style="margin-top:4px">비슷한 툴: {esc(d.get("similar", ""))}</div></div>')
    if ins.get("questions"):
        p.append('<h3>회의에서 정할 것</h3>' + "".join(f'<div class="q">{q}</div>' for q in ins["questions"]))
    return "".join(p)


def stats_table(stats: list[dict]) -> str:
    return ("<table><thead><tr><th style='width:20%'>주제</th><th>내용</th><th style='width:18%'>핵심 수치</th><th style='width:18%'>표본·날짜</th></tr></thead><tbody>"
            + "".join(f'<tr><td>{esc(s.get("topic"))}</td><td>{esc(s.get("finding"))}{cite(s.get("ref"))}</td><td>{esc(s.get("figures"))}</td>'
                      f'<td>{esc(s.get("sample"))}<br><span class="muted">{esc(s.get("date"))}</span> <span class="badge rel">{rel_label(s.get("reliability", ""))}</span></td></tr>'
                      for s in stats)
            + "</tbody></table>")


def head_html(title: str, extra_css: str = "") -> str:
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{esc(title)}</title><style>{CSS}{extra_css}</style></head><body><main>")


def render(tasks, tools, cases, stats, gaps, ins, sources: Sources, dropped: list[dict] | None = None,
           zero: list[dict] | None = None) -> str:
    title = ins.get("title", "마케팅 자동화는 무엇을, 어떤 툴로 하나")
    by_area_tasks, by_area_tools, by_area_cases = defaultdict(list), defaultdict(list), defaultdict(list)
    for t in tasks:
        by_area_tasks[t["_area"]].append(t)
    for t in tools:
        by_area_tools[t["_areas"][0]].append(t)
    for u in cases:
        by_area_cases[u["_area"]].append(u)
    n_kr = sum(t.get("origin") == "국내" for t in tools)

    p = [head_html(title), f'<h1>{esc(title)}</h1><div class="meta">{esc(ins.get("subtitle", ""))}</div>',
         '<nav class="toc"><a href="#sum">결론</a><a href="#frame">정리 기준</a><a href="#map">업무 지도</a><a href="#tools">툴</a>'
         '<a href="#cases">활용 사례</a><a href="#zero">초기·소규모 사례</a><a href="#stats">도입 통계</a><a href="#dir">방향 후보</a><a href="#gaps">한계</a><a href="#src">출처</a></nav>']
    if ins.get("tldr"):
        p.append('<div class="tldr" id="sum"><b>한눈에 보기</b><ul>' + "".join(f"<li>{t}</li>" for t in ins["tldr"]) + "</ul></div>")
    p.append(f'<div class="kpis"><div class="kpi"><b>{len(tasks)}</b>자동화 업무</div><div class="kpi"><b>{len(tools)}</b>툴·서비스 (국내 {n_kr})</div>'
             f'<div class="kpi"><b>{len(cases)}</b>활용 사례</div><div class="kpi"><b>{len(sources.items)}</b>출처</div></div>')

    p.append('<h2 id="frame">0. 정리 기준</h2>'
             '<p>각 업무를 <b>어떤 문제를 해결하나 → 누가 쓰나 → <span style="background:var(--auto)">자동으로 하는 것</span> → '
             '<span style="background:var(--human)">사람이 하는 것</span></b> 순서로 나눴습니다. 사람이 직접 하는 영업(대면·전화)과 입소문은 뺐고, '
             '영업을 돕는 자동화(리드 점수, 제안서 초안, 메일 시퀀스)는 넣었습니다.</p>'
             '<p class="muted">신뢰도 표시: ' + " ".join(f'<span class="badge rel">{v}</span>' for v in RELIABILITY.values())
             + '. 근거가 모두 툴 회사나 사용 기업 발표인 항목에는 <span class="badge rel">회사 발표</span>를 붙였습니다. 해석·가설은 따로 표시했습니다.</p>')

    p.append('<h2 id="map">1. 영역별 업무 지도 — 무엇을 어떻게 자동화하나</h2>')
    for i, a in enumerate(AREAS, 1):
        if by_area_tasks.get(a):
            p.append(f"<h3>1-{i}. {esc(a)}</h3>" + task_table(by_area_tasks[a]))

    p.append('<h2 id="tools">2. 툴·서비스 — 실제로 어떤 기능을 주나</h2><div class="filters">'
             '<select id="f-a"><option value="">전체 영역</option>' + "".join(f"<option>{esc(a)}</option>" for a in AREAS) + "</select>"
             '<select id="f-o"><option value="">국내·해외</option><option>국내</option><option>해외</option></select>'
             '<input id="f-q" placeholder="툴·기능 검색"><span id="f-n" class="muted"></span></div>')
    for i, a in enumerate(AREAS, 1):
        ts = sorted(by_area_tools.get(a, []), key=lambda t: t.get("origin") != "국내")
        if ts:
            p.append(f"<h3>2-{i}. {esc(a)} ({len(ts)}개)</h3><div class='cards'>" + "".join(tool_card(t) for t in ts) + "</div>")

    if dropped:
        p.append('<p class="muted"><b>국내 사용 근거를 확인하지 못해 뺀 해외 툴</b>(전체판 <code>index-all.html</code>에 있음): '
                 + esc(", ".join(t["name"] for t in dropped)) + "</p>")
    p.append('<h2 id="cases">3. 활용 사례 — 실제로 어떻게 쓰고 무엇이 달라졌나</h2>'
             '<p class="muted">수치 결과가 있는 사례를 앞에 두었습니다. 툴 회사가 낸 고객 사례 수치는 독립 검증이 안 된 회사 발표입니다.</p>')
    for i, a in enumerate(AREAS, 1):
        cs = ranked_cases(by_area_cases.get(a, []))
        if cs:
            p.append(f"<h3>3-{i}. {esc(a)}</h3>" + case_table(cs, tools))

    if zero:
        p.append(f'<h2 id="zero">4. 초기·소규모(제로베이스) 사례 ({len(zero)}개)</h2><p class="muted">{ZERO_NOTE}</p>' + zero_table(zero, tools))
    p.append('<h2 id="stats">5. 도입 현황 통계</h2>')
    sg: dict[str, list[dict]] = defaultdict(list)
    for s in stats:
        sg[s["_group"]].append(s)
    for g in AREAS:
        if sg.get(g):
            p.append(f"<h3>{esc(g)}</h3>" + stats_table(sg[g]))

    p.append('<h2 id="dir">6. 해석 — 범용 자동화 서비스 방향</h2>' + insight_blocks(ins))

    p.append('<h2 id="gaps">7. 한계</h2>')
    if ins.get("limits"):
        p.append("<ul>" + "".join(f"<li>{t}</li>" for t in ins["limits"]) + "</ul>")
    p.append('<details class="gaps"><summary>영역별 상세 한계</summary><ul>' + "".join(f'<li><b>{esc(g["group"])}</b>: {esc(g["text"])}</li>' for g in gaps) + "</ul></details>")
    p.append('<h2 id="src">출처</h2><ol class="src">' + "".join(
        f'<li id="s{i}"><a href="{esc(s["url"])}">{esc(s["url"])}</a> <span class="muted">{esc(s["date"])} · {rel_label(s["reliability"])}</span></li>'
        for i, s in enumerate(sources.items, 1)) + "</ol>")
    p.append(f'<p class="muted">{esc(ins.get("method", ""))}</p>')
    p.append(f"</main><script>{SCRIPT}apply();</script></body></html>")
    return "".join(p)


SUMMARY_CSS = """
@media print{body{font-size:10.3px}h2{margin:12px 0 6px;font-size:15px}h3{margin:10px 0 4px;font-size:12.5px}table{font-size:9.6px}td,th{padding:3px 5px}
.pattern,.dir,.q{padding:4px 10px;margin:5px 0}.tldr{padding:6px 14px}}
"""


def render_summary(tasks, tools, cases, stats, ins, sources: Sources, zero: list[dict] | None = None) -> str:
    """회의용 요약본: 결론 → 영역별 업무 지도(간단) → 대표 활용 사례 → 방향 후보·회의 질문. 출처 번호는 본문과 같다."""
    title = ins.get("title", "마케팅 자동화는 무엇을, 어떤 툴로 하나")
    p = [head_html(f"{title} — 요약", SUMMARY_CSS),
         f'<h1>{esc(title)} — 회의용 요약</h1><div class="meta">{esc(ins.get("subtitle", ""))} '
         f'툴별 기능·요금·출처 전체는 본문(<code>{esc(ins.get("full_pdf", "마케팅-자동화-툴-조사.pdf"))}</code>)에 있고, [번호]는 본문의 출처 번호입니다.</div>']
    p.append('<div class="tldr"><b>한눈에 보기</b><ul>' + "".join(f"<li>{t}</li>" for t in ins.get("tldr", [])) + "</ul></div>")
    p.append('<h2>1. 영역별로 무엇을 자동화하나 <span class="muted" style="font-size:12px;font-weight:normal">초록=자동, 노랑=사람</span></h2>')
    for i, a in enumerate(AREAS, 1):
        ts = [t for t in tasks if t["_area"] == a]
        if ts:
            p.append(f"<h3>1-{i}. {esc(a)}</h3>" + task_table(ts, compact=True))
    p.append('<h2>2. 대표 활용 사례</h2><p class="muted">영역마다 수치 결과가 있는 사례 위주로 2~3개씩 골랐습니다.</p>')
    picked = [u for a in AREAS for u in ranked_cases([c for c in cases if c["_area"] == a], 3 if a != AREAS[-1] else 2)]
    p.append(case_table(picked, tools, with_scope=False))
    n = 3
    if zero:
        names = ins.get("summary_zero")  # 회의 대본·한눈에 보기에서 말하는 사례를 요약본에 꼭 싣기 위해 직접 고른다
        picked = [u for n_ in names for u in zero if u.get("company", "").startswith(n_)] if names else pick_zero(zero)
        missing = [n_ for n_ in names or [] if not any(u.get("company", "").startswith(n_) for u in zero)]
        if missing:
            raise SystemExit(f"summary_zero에 없는 사례: {missing}")
        p.append(f'<h2>{n}. 초기·소규모(제로베이스) 사례</h2><p class="muted">{ZERO_NOTE} 묶음마다 수치가 있는 사례 위주로 {len(picked)}개를 골랐고, '
                 f'전체 {len(zero)}개는 본문에 있습니다.</p>' + zero_table(picked, tools))
        n += 1
    key = [s for s in stats if s.get("topic") in set(ins.get("summary_stats", []))]
    if key:
        p.append(f'<h2>{n}. 도입 현황 숫자</h2><table><thead><tr><th style="width:26%">주제</th><th>핵심 수치</th><th style="width:22%">조사·날짜</th></tr></thead><tbody>'
                 + "".join(f'<tr><td>{esc(s["topic"])}</td><td>{esc(s.get("finding"))}{cite(s.get("ref"))}</td><td>{esc(s.get("sample"))} · {esc(s.get("date"))}</td></tr>' for s in key)
                 + "</tbody></table>")
        n += 1
    p.append(f'<h2>{n}. 해석과 방향 후보</h2>' + insight_blocks(ins))
    if ins.get("limits"):
        p.append('<h2>한계</h2><ul class="muted">' + "".join(f"<li>{t}</li>" for t in ins["limits"]) + "</ul>")
    p.append("</main></body></html>")
    return "".join(p)


def render_readme(tasks, tools, cases, stats, ins, sources: Sources) -> str:
    lines = [f'# {ins.get("title", "마케팅 자동화는 무엇을, 어떤 툴로 하나")}', "", ins.get("subtitle", ""), "",
             "- **회의용 요약본**: `automation-summary.pdf`(`summary.html` 인쇄) — 결론, 영역별 업무 지도, 대표 활용 사례, 방향 후보·회의 질문.",
             "- **본문**: `index.html`(툴 필터·검색), 인쇄본 `automation-tools.pdf`.",
             "- **범위**: 기본은 국내 버전(툴은 국내 툴 + 국내 사용 근거가 있는 해외 툴, 활용 사례는 국내 기업, 통계는 국내 조사). 해외 포함 전체판은 "
             "`python3 build.py --all` → `index-all.html`·`summary-all.html`(해석은 `data/insights-all.json`).",
             "- **데이터**: `tools.json`(국내 버전 합친 데이터), `data/*.json`(영역별 원자료, 8~10은 국내 보강, 11은 해외 툴 국내 사용 근거, 12~14는 초기·소규모 사례), `data/insights.json`(국내 해석).",
             "- **전달본**: `./final.sh` → build.py, PDF 2개 인쇄, `../final/`에 한글 이름으로 복사.", "",
             "## 한눈에 보기", ""]
    lines += [f"- {re.sub('<[^>]+>', '', t)}" for t in ins.get("tldr", [])]
    lines += ["", f"업무 {len(tasks)}개 · 툴 {len(tools)}개 · 활용 사례 {len(cases)}개 · 통계 {len(stats)}개 · 출처 {len(sources.items)}개", "",
              "| 툴 | 영역 | 업무 |", "|---|---|---|"]
    for t in tools:
        lines.append(f'| {t.get("name")} | {", ".join(t["_areas"])} | {", ".join(t.get("tasks", []))} |')
    return "\n".join(lines) + "\n"


def main() -> None:
    """기본: 국내 버전(index.html·summary.html·tools.json·README.md). --all: 해외 포함 전체판(index-all.html·summary-all.html)."""
    scope_all = "--all" in sys.argv[1:]
    tasks, tools, cases, stats, gaps, usage = load()
    tools = dedupe_tools(tools)
    cases = dedupe_cases(cases)
    zero, cases = split_zero(cases)
    attach_kr_usage(tools, usage, cases)
    dropped: list[dict] = []
    if not scope_all:
        tools = [t for t in tools if not (t.get("_zero") and t.get("origin") == "해외")]  # 해외 초기 사례에만 나오는 툴은 국내판 툴 목록에 넣지 않는다
        domestic_only(cases, stats)
        dropped = split_by_kr_usage(tools)
        for t in tasks:  # 업무 지도의 대표 툴도 남은 툴만
            t["tools"] = [n for n in t.get("tools", []) if any(same_tool(n, x["name"]) for x in tools)]
    ins = json.loads((DATA / ("insights-all.json" if scope_all else "insights.json")).read_text())
    sources = Sources()
    normalize(tools, cases, stats, sources, zero)
    suffix = "-all" if scope_all else ""
    (ROOT / f"index{suffix}.html").write_text(render(tasks, tools, cases, stats, gaps, ins, sources, dropped, zero))
    (ROOT / f"summary{suffix}.html").write_text(render_summary(tasks, tools, cases, stats, ins, sources, zero))
    if not scope_all:
        (ROOT / "tools.json").write_text(json.dumps({"tasks": tasks, "tools": tools, "use_cases": cases, "zero_cases": zero, "stats": stats, "gaps": gaps,
                                                     "sources": sources.items}, ensure_ascii=False, indent=1))
        (ROOT / "README.md").write_text(render_readme(tasks, tools, cases, stats, ins, sources))
    print(f"scope={'all' if scope_all else 'kr'} tasks={len(tasks)} tools={len(tools)} cases={len(cases)} "
          f"zero={len(zero)} stats={len(stats)} sources={len(sources.items)}")
    print("tools by area:", Counter(t["_areas"][0] for t in tools).most_common())
    print("cases by area:", Counter(u["_area"] for u in cases).most_common())


if __name__ == "__main__":
    main()
