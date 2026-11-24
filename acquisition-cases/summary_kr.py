"""국내 기업 버전 요약본: cases.json에서 국내 기업 사례만 골라 summary-kr.html을 만든다.

- 대상: country == "KR" 이면서 해외 기업이 아닌 사례(틱톡 라이트·테무처럼 국내 시장의 해외 기업은 제외).
- 집계는 코드가 계산하고, 대표 근거·통계 문장은 아래 목록에서 손으로 고른다(모두 data/*.json에 있는 수치).
사용: python3 build.py && python3 summary_kr.py → Chrome으로 acquisition-summary-kr.pdf 인쇄(README 참고)
"""
from __future__ import annotations

import json
from collections import Counter

from summary import CSS, ROOT, SEGMENTS, bars, esc

FOREIGN_COMPANIES = ("틱톡", "테무")
AD_CHANNELS = ("SNS·디지털 광고", "검색 광고", "TV·옥외 등 매스 광고")



def domestic_cases(data: dict) -> list[dict]:
    """국내 기업 사례만: 국가가 KR이면서 국내 시장의 해외 기업(FOREIGN_COMPANIES)은 뺀다."""
    return [c for c in data["cases"] if c.get("country") == "KR" and not any(f in c.get("service", "") for f in FOREIGN_COMPANIES)]


# (서비스, 주 채널, 수치, 출처 종류)
HIGHLIGHTS = [
    ("캐시노트 (사장님 매출 관리 앱)", "입소문·추천", "출시 8개월 가입 3.4만 곳 중 절반이 자발적 입소문(사장님 단톡방). 오프라인 영업 없이 30만 곳", "인터뷰"),
    ("리멤버 (명함 관리 앱)", "입소문·추천", "사용자 유입 경로 40% 이상이 지인 추천", "회사 설문"),
    ("셀러 금융 서비스 (온라인 판매자 대상 금융, 이름 비공개)", "입소문·추천", "'블로그 후기 + 추천 코드' 이벤트가 1년 가입의 20~30%", "담당자 기고"),
    ("삼쩜삼 (종합소득세 환급 조회)", "입소문·추천", "사용자 트윗 확산으로 한 달 만에 누적 가입 4.34배", "언론"),
    ("포스뱅크 (POS·키오스크 기기)", "대리점", "국내 매출의 94.1%가 대리점 경유", "사업보고서"),
    ("토스플레이스 (결제 단말·POS)", "대리점", "VAN 대리점·단말기 무상 설치로 2026-09 설치 가맹점 50만 곳. 2024년 순손실 536억 원", "언론·회사"),
    ("메뉴잇 (테이블 주문·키오스크)", "제휴·번들", "SK쉴더스 '캡스 스마트오더' 제휴로 6,000여 매장 설치", "언론"),
    ("땡겨요 (신한은행 배달앱)", "기존 조직(은행)", "은행 지점·지자체 협약·수수료 2%로 가맹점 14만 → 35.5만 곳(2년 4개월)", "언론"),
    ("배달특급 (경기도 공공 배달앱)", "상인단체·지자체", "사전접수 6주에 가맹점 3,699곳(목표 3,000곳). 소상공인연합회·외식업중앙회·맘카페 협조", "운영사"),
    ("동네선물 (지역 상점 모바일 상품권)", "공공사업", "가맹점 2,100곳 중 1,500곳이 시흥시 지역화폐 시범사업 지역", "인터뷰"),
    ("카카오 프로젝트 단골 (카카오톡 채널 단골 관리)", "교육", "상인 현장 교육 4,112명 → 카카오톡 채널 4,000여 개 개설", "회사 발표"),
    ("시프티 (직원 근태·스케줄 관리)", "무료 제공", "소규모 사업장 무료 제공 후 도입 문의 350% 증가", "회사 발표"),
    ("기프티쇼 비즈 (기업용 모바일 상품권 발송)", "콘텐츠·SEO", "검색광고(월 2,200만 원)를 끄고 SEO로 논브랜드 유입 약 700% 증가", "회사 블로그"),
    ("캐치테이블 (식당 예약)", "직접 영업", "대표가 하루 30~40곳 방문해 4개월 17곳 → 이후 입소문으로 2년 반 만에 2,000곳", "인터뷰"),
    ("토스 만보기 (걸음 수 리워드)", "리워드", "매장 '방문 미션'(곳당 20원) 추가 후 누적 사용자 46만 → 400만", "회사 발표"),
]

