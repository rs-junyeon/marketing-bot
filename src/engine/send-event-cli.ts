import { readFileSync } from "node:fs";
import { loadConfig } from "../shared/config.ts";
import { signPayload } from "./http.ts";

/**
 * pnpm engine:event <service> <event.json>
 * 서비스 쪽 웹훅 연동을 시험할 때 쓰는 도구. 서비스와 같은 방식으로 서명해 이벤트를 보낸다.
 * 서명 시크릿은 services.json의 webhookSecretEnv에 적힌 환경 변수 이름을 --secret-env 로 넘긴다.
 */
loadConfig();
const [service, file, ...rest] = process.argv.slice(2);
const secretEnv = rest[rest.indexOf("--secret-env") + 1];
if (!service || !file || !rest.includes("--secret-env") || !secretEnv) {
  console.error("사용법: pnpm engine:event <service> <event.json> --secret-env <환경변수 이름> [--url http://127.0.0.1:3200]");
  process.exit(2);
}
const secret = process.env[secretEnv];
if (!secret) {
  console.error(`환경 변수 ${secretEnv} 이 없습니다.`);
  process.exit(2);
}
const url = rest.includes("--url") ? rest[rest.indexOf("--url") + 1] : `http://127.0.0.1:${process.env.ENGINE_PORT ?? 3200}`;
const body = readFileSync(file, "utf8").trim();
const timestamp = Math.floor(Date.now() / 1000);
const response = await fetch(`${url}/v1/events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mb-service": service,
    "x-mb-timestamp": String(timestamp),
    "x-mb-signature": signPayload(secret, timestamp, body),
  },
  body,
});
console.log(response.status, await response.text());
process.exit(response.ok ? 0 : 1);
