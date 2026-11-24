"""'마케팅이란' 요약본 생성기 → marketing-basics.html (Chrome으로 marketing-basics.pdf 인쇄).

회사·서비스 이야기 없이 마케팅 개념만 정리한다. 정의·법 조항은 원문을 확인한 출처만 쓰고,
사례 수치는 cases.json(조사 데이터)에서 계산한다.
사용: python3 build.py && python3 basics.py
"""
from __future__ import annotations

import json
from collections import Counter

from summary import CSS, ROOT, esc
from summary_kr import domestic_cases

SOURCES = [
    ("AMA(미국마케팅협회) 마케팅 정의, 2017 승인", "https://www.ama.org/the-definition-of-marketing-what-is-marketing/"),
    ("정보통신망법 제50조(영리목적의 광고성 정보 전송 제한), 2024-07-24 시행", "https://casenote.kr/법령/정보통신망_이용촉진_및_정보보호_등에_관한_법률/제50조"),
    ("채널별 사례 수: 국내 기업 사용자 유입 사례 조사(국내 기업만 집계, 해외 사례·국내 시장의 해외 기업 제외)", "acquisition-cases/acquisition-summary-kr.pdf"),
]

CONFUSED = [
    ("마케팅", "사람들이 알게 되고, 들어오고, 계속 쓰게 만드는 활동 전체", "제품 소개부터 가입·구매·재구매까지 전 과정"),
    ("광고", "돈을 내고 노출을 사는 것. 마케팅 수단 중 하나", "검색광고, SNS 광고, TV 광고"),
    ("영업", "사람이 직접 한 명(한 곳)씩 설득해 계약을 끌어오는 것", "매장 방문, 기업 미팅·제안"),
    ("홍보·PR", "언론·커뮤니티에 소개되게 해 신뢰를 얻는 것. 직접 돈을 내지 않음", "기사, 인터뷰, 수상"),
    ("브랜딩", "이름을 들었을 때 떠오르는 인상을 만드는 것. 효과가 느리게 나타남", "로고·말투·일관된 메시지"),
    ("그로스", "숫자(퍼널)를 보고 실험으로 가장 약한 단계를 고치는 방식", "가입 화면 A/B 테스트, 추천 보상 실험"),
]

FRAMES = [
    ("STP", "누구에게 팔지 정하기",
     "<b>시장 나누기</b>(Segmentation) → <b>목표 고르기</b>(Targeting) → <b>자리 잡기</b>(Positioning: 고객 머릿속에 경쟁 상품과 어떻게 다르게 기억될지)"),
    ("4P", "무엇을 어떻게 팔지 정하기",
     "<b>제품</b>(Product) · <b>가격</b>(Price) · <b>유통</b>(Place: 어디서 살 수 있나) · <b>촉진</b>(Promotion: 광고·홍보·영업·판촉)"),
]

FUNNEL = [
    ("① 알게 됨 (인지)", "광고·검색·지인·영업으로 처음 접함", "노출 수, 도달"),
    ("② 들어옴 (방문)", "웹사이트·앱스토어·매장에 들어옴", "방문 수, 클릭률, 유입 경로"),
    ("③ 가입·첫 구매", "회원가입, 문의, 첫 구매", "전환율, 가입(구매)당 비용"),
    ("④ 첫 사용 (활성화)", "핵심 기능을 처음 제대로 써 봄", "활성화율"),
    ("⑤ 다시 씀·돈을 냄", "재구매, 유료 전환, 계속 이용", "재구매율, 이탈률, LTV"),
    ("⑥ 추천", "다른 사람에게 소개", "추천으로 들어온 비중"),
]

CHANNEL_GROUPS = [
    ("사람이 직접", ["직접 영업", "대리점·리셀러·파트너", "제휴·번들", "공공·지원사업", "교육·이벤트", "오프라인 홍보"],
     "물량은 크지만 사람 비용이 큼", "방문 영업, 대리점, 제휴사 번들"),
    ("사용자가 퍼뜨림 (획득 미디어)", ["입소문·추천", "제품 내 바이럴", "커뮤니티", "PR·언론"],
     "가장 싸고 들어온 고객의 품질이 좋음. 직접 조절은 어려움", "지인 추천, 추천 보상, 언론 기사"),
    ("자체 채널 (보유 미디어)", ["콘텐츠·SEO", "무료 플랜·무료 제공", "기존 사용자 기반", "앱마켓·플랫폼 노출"],
     "쌓일수록 싸짐. 시간이 걸림", "블로그·검색 노출, 무료 체험, 기존 고객 대상 신상품"),
    ("돈을 냄 (유료 미디어)", ["검색 광고", "SNS·디지털 광고", "TV·옥외 등 매스 광고", "리워드·프로모션"],
     "바로 켜고 끌 수 있음. 끄면 유입도 멈춤", "검색광고, SNS 광고, 가입 쿠폰"),
]

