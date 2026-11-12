// Raminga DSH shell entry point.
//
// Registers the raminga_* native tools on the Cordis `tools` service, gates the
// outbound (confirm) tools behind the tools/pre-execute waterfall, and starts
// an Events subscription that emits `raminga/event` on the context bus.
import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools';
import { resolveConfig, type PluginConfig } from './config.js';
import { RamingaApi } from './client.js';
import { defineRamingaTools } from './tools.js';
import { subscribeEvents } from './events.js';
import { CONFIRM_TOOLS, CORE_GUIDANCE } from './tools.generated.js';

export const name = 'raminga';

// systemPrompt is the DSH service that owns ordered system-prompt sections
// (docs/subsystems/system-prompt.md). Inject it so the core Raminga rules are
// present in every session without relying on a skill being loaded.
export const inject = ['tools', 'systemPrompt'];

// Section order: after the harness identity/persona and tool sections, before
// TOOLS_SDK (5000). The exact external order is ours to choose; the section is
// static and literal so guidance braces are never interpolated.
const CORE_SECTION = 'plugin:raminga:core';
const CORE_SECTION_ORDER = 4500;

export const Config = Schema.object({
  dataDir: Schema.string()
    .default('')
    .description('Absolute Raminga data directory; empty means $RAMINGA_DATA_DIR, else ~/.raminga.'),
  ramingaBin: Schema.string()
    .default('')
    .description(
      'Path to the raminga binary used to auto-start a node. Empty uses $RAMINGA_BIN, ' +
        'then the bundled @raminga/bin-<os>-<cpu> package, then "raminga" on PATH.',
    ),
});

export function apply(ctx: Context, config: PluginConfig): () => void {
  const resolved = resolveConfig(config);
  const api = new RamingaApi(resolved);

  const disposers: Array<() => void> = [];

  // Core behavior guidance is a system-prompt section, not a tool description:
  // DSH assembles sections into the system prompt for every session.
  disposers.push(
    ctx.systemPrompt.section({
      name: CORE_SECTION,
      order: CORE_SECTION_ORDER,
      text: CORE_GUIDANCE,
      interpolate: false,
    }),
  );

  for (const tool of defineRamingaTools(api)) {
    disposers.push(ctx.tools.register(tool));
  }

  disposers.push(
    ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      if (CONFIRM_TOOLS.has(exec.name)) {
        return {
          kind: 'ask',
          reason: `"${exec.name}" performs a real outbound action and needs your confirmation.`,
        };
      }
      return next();
    }),
  );

  // A one-shot headless run has no consumer for live events and must be able
  // to exit. The headless bundle registers the headlessStartup service; skip
  // the long-lived subscription there (and when DSH_PROFILE names headless)
  // so an open Events stream cannot keep the process alive.
  const oneShot =
    ctx.get('headlessStartup') !== undefined || process.env.DSH_PROFILE === 'headless';
  if (!oneShot) {
    disposers.push(
      subscribeEvents(
        api,
        (event) => ctx.emit('raminga/event', event),
        (error) => ctx.emit('raminga/event-error', error),
      ),
    );
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
