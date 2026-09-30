/**
 * Analytics events for the spatial city, with no provider behind them yet.
 *
 * 3D code only calls `analytics.track(...)` with a typed event; where events
 * go is decided by the sinks plugged in at startup. Swapping in a real
 * provider (or a WorldMesh signals endpoint that feeds ranking) means adding
 * a sink, not touching the city.
 */

export interface CityEventMap {
  /** A door showing this world was on screen and near enough to read. */
  world_impression: { listingId: string; slotId: string; towerId: string; floor: number };
  preview_started: { listingId: string; slotId: string; kind: 'video' | 'animated' };
  /** A preview loop played through once while in view. */
  preview_completed: { listingId: string; slotId: string };
  door_focused: { listingId: string; slotId: string; distance: number };
  door_interacted: { listingId: string; slotId: string; via: 'walk' | 'key' | 'tap' };
  world_entered: { listingId: string; url: string; slotId: string | null; towerId: string | null };
  bridge_crossed: { bridgeId: string; from: string; to: string };
  floor_visited: { towerId: string; floor: number };
  elevator_boarded: { towerId: string; kind: 'discovery' | 'fast'; floor: number; destination?: number };
  search_result_selected: { query: string; listingId: string; located: boolean };
}

export type CityEventName = keyof CityEventMap;

export interface CityEvent<K extends CityEventName = CityEventName> {
  name: K;
  props: CityEventMap[K];
  /** Unix ms. */
  at: number;
  /** Per page load; lets a sink group events without identifying anyone. */
  session: string;
}

export interface AnalyticsSink {
  send(event: CityEvent): void;
  flush?(): void;
}

export class Analytics {
  private sinks: AnalyticsSink[] = [];
  private session = Math.random().toString(36).slice(2, 10);
  private recent: CityEvent[] = [];

  addSink(sink: AnalyticsSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((entry) => entry !== sink);
    };
  }

  track<K extends CityEventName>(name: K, props: CityEventMap[K]): void {
    const event: CityEvent<K> = { name, props, at: Date.now(), session: this.session };
    this.recent.push(event);
    if (this.recent.length > 200) this.recent.shift();
    for (const sink of this.sinks) {
      try {
        sink.send(event);
      } catch {
        // A broken sink never breaks the city.
      }
    }
  }

  /** The last events tracked, newest last. For the debug overlay. */
  history(): readonly CityEvent[] {
    return this.recent;
  }

  flush(): void {
    for (const sink of this.sinks) sink.flush?.();
  }
}

/** Logs every event to the console. Development only. */
export const consoleSink: AnalyticsSink = {
  send(event) {
    console.debug(`[city] ${event.name}`, event.props);
  },
};
