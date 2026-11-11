// connect-node transport that reaches the Raminga daemon over its Unix domain
// socket and authenticates with the local bearer token.
//
// NOTE (Windows): Go serves the API over AF_UNIX sockets. Node.js maps
// `socketPath` to NAMED PIPES on Windows, not AF_UNIX, so this transport cannot
// reach the daemon on Windows without a daemon change (loopback-TCP or a named
// pipe listener). It works as written on macOS/Linux. See the P5 report.
import { createConnectTransport } from '@connectrpc/connect-node';
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
