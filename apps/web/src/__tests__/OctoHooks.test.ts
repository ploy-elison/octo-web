import { describe, it, expect, beforeEach, vi } from "vitest";
import { emitHook } from "@octo/base/src/Service/OctoHooks";

describe("emitHook", () => {
  beforeEach(() => {
    delete (window as any).__octo__;
  });

  it("no-op when window.__octo__ is undefined", () => {
    expect(() =>
      emitHook("voice:transcribe:result", {
        channel_id: "ch1",
        utterance_id: "u1",
        text: "hello",
        source: "local",
      }),
    ).not.toThrow();
  });

  it("dispatches asynchronously via queueMicrotask", async () => {
    let called = false;
    (window as any).__octo__ = {
      emit: () => {
        called = true;
      },
      on: () => {},
      off: () => {},
    };
    emitHook("voice:transcribe:result", {
      channel_id: "ch1",
      utterance_id: "u1",
      text: "hello",
      source: "local",
    });
    expect(called).toBe(false);
    await new Promise<void>((r) => queueMicrotask(r));
    expect(called).toBe(true);
  });

  it("swallows handler errors without throwing", async () => {
    (window as any).__octo__ = {
      emit: () => {
        throw new Error("handler bug");
      },
      on: () => {},
      off: () => {},
    };
    expect(() =>
      emitHook("voice:transcribe:result", {
        channel_id: "ch1",
        utterance_id: "u1",
        text: "hello",
        source: "remote",
      }),
    ).not.toThrow();
    await new Promise<void>((r) => queueMicrotask(r));
  });

  it("passes correctly typed data", async () => {
    const received: any[] = [];
    (window as any).__octo__ = {
      emit: (_event: string, data: any) => received.push(data),
      on: () => {},
      off: () => {},
    };
    emitHook("voice:transcribe:result", {
      channel_id: "ch1",
      utterance_id: "u1",
      text: "hello",
      source: "local",
    });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveProperty("channel_id", "ch1");
    expect(received[0]).toHaveProperty("utterance_id", "u1");
    expect(received[0]).toHaveProperty("text", "hello");
    expect(received[0]).toHaveProperty("source", "local");
  });

  it("passes message:send:before data correctly", async () => {
    const received: any[] = [];
    (window as any).__octo__ = {
      emit: (_event: string, data: any) => received.push(data),
      on: () => {},
      off: () => {},
    };
    emitHook("message:send:before", {
      channel_id: "ch2",
      text: "world",
    });
    await new Promise<void>((r) => queueMicrotask(r));
    expect(received[0]).toHaveProperty("channel_id", "ch2");
    expect(received[0]).toHaveProperty("text", "world");
  });
});
