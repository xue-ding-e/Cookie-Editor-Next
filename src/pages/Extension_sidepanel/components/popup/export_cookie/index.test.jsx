import React from "react";
import CryptoJS from "crypto-js";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ExportCookie from "./index";
import {copyCookie} from "../../../../../utils/cookie";
import {parseCookieImport} from "../../../../../utils/cookie_text_import";
import {settingStore} from "../../../../../mobx/setting.store";
import {googleAnalytics} from "../../../../../utils/google_analytics";

// Exercise the real copy/export paths, parser and encryption with synthetic data only.
// Browser Cookie reads, clipboard, anchor clicks, object URLs and analytics are replaced.
vi.mock("../../../../../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "export_cookie", format_export: "netscape", alert: {},
        setFormatExport(value) { this.format_export = value; },
    })};
});
vi.mock("../../../../../utils/google_analytics", () => ({googleAnalytics: vi.fn()}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const url = "https://example.invalid/";
const fixture = {name: "fixture-session", value: "synthetic==", domain: "example.invalid", hostOnly: true, path: "/", httpOnly: true, secure: true, session: true, storeId: "0"};
let chromeMock, clipboard, createObjectURL, downloads, clipboardDescriptor;
beforeEach(() => {
    googleAnalytics.mockClear();
    runInAction(() => { settingStore.popup = "export_cookie"; settingStore.format_export = "netscape"; settingStore.alert = {}; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 1, url}])},
        cookies: {getAll: vi.fn().mockResolvedValue([{...fixture}]), set: vi.fn(), remove: vi.fn()},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in synthetic export tests")));
    clipboard = {writeText: vi.fn().mockResolvedValue(undefined)};
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {configurable: true, value: clipboard});
    createObjectURL = vi.fn().mockReturnValue("blob:synthetic-export");
    vi.stubGlobal("URL", class extends URL { static createObjectURL = createObjectURL; });
    downloads = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { downloads.push(this.download); });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    else delete navigator.clipboard;
});

function readBlob(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(blob);
    });
}

function expectSessionRoundTrip(text) {
    const row = text.split("\n").find(line => line.startsWith("#HttpOnly_example.invalid\t"));
    expect(row.split("\t")[4]).toBe("0");
    const [cookie] = parseCookieImport(text, url);
    expect(cookie).not.toHaveProperty("expirationDate");
    expect(cookie).toMatchObject({name: fixture.name, value: fixture.value, path: "/", secure: true, httpOnly: true});
    expect(cookie).not.toHaveProperty("domain");
}

it("Netscape session export: copying a session Cookie preserves its lifetime through re-import", async () => {
    copyCookie([{...fixture}], "netscape");
    await waitFor(() => expect(settingStore.alert.type).toBe("info"));
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expectSessionRoundTrip(clipboard.writeText.mock.calls[0][0]);
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});

it.each(["", "synthetic-export-password"])("Netscape session export: the actual file action preserves lifetime with password=%s", async password => {
    render(<ExportCookie />);
    if (password) fireEvent.change(screen.getByPlaceholderText("label_password_encrypt"), {target: {value: password}});
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    let text = await readBlob(blob);
    if (password) text = JSON.parse(CryptoJS.AES.decrypt(text, password).toString(CryptoJS.enc.Utf8));
    expectSessionRoundTrip(text);
    expect(downloads[0]).toMatch(password ? /^E2EE_example\.invalid_netscape_\d+\.txt$/ : /^example\.invalid_netscape_\d+\.txt$/);
    expect(settingStore.popup).toBe("");
    expect(googleAnalytics).toHaveBeenCalledExactlyOnceWith({name: "export_cookie", params: []});
    expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url});
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});

it.each([1893456000, 1893456000.625])("keeps copy and file export identical for mixed lifetimes with persistent expiration %s", async expirationDate => {
    const cookies = [{...fixture}, {...fixture, name: "fixture-persistent", domain: ".example.invalid", hostOnly: false, path: "/sub", value: "", httpOnly: false, secure: false, session: false, expirationDate}];
    chromeMock.cookies.getAll.mockResolvedValue(cookies);
    copyCookie(cookies, "netscape");
    render(<ExportCookie />);
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const text = await readBlob(createObjectURL.mock.calls[0][0]);
    expect(text).toBe(clipboard.writeText.mock.calls[0][0]);
    expectSessionRoundTrip(text);
    const imported = parseCookieImport(text, url);
    expect(imported).toHaveLength(2);
    expect(imported[1]).toMatchObject({name: "fixture-persistent", value: "", domain: ".example.invalid", path: "/sub", secure: false, httpOnly: false, expirationDate: 1893456000});
});

it.each([
    ["header_string", ""], ["json", ""],
    ["header_string", "synthetic-compatibility-password"], ["json", "synthetic-compatibility-password"],
])("preserves %s output and encryption with password=%s", async (format, password) => {
    const cookies = [{...fixture}, {...fixture, name: "fixture-empty", value: ""}];
    chromeMock.cookies.getAll.mockResolvedValue(cookies);
    runInAction(() => { settingStore.format_export = format; });
    const expected = format === "json" ? JSON.stringify(cookies, null, 2) : "fixture-session=synthetic==;fixture-empty=";
    copyCookie(cookies, format);
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(expected);
    render(<ExportCookie />);
    if (password) fireEvent.change(screen.getByPlaceholderText("label_password_encrypt"), {target: {value: password}});
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    const blob = createObjectURL.mock.calls[0][0];
    let text = await readBlob(blob);
    if (password) text = JSON.parse(CryptoJS.AES.decrypt(text, password).toString(CryptoJS.enc.Utf8));
    expect(text).toBe(expected);
    expect(blob.type).toBe(!password && format === "json" ? "application/json" : "application/txt");
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});
