// What a native shell is to the app (src/app/shell.ts): how the page knows that it runs in one, and that the hooks a shell gives
// are used in one and nowhere else.
import { describe, expect, it } from "vitest";
import { shellHooks, shellPlatform } from "../src/app/shell";
import type { ShellWindow } from "../src/app/shell";

const hooks = { version: "test", saveFile: async () => undefined };

describe("the native shell that the page runs in", () => {
  it("is none in a browser, with or without a Capacitor that says it is the web", () => {
    expect(shellPlatform({})).toBeNull();
    expect(shellPlatform({ Capacitor: { getPlatform: () => "web", isNativePlatform: () => false } })).toBeNull();
    expect(shellPlatform({ Capacitor: { isNativePlatform: () => false } })).toBeNull();
    expect(shellPlatform({ Capacitor: {} })).toBeNull();
  });

  it("is the platform that Capacitor says, or just native when it only says that", () => {
    expect(shellPlatform({ Capacitor: { getPlatform: () => "android", isNativePlatform: () => true } })).toBe("android");
    expect(shellPlatform({ Capacitor: { getPlatform: () => "ios" } })).toBe("ios");
    expect(shellPlatform({ Capacitor: { isNativePlatform: () => true } })).toBe("native");
  });

  it("is the desktop in Tauri, whatever else the page has", () => {
    expect(shellPlatform({ __TAURI_INTERNALS__: {} })).toBe("desktop");
    expect(shellPlatform({ __TAURI_INTERNALS__: null })).toBe("desktop");
    expect(shellHooks({ __TAURI_INTERNALS__: {}, __zimShell: hooks })).toBe(hooks);
  });

  it("gives its hooks in a shell and no hook in a browser, even if a page put some there", () => {
    const shell: ShellWindow = { Capacitor: { getPlatform: () => "android" }, __zimShell: hooks };
    expect(shellHooks(shell)).toBe(hooks);
    expect(shellHooks({ Capacitor: { getPlatform: () => "android" } })).toEqual({});
    expect(shellHooks({ __zimShell: hooks })).toEqual({});
    expect(shellHooks({ Capacitor: { getPlatform: () => "web" }, __zimShell: hooks })).toEqual({});
  });
});
