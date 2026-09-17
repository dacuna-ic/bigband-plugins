import { type HostEventOptions } from './host.ts';
export declare function useHostEvent<Payload = any>(event: string, callback: (payload: Payload) => void, options?: HostEventOptions): void;
export declare function usePanel(): BigbandSelection;
