"""요약본 생성기: cases.json(build.py 결과)에서 집계를 다시 계산해 summary.html을 만든다.

집계(채널 순위·구분별 1위)는 코드가 cases.json에서 계산하고,
대표 근거·통계 문장은 아래 HIGHLIGHTS/STATS에 손으로 고른다(모두 data/*.json에 있는 수치).
사용: python3 build.py && python3 summary.py → Chrome으로 acquisition-summary.pdf 인쇄(README 참고)
"""
from __future__ import annotations

import html
import json
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
HIGHLIGHTS = [
    ("캐시노트 (사장님 매출 관리 앱)", "입소문·추천", "출시 8개월 가입 3.4만 곳 중 절반이 자발적 입소문(사장님 단톡방)", "인터뷰"),
    ("Square (미국 결제 단말·POS)", "입소문·추천", "판매자의 약 절반이 스스로 가입", "공시(S-1)"),
    ("Toast (미국 식당용 POS)", "입소문·추천", "신규 매장 약 3분의 2가 인바운드, 그중 추천 20% 이상", "공시(S-1)"),
    ("Wix (홈페이지 제작 도구)", "입소문·추천", "유료 구독의 59%가 오가닉·직접 유입", "공시"),
    ("리멤버 (명함 관리 앱)", "입소문·추천", "사용자 유입 경로 40% 이상이 지인 추천", "회사 설문"),
    ("포스뱅크 (POS·키오스크 기기)", "대리점", "국내 매출의 94.1%가 대리점 경유", "사업보고서"),
    ("Clover (미국 결제 단말·POS)", "대리점", "신규 매장 약 60%가 대리점·에이전트 경유", "투자자 발표"),
    ("Bill.com (미국 기업 결제·정산)", "파트너(회계법인)", "고객의 54%가 회계법인 경유", "공시(S-1)"),
    ("토스플레이스 (결제 단말·POS)", "대리점", "VAN 대리점·단말기 무상 설치로 3천 → 50만 매장. 2024년 순손실 536억 원", "언론·회사"),
    ("Uber Eats (미국 음식 배달)", "기존 사용자", "첫 이용자의 절반이 기존 우버 사용자", "공시(S-1)"),
    ("Ibotta (미국 장보기 캐시백 앱)", "제휴", "리딤 사용자 820만 중 620만(76%)이 제휴 유통사 앱 경유", "공시(S-1)"),
    ("동네선물 (지역 상점 모바일 상품권)", "공공사업", "가맹점 2,100곳 중 1,500곳이 시흥시 지역화폐 시범사업 지역", "인터뷰"),
    ("카카오 프로젝트 단골 (카카오톡 채널 단골 관리)", "교육", "상인 현장 교육 4,112명 → 카카오톡 채널 4,000여 개 개설", "회사 발표"),
    ("시프티 (직원 근태·스케줄 관리)", "무료 제공", "소규모 사업장 무료 제공 후 도입 문의 350% 증가", "회사 발표"),
    ("Mailchimp (이메일 마케팅 도구)", "무료 플랜", "무료 요금제 도입 1년 만에 사용자 5배", "회사 블로그"),
]

