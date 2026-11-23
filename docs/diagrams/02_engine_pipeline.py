"""엔진 처리 흐름 상세 — 한 이벤트가 엔진을 지나는 모든 분기."""

from diagrams.generic.compute import Rack
from diagrams.onprem.client import User
from diagrams.programming.flowchart import Database, Decision, Document, InputOutput, PredefinedProcess, StartEnd

from style import cluster, diagram, edge

with diagram("02_engine_pipeline", "엔진 처리 흐름 — 이벤트 1건이 지나는 길"):
    with cluster("① 이벤트 수신", "trigger"):
        event = InputOutput("공통 이벤트\n서비스·종류·대상·시각")
        match = Decision("이 이벤트를 쓰는\n플레이북이 있나?")

    with cluster("② 조건 판단 (모델 호출 전, 코드)", "engine"):
        consent = Decision("수신 동의\n있나?")
        limit = Decision("발송 한도·\n허용 시간 안?")
        enough = Decision("필요 데이터\n충분?")
        cache = Decision("저장된 문구\n재사용 가능?")

    with cluster("③ 문구 생성", "model"):
        needs_llm = Decision("플레이북이\n모델을 쓰나?")
        llm = Rack("모델 호출\nJSON 스키마 강제")
        fixed = Document("고정 문구\n템플릿")

    with cluster("④ 검증 (코드)", "engine"):
        check = Decision("빈칸·한자·없는 수치·\n금지어·길이 통과?")
        retry = Decision("재생성\n1회 했나?")

    with cluster("⑤ 승인", "human"):
        level = Decision("승인 수준")
        reviewer = User("운영자 / 사장님")

    with cluster("⑥ 발송 · ⑦ 측정", "channel"):
        send = PredefinedProcess("연결부 채널로 발송\n(실험 중 DRY_RUN)")
        metrics = Database("시나리오별 기록\n발송 → 열람 → 전환")

    with cluster("조건 미충족 → 종료 (모델 호출 없음, 사유만 기록)", "warn"):
        stop_match = StartEnd("플레이북 없음")
        stop_consent = StartEnd("동의 없음")
        stop_limit = StartEnd("한도 초과·야간")
        stop_data = StartEnd("데이터 부족")

    event >> edge() >> match
    match >> edge("no") >> stop_match
    match >> edge("yes") >> consent
    consent >> edge("no") >> stop_consent
    consent >> edge("yes") >> limit
    limit >> edge("no") >> stop_limit
    limit >> edge("yes") >> enough
    enough >> edge("no") >> stop_data
    enough >> edge("yes") >> cache
    cache >> edge("yes", "재사용") >> check
    cache >> edge("no") >> needs_llm
    needs_llm >> edge("no", "고정 문구 플레이북") >> fixed >> edge() >> check
    needs_llm >> edge("model", "예") >> llm >> edge("model") >> check
    check >> edge("no", "실패") >> retry
    retry >> edge("model", "아직 → 재생성") >> llm
    retry >> edge("no", "이미 했음 → 사람 검토") >> reviewer
    check >> edge("yes", "통과") >> level
    level >> edge("yes", "L0 · 승인된 L1 틀") >> send
    level >> edge("human", "L2 · 사장님 선택") >> reviewer
    reviewer >> edge("human", "승인·수정") >> send
    reviewer >> edge("no", "반려") >> metrics
    send >> edge("metric") >> metrics
