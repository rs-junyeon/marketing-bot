"""목표 구조 — 서비스 무관 공용 엔진 + 서비스별 연결부(어댑터)."""

from diagrams.gcp.ml import VertexAI
from diagrams.generic.compute import Rack
from diagrams.generic.device import Mobile
from diagrams.onprem.client import User, Users
from diagrams.programming.flowchart import Database, Document, Inspection, InputOutput, PredefinedProcess, Preparation

from style import cluster, diagram, edge

with diagram("01_target_architecture", "마케팅 봇 목표 구조 — 공용 엔진 1개 + 서비스별 연결부"):
    with cluster("대상 서비스", "service"):
        with cluster("쿠핀 PLUS (사장님 · B2B)", "service"):
            plus = InputOutput("가입 · 구독 · 발송\nQR 손님 · AI 리포트")
        with cluster("쿠핀 ON (소비자 · B2C)", "service"):
            on = InputOutput("회원 · 구매\n쿠폰 만료 · 동의 이력")
        future = InputOutput("다음 서비스\n(CIMS, 회사 B2B 서비스)")

    with cluster("연결부 (서비스마다 1개)", "adapter"):
        plus_ad = Preparation("PLUS 연결부\n이벤트 변환 · 대상 조회\n동의 확인 · 채널")
        on_ad = Preparation("ON 연결부\n이벤트 변환 · 대상 조회\n동의 확인 · 채널")
        new_ad = Preparation("새 연결부\n(약속만 지키면 추가)")

    with cluster("공용 엔진 (서비스 이름을 모름)", "engine"):
        receive = PredefinedProcess("① 이벤트 수신\n실시간·예약·수동")
        gate = Inspection("② 조건 판단\n동의·한도·시간·데이터")
        generate = PredefinedProcess("③ 문구 생성")
        verify = Inspection("④ 검증\n빈칸·한자·수치·금지어")
        approve = PredefinedProcess("⑤ 승인 수준\nL0·L1·L2·사장님 선택")
        send = PredefinedProcess("⑥ 발송")
        measure = PredefinedProcess("⑦ 측정")
        playbooks = Document("플레이북 설정\n시나리오 = 설정 추가")

    with cluster("모델 (③에서만 호출)", "model"):
        local = Rack("기본: Ollama\n배치 · 초안")
        cloud = VertexAI("상위: Gemini\n실시간 대기 작업만")

    with cluster("사람", "human"):
        operator = User("운영자\n승인 화면")
        owner = Users("사장님\n콘솔에서 선택")

    with cluster("채널 · 기록", "channel"):
        msg = Mobile("알림톡 · 문자 · 앱 푸시")
        mail = InputOutput("이메일 · 블로그 초안")
        db = Database("발송 기록 · 지표\n시나리오별 비교")

    plus >> edge("flow", "웹훅 · 조회") >> plus_ad
    on >> edge("flow", "웹훅 · 조회") >> on_ad
    future >> edge("flow", style="dashed") >> new_ad
    for ad in (plus_ad, on_ad, new_ad):
        ad >> edge("flow", "공통 이벤트") >> receive

    receive >> edge() >> gate >> edge("yes", "통과") >> generate
    generate >> edge("model") >> local
    generate >> edge("model", style="dashed") >> cloud
    generate >> edge() >> verify >> edge() >> approve
    approve >> edge("human") >> operator
    approve >> edge("human") >> owner
    approve >> edge() >> send
    send >> edge("flow", "연결부의 채널로") >> msg
    send >> edge() >> mail
    send >> edge("metric") >> measure >> edge("metric") >> db
    playbooks >> edge("data", style="dashed") >> gate
