import { EventEmitter } from "node:events";

/** Minimal typed emitter. `on` returns an unsubscribe function. */
export class TypedEmitter<E extends { [K in keyof E]: unknown }> {
  private readonly ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(0);
  }

  on<K extends keyof E & string>(event: K, listener: (payload: E[K]) => void): () => void {
    this.ee.on(event, listener);
    return () => {
      this.ee.off(event, listener);
    };
  }

  protected emit<K extends keyof E & string>(event: K, payload: E[K]): void {
    this.ee.emit(event, payload);
  }
}
