// Thin wrapper over the generated connect-es client: lazily builds a client
// from the explicitly selected transport, ensures the daemon is running on
// first use, and maps connect/transport failures to clear Raminga-specific
// messages. The per-run TCP token and certificate stay host-side.
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { RamingaService } from './gen/raminga/api/v1/api_connect.js';
import { StatusRequest } from './gen/raminga/api/v1/api_pb.js';
import { makeTcpTransport, makeTransport } from './transport.js';
import { ensureDaemon, readToken } from './daemon.js';
import { EXPECTED_API_VERSION } from './config.js';
import { readTcpEndpoint } from './endpoint.js';
export class RamingaApi {
    config;
    client = null;
    clientKey = '';
    versionChecked = false;
    constructor(config) {
        this.config = config;
    }
    selectEndpoint() {
        const endpoint = readTcpEndpoint(this.config.dataDir, this.config.endpointPath, {
            ramingaBin: this.config.ramingaBin,
            platform: this.config.platform,
        });
        if (endpoint === null && this.config.apiTcp) {
            throw new Error('Raminga loopback TCP API was explicitly enabled, but no protected endpoint is available; ' +
                'the plugin does not fall back to the Unix socket.');
        }
        return endpoint;
    }
    /**
     * On Windows an explicit false is honored, not overridden. It rejects the
     * loopback TCP API even when a protected endpoint still describes a live
     * daemon, and no transport is started. Node's socketPath is a named pipe
     * there, so the DSH client has no usable Unix transport either.
     */
    assertWindowsTransport() {
        if (this.config.platform !== 'win32' || this.config.apiTcp)
            return;
        throw new Error('Raminga apiTcp is false on Windows; the DSH client will not connect to the loopback TCP API ' +
            '(even if an endpoint already exists) and will not start a daemon. ' +
            'This can come from an existing plugin profile that persisted the old default. ' +
            'The DSH client cannot use the daemon AF_UNIX socket (Node maps that path to a named pipe). ' +
            'Set apiTcp to true or remove the key to use the Windows default, then restart the daemon with ' +
            'the loopback TCP local API. The plugin did not silently enable TCP.');
    }
    buildClient() {
        const endpoint = this.selectEndpoint();
        if (endpoint) {
            return {
                client: createClient(RamingaService, makeTcpTransport(endpoint)),
                key: `tcp:${endpoint.certSha256}`,
            };
        }
        const token = readToken(this.config.dataDir);
        return {
            client: createClient(RamingaService, makeTransport(this.config.socketPath, token)),
            key: 'unix',
        };
    }
    /** Rebuild only when the protected endpoint/transport identity changed. */
    refreshClient() {
        const built = this.buildClient();
        if (this.client !== null && this.clientKey === built.key)
            return this.client;
        this.client = built.client;
        this.clientKey = built.key;
        this.versionChecked = false;
        return this.client;
    }
    locationLabel() {
        if (this.clientKey.startsWith('tcp:') || this.config.apiTcp) {
            return 'the authenticated 127.0.0.1 loopback TCP endpoint';
        }
        return this.config.socketPath;
    }
    /** True only when the daemon answers a Status call. Never starts one. */
    async probeStatus() {
        // The transport switch is authoritative. Do not let a leftover HTTPS
        // descriptor make a Windows false configuration probe or connect.
        if (this.config.platform === 'win32' && !this.config.apiTcp)
            return false;
        try {
            const built = this.buildClient();
            const res = await built.client.status(new StatusRequest(), { timeoutMs: 1500 });
            const json = res.toJson({ emitDefaultValues: true });
            return typeof json.peerId === 'string' && json.peerId.length > 0;
        }
        catch {
            return false;
        }
    }
    async ensure() {
        this.assertWindowsTransport();
        // Auto-start only before the first successful client build. After a panel
        // has been opened, a stopped/restarted daemon must remain visibly down
        // until an external restart or a later retry succeeds; a read must not
        // silently spawn a new daemon behind the user's back. When a daemon does
        // restart, refreshClient discovers the new per-run endpoint and rebuilds.
        if (this.client === null && !(await this.probeStatus())) {
            await ensureDaemon(this.config, () => this.probeStatus());
        }
        const client = this.refreshClient();
        await this.checkVersion(client);
        return client;
    }
    /**
     * Reject an old daemon before any tool call can be silently unprotected.
     * Proto3 ignores unknown fields, so a shell that sets agent_origin against an
     * api_version=1 daemon would otherwise send without the daemon-side guard.
     */
    async checkVersion(client) {
        if (this.versionChecked)
            return;
        const status = await client.status(new StatusRequest(), { timeoutMs: 2000 });
        if (status.apiVersion !== EXPECTED_API_VERSION) {
            throw new Error(`Raminga node api_version=${status.apiVersion} but this plugin requires ${EXPECTED_API_VERSION}; ` +
                'restart or upgrade the Raminga daemon so agent-origin send protection is active.');
        }
        this.versionChecked = true;
    }
    async call(fn, operation = '访问 Raminga 节点') {
        let client;
        try {
            client = await this.ensure();
        }
        catch (error) {
            // Reaching the local daemon failed (probe/auto-start/version check).
            // Only this phase can honestly say the local node is not running.
            throw describeError(error, this.locationLabel(), { operation, phase: 'ensure' });
        }
        try {
            return await fn(client);
        }
        catch (error) {
            // The local daemon was reachable immediately before this RPC. An
            // Unavailable returned by a handler (for example a failed remote dial in
            // Connect) is an operation failure, not a stopped local daemon.
            throw describeError(error, this.locationLabel(), { operation, phase: 'call' });
        }
    }
}
export function describeError(error, location, context = { operation: '访问 Raminga 节点', phase: 'ensure' }) {
    if (error instanceof ConnectError) {
        switch (error.code) {
            case Code.Unavailable:
                if (context.phase === 'ensure') {
                    return new Error(`Raminga node is not running at ${location}. The plugin tried to auto-start it; ` +
                        `check daemon.log in the data directory for details. (${error.message})`);
                }
                return new Error(`${context.operation}没有完成：Raminga 节点返回暂不可用（${error.message}）。` +
                    '本机节点在这次操作前可以访问，这不是自动启动失败。' +
                    (context.operation === '连接节点' ? '请检查目标节点地址和网络后重试。' : '请稍后重试。'));
            case Code.Unauthenticated:
                return new Error(`Raminga local API token mismatch. (${error.message})`);
            case Code.InvalidArgument:
                return new Error(`Invalid argument: ${error.message}`);
            default:
                return new Error(`Raminga RPC failed (${error.code}): ${error.message}`);
        }
    }
    if (error instanceof Error)
        return error;
    return new Error(String(error));
}
