/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyListener = (payload: any) => void;

/** Tiny typed event bus. Deliberately no dependencies. */
export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: (payload: Events[K]) => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) fn(payload);
  }

  clear(): void {
    this.listeners.clear();
  }
}
