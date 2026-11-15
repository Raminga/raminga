// Subscribe to the daemon's server-streaming Events RPC and forward each
// non-heartbeat notification to a sink, reconnecting with backoff until
// disposed. Heartbeats are dropped (they exist only to keep the stream's
// response headers flowing while quiet).
//
// A clean stream end is a disconnect too: after a daemon restart the transport
// can complete the iterator without throwing. Both paths must mark the stream
// as reconnecting so the UI never presents the last snapshot as live.
import type { RamingaApi } from './client.js';
import { EventsRequest } from './gen/raminga/api/v1/api_pb.js';

const RECONNECT_DELAY_MS = 5000;

/** Observable lifecycle used by the UI bridge to prove subscription cleanup. */
export type EventStreamPhase = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SubscribeEventsOptions {
  /** Test seam; the production reconnect delay stays at five seconds. */
  reconnectDelayMs?: number;
}

export function subscribeEvents(
  api: RamingaApi,
  onEvent: (event: Record<string, unknown>) => void,
  onError: (error: unknown) => void,
  onState?: (phase: EventStreamPhase) => void,
  options: SubscribeEventsOptions = {},
): () => void {
  const reconnectDelayMs = options.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  let disposed = false;
  let closed = false;
  let controller: AbortController | null = null;
  const lifecycle = new AbortController();

  function reportClosed(): void {
    if (closed) return;
    closed = true;
    onState?.('closed');
  }

  async function run(): Promise<void> {
    while (!disposed) {
      const current = new AbortController();
      controller = current;
      onState?.('connecting');
      let opened = false;
      let endedCleanly = false;
      try {
        const client = await api.ensure();
        // dispose() may have run while api.ensure() was in flight. Do not open
        // a new Events stream for an already-cancelled subscription.
        if (disposed) return;
        for await (const raw of client.events(new EventsRequest(), { signal: current.signal })) {
          if (disposed) return;
          if (!opened) {
            opened = true;
            onState?.('open');
          }
          const event = raw.toJson({ emitDefaultValues: true }) as Record<string, unknown>;
          if (event.heartbeat === true) continue;
          onEvent(event);
        }
        endedCleanly = true;
      } catch (error) {
        if (disposed) return;
        onError(error);
      } finally {
        // Drop the real stream handle on every exit path, not just when stop()
        // happens to catch it. stop() also aborts the in-flight controller.
        current.abort();
        if (controller === current) controller = null;
      }
      if (disposed) return;
      if (endedCleanly) {
        // A daemon restart can close the stream gracefully. Treat that exactly
        // like a transport error: the snapshot stops being live immediately.
        onError(new Error('实时更新连接已结束，正在重新连接'));
      }
      onState?.('reconnecting');
      await sleep(reconnectDelayMs, lifecycle.signal);
    }
    reportClosed();
  }

  void run();

  return () => {
    if (disposed) return;
    disposed = true;
    lifecycle.abort();
    controller?.abort();
    controller = null;
    reportClosed();
  };
}

/** Sleep that wakes immediately when the subscription lifecycle is aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