# (주제, 수치, 출처)
STATS = [
    ("국내 자영업자가 사업 정보를 얻는 곳", "주변 지인 44% · 인터넷 기사 30% · 세무사 17%", "엠브레인, 자영업자 1,075명, 2021 · 최신판 없음"),
    ("소상공인이 지원제도를 알게 된 경로 (최신 대용)", "뉴스·신문 30.2% · 정부 홈페이지 17.3% · SNS 16.8% · 지인·동료 15.2%", "중기중앙회, 노란우산 396명, 2025-07"),
    ("자영업자 경영 애로", "신규 고객 확보 65.9% (재료비 68.7%, 경쟁 66.2% 다음)", "국회미래연구원, 3,088명, 2026-02"),
    ("미국 로컬 사업자의 신규 고객 1위 채널", "입소문 35% · 소셜 33%", "BrightLocal, 1,002명, 2026"),
    ("정부 디지털 지원사업을 안 쓴 이유", "'있는 줄 몰라서' 76.2% (참여율 3.2%)", "중기중앙회, 2026"),
    ("키오스크를 들인 계기", "본사 지시 27.1% · 정부 지원 4.0%", "2024-12 설문"),
    ("배달앱을 쓰기 시작한 이유", "사업 범위 확대 28.5% · 안 하면 영업 어려움 28.2% · 경쟁 업체가 써서 22.4% · 광고/홍보 20.9%", "중기부·동반위, 입점 음식점 808곳, 2026-01 (2020년 조사 대체)"),
    ("국내 B2B가 꼽은 가장 효과적인 리드 채널", "기존 네트워크(소개·지인) 32.1%", "리캐치, 93곳, 2024"),
    ("리워드 앱을 처음 알게 된 경로", "지인 추천 28.3% · 앱스토어 25.2%", "1,001명, 2025"),
    ("소상공인 디지털 도구 활용률", "27.2% (매장관리 도구는 전체의 9.4%)", "소상공인실태조사, 2026-03"),
    ("네이버 플레이스 쿠폰(무료) 사용 업체", "252만 곳 중 약 19만 곳(약 7.5%)", "네이버, 2024"),
    ("외식하러 가게 된 계기", "약속·모임 44.3% · 광고·SNS 2.1%", "픽플리, 2026 1분기"),
    ("소비자가 쿠폰·할인 정보를 보는 곳", "쇼핑앱 40.8% · 문자/알림 29%", "2026-03 설문"),
    ("카카오 알림톡 반응", "오픈 82.3% · 클릭 11.5%", "발송사 데이터, 2026"),
]

FAILS = [
    ("기능을 앞세운 광고", "캐시노트 '카카오톡으로 재무관리' 페이스북 광고는 반응이 없었고, '카드 매출 누락' 손익 메시지로 바꾸자 가입이 늘었습니다."),
    ("광고비로 사장님 모으기", "Fivestars는 페이스북·구글 광고로 연 70% 성장했지만 광고비가 오르고 매장 월 이탈 3%에 막혔습니다."),
    ("큰 할인·현금 보상", "Groupon·LivingSocial은 딜 이용자가 다시 오지 않아 매장이 손해를 봤습니다. 틱톡 라이트는 1인 약 4.5~5만 원 초대 보상으로 규제 검토를 받았습니다."),
    ("인센티브가 끝나면 빠짐", "공공배달 땡겨요는 소비쿠폰이 끝난 뒤 MAU가 36.6% 줄었습니다."),
    ("무료인데도 안 씀", "네이버 플레이스 쿠폰은 무료여도 약 7.5%만 썼습니다. 무료는 진입 장벽만 낮출 뿐입니다."),
    ("'새 손님 보내기'만 팔기", "Booksy는 예약의 60~80%가 단골이라 신규 고객 중개 모델을 접고 매장 관리 도구로 바꿨습니다."),
]

TAKEAWAYS = [
    ("PLUS 가입 경로부터 잽니다", "가입 UTM 기록(<code>tn_company_attribution</code>)이 실제로 쌓이는지 확인하고, 가입할 때 '어떻게 알게 되셨나요'를 필수로 묻습니다. 다른 회사 비중은 참고일 뿐입니다."),
    ("사장님 추천을 설계합니다", "추천한 사장님과 추천받은 사장님 모두에게 PLUS 크레딧을 주고, 상인회·사장님 단톡방을 공략합니다(캐시노트·리멤버 방식)."),
    ("매장에 드나드는 사람에게 수수료를 줍니다", "POS·VAN 대리점, 세무사, 프랜차이즈 본사가 채널입니다. 쿠핀은 카드 결제를 만들지 않아 대리점 수익이 없으므로 가입 건당 보상이 필요합니다."),
    ("한 상권에 몰아서 시작합니다", "대학가나 신도시 한 곳에서 PLUS 매장과 ON 이용자 목표를 함께 세우고, 넘으면 다음 상권으로 갑니다(배민·캐치테이블·당근·핫페퍼)."),
    ("손익으로 말하고, 쿠폰 화면이 홍보하게 합니다", "'떠난 단골을 쿠폰 한 번으로 다시 오게' 같은 메시지를 씁니다. 손님이 받는 쿠폰·QR 화면에 '사장님도 무료로 시작'을 붙입니다."),
]


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


