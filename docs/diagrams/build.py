"""모든 다이어그램을 다시 그린다: `python build.py` (docs/diagrams 안에서 실행)."""

import runpy
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

scripts = sorted(p for p in HERE.glob("[0-9][0-9]_*.py"))
for script in scripts:
    runpy.run_path(str(script), run_name="__main__")
    print(f"ok  {script.stem}.png")
print(f"{len(scripts)}개 생성 → {HERE / 'out'}")
