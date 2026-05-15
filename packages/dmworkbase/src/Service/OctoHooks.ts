export interface OctoEventMap {
  "voice:transcribe:result": {
    channel_id: string;
    utterance_id: string;
    text: string;
    source: "local" | "remote";
    audio?: Blob;
    request_id?: string;
  };
  "message:send:before": {
    channel_id: string;
    text: string;
  };
}

type HookCallback<T = unknown> = (data: T) => void;

interface OctoHooksInterface {
  on(event: string, cb: HookCallback): void;
  off(event: string, cb: HookCallback): void;
  emit(event: string, data: unknown): void;
}

declare global {
  interface Window {
    __octo__?: OctoHooksInterface;
  }
}

export function emitHook<K extends keyof OctoEventMap>(
  event: K,
  data: OctoEventMap[K],
): void {
  try {
    const octo = window.__octo__;
    if (!octo) return;
    queueMicrotask(() => {
      try {
        octo.emit(event, data);
      } catch {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[OctoHooks] handler error in event:", event);
        }
      }
    });
  } catch {
    // no-op
  }
}
