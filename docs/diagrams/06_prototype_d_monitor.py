"""D. 커뮤니티·트렌드 모니터링 — 현재 프로토타입 흐름 (src/prototypes/d-community-monitor)."""

from diagrams.generic.compute import Rack
from diagrams.onprem.network import Internet
from diagrams.programming.flowchart import Database, Decision, Document, MultipleDocuments, PredefinedProcess, StartEnd

from style import cluster, diagram, edge

with diagram("06_prototype_d_monitor", "D. 모니터링 — 수집(모델 없음) → 분석(모델 1회) → A·C로 전달"):
    with cluster("① collect (수동 실행, 모델 없음)", "trigger"):
        rss = Internet("Google 뉴스 RSS 4개\n(when:7d, 소스당 30건)")
        sample = Document("가상 샘플 글 10건\n(로그인 카페는 수집 안 함)")
        dedup = PredefinedProcess("링크·제목 기준\n중복 제거")
        items = Database("items.jsonl")

    with cluster("② analyze: 코드 전처리", "engine"):
        cluster_news = PredefinedProcess("같은 보도 묶기\n2-gram 0.45 이상")
        keywords = PredefinedProcess("키워드 집계\n불용어 · 관심 키워드")

    with cluster("② analyze: 모델 1회", "model"):
        llm = Rack("Ollama\n테마·고민·글감·영업 포인트\n근거는 글 번호로만")

    with cluster("품질 장치 (코드)", "engine"):
        evidence = Decision("근거 글 번호\n유효?")
        competitor = Decision("경쟁사·샘플만\n근거?")
        warn = PredefinedProcess("과장 표현·없는 수치 경고\n\"근거: 보도 n건\" 표시")

    with cluster("결과 · 전달", "channel"):
        report = MultipleDocuments("reports/<날짜>.md · .json")
        to_a = Document("latest-topics.json\n→ A 글감")
        to_c = Document("latest-sales-angles.json\n→ C 영업 포인트 (파일만)")

    drop = StartEnd("버림\n(리포트에 개수만 기록)")

    rss >> edge("data") >> dedup
    sample >> edge("data") >> dedup
    dedup >> edge("data") >> items >> edge() >> cluster_news >> edge() >> keywords
    keywords >> edge("model", "[번호] 붙인 글 목록") >> llm >> edge("model") >> evidence
    evidence >> edge("no", "범위 밖·빈 근거") >> drop
    evidence >> edge("yes") >> competitor
    competitor >> edge("no", "글감에서 제외") >> drop
    competitor >> edge("yes", "통과") >> warn
    warn >> edge() >> report
    warn >> edge() >> to_a
    warn >> edge() >> to_c
