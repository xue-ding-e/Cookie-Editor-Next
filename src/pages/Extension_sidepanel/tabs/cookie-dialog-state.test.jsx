import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ShowCookie from "./cookie";
import {settingStore} from "../../../mobx/setting.store";

// Keep the real ImportCookie and DetailCookie/EditCookie components and their state.
// Only unrelated toolbar controls, animation, the store fixture and API boundaries are replaced.
vi.mock("../components/top_action", async () => {
    const {default: ImportCookie} = await import("../components/popup/import_cookie");
    return {default: () => <ImportCookie />};
});
vi.mock("../../../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({
        tab: "home", theme_mode: "dark", popup: "", format_import: "text", option_import: [],
        display_cookie: "compact", customize_display_cookie: [], confirm_dialog: [], cookie_select: {}, alert: {},
        setFormatImport(value) { this.format_import = value; },
    })};
});
vi.mock("../../../utils/google_analytics", () => ({googleAnalytics: vi.fn()}));
vi.mock("../../../constants/icon", () => ({icons: {chrome: "fixture-default-icon"}}));
vi.mock("../../../icons/edit", () => ({default: () => <span data-testid="edit-cookie-control" />}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const fixture = {name: "fixture-cookie", value: "synthetic", domain: "example.invalid", path: "/", secure: false, session: true, storeId: "0"};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
let chromeMock;
beforeEach(() => {
    runInAction(() => {
        settingStore.popup = "";
        settingStore.cookie_select = {};
        settingStore.alert = {};
    });
    const event = () => ({addListener: vi.fn(), removeListener: vi.fn()});
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 1, url: "https://example.invalid/"}]), onActivated: event(), onUpdated: event(), reload: vi.fn().mockResolvedValue(undefined)},
        cookies: {getAll: vi.fn().mockResolvedValue([{...fixture}]), set: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({})},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({status: 404}));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openImport() {
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; }));
    return screen.findByPlaceholderText("JSON/Header string/Netscape");
}
function notifyCookieUpdate(action = "edit") {
    act(() => document.dispatchEvent(new CustomEvent("update_cookie", {detail: {action}})));
}

it("preserves the actual import draft and password across a pending/successful Cookie refresh", async () => {
    const refresh = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(Promise.resolve([{...fixture}])).mockReturnValueOnce(refresh.promise);
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=synthetic"}});
    const password = screen.getByPlaceholderText("label_password_decrypt");
    fireEvent.change(password, {target: {value: "fixture-password"}});
    notifyCookieUpdate();
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draft);
    expect(draft).toHaveValue("fixture=synthetic");
    expect(password).toHaveValue("fixture-password");
    await act(async () => refresh.resolve([{...fixture, value: "updated"}]));
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draft);
    expect(password).toHaveValue("fixture-password");
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
});

it("preserves a draft after refresh failure and still lets the actual import cancel", async () => {
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockRejectedValueOnce(new Error("Synthetic refresh failure"));
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=synthetic"}});
    notifyCookieUpdate();
    expect(await screen.findByRole("alert")).toHaveTextContent("msg_error");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draft);
    expect(draft).toHaveValue("fixture=synthetic");
    fireEvent.click(screen.getByText("btn_cancel"));
    expect(settingStore.popup).toBe("");
    expect(screen.queryByPlaceholderText("JSON/Header string/Netscape")).not.toBeInTheDocument();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
});

it("preserves the actual detail selection, search and edit draft until the user cancels", async () => {
    const refresh = deferred();
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockReturnValueOnce(refresh.promise);
    render(<ShowCookie />);
    const search = await screen.findByPlaceholderText("placeholder_search");
    fireEvent.change(search, {target: {value: "fixture"}});
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    const value = screen.getByLabelText("Value");
    fireEvent.change(value, {target: {value: "unsaved-fixture"}});
    notifyCookieUpdate();
    expect(screen.getByLabelText("Value")).toBe(value);
    await act(async () => refresh.resolve([{...fixture, value: "refreshed-fixture"}]));
    expect(screen.getByLabelText("Value")).toBe(value);
    expect(value).toHaveValue("unsaved-fixture");
    expect(search).toHaveValue("fixture");
    fireEvent.click(screen.getByText("Cancel"));
    expect(settingStore.popup).toBe("");
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});

it("keeps an in-flight actual import mounted through another refresh and closes on its own completion", async () => {
    const write = deferred(), refresh = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockReturnValueOnce(refresh.promise);
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=synthetic"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    notifyCookieUpdate();
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draft);
    await act(async () => refresh.resolve([{...fixture}]));
    expect(settingStore.popup).toBe("import_cookie");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draft);
    await act(async () => write.resolve({}));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(settingStore.alert.type).toBe("info");
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
    expect(chromeMock.tabs.reload).not.toHaveBeenCalled();
});

it("keeps an actual edit draft when same-tab refresh temporarily returns no Cookies", async () => {
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{...fixture}]);
    render(<ShowCookie />);
    const search = await screen.findByPlaceholderText("placeholder_search");
    fireEvent.change(search, {target: {value: "fixture"}});
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    const value = screen.getByLabelText("Value");
    fireEvent.change(value, {target: {value: "unsaved-fixture"}});
    notifyCookieUpdate();
    await screen.findByText("msg_no_cookies");
    expect(screen.getByLabelText("Value")).toBe(value);
    expect(value).toHaveValue("unsaved-fixture");
    notifyCookieUpdate();
    expect(await screen.findByPlaceholderText("placeholder_search")).toHaveValue("fixture");
    expect(screen.getByLabelText("Value")).toBe(value);
    fireEvent.click(screen.getByText("Cancel"));
    expect(settingStore.popup).toBe("");
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});

it("discards the previous tab's actual edit draft and search on activation", async () => {
    render(<ShowCookie />);
    const search = await screen.findByPlaceholderText("placeholder_search");
    fireEvent.change(search, {target: {value: "fixture"}});
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "unsaved-old-tab"}});
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, name: "second-cookie", domain: "second.invalid"}]);
    await act(async () => chromeMock.tabs.onActivated.addListener.mock.calls[0][0]());
    expect(await screen.findByText("second-cookie")).toBeInTheDocument();
    expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("unsaved-old-tab")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("placeholder_search")).toHaveValue("");
    expect(chromeMock.cookies.getAll).toHaveBeenLastCalledWith({url: "https://second.invalid/"});
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
});
