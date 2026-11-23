import type { ApprovalItem } from "../../shared/approval.ts";
import { type Brand, type FieldErrors, type FollowUpRecord, INDUSTRIES, type Lead, type LeadInput, type Utm } from "./leads.ts";

/** 사용자 입력은 모두 이 함수를 거쳐 HTML에 넣는다. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:#1f2430;background:#f6f7fb;line-height:1.6;word-break:keep-all}
a{color:#3156d8}
.wrap{max-width:960px;margin:0 auto;padding:24px 20px}
.hero{background:linear-gradient(135deg,#3156d8,#5b7cf0);color:#fff;padding:56px 0 48px}
.hero h1{margin:8px 0 12px;font-size:clamp(26px,5vw,40px);line-height:1.3}
.hero p{margin:0;max-width:620px;opacity:.92}
.badge{display:inline-block;font-size:13px;font-weight:600;background:rgba(255,255,255,.18);padding:4px 10px;border-radius:999px}
.props{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:-24px}
.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px rgba(20,30,60,.06)}
.card h3{margin:0 0 6px;font-size:17px}
.card p{margin:0;font-size:14px;color:#566}
form.card{margin:28px 0;padding:28px}
form h2{margin:0 0 4px}
.muted{color:#667;font-size:14px}
.field{margin-top:16px}
label.title{display:block;font-weight:600;margin-bottom:6px;font-size:15px}
input[type=text],input[type=email],select,textarea{width:100%;padding:11px 12px;border:1px solid #cfd5e3;border-radius:10px;font:inherit;background:#fff}
textarea{min-height:110px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid #3156d8;outline-offset:1px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media (max-width:600px){.row{grid-template-columns:1fr}}
.consent{margin-top:18px;padding:14px;border:1px solid #e1e5ef;border-radius:10px;background:#fafbfe}
.consent label{display:flex;gap:10px;align-items:flex-start;font-size:15px;cursor:pointer}
.consent input{margin-top:5px;width:18px;height:18px;flex:none}
.consent small{display:block;color:#667;font-size:13px;margin-top:4px}
.req{color:#d33;font-weight:700}
.opt{color:#3156d8;font-weight:700}
.error{color:#c62828;font-size:13px;margin-top:4px}
.alert{background:#fdecea;color:#8a1c1c;border-radius:10px;padding:12px 14px;margin-top:16px;font-size:14px}
button{background:#3156d8;color:#fff;border:0;border-radius:10px;padding:13px 18px;font:inherit;font-weight:700;cursor:pointer}
button.full{width:100%;margin-top:22px;font-size:17px}
button.small{padding:6px 10px;font-size:13px}
button.gray{background:#8a93a6}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;font-size:14px}
th,td{padding:10px;border-bottom:1px solid #eceff5;text-align:left;vertical-align:top}
th{background:#f0f2f8}
.scroll{overflow-x:auto}
pre{white-space:pre-wrap;font:inherit;margin:0}
footer{color:#889;font-size:13px;padding:24px 0}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

export interface LandingState {
  utm: Utm;
  values?: LeadInput;
  errors?: FieldErrors;
}

function fieldError(errors: FieldErrors | undefined, key: keyof FieldErrors): string {
  const message = errors?.[key];
  return message ? `<div class="error" id="err-${key}">${escapeHtml(message)}</div>` : "";
}

export function landingPage(brand: Brand, state: LandingState): string {
  const v = state.values;
  const errors = state.errors;
  const hasErrors = errors && Object.keys(errors).length > 0;
  const industryOptions = INDUSTRIES.map(
    (industry) =>
      `<option value="${escapeHtml(industry)}"${v?.industry === industry ? " selected" : ""}>${escapeHtml(industry)}</option>`,
  ).join("");
  const props = brand.valueProps
    .map((p) => `<div class="card"><h3>${escapeHtml(p.title)}</h3><p>${escapeHtml(p.body)}</p></div>`)
    .join("");

  return layout(
    `${brand.serviceName} - ${brand.tagline}`,
    `<header class="hero"><div class="wrap">
  <span class="badge">사장님을 위한 쿠폰 서비스</span>
  <h1>${escapeHtml(brand.serviceName)}<br>${escapeHtml(brand.tagline)}</h1>
  <p>${escapeHtml(brand.description)}</p>
</div></header>
<main class="wrap">
  <section class="props">${props}</section>

  <form class="card" method="post" action="/leads" novalidate>
    <h2>도입 상담 신청</h2>
    <p class="muted">남겨 주신 내용을 확인하고 담당자가 이메일로 연락드립니다.</p>
    ${hasErrors ? `<div class="alert" role="alert">입력 내용을 다시 확인해 주세요.</div>` : ""}

    <input type="hidden" name="utm_source" value="${escapeHtml(state.utm.source)}">
    <input type="hidden" name="utm_medium" value="${escapeHtml(state.utm.medium)}">
    <input type="hidden" name="utm_campaign" value="${escapeHtml(state.utm.campaign)}">

    <div class="row">
      <div class="field">
        <label class="title" for="company">매장/회사명 <span class="req">*</span></label>
        <input type="text" id="company" name="company" required maxlength="100" value="${escapeHtml(v?.company)}">
        ${fieldError(errors, "company")}
      </div>
      <div class="field">
        <label class="title" for="name">담당자명 <span class="req">*</span></label>
        <input type="text" id="name" name="name" required maxlength="50" value="${escapeHtml(v?.name)}">
        ${fieldError(errors, "name")}
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label class="title" for="email">이메일 <span class="req">*</span></label>
        <input type="email" id="email" name="email" required maxlength="200" value="${escapeHtml(v?.email)}">
        ${fieldError(errors, "email")}
      </div>
      <div class="field">
        <label class="title" for="industry">업종 <span class="req">*</span></label>
        <select id="industry" name="industry" required>
          <option value="">선택해 주세요</option>${industryOptions}
        </select>
        ${fieldError(errors, "industry")}
      </div>
    </div>
    <div class="field">
      <label class="title" for="concern">고민/문의 내용 <span class="req">*</span></label>
      <textarea id="concern" name="concern" required maxlength="2000" placeholder="예: 평일 오후에 손님이 너무 없어요. 단골이 다시 오게 할 방법이 궁금합니다.">${escapeHtml(v?.concern)}</textarea>
      ${fieldError(errors, "concern")}
    </div>

    <div class="consent">
      <label><input type="checkbox" name="privacyConsent" value="on"${v?.privacyConsent ? " checked" : ""}>
        <span><span class="req">[필수]</span> 개인정보 수집·이용에 동의합니다.
        <small>${escapeHtml(brand.privacyConsentText)}</small></span></label>
      ${fieldError(errors, "privacyConsent")}
    </div>
    <div class="consent">
      <label><input type="checkbox" name="marketingConsent" value="on"${v?.marketingConsent ? " checked" : ""}>
        <span><span class="opt">[선택]</span> 광고성 정보 수신에 동의합니다.
        <small>${escapeHtml(brand.marketingConsentText)}</small></span></label>
    </div>

    <button class="full" type="submit">상담 신청하기</button>
  </form>
</main>
<footer class="wrap">© ${escapeHtml(brand.companyName)} · 문의 ${escapeHtml(brand.contactEmail)}</footer>`,
  );
}

export function thanksPage(brand: Brand, lead: Lead): string {
  return layout(
    `${brand.serviceName} - 문의 접수 완료`,
    `<main class="wrap"><div class="card" style="margin-top:48px">
  <h2>문의가 접수되었습니다</h2>
  <p>${escapeHtml(lead.name)}님, ${escapeHtml(lead.company)}의 문의 감사합니다.<br>
  <b>${escapeHtml(lead.email)}</b>로 접수 확인 메일을 보내 드리고, 담당자가 내용을 확인한 뒤 연락드리겠습니다.</p>
  <p><a href="/">처음으로</a></p>
</div></main>`,
  );
}

const STATUS_LABEL: Record<FollowUpRecord["status"], string> = {
  "sent-advertising": "자동 발송 (광고 동의)",
  "pending-approval": "승인 대기",
  "sent-after-approval": "승인 후 1:1 발송",
  rejected: "반려",
  failed: "생성/발송 실패",
};

export function adminPage(leads: Lead[], followUps: Map<string, FollowUpRecord>, meetings: Set<string>, pending: ApprovalItem[]): string {
  const rows = [...leads]
    .reverse()
    .map((lead) => {
      const followUp = followUps.get(lead.id);
      const status = followUp ? STATUS_LABEL[followUp.status] : "처리 중";
      const meeting = meetings.has(lead.id)
        ? "미팅 확정"
        : `<form method="post" action="/admin/leads/${encodeURIComponent(lead.id)}/meeting"><button class="small" type="submit">미팅 확정 기록</button></form>`;
      return `<tr>
  <td>${escapeHtml(lead.createdAt.slice(0, 16).replace("T", " "))}</td>
  <td>${escapeHtml(lead.company)}<br><span class="muted">${escapeHtml(lead.name)} · ${escapeHtml(lead.email)}</span></td>
  <td>${escapeHtml(lead.industry)}</td>
  <td>${escapeHtml(lead.utm.source || "-")}</td>
  <td>개인정보 ✔<br>광고 ${lead.marketingConsentAt ? "✔" : "✘"}</td>
  <td>${escapeHtml(status)}</td>
  <td>${meeting}</td>
</tr>`;
    })
    .join("");

  const approvalCards = pending
    .map(
      (item) => `<div class="card" style="margin-top:12px">
  <h3>${escapeHtml(item.title)}</h3>
  <p class="muted">받는 사람: ${escapeHtml(item.meta.email)} · 광고 수신 미동의 → 문의에 대한 1:1 답장으로만 발송</p>
  <form method="post" action="/admin/approvals/${encodeURIComponent(item.id)}/approve">
    <textarea name="body" style="min-height:180px">${escapeHtml(item.body)}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="small" type="submit">승인하고 발송</button>
      <button class="small gray" type="submit" formaction="/admin/approvals/${encodeURIComponent(item.id)}/reject">반려</button>
    </div>
  </form>
</div>`,
    )
    .join("");

  return layout(
    "리드 관리",
    `<main class="wrap">
  <h1>리드 관리</h1>
  <p class="muted">문의 ${leads.length}건 · 미팅 ${meetings.size}건 · 승인 대기 ${pending.length}건 (DRY_RUN이면 발송은 data/outbox.jsonl 기록만)</p>
  <div class="scroll"><table>
    <thead><tr><th>접수</th><th>매장/담당자</th><th>업종</th><th>utm_source</th><th>동의</th><th>후속 상태</th><th>미팅</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7">아직 문의가 없습니다.</td></tr>`}</tbody>
  </table></div>
  <h2 style="margin-top:32px">승인 대기 후속 메시지</h2>
  ${approvalCards || `<p class="muted">대기 중인 항목이 없습니다.</p>`}
</main>`,
  );
}
