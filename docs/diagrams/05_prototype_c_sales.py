"""C. 영업 지원 봇 — 현재 프로토타입 흐름 (src/prototypes/c-sales-brief)."""

from diagrams.generic.compute import Rack
from diagrams.onprem.client import User
from diagrams.onprem.network import Internet
from diagrams.programming.flowchart import Database, Decision, Document, ManualInput, StartEnd

from style import cluster, diagram, edge

with diagram("05_prototype_c_sales", "C. 영업 지원 — 대상 정보로 미팅 브리프·제안서 초안 (발송 없음)"):
    with cluster("시작 신호 (수동 실행)", "trigger"):
        cmd = ManualInput("pnpm c:sales brief\n이름 · URL · 업종 · 메모")

    with cluster("정보 수집 (코드)", "engine"):
        has_url = Decision("URL\n있나?")
        web = Internet("대상 홈페이지 1페이지\n10초 제한 · 평문 6000자")
        memo = Document("메모만 사용\n수집 실패 사유 기록")

    with cluster("문구 생성 (모델 1회)", "model"):
        offering = Document("우리 서비스·포트폴리오\nsamples/offering.json (임시)")
        llm = Rack("Ollama\n브리프 JSON (약 30초)")

    with cluster("검증 · 저장", "engine"):
        check = Decision("필수 필드\n있나?")
        brief = Document("briefs/<slug>.md\n확인된 사실 / 추정 분리\n제안서 초안 · 미팅 질문")

    with cluster("사람 승인 (CLI)", "human"):
        queue = Database("승인 대기열\nsales-proposal")
        sales = User("영업 담당자\n검토 · 수정 후 직접 전달")

    with cluster("효과 측정", "store"):
        metrics = Database("metrics.jsonl\napproved · meeting_booked\n미팅 성사율")

    fail = StartEnd("failed 기록\n(일괄 처리는 계속)")

    cmd >> edge() >> has_url
    has_url >> edge("yes", "예") >> web >> edge("data") >> llm
    has_url >> edge("no", "아니오") >> memo >> edge("data") >> llm
    offering >> edge("data") >> llm
    llm >> edge("model") >> check
    check >> edge("no", "실패") >> fail
    check >> edge("yes", "통과") >> brief >> edge() >> queue >> edge("human") >> sales
    sales >> edge("human", "approve / meeting") >> metrics
