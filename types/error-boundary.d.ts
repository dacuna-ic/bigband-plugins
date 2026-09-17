import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
interface ErrorBoundaryProps {
    name: string;
    children?: ReactNode;
}
interface ErrorBoundaryState {
    hasError: boolean;
    error: unknown;
    copied: boolean;
}
export declare class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState;
    static getDerivedStateFromError(error: unknown): ErrorBoundaryState;
    componentDidCatch(error: unknown, info: ErrorInfo): void;
    copyDetails: () => Promise<void>;
    render(): ReactNode;
}
export {};