STATS = [
    ("자영업자가 사업 정보를 얻는 곳", "주변 지인 44% · 인터넷 기사 30% · 세무사 17%", "엠브레인, 자영업자 1,075명, 2021 · 최신판 없음"),
    ("소상공인이 지원제도를 알게 된 경로 (최신 대용)", "뉴스·신문 30.2% · 정부 홈페이지 17.3% · SNS 16.8% · 지인·동료 15.2%", "중기중앙회, 노란우산 396명, 2025-07"),
    ("자영업자 경영 애로", "신규 고객 확보 65.9% (재료비 68.7%, 경쟁 66.2% 다음)", "국회미래연구원, 3,088명, 2026-02"),
    ("정부 디지털 지원사업을 안 쓴 이유", "'있는 줄 몰라서' 76.2% (참여율 3.2%)", "중기중앙회, 2026"),
    ("키오스크를 들인 계기", "본사 지시 27.1% · 정부 지원 4.0%", "2024-12 설문"),
    ("배달앱을 쓰기 시작한 이유", "사업 범위 확대 28.5% · 안 하면 영업 어려움 28.2% · 경쟁 업체가 써서 22.4% · 광고/홍보 20.9%", "중기부·동반위, 입점 음식점 808곳, 2026-01 (2020년 조사 대체)"),
    ("국내 B2B가 꼽은 가장 효과적인 리드 채널", "기존 네트워크(소개·지인) 32.1%", "리캐치, 93곳, 2024"),
    ("소상공인 대상 B2B 기업의 리드 채널", "제휴·파트너십 72.2%", "리캐치, 2024"),
    ("리워드 앱을 처음 알게 된 경로", "지인 추천 28.3% · 앱스토어 25.2%", "1,001명, 2025"),
    ("소상공인 디지털 도구 활용률", "27.2% (매장관리 도구는 전체의 9.4%)", "소상공인실태조사, 2026-03"),
    ("소상공인 소프트웨어 결제 방식", "구독 45% · 월 1~3만 원과 3~5만 원이 각 14.4%", "2026-06 조사"),
    ("중소상공인 디지털 광고", "이용 57.4% · 월 29만 원 · 네이버 79.1% · 인스타 48.7%", "닐슨코리아, 2021 · 최신판 없음"),
    ("네이버 플레이스 쿠폰(무료) 사용 업체", "252만 곳 중 약 19만 곳(약 7.5%)", "네이버, 2024"),
    ("외식하러 가게 된 계기", "약속·모임 44.3% · 광고·SNS 2.1% · 탐색은 네이버 42.4%", "픽플리, 2026 1분기"),
    ("소비자가 쿠폰·할인 정보를 보는 곳", "쇼핑앱 40.8% · 문자/알림 29%", "2026-03 설문"),
    ("카카오 알림톡 반응", "오픈 82.3% · 클릭 11.5%", "발송사 데이터, 2026"),
]

FAILS = [
    ("기능을 앞세운 광고", "캐시노트 '카카오톡으로 재무관리' 페이스북 광고는 반응이 없었고, '카드 매출 누락' 손익 메시지로 바꾸자 가입이 늘었습니다."),
    ("직접 판매만으로 버티기", "메뉴잇은 직접 판매 중 자본잠식에 빠졌다가 SK쉴더스 번들로 돌아섰습니다. KT 하이오더도 자체 영업에서 대리점 위탁으로 바꿨습니다."),
    ("돈이 많이 드는 확장", "토스플레이스는 단말기 비용을 돌려주며 50만 곳을 모았지만 2024년 순손실이 536억 원이었습니다. 토스 만보기는 이용자가 늘수록 보상 비용도 늘어, 보상 앞에 광고를 붙여 비용을 메워야 했습니다."),
    ("인센티브가 끝나면 빠짐", "공공배달 땡겨요는 소비쿠폰 종료 후 MAU가 355만 → 225만(-36.6%), 경기지역화폐도 22.4% 줄었습니다."),
    ("무료인데도 안 씀", "네이버 플레이스 쿠폰은 무료여도 약 7.5%만 썼습니다. 무료는 진입 장벽만 낮출 뿐입니다."),
    ("지원사업에만 기대기", "정부 디지털 지원사업은 참여율 3.2%이고, 미참여 사장님 76.2%는 존재를 몰랐습니다. 알리는 채널이 따로 필요합니다."),
]

