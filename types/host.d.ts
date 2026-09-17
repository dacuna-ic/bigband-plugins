import './theme.ts';
export type ViewPlacement = 'tab' | 'split-right' | 'split-down';
export interface ExecResult {
    stdout: string;
    stderr: string;
    exit: number;
}
export interface HostEventOptions {
    debounce?: number;
}
export type RpcHandler<Payload = Record<string, any>, Result = unknown> = (payload: Payload) => Result | Promise<Result>;
export declare function control<Result = any>(method: string, params?: Record<string, unknown>): Promise<Result>;
export declare function exec(instance: string, argv: readonly string[]): Promise<ExecResult>;
export interface ExecStreamExit {
    code: number;
}
export interface ExecStreamEvents {
    stdout: CustomEvent<string>;
    stderr: CustomEvent<string>;
    exit: CustomEvent<ExecStreamExit>;
    error: CustomEvent<unknown>;
    close: Event;
}
/**
 * A running command with incremental stdout/stderr events and writable stdin.
 * Events: `stdout`/`stderr` (detail: string), `exit` (detail: ExecStreamExit),
 * `error` (detail: Error), and `close`.
 */
export declare class ExecStream extends EventTarget {
    readonly id: string;
    private consumeStarted;
    private consumeScheduled;
    constructor(id: string);
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean): void;
    on<K extends keyof ExecStreamEvents>(type: K, listener: (event: ExecStreamEvents[K]) => void): () => void;
    private scheduleConsume;
    private emit;
    write(input: string): Promise<void>;
    close(): Promise<void>;
    kill(): Promise<void>;
    private consume;
    private handleEvent;
}
/** Start a command whose output and stdin remain live until it exits. */
export declare function execStream(instance: string, argv: readonly string[]): Promise<ExecStream>;
export declare function instances(): Promise<string[]>;
export declare function openFile(instance: string, path: string, diff?: string): Promise<unknown>;
export declare function openEditor(path?: string, instance?: string): Promise<unknown>;
export declare function openView(plugin: string, view: string, instance: string, viewArgs?: Record<string, unknown>, placement?: ViewPlacement): Promise<unknown>;
export declare function viewContext<Arguments = Record<string, unknown>>(): BigbandViewContext<Arguments> | null;
export declare function on<Payload = any>(event: string, handler: (payload: Payload) => void, options?: HostEventOptions): () => void;
export declare const selection: import("@preact/signals-core").Signal<BigbandSelection>;
export declare function onLifecycleEvent<Payload = any>(event: string, handler: (payload: Payload) => unknown | Promise<unknown>): () => boolean;
export declare function registerRPC(name: string, handler: RpcHandler, target?: string): void;
