import { createHmac, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { EngineEvent, MessageStatus } from "./domain.ts";
import type { Engine } from "./engine.ts";
import { InputError, facts, isoDate, obj, str } from "./input.ts";
import type { Logger } from "./logger.ts";
import { collectMetrics } from "./metrics.ts";
import { ConflictError, NotFoundError } from "./store.ts";
import { renderAdminPage } from "./admin-page.ts";

/**
 * HTTP 입구.
 * - POST /v1/events           서비스 → 엔진 웹훅 (서비스별 HMAC 서명)
 * - GET  /v1/messages 등      운영 API (Bearer ADMIN_TOKEN)
 * - GET  /admin               승인 화면 (Basic 인증, 비밀번호 = ADMIN_TOKEN)
 * - GET  /healthz, /readyz    상태 확인
 */

export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MAX_BODY_BYTES = 64 * 1024;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "요청 본문이 너무 큽니다.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON 본문이 아닙니다.");
  }
}

export function parseEventBody(raw: unknown, service: string): EngineEvent {
  const o = obj(raw, "event");
  const id = str(o, "id", "event");
  if (id.length > 128) throw new InputError("event.id: 128자 이하여야 합니다.");
  return {
    id,
    service,
    type: str(o, "type", "event"),
    subjectId: str(o, "subjectId", "event"),
    occurredAt: isoDate(o, "occurredAt", "event"),
    payload: facts(o.payload, "event.payload"),
  };
}

export interface HttpOptions {
  engine: Engine;
  adminToken: string;
  logger: Logger;
  /** 서명 시각 검사용. 테스트에서 바꿔 끼운다. */
  clock?: () => Date;
}