TAKEAWAYS = [
    ("PLUS 가입 경로부터 잽니다", "가입 UTM 기록(<code>tn_company_attribution</code>)이 실제로 쌓이는지 확인하고, 가입할 때 '어떻게 알게 되셨나요'를 필수로 묻습니다."),
    ("사장님 추천을 설계합니다", "추천한 사장님·추천받은 사장님 모두에게 PLUS 크레딧, 후기 작성 + 추천 코드 이벤트, 상인회·사장님 단톡방 공략(캐시노트·리멤버·셀러 금융 사례)."),
    ("대리점·세무사·본사·상인단체와 손잡습니다", "포스뱅크 94%, 배달특급 3,699곳처럼 사장님 곁의 조직이 물량을 만듭니다. 쿠핀은 결제 수수료가 없으니 가입 건당 보상을 따로 줍니다."),
    ("한 상권에서 시작하고 지자체·교육과 묶습니다", "동네선물(시흥)·카카오 현장 교육처럼 지역 사업과 교육으로 한 상권을 채운 뒤 넓힙니다. 인센티브가 끝나도 남을 이유(재방문 성과)를 먼저 보여줍니다."),
    ("무료로 시작하게 하고, 손익으로 말합니다", "첫 달 무료·발송 N건 무료로 장벽을 낮추고, '떠난 단골을 쿠폰으로 다시 오게', '배달앱 수수료 없이 직접 손님 모으기'처럼 돈 이야기로 설득합니다."),
]


