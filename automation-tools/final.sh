#!/bin/sh
# build.py → 본문·요약 PDF 인쇄 → final/에 한글 이름으로 복사
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 build.py
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=automation-tools.pdf "file://$PWD/index.html"
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --print-to-pdf=automation-summary.pdf "file://$PWD/summary.html"
cp automation-summary.pdf "../final/마케팅-자동화-툴-조사-요약.pdf"
cp automation-tools.pdf "../final/마케팅-자동화-툴-조사.pdf"
shasum automation-summary.pdf "../final/마케팅-자동화-툴-조사-요약.pdf" automation-tools.pdf "../final/마케팅-자동화-툴-조사.pdf"
