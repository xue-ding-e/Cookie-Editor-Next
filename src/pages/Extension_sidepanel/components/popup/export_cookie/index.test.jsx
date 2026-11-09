import React from "react";
import CryptoJS from "crypto-js";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ExportCookie from "./index";
import TopAction from "../../top_action";
import {copyCookie} from "../../../../../utils/cookie";
import {parseCookieImport} from "../../../../../utils/cookie_text_import";
import {settingStore} from "../../../../../mobx/setting.store";
import {googleAnalytics} from "../../../../../utils/google_analytics";

// Exercise the real copy/export paths, parser and encryption with synthetic data only.
// Browser Cookie reads, clipboard, anchor clicks, object URLs and analytics are replaced.
vi.mock("../../../../../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "export_cookie", format_export: "netscape", alert: {}, confirm_dialog: [], theme_mode: "dark",
        setFormatExport(value) { this.format_export = value; },
    })};
});
vi.mock("../../../../../utils/google_analytics", () => ({googleAnalytics: vi.fn()}));
// Retain the real toolbar/Export wiring and replace unrelated dialogs/account state.
vi.mock("../../../../../mobx/account.store", () => ({accountStore: {account: null}}));
vi.mock("../copy_cookie", () => ({default: () => null}));
vi.mock("../clear_cookie", () => ({default: () => null}));
vi.mock("../share_cookie", () => ({default: () => null}));
vi.mock("../add_cookie", () => ({default: () => null}));
vi.mock("../import_cookie", () => ({default: () => null}));
vi.mock("../../../../../icons/export", () => ({default: () => <span data-testid="export-cookie-control" />}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const url = "https://example.invalid/";
const tab = {id: 1, url};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const fixture = {name: "fixture-session", value: "synthetic==", domain: "example.invalid", hostOnly: true, path: "/", httpOnly: true, secure: true, session: true, storeId: "0"};
let chromeMock, clipboard, createObjectURL, downloads, clipboardDescriptor;
beforeEach(() => {
    googleAnalytics.mockReset();
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
    render(<ExportCookie tab={tab} />);
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
    render(<ExportCookie tab={tab} />);
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
    render(<ExportCookie tab={tab} />);
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

it("export context: uses the displayed tab instead of a later active tab", async () => {
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    render(<ExportCookie tab={tab} />);
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url});
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(downloads[0]).toMatch(/^example\.invalid_netscape_/);
});

it("export context: cancelling a pending read prevents its later download and popup change", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab} />);
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("btn_cancel"));
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "new-popup-fixture"}; }));
    await act(async () => read.resolve([{...fixture}]));
    expect(downloads).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("new-popup-fixture");
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("export context: repeated clicks share one in-flight read and download", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab} />);
    const button = screen.getByText("btn_export");
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => read.resolve([{...fixture}]));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveLength(1);
    expect(googleAnalytics).toHaveBeenCalledTimes(1);
});

it("passes the displayed tab through the real toolbar into Export", async () => {
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    runInAction(() => { settingStore.popup = ""; });
    render(<TopAction cookies={[{...fixture}]} tab={tab}/>);
    fireEvent.click(screen.getByTestId("export-cookie-control"));
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url});
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
});

it("suppresses an unmounted export's pending result", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    const view = render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    view.unmount();
    runInAction(() => { settingStore.popup = "add_cookie"; });
    await act(async () => read.resolve([{...fixture}]));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
    expect(settingStore.popup).toBe("add_cookie");
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it.each([false, true])("invalidates a pending export on tab changes, including a return to the same tab=%s", async returnToSource => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    const view = render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    view.rerender(<ExportCookie tab={{id: 2, url: "https://second.invalid/"}}/>);
    if (returnToSource) view.rerender(<ExportCookie tab={tab}/>);
    await act(async () => read.resolve([{...fixture}]));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url});
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(settingStore.popup).toBe("export_cookie");
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("preserves the submitted format/password and disables controls during the read", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab}/>);
    const password = screen.getByPlaceholderText("label_password_encrypt");
    fireEvent.change(password, {target: {value: "synthetic-submitted-password"}});
    fireEvent.click(screen.getByText("btn_export"));
    expect(password).toBeDisabled();
    expect(screen.getByText("btn_export")).toBeDisabled();
    for (const input of screen.getAllByRole("radio")) expect(input).toBeDisabled();
    fireEvent.change(password, {target: {value: "synthetic-later-password"}});
    fireEvent.click(screen.getByLabelText("JSON"));
    expect(password).toHaveValue("synthetic-submitted-password");
    expect(settingStore.format_export).toBe("netscape");
    await act(async () => read.resolve([{...fixture}]));
    const encrypted = await readBlob(createObjectURL.mock.calls[0][0]);
    expectSessionRoundTrip(JSON.parse(CryptoJS.AES.decrypt(encrypted, "synthetic-submitted-password").toString(CryptoJS.enc.Utf8)));
});

