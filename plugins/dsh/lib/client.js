// Thin wrapper over the generated connect-es client: lazily builds a client
// (reading the current token), ensures the daemon is running on first use, and
// maps connect/transport failures to clear Raminga-specific messages.
import { createClient, ConnectError, Code } from '@connectrpc/connect';
import { RamingaService } from './gen/raminga/api/v1/api_connect.js';
import { StatusRequest } from './gen/raminga/api/v1/api_pb.js';
import { makeTransport } from './transport.js';
import { ensureDaemon, readToken } from './daemon.js';
import { EXPECTED_API_VERSION } from './config.js';
export class RamingaApi {
    config;
    client = null;
    versionChecked = false;
    constructor(config) {
        this.config = config;
    }
    buildClient() {
        const token = readToken(this.config.dataDir);
        return createClient(RamingaService, makeTransport(this.config.socketPath, token));
    }
    /** True only when the daemon answers a Status call. Never starts one. */
    async probeStatus() {
        try {
            const res = await this.buildClient().status(new StatusRequest(), { timeoutMs: 1500 });
            const json = res.toJson({ emitDefaultValues: true });
            return typeof json.peerId === 'string' && json.peerId.length > 0;
        }
        catch {
            return false;
        }
    }
    async ensure() {
        if (this.client) {
            await this.checkVersion();
            return this.client;
        }
        await ensureDaemon(this.config, () => this.probeStatus());
        this.client = this.buildClient();
        await this.checkVersion();
        return this.client;
    }
    /**
     * Reject an old daemon before any tool call can be silently unprotected.
     * Proto3 ignores unknown fields, so a shell that sets agent_origin against an
     * api_version=1 daemon would otherwise send without the daemon-side guard.
     */
    async checkVersion() {
        if (this.versionChecked || !this.client)
            return;
        const status = await this.client.status(new StatusRequest(), { timeoutMs: 2000 });
        if (status.apiVersion !== EXPECTED_API_VERSION) {
            throw new Error(`Raminga node api_version=${status.apiVersion} but this plugin requires ${EXPECTED_API_VERSION}; ` +
                'restart or upgrade the Raminga daemon so agent-origin send protection is active.');
        }
        this.versionChecked = true;
    }
    async call(fn) {
        try {
            const client = await this.ensure();
            return await fn(client);
        }
        catch (error) {
            throw describeError(error, this.config.socketPath);
        }
    }
}
function describeError(error, socketPath) {
    if (error instanceof ConnectError) {
        switch (error.code) {
            case Code.Unavailable:
                return new Error(`Raminga node is not running at ${socketPath}. The plugin tried to auto-start it; ` +
                    `check daemon.log in the data directory for details. (${error.message})`);
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
