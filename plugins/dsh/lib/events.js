import { EventsRequest } from './gen/raminga/api/v1/api_pb.js';
const RECONNECT_DELAY_MS = 5000;
export function subscribeEvents(api, onEvent, onError) {
    let disposed = false;
    let controller = null;
    async function run() {
        while (!disposed) {
            controller = new AbortController();
            try {
                const client = await api.ensure();
                for await (const raw of client.events(new EventsRequest(), { signal: controller.signal })) {
                    if (disposed)
                        return;
                    const event = raw.toJson({ emitDefaultValues: true });
                    if (event.heartbeat === true)
                        continue;
                    onEvent(event);
                }
            }
            catch (error) {
                if (disposed)
                    return;
                onError(error);
            }
            finally {
                controller = null;
            }
            if (!disposed)
                await sleep(RECONNECT_DELAY_MS);
        }
    }
    void run();
    return () => {
        disposed = true;
        controller?.abort();
    };
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