def main() -> None:
    data = json.loads((ROOT / "cases.json").read_text())
    cases = data["cases"]
    top = lambda cs: Counter(c["top_channel"]["type"] for c in cs)  # noqa: E731
    kr = [c for c in cases if c.get("country") == "KR"]
    glob = [c for c in cases if c.get("country") != "KR"]
    num = [c for c in cases if c["top_channel"]["numeric"]]
    all_rank = top(cases).most_common()

    seg_rows = []
    for seg, desc in SEGMENTS:
        cs = [c for c in cases if c["segment"] == seg]
        ranked = top(cs).most_common(3)
        first = ranked[0][0]
        examples = ", ".join(c["service"].split("(")[0].strip() for c in cs if c["top_channel"]["type"] == first)[:90]
        seg_rows.append(
            f"<tr><td><b>{esc(seg)}</b><br><span class='muted'>{esc(desc)} · {len(cs)}곳</span></td>"
            f"<td><b>{esc(first)}</b> {ranked[0][1]}곳</td>"
            f"<td>{' · '.join(f'{esc(k)} {v}' for k, v in ranked[1:])}</td><td class='muted'>{esc(examples)}</td></tr>"
        )

    h = []
    h.append('<header><div class="eyebrow">요약본 · 2026-11-24 · 전준연</div><h1>다른 서비스는 어떻게 사용자를 모았나</h1>'
             f'<p class="lead">국내외 <b>{len(cases)}개 서비스</b>(국내 {len(kr)} · 해외 {len(glob)})와 통계 {len(data["stats"])}개, 출처 {len(data["sources"])}개를 정리한 '
             '<code>acquisition-cases</code> 문서의 결론만 모았습니다. 근거 전체는 본문 PDF·index.html에 있습니다.</p></header>')

    h.append('<section class="answer"><h2>결론</h2><ol>'
             f'<li><b>가장 많았던 주 채널은 입소문·추천({dict(all_rank)["입소문·추천"]}곳)과 직접 영업({dict(all_rank)["직접 영업"]}곳), 그다음 대리점·파트너({dict(all_rank)["대리점·리셀러·파트너"]}곳)입니다.</b> 이 셋이 전체의 {round(100 * sum(dict(all_rank)[k] for k in ["입소문·추천", "직접 영업", "대리점·리셀러·파트너"]) / len(cases))}%입니다. 광고(SNS·검색·TV)가 주 채널인 곳은 {sum(dict(all_rank).get(k, 0) for k in ["SNS·디지털 광고", "검색 광고", "TV·옥외 등 매스 광고"])}곳뿐입니다.</li>'
             f'<li><b>숫자로 확인되는 사례({len(num)}곳)만 보면 입소문·추천이 1위({top(num).most_common(1)[0][1]}곳)입니다.</b> 캐시노트·Square·Toast·Wix처럼 셀프 가입 서비스에서 절반 안팎이 자발 가입·추천이었습니다.</li>'
             '<li><b>누구를 모으느냐에 따라 1위 채널이 다릅니다.</b> 사장님이 쓰는 매장 도구는 대리점, 플랫폼의 매장 확보는 직접 영업, 소비자 앱은 입소문·리워드, B2B는 콘텐츠·SEO가 1위입니다.</li>'
             '<li><b>사장님은 사람에게서 정보를 얻습니다.</b> 국내 자영업자의 정보 출처 1위는 주변 지인(44%, 2021)이고, 지원사업을 안 쓴 사장님의 76.2%는 있는 줄 몰랐습니다. 광고만으로는 닿지 않는다는 뜻입니다.</li>'
             '<li><b>쿠핀 PLUS에 맞는 조합은 "사장님 추천 + 대리점·세무사 파트너 + 한 상권 집중"입니다.</b> 다만 이것은 남의 사례에서 나온 가설이고, 먼저 우리 가입 경로를 재야 합니다.</li>'
             '</ol></section>')

    h.append('<h2>1. 어떤 채널이 가장 많았나</h2><p class="muted">각 서비스의 "주 채널"(가장 많이 들어온 곳) 하나씩을 셌습니다.</p><div class="grid4">'
             f'<div><h3>전체 {len(cases)}곳</h3>{bars(top(cases))}</div>'
             f'<div><h3>수치 근거 있는 {len(num)}곳</h3>{bars(top(num), color="#16a34a")}</div>'
             f'<div><h3>국내 {len(kr)}곳</h3>{bars(top(kr), color="#7c3aed")}</div>'
             f'<div><h3>해외 {len(glob)}곳</h3>{bars(top(glob), color="#ea580c")}</div></div>'
             '<p class="note">국내는 <b>무료 제공</b>(시프티·카페24·당근 비즈프로필·네이버 스마트스토어 등)이 2위로 올라오고, 해외는 <b>직접 영업</b>(OpenTable·Meituan·DoorDash 등 매장 확보)이 1위입니다.</p>')

    h.append('<h2>2. 누구를 모으느냐에 따라 달랐다</h2><table><thead><tr><th style="width:27%">구분</th><th style="width:19%">1위 채널</th><th style="width:24%">2·3위</th><th>1위 채널 사례</th></tr></thead><tbody>'
             + "".join(seg_rows) + "</tbody></table>")

    h.append('<h2>3. 숫자로 확인된 대표 사례</h2><table><thead><tr><th style="width:24%">서비스</th><th style="width:14%">주 채널</th><th>수치</th><th style="width:13%">출처</th></tr></thead><tbody>'
             + "".join(f"<tr><td><b>{esc(a)}</b></td><td>{esc(b)}</td><td>{esc(c)}</td><td class='muted'>{esc(d)}</td></tr>" for a, b, c, d in HIGHLIGHTS) + "</tbody></table>")

    h.append('<h2>4. 사람들은 어디서 알게 되나 — 핵심 통계</h2><table><thead><tr><th style="width:32%">주제</th><th>수치</th><th style="width:26%">출처·표본</th></tr></thead><tbody>'
             + "".join(f"<tr><td>{esc(a)}</td><td><b>{esc(b)}</b></td><td class='muted'>{esc(c)}</td></tr>" for a, b, c in STATS) + "</tbody></table>")

    h.append('<h2>5. 잘 안 된 것</h2><table><tbody>'
             + "".join(f"<tr><td style='width:24%'><b>{esc(a)}</b></td><td>{esc(b)}</td></tr>" for a, b in FAILS) + "</tbody></table>")

    h.append('<h2>6. 쿠핀 PLUS·ON에 적용 <span class="tag">해석·가설</span></h2><ol class="take">'
             + "".join(f"<li><b>{a}</b> — {b}</li>" for a, b in TAKEAWAYS) + "</ol>")

    h.append(f'<p class="foot">읽는 법과 한계: 채널별 가입 비중을 공개한 회사는 적어서, 주 채널을 수치로 뒷받침하는 곳은 {len(cases)}곳 중 {len(num)}곳입니다. 나머지는 대표 인터뷰·회사 설명 기준입니다. '
             '여러 조사 묶음에서 겹친 서비스는 하나로 합쳤습니다. 일부 자료는 2010년대 초기 성장기 자료입니다. 상세 근거·출처: <code>acquisition-cases/acquisition-cases.pdf</code>, <code>index.html</code>.</p>')

    (ROOT / "summary.html").write_text(f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>요약 — 다른 서비스는 어떻게 사용자를 모았나</title><style>{CSS}</style></head><body>{"".join(h)}</body></html>')
    print("summary.html", len(cases), len(num), all_rank[:3])


if __name__ == "__main__":
    main()
