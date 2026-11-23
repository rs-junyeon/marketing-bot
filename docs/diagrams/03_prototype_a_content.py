"""A. 사장님 대상 콘텐츠 자동화 — 현재 프로토타입 흐름 (src/prototypes/a-content)."""

from diagrams.generic.compute import Rack
from diagrams.onprem.client import User
from diagrams.programming.flowchart import Database, Decision, Document, InputOutput, MultipleDocuments, PredefinedProcess, StartEnd

from style import cluster, diagram, edge

with diagram("03_prototype_a_content", "A. 콘텐츠 자동화 — 글감에서 블로그 발행까지"):
    with cluster("시작 신호 (수동 실행)", "trigger"):
        cmd = StartEnd("pnpm a:content draft")

    with cluster("글감 선택", "store"):
        handoff = Document("D가 넘긴 주제\nlatest-topics.json")
        sample = Document("샘플 주제\nsamples/topics.json")
        pick = Decision("D 주제가\n있나?")

    with cluster("문구 생성 (모델 1회 호출)", "model"):
        llm = Rack("Ollama\ngpt-oss:20b")
        prompt = Document("prompts/\na-content-draft.md")

    with cluster("검증 (코드)", "engine"):
        check = Decision("제목·길이·빈칸·\n한자 섞임 통과?")
        decorate = PredefinedProcess("CTA + UTM 링크 부착\n수치·인용 경고 표시")

    with cluster("사람 승인 (CLI)", "human"):
        queue = Database("승인 대기열\napprovals.json")
        reviewer = User("운영자\nreview / approve")
        decide = Decision("승인?")

    with cluster("발행 · 기록", "channel"):
        publish = InputOutput("블로그 발행\n(DRY_RUN)")
        files = MultipleDocuments("drafts/ · published/\noutbox.jsonl")

    metrics = Database("metrics.jsonl\ngenerated · failed ·\napproved · rejected · sent")

    cmd >> edge() >> pick
    handoff >> edge("data", "우선") >> pick
    sample >> edge("data", "없을 때") >> pick
    pick >> edge("model", "주제 + 브랜드") >> llm
    prompt >> edge("data") >> llm
    llm >> edge("model", "JSON {title, body, summary}") >> check
    check >> edge("no", "실패") >> metrics
    check >> edge("yes", "통과") >> decorate >> edge() >> queue
    queue >> edge("human") >> reviewer >> edge("human") >> decide
    decide >> edge("yes", "approve") >> publish >> edge("data") >> files
    decide >> edge("no", "reject") >> metrics
    publish >> edge("metric", "sent") >> metrics
