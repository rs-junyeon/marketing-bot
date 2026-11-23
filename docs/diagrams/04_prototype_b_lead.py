"""B. 랜딩페이지 + 문의 후속 자동화 — 현재 프로토타입 흐름 (src/prototypes/b-lead-followup)."""

from diagrams.generic.compute import Rack
from diagrams.onprem.client import User, Users
from diagrams.programming.flowchart import Action, Database, Decision, InputOutput, ManualInput, StartEnd

from style import cluster, diagram, edge

with diagram("04_prototype_b_lead", "B. 문의 후속 — 문의 접수 즉시 모델 호출(자동 트리거)"):
    with cluster("시작 신호 (실시간: 문의 접수)", "trigger"):
        owner = Users("사장님\n(랜딩 방문)")
        form = ManualInput("GET /  랜딩페이지\nUTM hidden 필드")
        post = InputOutput("POST /leads")

    with cluster("접수 (코드)", "engine"):
        valid = Decision("입력값\n유효?")
        save = Database("leads.jsonl\n동의 시각·문구 버전")
        thanks = StartEnd("감사 페이지 즉시 응답\n(모델을 기다리지 않음)")

    with cluster("백그라운드 처리", "engine"):
        ack = Action("① 접수 확인 메일\n정보성 · 모델 미사용")
        consent = Decision("② 광고 수신\n동의?")

    with cluster("문구 생성 (모델 1회)", "model"):
        llm = Rack("Ollama\n업종·고민 맞춤\n후속 메일 (약 10초)")

    with cluster("사람 승인 (/admin)", "human"):
        queue = Database("승인 대기열\nfollow-up-message")
        staff = User("담당자\n수정 · 승인 · 반려")

    with cluster("발송 (DRY_RUN)", "channel"):
        auto = InputOutput("(광고) 제목 + 수신거부\n코드가 고정으로 붙여 자동 발송")
        reply = InputOutput("1:1 답장 발송\nisAdvertising:false")
        outbox = Database("outbox.jsonl")

    with cluster("효과 측정", "store"):
        meeting = ManualInput("/admin 미팅 확정 기록")
        metrics = Database("metrics.jsonl\nlead_captured · sent ·\nmeeting_booked")

    err = StartEnd("400 + 오류 표시\n(입력값 유지)")

    owner >> edge() >> form >> edge() >> post >> edge() >> valid
    valid >> edge("no", "실패") >> err
    valid >> edge("yes", "성공") >> save >> edge() >> thanks
    save >> edge("flow", "비동기") >> ack >> edge("data") >> outbox
    ack >> edge() >> llm
    llm >> edge("model", "초안") >> consent
    consent >> edge("yes", "동의 O") >> auto >> edge("data") >> outbox
    consent >> edge("no", "동의 X") >> queue >> edge("human") >> staff
    staff >> edge("human", "승인") >> reply >> edge("data") >> outbox
    staff >> edge("human", "미팅 성사") >> meeting >> edge("metric") >> metrics
    save >> edge("metric", "lead_captured", "dashed") >> metrics
