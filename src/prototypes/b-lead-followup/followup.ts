import type { ApprovalItem } from "../../shared/approval.ts";
import type { AppContext } from "../../shared/context.ts";
import { EVENTS } from "../../shared/metrics.ts";
import { loadPrompt } from "../../shared/prompts.ts";
import { type Brand, type Lead, PROTOTYPE, recordFollowUp } from "./leads.ts";

export const FOLLOW_UP_KIND = "follow-up-message";

/** 접수 확인 메일: 문의에 대한 사실 안내만 담은 정보성 메시지 (LLM 미사용) */
export function receiptMessage(brand: Brand, lead: Lead): { subject: string; body: string } {
  return {
    subject: `[${brand.serviceName}] 문의가 접수되었습니다`,
    body: [
      `${lead.name}님, 안녕하세요. ${brand.senderName}입니다.`,
      "",
      `${lead.company}에서 남겨 주신 문의가 정상적으로 접수되었습니다.`,
      "담당자가 내용을 확인한 뒤 이메일로 연락드리겠습니다.",
      "",
      "[접수 내용]",
      `- 업종: ${lead.industry}`,
      `- 문의: ${lead.concern}`,
      "",
      `문의: ${brand.contactEmail}`,
    ].join("\n"),
  };
}

/** 광고성(수신 동의자 자동 발송)이면 정보통신망법 표기를 붙인다: 제목 (광고), 발신자, 수신거부 방법 */
export function composeFollowUp(brand: Brand, lead: Lead, body: string, isAdvertising: boolean): { subject: string; body: string } {
  const sender = `보내는 곳: ${brand.companyName} ${brand.senderName} (${brand.contactEmail})`;
  if (isAdvertising) {
    return {
      subject: `(광고) [${brand.serviceName}] ${lead.company} 맞춤 활용 안내`,
      body: `${body}\n\n---\n${sender}\n${brand.unsubscribeGuide}`,
    };
  }
  return { subject: `[${brand.serviceName}] 문의하신 내용 관련 안내드립니다`, body: `${body}\n\n---\n${sender}` };
}

export async function generateFollowUp(ctx: AppContext, brand: Brand, lead: Lead): Promise<string> {
  const prompt = loadPrompt("b-lead-followup-message", {
    serviceName: brand.serviceName,
    companyName: brand.companyName,
    senderName: brand.senderName,
    valueProps: brand.valueProps.map((v) => `- ${v.title}: ${v.body}`).join("\n"),
    company: lead.company,
    name: lead.name,
    industry: lead.industry,
    concern: lead.concern,
  });
  return ctx.metrics.track(PROTOTYPE, { step: "follow-up", leadId: lead.id }, async () => {
    const text = (await ctx.llm.complete({ ...prompt, temperature: 0.5 })).trim();
    if (!text) throw new Error("후속 메시지가 비어 있습니다.");
    return text;
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/**
 * 리드 접수 후 백그라운드 처리. 어떤 단계가 실패해도 예외를 밖으로 던지지 않고
 * failed 지표로 남긴다 (서버가 죽지 않도록).
 */
export async function processLead(ctx: AppContext, brand: Brand, lead: Lead): Promise<void> {
  // 1) 접수 확인 (정보성)
  try {
    const receipt = receiptMessage(brand, lead);
    await ctx.channel.send({ channel: "email", to: lead.email, ...receipt, isAdvertising: false });
    ctx.metrics.record(PROTOTYPE, EVENTS.sent, { meta: { leadId: lead.id, kind: "receipt" } });
  } catch (error) {
    ctx.metrics.record(PROTOTYPE, EVENTS.failed, { meta: { step: "receipt", leadId: lead.id, error: errorText(error) } });
  }

  // 2) 맞춤 후속 메시지 생성 (실패는 metrics.track이 failed로 기록)
  let body: string;
  try {
    body = await generateFollowUp(ctx, brand, lead);
  } catch (error) {
    recordFollowUp(ctx.store, { leadId: lead.id, status: "failed", error: errorText(error) });
    return;
  }

  // 3) 동의 여부에 따라 자동 발송 또는 사람 승인 대기
  try {
    if (lead.marketingConsentAt) {
      const message = composeFollowUp(brand, lead, body, true);
      const result = await ctx.channel.send({
        channel: "email",
        to: lead.email,
        ...message,
        isAdvertising: true,
        consentRef: lead.id,
      });
      ctx.metrics.record(PROTOTYPE, EVENTS.sent, { meta: { leadId: lead.id, kind: "follow-up-advertising" } });
      recordFollowUp(ctx.store, { leadId: lead.id, status: "sent-advertising", messageId: result.id });
    } else {
      // 광고 수신 동의가 없으면 자동 발송하지 않고, 사람이 문의에 대한 1:1 답장으로 검토·발송한다.
      const item = ctx.approvals.submit({
        prototype: PROTOTYPE,
        kind: FOLLOW_UP_KIND,
        title: `${lead.company} (${lead.industry}) 문의 답장`,
        body,
        meta: { leadId: lead.id, email: lead.email },
      });
      recordFollowUp(ctx.store, { leadId: lead.id, status: "pending-approval", approvalId: item.id });
    }
  } catch (error) {
    ctx.metrics.record(PROTOTYPE, EVENTS.failed, { meta: { step: "follow-up-send", leadId: lead.id, error: errorText(error) } });
    recordFollowUp(ctx.store, { leadId: lead.id, status: "failed", error: errorText(error) });
  }
}

/** 사람이 승인한 1:1 답장 발송. editedBody가 있으면 수정본을 보낸다. */
export async function approveFollowUp(
  ctx: AppContext,
  brand: Brand,
  lead: Lead,
  item: ApprovalItem,
  editedBody?: string,
): Promise<void> {
  const body = editedBody?.trim() ? editedBody.trim() : item.body;
  const edited = body !== item.body;
  ctx.approvals.decide(item.id, "approved", edited ? "수정 후 승인" : undefined);
  ctx.metrics.record(PROTOTYPE, EVENTS.approved, { meta: { leadId: lead.id, approvalId: item.id, edited: String(edited) } });
  const message = composeFollowUp(brand, lead, body, false);
  const result = await ctx.channel.send({ channel: "email", to: item.meta.email ?? lead.email, ...message, isAdvertising: false });
  ctx.metrics.record(PROTOTYPE, EVENTS.sent, { meta: { leadId: lead.id, kind: "follow-up-approved" } });
  recordFollowUp(ctx.store, { leadId: lead.id, status: "sent-after-approval", approvalId: item.id, messageId: result.id });
}

export function rejectFollowUp(ctx: AppContext, item: ApprovalItem): void {
  ctx.approvals.decide(item.id, "rejected");
  const leadId = item.meta.leadId ?? "";
  ctx.metrics.record(PROTOTYPE, EVENTS.rejected, { meta: { leadId, approvalId: item.id } });
  recordFollowUp(ctx.store, { leadId, status: "rejected", approvalId: item.id });
}
