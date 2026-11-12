import type { ThemeTokens } from './theme.ts';
export type RuntimeConfig = {
    theme?: ThemeTokens;
    db?: BigbandDatabaseConnection | null;
    execToken?: string;
    selection?: BigbandSelection;
    view?: BigbandViewContext;
    plugin?: string;
    entry?: string;
};
type RuntimeOptions = {
    lifecycle?: boolean;
};
export declare function runtimeUrl(path: string): string;
export declare function describeError(error: unknown): string;
export declare function initializeRuntime({ lifecycle }?: RuntimeOptions): RuntimeConfig;
export {};
