import type { ThemeTokens } from "./theme";
declare global {
    interface BigbandDatabaseConnection {
        address: string;
        namespace: string;
        database: string;
        username: string;
        password: string;
    }
    interface BigbandSelection {
        project: string | null;
        instance: string | null;
        vcs: string;
    }
    interface BigbandViewInstance {
        slug: string;
        project: string;
        name: string;
        path: string;
    }
    interface BigbandViewContext<Arguments = Record<string, unknown>> {
        id: string;
        plugin: string;
        view: string;
        instance: BigbandViewInstance;
        arguments: Arguments;
    }
    interface Window {
        __bigbandDb?: BigbandDatabaseConnection;
        __bigbandSelection?: BigbandSelection;
        __bigbandTheme?: ThemeTokens;
        __bigbandView?: BigbandViewContext;
        __bigbandSetTheme?: (theme: unknown) => void;
        BigbandToast?: {
            postMessage(message: string): void;
        };
        __bigband: {
            listeners: Map<string, Set<(...args: unknown[]) => void>>;
            last: Map<string, unknown>;
            rpc: Map<string, (...args: unknown[]) => unknown>;
            lifecycle?: Map<string, Set<unknown>>;
        };
    }
}
