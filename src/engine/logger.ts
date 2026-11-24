/** 한 줄 JSON 로그. 운영 환경의 로그 수집기(CloudWatch 등)가 그대로 읽을 수 있다. */
export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const log = (level: string) => (msg: string, fields: Record<string, unknown> = {}) =>
    write(JSON.stringify({ at: new Date().toISOString(), level, msg, ...fields }));
  return { info: log("info"), warn: log("warn"), error: log("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
