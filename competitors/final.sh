#!/bin/sh
# build_reports.py → PDF 4개 인쇄 → final/에 한글 이름으로 복사
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
python3 build_reports.py
print_pdf() {
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --allow-file-access-from-files \
    --print-to-pdf="reports/$1.pdf" "file://$PWD/reports/$1.html" 2>/dev/null
  cp "reports/$1.pdf" "../final/$2.pdf"
}
print_pdf competitors "쿠핀-경쟁사-조사"
print_pdf ads "경쟁사-광고-조회-결과"
print_pdf listening "경쟁사-언급-광고-분석-툴-조사"
print_pdf legal "경쟁사-정보-수집-법적-검토"
ls -la reports/*.pdf
