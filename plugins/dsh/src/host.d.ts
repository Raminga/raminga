// Ambient declarations for the DeepSeek Harness host packages.
//
// `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` are injected by the DSH
// runtime and are NOT published on public npm, so there is nothing for the
// compiler to resolve at build time. This file declares the minimal surface the
// Raminga shell consumes; it is intentionally narrow and matches the host's
// runtime API (verified against @deepseek-ai/dsh-tools@0.0.1-rc.1 and
// @deepseek-ai/cordis@4.0.1-rc.1 type definitions).

declare module '@deepseek-ai/dsh-tools' {
  export type ContentBlock = { type: 'text'; text: string };

  export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

  export interface ParameterPropertySpec {
    type: string;
    required?: true;
    description?: string;
    [key: string]: unknown;
  }

  export type ParameterSchemaSpec = { [key: string]: ParameterPropertySpec };

  export interface ValueSchemaSpec {
    type: string;
    description?: string;
    [key: string]: unknown;
  }

  export type JsonSchemaNode = {
    type?: string;
    description?: string;
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    items?: JsonSchemaNode;
    [key: string]: unknown;
  };

  export interface ToolOutputDefinition {
    schema: JsonSchemaNode;
    render(args: unknown, value: JsonValue): ContentBlock[];
  }

  export interface ToolOutputOptions {
    schema: ValueSchemaSpec;
    render(args: unknown, value: JsonValue): ContentBlock[];
  }

  export interface ToolExecution {
    readonly name: string;
    readonly arguments: unknown;
    readonly signal: AbortSignal;
    [key: string]: unknown;
  }

  export interface ToolRunContext extends ToolExecution {
    deferContext?(context: unknown): void;
    concludeTurn?(): void;
  }

  export type PreToolDecision =
    | { kind: 'allow' }
    | { kind: 'deny'; reason: string }
    | { kind: 'ask'; reason?: string };

  export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaNode;
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  }

  export interface DefineToolOptions {
    readonly name: string;
    readonly description: string;
    readonly parameters?: ParameterSchemaSpec;
    readonly output: ToolOutputOptions;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
  }

  export function defineTool(options: DefineToolOptions): ToolDefinition;

  export class ToolRegistry {
    register(definition: ToolDefinition): () => void;
    get(name: string): ToolDefinition | undefined;
    guard(guard: (exec: Readonly<ToolExecution>) => string | undefined): () => void;
  }
}

declare module '@deepseek-ai/cordis' {
  import type { ToolRegistry } from '@deepseek-ai/dsh-tools';
  import type { SystemPromptRegistry } from '@deepseek-ai/dsh-system-prompt';

  export interface Context {
    tools: ToolRegistry;
    systemPrompt: SystemPromptRegistry;
    on(event: string, listener: (...args: any[]) => any): () => void;
    emit(event: string, ...args: unknown[]): void;
    get(name: string): unknown;
    [key: string]: unknown;
  }

  export class Service {
    constructor(ctx: Context, config?: unknown);
  }
}
