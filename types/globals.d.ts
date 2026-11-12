import type { ThemeTokens } from "./theme";
declare global {
    interface BigbandDatabaseConnection {
        address: string;
        namespace: string;
        database: string;
        username: string;
        password: string;
    }
    interface BigbandWorkspace {
        workspace_id: string;
        kind: 'project_instance' | 'folder' | 'scratch';
        root: string;
        display_name: string;
        project: {
            name: string;
            instance: string;
            is_primary: boolean;
        } | null;
        repository: {
            backend: string;
            root: string;
        } | null;
        capabilities: {
            repository: boolean;
            project: boolean;
            managed_instance: boolean;
        };
        agent_id: string;
        session_prefix: string;
        available: boolean;
        unavailable_reason: string | null;
        open: boolean;
        controller_key: string;
    }
    interface BigbandSelection {
        workspace: BigbandWorkspace | null;
        project: string | null;
        instance: string | null;
        vcs: string | null;
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
        /** The manifest title restored by updateTitle(nullish). */
        title: string;
        workspace: BigbandWorkspace;
        instance: BigbandViewInstance | null;
        arguments: Arguments;
    }
    interface Window {
        __bigbandDb?: BigbandDatabaseConnection;
        __bigbandExecToken?: string;
        __bigbandSelection?: BigbandSelection;
        __bigbandTheme?: ThemeTokens;
        __bigbandView?: BigbandViewContext;
        __bigbandSetTheme?: (theme: unknown) => void;
        BigbandTitle?: {
            postMessage(title: string): void;
        };
        BigbandReady?: {
            postMessage(message: string): void;
        };
        BigbandToast?: {
            postMessage(message: string): void;
        };
        __bigband: {
            listeners: Map<string, Set<(...args: unknown[]) => void>>;
            last: Map<string, unknown>;
            rpc: Map<string, (...args: unknown[]) => unknown>;
            lifecycle?: Map<string, Set<unknown>>;
            emit(event: string, dataJson: string): void;
            dispatchLifecycle(callId: number, event: string, payloadJson?: string): Promise<void>;
            dispatchRPC(callId: number, method: string, payloadJson?: string): Promise<void>;
        };
    }
}
