import { type ReactNode } from 'react';
export interface PanelTitleScope {
    plugin: string;
    panel: string;
}
export declare const panelScope: any;
export declare function PanelScope({ scope, children, }: {
    scope: PanelTitleScope;
    children: ReactNode;
}): any;