export function createEngineServer(options: HttpOptions): Server {
  const { engine, adminToken, logger } = options;
  const clock = options.clock ?? (() => new Date());

  function verifyWebhook(req: IncomingMessage, body: string): string {
    const service = req.headers["x-mb-service"];
    const timestamp = Number(req.headers["x-mb-timestamp"]);
    const signature = req.headers["x-mb-signature"];
    if (typeof service !== "string" || typeof signature !== "string" || !Number.isInteger(timestamp)) {
      throw new HttpError(401, "x-mb-service, x-mb-timestamp, x-mb-signature 헤더가 필요합니다.");
    }
    let secret: string;
    try {
      secret = engine.service(service).config.webhookSecret;
    } catch {
      throw new HttpError(401, "알 수 없는 서비스입니다.");
    }
    if (Math.abs(clock().getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) throw new HttpError(401, "서명 시각이 너무 오래됐습니다.");
    if (!safeEqual(signPayload(secret, timestamp, body), signature)) throw new HttpError(401, "서명이 맞지 않습니다.");
    return service;
  }

  function requireBearer(req: IncomingMessage): string {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ") || !safeEqual(header.slice(7), adminToken)) throw new HttpError(401, "관리자 토큰이 필요합니다.");
    return "api";
  }

  /** 브라우저 승인 화면: Basic 인증. 아이디는 승인자 이름으로 기록된다. */
  function requireBasic(req: IncomingMessage, res: ServerResponse): string | null {
    const header = req.headers.authorization ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const index = decoded.indexOf(":");
      const user = decoded.slice(0, index).trim();
      if (index > 0 && user && safeEqual(decoded.slice(index + 1), adminToken)) return user.slice(0, 40);
    }
    res.writeHead(401, { "www-authenticate": 'Basic realm="marketing-bot", charset="UTF-8"' });
    res.end("인증이 필요합니다. 아이디에는 본인 이름, 비밀번호에는 관리자 토큰을 입력하세요.");
    return null;
  }

  /** Basic 인증은 브라우저가 자동으로 붙이므로 다른 사이트에서 보낸 폼(CSRF)을 막는다. */
  function requireSameOrigin(req: IncomingMessage): void {
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    if (site !== undefined && site !== "same-origin") throw new HttpError(403, "같은 사이트에서 보낸 요청만 허용합니다.");
    if (origin !== undefined && new URL(origin).host !== req.headers.host) throw new HttpError(403, "같은 사이트에서 보낸 요청만 허용합니다.");
    if (site === undefined && origin === undefined) throw new HttpError(403, "출처를 확인할 수 없는 요청입니다.");
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    if (method === "GET" && path === "/readyz") return sendJson(res, engine.store.ping() ? 200 : 503, { ok: engine.store.ping() });

    if (method === "POST" && path === "/v1/events") {
      const body = await readBody(req);
      const service = verifyWebhook(req, body);
      const event = parseEventBody(parseJson(body), service);
      const result = engine.ingest(event);
      return sendJson(res, result.status === "duplicate" ? 200 : 202, result);
    }

    if (path.startsWith("/v1/")) {
      const by = requireBearer(req);
      if (method === "GET" && path === "/v1/messages") {
        const status = url.searchParams.get("status") as MessageStatus | null;
        const service = url.searchParams.get("service");
        const list = engine.store.listMessages({ ...(status ? { status } : {}), ...(service ? { service } : {}) });
        return sendJson(res, 200, list.map((m) => ({ ...m, preview: engine.finalContent(m) })));
      }
      const decision = path.match(/^\/v1\/messages\/([\w-]+)\/(approve|reject)$/);
      if (method === "POST" && decision) {
        const input = obj(parseJson((await readBody(req)) || "{}"), "body");
        const reviewer = typeof input.reviewer === "string" && input.reviewer.trim() ? input.reviewer.trim().slice(0, 40) : by;
        const note = typeof input.note === "string" ? input.note : undefined;
        if (decision[2] === "reject") return sendJson(res, 200, engine.reject(decision[1], reviewer, note));
        const content =
          typeof input.body === "string" ? { body: input.body, ...(typeof input.title === "string" ? { title: input.title } : {}) } : undefined;
        return sendJson(res, 200, engine.approve(decision[1], reviewer, { ...(note ? { note } : {}), ...(content ? { content } : {}) }));
      }
      if (method === "GET" && path === "/v1/metrics") return sendJson(res, 200, collectMetrics(engine.store));
      if (method === "GET" && path === "/v1/jobs") {
        const status = url.searchParams.get("status");
        return sendJson(res, 200, engine.store.listJobs(status ? { status: status as never } : {}));
      }
      if (method === "GET" && path === "/v1/playbooks") return sendJson(res, 200, engine.listPlaybooks());
      throw new HttpError(404, "없는 경로입니다.");
    }

    if (path === "/admin" && method === "GET") {
      if (!requireBasic(req, res)) return;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      });
      res.end(renderAdminPage(engine, url.searchParams.get("flash")));
      return;
    }
    const adminDecision = path.match(/^\/admin\/messages\/([\w-]+)\/(approve|reject)$/);
    if (adminDecision && method === "POST") {
      const user = requireBasic(req, res);
      if (!user) return;
      requireSameOrigin(req);
      const form = new URLSearchParams(await readBody(req));
      const note = form.get("note") || undefined;
      let flash: string;
      try {
        if (adminDecision[2] === "reject") {
          engine.reject(adminDecision[1], user, note);
          flash = "반려했습니다.";
        } else {
          const body = form.get("body");
          const title = form.get("title");
          const content = body !== null ? { body: body.replaceAll("\r\n", "\n").trim(), ...(title !== null ? { title: title.trim() } : {}) } : undefined;
          engine.approve(adminDecision[1], user, { ...(note ? { note } : {}), ...(content ? { content } : {}) });
          flash = "승인했습니다. 발송 시각이 되면 워커가 보냅니다.";
        }
      } catch (error) {
        flash = `처리하지 못했습니다: ${(error as Error).message}`;
      }
      res.writeHead(303, { location: `/admin?flash=${encodeURIComponent(flash)}` });
      res.end();
      return;
    }

    throw new HttpError(404, "없는 경로입니다.");
  }

  return createServer((req, res) => {
    const started = performance.now();
    handle(req, res)
      .catch((error: unknown) => {
        const status =
          error instanceof HttpError
            ? error.status
            : error instanceof InputError
              ? 400
              : error instanceof NotFoundError
                ? 404
                : error instanceof ConflictError
                  ? 409
                  : 500;
        if (status === 500) logger.error("http.error", { path: req.url, error: (error as Error).stack });
        if (!res.headersSent) sendJson(res, status, { error: status === 500 ? "서버 오류" : (error as Error).message });
        else res.end();
      })
      .finally(() => {
        if (req.url !== "/healthz") {
          logger.info("http.request", { method: req.method, path: req.url?.split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
        }
      });
  });
}
