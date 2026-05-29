export type ErrorHandler = (error: Error, event: string, payload: unknown) => void;

export type EventCallback<T = unknown> = (payload: T) => void;

export interface TypedEventEmitter<T extends Record<string, unknown>> {
    emit<K extends keyof T>(event: K, payload: T[K]): void;

    off<K extends keyof T>(event: K, callback: EventCallback<T[K]>): void;

    on<K extends keyof T>(event: K, callback: EventCallback<T[K]>): void;

    removeAllListeners<K extends keyof T>(event?: K): void;

    setErrorHandler(handler: ErrorHandler): void;
}
