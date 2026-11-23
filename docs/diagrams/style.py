"""다이어그램 공통 스타일.

모든 다이어그램은 같은 글꼴·색·클러스터 모양을 쓰도록 여기서만 정의한다.
색을 바꾸고 싶으면 이 파일만 고치고 `python build.py`로 전부 다시 그린다.
"""

from pathlib import Path

from diagrams import Cluster, Diagram, Edge

OUT_DIR = Path(__file__).parent / "out"
FONT = "Apple SD Gothic Neo"

GRAPH_ATTR = {
    "fontsize": "20",
    "fontname": FONT,
    "splines": "ortho",
    "nodesep": "0.7",
    "ranksep": "0.9",
    "pad": "0.6",
    "bgcolor": "#f8f9fa",
    "labelloc": "t",
}
NODE_ATTR = {"fontsize": "12", "fontname": FONT}
EDGE_ATTR = {"fontsize": "10", "fontname": FONT, "penwidth": "2"}

# 클러스터 배경색 (역할별로 고정)
BG = {
    "service": "#e3f2fd",   # 쿠핀 PLUS·ON 등 대상 서비스
    "adapter": "#ede7f6",   # 서비스별 연결부
    "engine": "#e8f5e9",    # 공용 엔진
    "model": "#fff3e0",     # LLM
    "human": "#fce4ec",     # 사람 승인
    "channel": "#e0f7fa",   # 발송 채널
    "store": "#f5f5f5",     # 파일·DB·지표
    "trigger": "#fffde7",   # 시작 신호
    "warn": "#ffebee",      # 차단·실패
}

# 선 색 (의미별로 고정)
COLOR = {
    "flow": "#2196f3",      # 기본 진행
    "yes": "#4caf50",       # 조건 통과
    "no": "#e53935",        # 조건 실패·차단
    "model": "#ff9800",     # 모델 호출
    "human": "#9c27b0",     # 사람 승인·수정
    "data": "#795548",      # 데이터 읽기·쓰기
    "metric": "#607d8b",    # 지표 기록
}


def diagram(filename: str, title: str, direction: str = "LR"):
    OUT_DIR.mkdir(exist_ok=True)
    return Diagram(
        title,
        filename=str(OUT_DIR / filename),
        show=False,
        direction=direction,
        outformat="png",
        graph_attr=GRAPH_ATTR,
        node_attr=NODE_ATTR,
        edge_attr=EDGE_ATTR,
    )


def cluster(label: str, kind: str):
    return Cluster(
        label,
        graph_attr={"bgcolor": BG[kind], "style": "rounded", "margin": "14", "fontname": FONT, "fontsize": "14"},
    )


def edge(kind: str = "flow", label: str = "", style: str = "solid"):
    return Edge(label=label, color=COLOR[kind], fontcolor=COLOR[kind], style=style)