CUSTOMERS = [
    ("소비자 (B2C)", "본인", "지인 추천 28.3%·앱스토어 25.2%(리워드 앱, 2025), 포털 검색", "입소문·리워드", "몇 초~며칠"),
    ("소상공인 (B2SMB)", "사장님 본인", "주변 지인 44%(2021), 인터넷 기사, 단톡방·카페, 대리점", "대리점·입소문·무료 제공", "며칠~몇 주"),
    ("기업 (B2B)", "담당자 + 결재권자 여러 명", "기존 네트워크 32.1%(2024), 콘텐츠, 박람회", "콘텐츠·SEO, 영업", "몇 주~몇 달"),
]

METRICS = [
    ("전환율", "다음 단계로 넘어간 비율", "방문 100명 중 가입 5명 → 5%"),
    ("CAC (고객 획득 비용)", "고객 1명을 데려오는 데 든 돈", "광고비 100만 원으로 20명 가입 → 5만 원"),
    ("LTV (고객 생애 가치)", "한 고객이 떠나기 전까지 내는 돈", "월 2만 원 × 평균 12개월 → 24만 원"),
    ("회수 기간", "CAC를 매출로 되찾는 데 걸리는 시간", "CAC 5만 원 ÷ 월 2만 원 → 2.5개월"),
    ("유입 경로", "어느 채널에서 왔는지 기록", "링크에 붙이는 UTM 태그, 가입 시 '어떻게 알게 되셨나요' 질문"),
]

# 2쪽에 맞추기 위한 여백 조정
EXTRA_CSS = "body{font-size:10.6px;line-height:1.42}h2{margin:11px 0 4px}th,td{padding:3px 6px}.answer li{margin:2px 0}.note{margin:4px 0}"


def short(name: str) -> str:
    """'자체 채널 (보유 미디어)' → '자체 채널'"""
    return name.split(" (")[0]


def rows(items: list[tuple], muted_last: bool = True) -> str:
    out = []
    for item in items:
        cells = [f"<td><b>{esc(item[0])}</b></td>"] + [f"<td>{esc(v)}</td>" for v in item[1:-1]]
        cells.append(f"<td class='muted'>{esc(item[-1])}</td>" if muted_last else f"<td>{esc(item[-1])}</td>")
        out.append("<tr>" + "".join(cells) + "</tr>")
    return "".join(out)