it("keeps a failed read's draft and permits an explicit retry", async () => {
    chromeMock.cookies.getAll.mockRejectedValueOnce(new Error("Synthetic Cookie read rejection"));
    render(<ExportCookie tab={tab}/>);
    fireEvent.change(screen.getByPlaceholderText("label_password_encrypt"), {target: {value: "synthetic-retry-password"}});
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("export_cookie");
    expect(screen.getByPlaceholderText("label_password_encrypt")).toHaveValue("synthetic-retry-password");
    expect(screen.getByText("btn_export")).not.toBeDisabled();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(2);
    const encrypted = await readBlob(createObjectURL.mock.calls[0][0]);
    expectSessionRoundTrip(JSON.parse(CryptoJS.AES.decrypt(encrypted, "synthetic-retry-password").toString(CryptoJS.enc.Utf8)));
});

it("does not surface a stale read failure in a newer popup", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "new-context-fixture"}; }));
    await act(async () => read.reject(new Error("Synthetic stale read failure")));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("new-context-fixture");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("keeps a cancelled/reopened exporter locked until its old read settles without downloading", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    fireEvent.click(screen.getByText("btn_cancel"));
    act(() => runInAction(() => { settingStore.popup = "export_cookie"; }));
    expect(screen.getByText("btn_export")).toBeDisabled();
    fireEvent.click(screen.getByText("btn_export"));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve([{...fixture}]));
    expect(downloads).toHaveLength(0);
    expect(screen.getByText("btn_export")).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(2);
});

it("switching to the share flow prevents the pending export without dropping the CTA statistic", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    fireEvent.click(screen.getByText("cta_convert_share_link"));
    await act(async () => read.resolve([{...fixture}]));
    expect(settingStore.popup).toBe("share_cookie");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(googleAnalytics).toHaveBeenCalledExactlyOnceWith({name: "cta_share_link_export_cc", params: []});
});

it.each([undefined, {id: 1}, {id: 1, url: "chrome://extensions/"}])("rejects an unavailable export source %j before any Cookie read", async sourceTab => {
    render(<ExportCookie tab={sourceTab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    expect(settingStore.alert.type).toBe("error");
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
});

it("does not report a successfully started download as failed if analytics throws", async () => {
    googleAnalytics.mockImplementationOnce(() => { throw new Error("Synthetic analytics failure"); });
    render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(settingStore.popup).toBe("");
    expect(settingStore.alert).toEqual({});
});

it.each(["outside click", "popup replacement"])("invalidates a pending read across %s and reopening without Cancel", async interruption => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValue(read.promise);
    render(<ExportCookie tab={tab}/>);
    fireEvent.click(screen.getByText("btn_export"));
    if (interruption === "outside click") {
        fireEvent.mouseDown(document.body);
        expect(settingStore.popup).toBe("");
    } else {
        act(() => runInAction(() => { settingStore.popup = "share_cookie"; }));
    }
    act(() => runInAction(() => { settingStore.popup = "export_cookie"; }));
    expect(screen.getByText("btn_export")).toBeDisabled();
    await act(async () => read.resolve([{...fixture}]));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
    expect(settingStore.popup).toBe("export_cookie");
    expect(screen.getByText("btn_export")).not.toBeDisabled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});
