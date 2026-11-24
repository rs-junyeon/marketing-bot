import type { Engine } from "./engine.ts";
import { collectMetrics } from "./metrics.ts";

/** 운영자 승인 화면. 의존성 없는 서버 렌더링 HTML 한 장. 모든 값은 escape 한다. */

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`);

export function renderAdminPage(engine: Engine, flash: string | null): string {
  const pending = engine.store.listMessages({ status: "pending_approval", limit: 50 });
  const recent = engine.store.listMessages({ limit: 30 }).filter((m) => m.status !== "pending_approval");
  const metrics = collectMetrics(engine.store);
  const names = new Map(engine.listPlaybooks().map((p) => [p.id, p.name]));

  const pendingHtml = pending.length
    ? pending
        .map((m) => {
          const preview = engine.finalContent(m);
          return `<article>
  <header><b>${esc(names.get(m.playbookId) ?? m.playbookId)}</b> · ${esc(m.service)} · 대상 ${esc(m.subjectId)} · ${esc(m.channel)} → ${esc(m.recipient)}
  ${m.advertising ? '<span class="tag">광고</span>' : ""} <small>${esc(m.createdAt)} · ${esc(m.model ?? "템플릿")}</small></header>
  <form method="post" action="/admin/messages/${esc(m.id)}/approve">
    ${m.title !== null ? `<label>제목<input name="title" value="${esc(m.title)}"></label>` : ""}
    <label>본문 (고쳐서 승인할 수 있습니다)<textarea name="body" rows="6">${esc(m.body)}</textarea></label>
    <details><summary>수신자에게 실제로 나가는 문구</summary><pre>${esc(preview.title ? `${preview.title}\n\n${preview.body}` : preview.body)}</pre></details>
    <label>메모<input name="note"></label>
    <button>승인</button>
    <button formaction="/admin/messages/${esc(m.id)}/reject" class="secondary">반려</button>
  </form>
</article>`;
        })
        .join("\n")
    : "<p>승인 대기 중인 메시지가 없습니다.</p>";

  const metricRows = metrics
    .map(
      (m) => `<tr><td>${esc(names.get(m.playbookId) ?? m.playbookId)}</td><td>${m.jobs}</td><td>${m.skipped}</td><td>${m.failed}</td>
<td>${m.generated}</td><td>${m.pendingApproval}</td><td>${m.rejected}</td><td>${m.edited}</td><td>${m.sent}</td><td>${m.dryRun}</td>
<td>${m.converted}</td><td>${pct(m.conversionRate)}</td><td>${m.avgGenerationMs ?? "-"}</td>
<td><small>${esc(Object.entries(m.skipReasons).map(([k, v]) => `${k} ${v}`).join(", "))}</small></td></tr>`,
    )
    .join("");

  const recentRows = recent
    .map(
      (m) =>
        `<tr><td>${esc(m.createdAt.slice(0, 16).replace("T", " "))}</td><td>${esc(names.get(m.playbookId) ?? m.playbookId)}</td><td>${esc(m.subjectId)}</td>
<td>${esc(m.status)}</td><td>${esc(m.decidedBy ?? "")}</td><td>${esc(m.error ?? "")}</td><td>${esc(m.body.slice(0, 60))}</td></tr>`,
    )
    .join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>마케팅 봇 승인</title><style>
body{font-family:-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;margin:0;background:#f6f7f9;color:#111827}
main{max-width:1100px;margin:0 auto;padding:24px}h1{font-size:22px}h2{font-size:17px;margin-top:32px}
article{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:12px 0}
label{display:block;margin:8px 0;font-size:13px;color:#374151}input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #d1d5db;border-radius:6px;margin-top:4px}
button{background:#111827;color:#fff;border:0;border-radius:6px;padding:8px 16px;font:inherit;cursor:pointer;margin-right:6px}button.secondary{background:#e5e7eb;color:#111827}
table{width:100%;border-collapse:collapse;background:#fff;font-size:12px}th,td{border:1px solid #e5e7eb;padding:6px;text-align:left;vertical-align:top}th{background:#f3f4f6}
.tag{background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 6px;font-size:12px}.flash{background:#ecfdf5;border:1px solid #a7f3d0;padding:10px;border-radius:8px}
pre{white-space:pre-wrap;background:#f9fafb;padding:8px;border-radius:6px}small{color:#6b7280}
</style></head><body><main>
<h1>마케팅 봇 · 승인 대기열</h1>
${flash ? `<p class="flash">${esc(flash)}</p>` : ""}
${pendingHtml}
<h2>플레이북 성과</h2>
<table><thead><tr><th>플레이북</th><th>작업</th><th>건너뜀</th><th>실패</th><th>생성</th><th>승인대기</th><th>반려</th><th>수정승인</th><th>발송</th><th>DRY_RUN</th><th>전환</th><th>전환율</th><th>평균 생성ms</th><th>건너뛴 사유</th></tr></thead><tbody>${metricRows}</tbody></table>
<h2>최근 처리 메시지</h2>
<table><thead><tr><th>생성</th><th>플레이북</th><th>대상</th><th>상태</th><th>승인자</th><th>오류</th><th>본문</th></tr></thead><tbody>${recentRows}</tbody></table>
</main></body></html>`;
}
