import type { Engine } from "./engine.ts";
import type { Logger } from "./logger.ts";

/** 서버 안에서 주기적으로 예약 작업과 발송을 처리한다. 한 번에 한 바퀴만 돈다(겹쳐 실행하지 않음). */
export class Worker {
  private readonly engine: Engine;
  private readonly intervalMs: number;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;

  constructor(engine: Engine, options: { intervalMs: number; logger: Logger }) {
    this.engine = engine;
    this.intervalMs = options.intervalMs;
    this.logger = options.logger;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 이전 실행이 처리 도중 죽어 running으로 남은 작업을 되살린다.
    const now = new Date();
    const recovered = this.engine.store.recoverStaleJobs(new Date(now.getTime() - 10 * 60 * 1000).toISOString(), now.toISOString());
    if (recovered) this.logger.warn("worker.recovered_jobs", { count: recovered });
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = null;
        this.schedule(this.intervalMs);
      });
    }, delay);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.engine.runDueWork();
      if (result.jobs || result.deliveries) this.logger.info("worker.tick", result);
    } catch (error) {
      this.logger.error("worker.error", { error: (error as Error).stack });
    }
  }

  /** 새 작업을 받지 않고, 진행 중인 한 바퀴가 끝날 때까지 기다린다. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