def main() -> None:
    data = json.loads((ROOT / "cases.json").read_text())
    cases = domestic_cases(data)
    top = lambda cs: Counter(c["top_channel"]["type"] for c in cs)  # noqa: E731
    num = [c for c in cases if c["top_channel"]["numeric"]]
    rank = dict(top(cases).most_common())
    first3 = top(cases).most_common(3)
    kr_stats = sum(1 for s in data["stats"] if s.get("_group", "").startswith("국내"))

    seg_rows = []
    for seg, desc in SEGMENTS:
        cs = [c for c in cases if c["segment"] == seg]
        if not cs:
            continue
        ranked = top(cs).most_common(3)
        first = ranked[0][0]
        examples = ", ".join(c["service"].split("(")[0].strip() for c in cs if c["top_channel"]["type"] == first)
        seg_rows.append(
            f"<tr><td><b>{esc(seg)}</b><br><span class='muted'>{esc(desc)} · {len(cs)}곳</span></td>"
            f"<td><b>{esc(first)}</b> {ranked[0][1]}곳</td>"
            f"<td>{' · '.join(f'{esc(k)} {v}' for k, v in ranked[1:])}</td><td class='muted'>{esc(examples)}</td></tr>"
        )
    by_channel = lambda t: ", ".join(c["service"].split("(")[0].strip() for c in cases if c["top_channel"]["type"] == t)  # noqa: E731

    h = []
    h.append('<header><div class="eyebrow">요약본 · 국내 기업 버전 · 2026-11-24 · 전준연</div><h1>국내 서비스는 어떻게 사용자를 모았나</h1>'
             f'<p class="lead">국내 기업 <b>{len(cases)}개 서비스</b>와 국내 통계를 정리했습니다. 해외 사례와 국내 시장의 해외 기업(틱톡 라이트·테무)은 뺐습니다. '
             '전체판 요약은 <code>acquisition-summary.pdf</code>, 근거 전체는 <code>acquisition-cases.pdf</code>·<code>index.html</code>에 있습니다.</p></header>')

    ads = sum(rank.get(k, 0) for k in AD_CHANNELS)
    h.append('<section class="answer"><h2>결론</h2><ol>'
             f'<li><b>가장 많았던 주 채널은 입소문·추천({rank["입소문·추천"]}곳), 무료 제공({rank["무료 플랜·무료 제공"]}곳), 대리점·파트너({rank["대리점·리셀러·파트너"]}곳), 직접 영업({rank["직접 영업"]}곳) 순입니다.</b> '
             f'이 넷이 전체의 {round(100 * sum(rank[k] for k in ["입소문·추천", "무료 플랜·무료 제공", "대리점·리셀러·파트너", "직접 영업"]) / len(cases))}%입니다. 광고가 주 채널인 곳은 {ads}곳뿐입니다.</li>'
             f'<li><b>숫자로 확인되는 사례({len(num)}곳)에서도 입소문·추천이 1위({top(num).most_common(1)[0][1]}곳)입니다.</b> 캐시노트는 초기 가입 절반이 사장님 단톡방 입소문, 리멤버는 40% 이상이 지인 추천이었습니다.</li>'
             '<li><b>매장 도구는 "사장님 곁의 조직"이 퍼뜨렸습니다.</b> 포스뱅크 국내 매출 94%가 대리점 경유, 토스플레이스는 VAN 대리점으로 50만 곳, 배달특급은 상인단체·지자체 협조로 출시 전 3,699곳.</li>'
             '<li><b>국내만의 특징은 무료 제공과 공공·지역 사업입니다.</b> 시프티·카페24·당근 비즈프로필·네이버 스마트스토어가 무료로 키웠고, 지역화폐·공공배달·지자체 시범사업이 매장을 모았습니다. 다만 인센티브가 끝나면 이용이 빠졌습니다.</li>'
             '<li><b>쿠핀 PLUS에 맞는 조합은 "사장님 추천 + 대리점·세무사·상인단체 파트너 + 한 상권·지역 사업"입니다.</b> 남의 사례에서 나온 가설이므로 먼저 우리 가입 경로를 잽니다.</li>'
             '</ol></section>')

    h.append('<h2>1. 어떤 채널이 가장 많았나</h2><p class="muted">각 서비스의 "주 채널"(가장 많이 들어온 곳) 하나씩을 셌습니다.</p><div class="grid4">'
             f'<div><h3>국내 기업 {len(cases)}곳</h3>{bars(top(cases), top=8, color="#7c3aed")}</div>'
             f'<div><h3>수치 근거 있는 {len(num)}곳</h3>{bars(top(num), top=8, color="#16a34a")}</div></div>'
             '<table><thead><tr><th style="width:20%">상위 채널</th><th>해당 서비스</th></tr></thead><tbody>'
             + "".join(f"<tr><td><b>{esc(t)}</b> {n}곳</td><td class='muted'>{esc(by_channel(t))}</td></tr>" for t, n in first3 + [("직접 영업", rank["직접 영업"])])
             + "</tbody></table>")

    h.append('<h2>2. 누구를 모으느냐에 따라 달랐다</h2><table><thead><tr><th style="width:27%">구분</th><th style="width:19%">1위 채널</th><th style="width:24%">2·3위</th><th>1위 채널 사례</th></tr></thead><tbody>'
             + "".join(seg_rows) + "</tbody></table>")

    h.append('<h2>3. 숫자로 확인된 대표 사례</h2><table><thead><tr><th style="width:24%">서비스</th><th style="width:14%">주 채널</th><th>수치</th><th style="width:12%">출처</th></tr></thead><tbody>'
             + "".join(f"<tr><td><b>{esc(a)}</b></td><td>{esc(b)}</td><td>{esc(c)}</td><td class='muted'>{esc(d)}</td></tr>" for a, b, c, d in HIGHLIGHTS) + "</tbody></table>")

    h.append('<h2>4. 사장님·소비자는 어디서 알게 되나 — 국내 통계</h2><table><thead><tr><th style="width:32%">주제</th><th>수치</th><th style="width:24%">출처·표본</th></tr></thead><tbody>'
             + "".join(f"<tr><td>{esc(a)}</td><td><b>{esc(b)}</b></td><td class='muted'>{esc(c)}</td></tr>" for a, b, c in STATS) + "</tbody></table>")

    h.append('<h2>5. 잘 안 된 것</h2><table><tbody>'
             + "".join(f"<tr><td style='width:22%'><b>{esc(a)}</b></td><td>{esc(b)}</td></tr>" for a, b in FAILS) + "</tbody></table>")

    h.append('<h2>6. 쿠핀 PLUS·ON에 적용 <span class="tag">해석·가설</span></h2><ol class="take">'
             + "".join(f"<li><b>{a}</b> — {b}</li>" for a, b in TAKEAWAYS) + "</ol>")

    h.append(f'<p class="foot">읽는 법과 한계: 국내 기업도 채널별 가입 비중을 거의 공개하지 않아, 주 채널을 수치로 뒷받침하는 곳은 {len(cases)}곳 중 {len(num)}곳입니다. '
             f'나머지는 대표 인터뷰·회사 설명 기준입니다. 국내 통계는 조사 묶음 1~4·7에서 {kr_stats}개, 통계 묶음에서 국내 자료를 골랐습니다. '
             '한국 사장님이 "새 소프트웨어를 어디서 알게 되는지" 직접 물은 공식 통계는 찾지 못했습니다.</p>')

    (ROOT / "summary-kr.html").write_text(f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>요약(국내) — 국내 서비스는 어떻게 사용자를 모았나</title><style>{CSS}</style></head><body>{"".join(h)}</body></html>')
    print("summary-kr.html", len(cases), len(num), first3)


if __name__ == "__main__":
    main()
