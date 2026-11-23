# flow 다이어그램

마케팅 봇의 프로토타입과 목표 구조를 [diagrams](https://diagrams.mingrammer.com/)(Python, Graphviz)로 그린 원본입니다.
그림을 모아 설명을 붙인 문서는 `research/marketing-bot-flow-diagrams.html` / `.pdf` 입니다.

## 다시 그리기

```bash
brew install graphviz                      # dot 명령이 필요합니다
cd docs/diagrams
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python build.py                  # out/*.png 6개 생성
```

## 파일

| 파일 | 내용 |
|---|---|
| `style.py` | 글꼴·색·클러스터 공통 스타일 (색 의미는 아래 표) |
| `01_target_architecture.py` | 목표 구조: 공용 엔진 + 서비스별 연결부 |
| `02_engine_pipeline.py` | 엔진 처리 흐름: 모델 호출 조건과 분기 |
| `03`~`06` | 프로토타입 A·B·C·D 흐름 |

## 색 규칙

| 선 | 의미 | 배경 | 의미 |
|---|---|---|---|
| 파랑 | 기본 진행 | 노랑 | 시작 신호 |
| 초록 | 조건 통과 | 연두 | 코드 처리(엔진) |
| 빨강 | 실패·차단 | 주황 | 모델 호출 |
| 주황 | 모델 호출·응답 | 분홍 | 사람 승인 |
| 보라 | 사람 승인·수정 | 하늘 | 발송·결과 |
| 갈색/회색 | 데이터 / 지표 | 연보라 | 서비스별 연결부 |

새 다이어그램은 `NN_이름.py`로 추가하면 `build.py`가 자동으로 포함합니다. 프로토타입 동작이 바뀌면 해당 그림도 같이 고쳐 주세요.
