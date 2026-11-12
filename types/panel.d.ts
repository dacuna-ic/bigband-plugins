import { type ReactNode } from 'react';
import { type HostEventOptions } from './host.ts';
export { PanelScope } from './panel_scope.ts';
export type { PanelTitleScope } from './panel_scope.ts';
export interface BigbandPanel extends BigbandSelection {
    /** Update this panel's header; nullish values restore its manifest title. */
    updateTitle(title?: ReactNode | null): void;
}
export declare function useHostEvent<Payload = unknown>(event: string, callback: (payload: Payload) => void, options?: HostEventOptions): void;
export declare function usePanel(): BigbandPanel;