def main() -> None:
    data = json.loads((ROOT / "cases.json").read_text())
    cases = domestic_cases(data)
    top = Counter(c["top_channel"]["type"] for c in cases)
    counts = [(name, sum(top.get(t, 0) for t in types)) for name, types, _, _ in CHANNEL_GROUPS]
    ranked = sorted(counts, key=lambda x: -x[1])
    group_rows = "".join(
        f"<tr><td><b>{esc(name)}</b><br><span class='muted'>{esc(' · '.join(types))}</span></td>"
        f"<td><b>{sum(top.get(t, 0) for t in types)}곳</b></td><td>{esc(trait)}</td><td class='muted'>{esc(example)}</td></tr>"
        for name, types, trait, example in CHANNEL_GROUPS
    )

    h = []
    h.append('<header><div class="eyebrow">요약본 · 2026-11-24 · 전준연</div><h1>마케팅이란 무엇인가</h1>'
             '<p class="lead">마케팅의 기본 개념만 짧게 정리했습니다. 정의와 법은 원문을 확인했고, 예시 수치는 국내 기업 사례 조사와 국내 통계에서 가져왔습니다.</p></header>')

    h.append('<section class="answer"><h2>한 줄로</h2><ol>'
             '<li><b>마케팅은 사람들이 제품·서비스를 알게 되고, 들어오고, 계속 쓰게 만드는 모든 활동입니다.</b> 광고는 그중 한 수단일 뿐입니다.</li>'
             '<li><b>공식 정의(AMA):</b> "고객·파트너·사회에 가치 있는 제공물을 만들고, 알리고, 전달하고, 교환하는 활동·제도·과정" '
             '<span class="muted">(Marketing is the activity, set of institutions, and processes for creating, communicating, delivering, and exchanging offerings that have value for customers, clients, partners, and society at large.)</span></li>'
             '<li><b>그래서 만들기(제품)·알리기(광고·홍보)·전달하기(유통·영업)·주고받기(가격·결제)가 모두 마케팅에 들어갑니다.</b></li>'
             '</ol></section>')

    h.append('<h2>1. 헷갈리는 말 정리</h2><table><thead><tr><th style="width:13%">말</th><th>뜻</th><th style="width:36%">예시</th></tr></thead><tbody>'
             + rows(CONFUSED) + "</tbody></table>")

    h.append('<h2>2. 기본 틀 — STP와 4P</h2><table><thead><tr><th style="width:9%">틀</th><th style="width:22%">무엇을 정하나</th><th>내용</th></tr></thead><tbody>'
             + "".join(f"<tr><td><b>{esc(a)}</b></td><td>{esc(b)}</td><td>{c}</td></tr>" for a, b, c in FRAMES)
             + '</tbody></table><p class="muted">STP로 "누구에게"를 먼저 정하고, 4P로 "무엇을, 얼마에, 어디서, 어떻게 알릴지"를 정합니다.</p>')

    h.append('<h2>3. 사람이 들어오는 과정 (퍼널)</h2><p class="muted">사람은 단계마다 줄어듭니다. 마케팅은 각 단계에서 덜 빠지게 하고, 가장 약한 단계를 먼저 고치는 일입니다. '
             '스타트업에서는 AARRR(인지·활성화·유지·추천·수익)로 부르기도 합니다. 흔히 말하는 "신규 유입"은 ①~③입니다.</p>'
             '<table><thead><tr><th style="width:20%">단계</th><th>무슨 일</th><th style="width:32%">보는 숫자</th></tr></thead><tbody>'
             + rows(FUNNEL, muted_last=False) + "</tbody></table>")

    h.append(f'<h2>4. 사람들이 들어오는 길 (채널)</h2><p class="muted">채널은 크게 네 종류입니다. "주 채널" 열은 사례 조사한 국내 기업 {len(cases)}곳 중 그 종류로 가장 많은 사용자가 들어온 곳의 수입니다.</p>'
             '<table><thead><tr><th style="width:34%">종류</th><th style="width:10%">주 채널</th><th style="width:28%">특징</th><th>예시</th></tr></thead><tbody>'
             + group_rows + "</tbody></table>"
             + f'<p class="note">국내 사례에서 가장 많이 들어온 길은 <b>{esc(short(ranked[0][0]))}</b>({ranked[0][1]}곳)이었고, '
             + ", ".join(f"{esc(short(n))}({c}곳)" for n, c in ranked[1:]) + " 순이었습니다.</p>")

    h.append('<h2>5. 누구에게 파느냐에 따라 다르다</h2><table><thead><tr><th style="width:16%">대상</th><th style="width:17%">누가 결정</th><th>어디서 알게 되나</th><th style="width:19%">주로 통한 채널</th><th style="width:12%">결정 기간</th></tr></thead><tbody>'
             + rows(CUSTOMERS, muted_last=False)
             + '</tbody></table><p class="muted">결정 기간은 일반적인 경향이며 조사 수치가 아닙니다. 지인 28.3%는 리워드 앱 이용자 1,001명 조사(2025), 지인 44%는 엠브레인 자영업자 조사(2021), 기존 네트워크 32.1%는 리캐치 국내 B2B 조사(2024)입니다.</p>')

    h.append('<h2>6. 잘 되고 있는지 보는 숫자</h2><table><thead><tr><th style="width:22%">지표</th><th>뜻</th><th style="width:42%">예시</th></tr></thead><tbody>'
             + rows(METRICS)
             + '</tbody></table><p class="note">가장 기본은 <b>LTV가 CAC보다 커야 한다</b>는 것입니다. 그리고 <b>어디서 왔는지 기록하지 않으면</b> 어떤 채널이 효과가 있는지 알 수 없습니다. 전환율·CAC·LTV·회수 기간 예시 숫자는 계산 방법을 보이기 위한 가상의 값입니다.</p>')

    h.append('<h2>7. 한국에서 꼭 지켜야 하는 규칙 — 정보통신망법 제50조</h2><ul>'
             '<li><b>사전 동의:</b> 문자·메일·메신저 등으로 영리 목적의 광고를 보내려면 받는 사람의 명시적인 사전 동의가 필요합니다. 상대가 사업자여도 같습니다. 같은 종류의 거래를 한 고객에게 정해진 기간 안에 보내는 경우 등은 예외입니다.</li>'
             '<li><b>거부하면 중단:</b> 수신을 거부하거나 동의를 철회하면 보내면 안 됩니다.</li>'
             '<li><b>야간 별도 동의:</b> 오후 9시~다음 날 오전 8시에 보내려면 따로 동의를 받아야 합니다.</li>'
             '<li><b>밝혀야 할 것:</b> 보내는 사람의 이름·연락처와 수신 거부 방법을 광고에 적어야 합니다.</li>'
             '</ul><p class="note">그래서 모르는 사람에게 먼저 광고 메시지를 보내는 방식(콜드 메시지)은 쓰기 어렵고, 스스로 찾아오게 하는 방식(인바운드)과 동의를 받은 사람에게 보내는 방식이 기본이 됩니다.</p>')

    h.append('<h2>출처</h2><ol class="take">' + "".join(f"<li>{esc(t)} — <span class='muted'>{esc(u)}</span></li>" for t, u in SOURCES) + "</ol>")

    (ROOT / "marketing-basics.html").write_text(f'<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>마케팅이란 무엇인가 — 요약</title><style>{CSS}{EXTRA_CSS}</style></head><body>{"".join(h)}</body></html>')
    print("marketing-basics.html", dict(top.most_common(3)))


if __name__ == "__main__":
    main()
