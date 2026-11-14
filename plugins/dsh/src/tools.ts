// Raminga tool definitions for the DSH shell.
//
// Tool names, descriptions, parameters, permissions and untrusted flags come
// from tools.generated.ts, which scripts/genplugins renders from
// agent/tools.yaml (the single source of truth). This file only owns the
// connect-es execution handlers; it must not restate model-facing metadata.
import type {
  DefineToolOptions,
  JsonSchemaNode,
  ParameterSchemaSpec,
  ToolDefinition,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools';
import type { RamingaApi } from './client.js';
import { EXPECTED_API_VERSION } from './config.js';
import { initAgentData } from './agent-init.js';
import { AGENT_ONBOARDING_FILES, GENERATED_TOOLS } from './tools.generated.js';
import { wrapUntrusted } from './untrusted.generated.js';
import {
  ConnectListedPeerRequest,
  ConnectRequest,
  DownloadPeerFileRequest,
  GetPeerFriendsRequest,
  GetPeerManifestRequest,
  GetPeerProfileRequest,
  RecentMessagesRequest,
  SendChatRequest,
  StatusRequest,
} from './gen/raminga/api/v1/api_pb.js';

// The host packages are injected by the DSH runtime and are not resolvable
// from an installed plugin package (the public rc.1 package is a different
// protocol generation). These two adapters reproduce the small, stable part of
// defineTool this shell needs: convert the author-facing parameter spec to the
// raw JSON Schema the registry stores, and pass through the declared output
// schema. `json` is author-only and compiles to the annotation-only schema.
function parametersToJSONSchema(spec: ParameterSchemaSpec | undefined): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {};
  const required: string[] = [];
  for (const [name, property] of Object.entries(spec ?? {})) {
    const schema: JsonSchemaNode = { type: property.type };
    if (property.description) schema.description = property.description;
    if (property.items) schema.items = property.items as JsonSchemaNode;
    properties[name] = schema;
    if (property.required) required.push(name);
  }
  const schema: JsonSchemaNode = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function valueToJSONSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  if (spec.type === 'json') return {};
  return { ...spec };
}

function defineRamingaTool(options: DefineToolOptions): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: parametersToJSONSchema(options.parameters),
    output: {
      schema: valueToJSONSchema(options.output.schema),
      render: options.output.render,
    },
    execute: options.execute,
  };
}

type ContentBlock = { type: 'text'; text: string };
type Args = Record<string, unknown>;

function jsonRender(untrusted: boolean) {
  return (_args: unknown, value: unknown): ContentBlock[] => {
    const body = JSON.stringify(value, null, 2);
    return [{ type: 'text', text: untrusted ? wrapUntrusted(body) : body }];
  };
}

type Handler = (api: RamingaApi, args: Args) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  raminga_status: async (api) => {
    const res = await api.call((c) => c.status(new StatusRequest()));
    const value = res.toJson({ emitDefaultValues: true }) as Record<string, unknown>;
    // MCP and the guidance use the proto field name. connect-es emits
    // camelCase JSON, so expose the same snake_case spelling here too.
    if (typeof value.currentTime === 'string') value.current_time = value.currentTime;
    if (typeof value.apiVersion === 'string' && value.apiVersion !== EXPECTED_API_VERSION) {
      value.apiVersionMismatch =
        `node api_version=${value.apiVersion} but plugin expects ${EXPECTED_API_VERSION}; ` +
        'restart or upgrade the raminga binary.';
    }
    return value;
  },

  raminga_friends: async (api) => {
    const res = await api.call((c) => c.listFriends({}));
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_published: async (api) => {
    const res = await api.call((c) => c.published({}));
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_peer_profile: async (api, args) => {
    const res = await api.call((c) =>
      c.getPeerProfile(new GetPeerProfileRequest({ peerId: String(args.peer_id) })),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_peer_manifest: async (api, args) => {
    const res = await api.call((c) =>
      c.getPeerManifest(
        new GetPeerManifestRequest({
          peerId: String(args.peer_id),
          offset: Number(args.offset ?? 0),
          limit: Number(args.limit ?? 0),
        }),
      ),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_peer_friends: async (api, args) => {
    const res = await api.call((c) =>
      c.getPeerFriends(new GetPeerFriendsRequest({ peerId: String(args.peer_id) })),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_content_get: async (api, args) => {
    const peerId = String(args.peer_id);
    const requestedPath = String(args.path);
    const frames: unknown[] = [];
    await api.call(async (c) => {
      for await (const frame of c.downloadPeerFile(
        new DownloadPeerFileRequest({
          peerId,
          path: requestedPath,
          recordDiscovery: true,
          discoverySource: 'raminga_content_get',
        }),
      )) {
        frames.push(frame.toJson({ emitDefaultValues: true }));
      }
    });
    return {
      peer_id: peerId,
      path: requestedPath,
      phases: frames,
      final: frames[frames.length - 1] ?? null,
    };
  },

  raminga_connect: async (api, args) => {
    const res = await api.call((c) =>
      c.connect(
        new ConnectRequest({
          peerId: String(args.peer_id ?? ''),
          multiaddr: String(args.multiaddr ?? ''),
        }),
      ),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_connect_listed: async (api, args) => {
    const res = await api.call((c) =>
      c.connectListedPeer(
        new ConnectListedPeerRequest({
          peerId: String(args.peer_id),
          addrs: Array.isArray(args.addrs) ? args.addrs.map(String) : [],
        }),
      ),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_chat_send: async (api, args) => {
    const res = await api.call((c) =>
      c.sendChat(
        new SendChatRequest({
          peerId: String(args.peer_id ?? ''),
          multiaddr: String(args.multiaddr ?? ''),
          text: String(args.text),
          // Agent-origin is mandatory for native Agent sends. The daemon uses
          // it to apply private-data leak checks and rate limits.
          agentOrigin: true,
        }),
      ),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  raminga_chat_history: async (api, args) => {
    const res = await api.call((c) =>
      c.recentMessages(new RecentMessagesRequest({ limit: Number(args.limit ?? 0) })),
    );
    return res.toJson({ emitDefaultValues: true });
  },

  // Local file I/O, like the MCP tool: no daemon call and no public/ writes.
  raminga_agent_init: async (api) => initAgentData(api.config.dataDir, AGENT_ONBOARDING_FILES),
};

export function defineRamingaTools(api: RamingaApi): ToolDefinition[] {
  return GENERATED_TOOLS.map((tool) => {
    const handler = HANDLERS[tool.name];
    if (!handler) {
      throw new Error(`no DSH execution handler for generated tool "${tool.name}"`);
    }
    return defineRamingaTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: { type: 'json' }, render: jsonRender(tool.resultUntrusted) },
      execute: async (args) => handler(api, (args ?? {}) as Args),
    });
  });
}
