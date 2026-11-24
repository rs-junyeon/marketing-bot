import { readFileSync } from "node:fs";
import { InputError, num, obj, oneOf, optStr, str, strArray } from "./input.ts";

/**
 * 서비스 하나(쿠핀 PLUS, 쿠핀 ON, 회사의 다른 서비스 ...)의 연결 설정.
 * 비밀값은 파일에 쓰지 않고 환경 변수 이름만 적는다(…Env 필드).
 */

export const SERVICE_TYPES = ["b2b-sales", "self-serve-saas", "b2c"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export type AdapterConfig =
  /** 개발·데모용: JSON 파일에서 대상 정보를 읽는다. */
  | { type: "fixture"; file: string }
  /** 운영용: 서비스가 구현한 조회 API를 부른다 (docs/engine/integration-contract.md). */
  | { type: "http"; baseUrl: string; token: string };

export type DeliveryConfig =
  | { type: "dry-run" }
  /** 서비스가 가진 발송 수단(알림톡·푸시 계정 등)으로 대신 보내 달라고 요청한다. */
  | { type: "http"; url: string; token: string };

export interface ServiceConfig {
  id: string;
  name: string;
  type: ServiceType;
  brand: { name: string; tone: string; senderName: string; landingUrl?: string };
  /** 광고성 메시지 끝에 붙는 수신거부 안내. 정보통신망법 제50조 제4항 */
  optOutText: string;
  /** 생성 문구에 나오면 안 되는 표현 (공통 금지어에 더해짐) */
  bannedWords: string[];
  /** 한 대상에게 7일 동안 보낼 수 있는 광고성 메시지 수 (모든 플레이북 합계) */
  maxAdsPerSubjectPerWeek: number;
  webhookSecret: string;
  adapter: AdapterConfig;
  delivery: DeliveryConfig;
}

type Env = Record<string, string | undefined>;

function secret(env: Env, name: string, path: string): string {
  const value = env[name];
  if (!value || value.length < 16) throw new InputError(`${path}: 환경 변수 ${name} 이 없거나 16자 미만입니다.`);
  return value;
}

export function parseService(raw: unknown, path: string, env: Env, resolveFile: (file: string) => string): ServiceConfig {
  const o = obj(raw, path);
  const brand = obj(o.brand, `${path}.brand`);
  const adapterRaw = obj(o.adapter, `${path}.adapter`);
  const deliveryRaw = obj(o.delivery, `${path}.delivery`);

  const adapterType = oneOf(adapterRaw, "type", `${path}.adapter`, ["fixture", "http"] as const);
  const adapter: AdapterConfig =
    adapterType === "fixture"
      ? { type: "fixture", file: resolveFile(str(adapterRaw, "file", `${path}.adapter`)) }
      : {
          type: "http",
          baseUrl: str(adapterRaw, "baseUrl", `${path}.adapter`).replace(/\/$/, ""),
          token: secret(env, str(adapterRaw, "tokenEnv", `${path}.adapter`), `${path}.adapter`),
        };

  const deliveryType = oneOf(deliveryRaw, "type", `${path}.delivery`, ["dry-run", "http"] as const);
  const delivery: DeliveryConfig =
    deliveryType === "dry-run"
      ? { type: "dry-run" }
      : {
          type: "http",
          url: str(deliveryRaw, "url", `${path}.delivery`),
          token: secret(env, str(deliveryRaw, "tokenEnv", `${path}.delivery`), `${path}.delivery`),
        };

  const landingUrl = optStr(brand, "landingUrl", `${path}.brand`);
  return {
    id: str(o, "id", path),
    name: str(o, "name", path),
    type: oneOf(o, "type", path, SERVICE_TYPES),
    brand: {
      name: str(brand, "name", `${path}.brand`),
      tone: str(brand, "tone", `${path}.brand`),
      senderName: str(brand, "senderName", `${path}.brand`),
      ...(landingUrl ? { landingUrl } : {}),
    },
    optOutText: str(o, "optOutText", path),
    bannedWords: strArray(o, "bannedWords", path),
    maxAdsPerSubjectPerWeek: num(o, "maxAdsPerSubjectPerWeek", path, { min: 0, integer: true }),
    webhookSecret: secret(env, str(o, "webhookSecretEnv", path), path),
    adapter,
    delivery,
  };
}

export function loadServices(file: string, env: Env, resolveFile: (file: string) => string): ServiceConfig[] {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new InputError("services.json: 서비스 배열이어야 합니다.");
  const services = raw.map((item, i) => parseService(item, `services.json[${i}]`, env, resolveFile));
  const ids = new Set<string>();
  for (const service of services) {
    if (ids.has(service.id)) throw new InputError(`services.json: 서비스 id가 중복됩니다: ${service.id}`);
    ids.add(service.id);
  }
  return services;
}
