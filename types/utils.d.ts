export { cn } from "cn";
export interface ToastOptions {
    /** How long the native toast remains visible, in milliseconds. */
    duration?: number;
}
/** Show a compact native Bigband toast from a webview plugin. */
export declare function toast(message: string, options?: ToastOptions): void;
