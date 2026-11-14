// connect-node transports for the local Raminga API. The default reaches the
// daemon over its Unix domain socket; the explicit opt-in transport reaches the
// per-run pinned-TLS 127.0.0.1 endpoint. Both authenticate with a host-side
// bearer token that never enters the renderer.
//
// NOTE (Windows): Node.js maps a Unix `socketPath` to a named pipe, not AF_UNIX.
// Use the explicit apiTcp option there; it does not silently replace the
// default transport.
import { createConnectTransport } from '@connectrpc/connect-node';
import { tlsNodeOptions } from './endpoint.js';
export function authInterceptor(token) {
    return (next) => (req) => {
        req.header.set('Authorization', `Bearer ${token}`);
        return next(req);
    };
}
export function makeTransport(socketPath, token) {
    return createConnectTransport({
        httpVersion: '1.1',
        baseUrl: 'http://unix',
        nodeOptions: { socketPath },
        interceptors: [authInterceptor(token)],
    });
}
/**
 * The explicit loopback-TCP transport. It connects only to the literal
 * 127.0.0.1:port in the protected per-run endpoint, trusts only that run's
 * certificate (plus a fingerprint pin), and never disables verification or
 * uses an environment proxy.
 */
export function makeTcpTransport(endpoint) {
    return createConnectTransport({
        httpVersion: '1.1',
        baseUrl: `https://127.0.0.1:${endpoint.port}`,
        nodeOptions: tlsNodeOptions(endpoint),
        interceptors: [authInterceptor(endpoint.token)],
    });
}
