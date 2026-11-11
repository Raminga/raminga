// Subscribe to the daemon's server-streaming Events RPC and forward each
// non-heartbeat notification to a sink, reconnecting with backoff until
// disposed. Heartbeats are dropped (they exist only to keep the stream's
// response headers flowing while quiet).
import type { RamingaApi } from './client.js';
import { EventsRequest } from './gen/raminga/api/v1/api_pb.js';

const RECONNECT_DELAY_MS = 5000;

export function subscribeEvents(
  api: RamingaApi,
  onEvent: (event: Record<string, unknown>) => void,
  onError: (error: unknown) => void,
): () => void {
  let disposed = false;
  let controller: AbortController | null = null;

  async function run(): Promise<void> {
    while (!disposed) {
      controller = new AbortController();
      try {
        const client = await api.ensure();
        for await (const raw of client.events(new EventsRequest(), { signal: controller.signal })) {
          if (disposed) return;
          const event = raw.toJson({ emitDefaultValues: true }) as Record<string, unknown>;
          if (event.heartbeat === true) continue;
          onEvent(event);
        }
      } catch (error) {
        if (disposed) return;
        onError(error);
      } finally {
        controller = null;
      }
      if (!disposed) await sleep(RECONNECT_DELAY_MS);
    }
  }

  void run();

  return () => {
    disposed = true;
    controller?.abort();
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
