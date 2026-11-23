import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AppContext } from "../../shared/context.ts";
import { EVENTS } from "../../shared/metrics.ts";
import { FOLLOW_UP_KIND, approveFollowUp, processLead, rejectFollowUp } from "./followup.ts";
import { adminPage, landingPage, thanksPage } from "./html.ts";
import { type Brand, PROTOTYPE, latestFollowUps, listLeads, loadBrand, normalizeInput, saveLead, validate } from "./leads.ts";

/** 응답 뒤에 도는 백그라운드 작업 추적. 테스트·종료 시 idle()로 끝날 때까지 기다린다. */
export class JobTracker {
  private readonly running = new Set<Promise<void>>();

  run(work: () => Promise<void>): void {
    const job = work().finally(() => this.running.delete(job));
    this.running.add(job);
  }

  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}

export interface LeadServer {
  server: Server;
  jobs: JobTracker;
}

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "요청 본문이 너무 큽니다.");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (isJson(req)) {
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "JSON 형식이 올바르지 않습니다.");
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function isJson(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").includes("application/json");
}

function send(res: ServerResponse, status: number, type: "html" | "json" | "text", body: string): void {
  const types = { html: "text/html; charset=utf-8", json: "application/json; charset=utf-8", text: "text/plain; charset=utf-8" };
  res.writeHead(status, { "content-type": types[type] });
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location });
  res.end();
}

function meetingLeadIds(ctx: AppContext): Set<string> {
  return new Set(
    ctx.metrics
      .all()
      .filter((e) => e.prototype === PROTOTYPE && e.name === EVENTS.meetingBooked && e.meta?.leadId)
      .map((e) => e.meta?.leadId ?? ""),
  );
}

export function createLeadServer(ctx: AppContext, brand: Brand = loadBrand()): LeadServer {
  const jobs = new JobTracker();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      const q = url.searchParams;
      const utm = { source: q.get("utm_source") ?? "", medium: q.get("utm_medium") ?? "", campaign: q.get("utm_campaign") ?? "" };
      return send(res, 200, "html", landingPage(brand, { utm }));
    }

    if (req.method === "POST" && path === "/leads") {
      const json = isJson(req);
      const input = normalizeInput(await readBody(req));
      const errors = validate(input);
      if (Object.keys(errors).length > 0) {
        return json
          ? send(res, 400, "json", JSON.stringify({ ok: false, errors }))
          : send(res, 400, "html", landingPage(brand, { utm: input.utm, values: input, errors }));
      }
      const lead = saveLead(ctx.store, input, brand.consentVersion);
      ctx.metrics.record(PROTOTYPE, EVENTS.leadCaptured, {
        meta: { leadId: lead.id, industry: lead.industry, utmSource: lead.utm.source, marketingConsent: String(Boolean(lead.marketingConsentAt)) },
      });
      // 응답은 바로 보내고, 접수 확인·후속 메시지는 백그라운드에서 처리한다.
      jobs.run(() => processLead(ctx, brand, lead));
      return json ? send(res, 201, "json", JSON.stringify({ ok: true, leadId: lead.id })) : send(res, 200, "html", thanksPage(brand, lead));
    }

    if (req.method === "GET" && path === "/admin") {
      const pending = ctx.approvals.list({ prototype: PROTOTYPE, status: "pending" }).filter((item) => item.kind === FOLLOW_UP_KIND);
      return send(res, 200, "html", adminPage(listLeads(ctx.store), latestFollowUps(ctx.store), meetingLeadIds(ctx), pending));
    }

    const meeting = path.match(/^\/admin\/leads\/([\w-]+)\/meeting$/);
    if (req.method === "POST" && meeting) {
      const leadId = meeting[1];
      if (!listLeads(ctx.store).some((lead) => lead.id === leadId)) throw new HttpError(404, "리드를 찾을 수 없습니다.");
      if (!meetingLeadIds(ctx).has(leadId)) ctx.metrics.record(PROTOTYPE, EVENTS.meetingBooked, { meta: { leadId } });
      return redirect(res, "/admin");
    }

    const decision = path.match(/^\/admin\/approvals\/([\w-]+)\/(approve|reject)$/);
    if (req.method === "POST" && decision) {
      const [, approvalId, action] = decision;
      const form = await readBody(req);
      const item = ctx.approvals.all().find((candidate) => candidate.id === approvalId && candidate.prototype === PROTOTYPE);
      if (!item) throw new HttpError(404, "승인 항목을 찾을 수 없습니다.");
      if (item.status !== "pending") throw new HttpError(409, `이미 처리된 항목입니다 (${item.status}).`);
      if (action === "reject") {
        rejectFollowUp(ctx, item);
      } else {
        const lead = listLeads(ctx.store).find((candidate) => candidate.id === item.meta.leadId);
        if (!lead) throw new HttpError(404, "원본 리드를 찾을 수 없습니다.");
        await approveFollowUp(ctx, brand, lead, item, typeof form.body === "string" ? form.body : undefined);
      }
      return redirect(res, "/admin");
    }

    throw new HttpError(404, "페이지를 찾을 수 없습니다.");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) {
        ctx.metrics.record(PROTOTYPE, EVENTS.failed, { meta: { step: "http", error: error instanceof Error ? error.message.slice(0, 200) : String(error) } });
      }
      const message = error instanceof HttpError ? error.message : "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
      if (!res.headersSent) send(res, status, "text", message);
      else res.end();
    });
  });

  return { server, jobs };
}
