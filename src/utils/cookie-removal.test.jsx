import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import DetailCookie from "../pages/Extension_sidepanel/components/detail_cookie";
import TopAction from "../pages/Extension_sidepanel/components/top_action";
import {settingStore} from "../mobx/setting.store";
import {googleAnalytics} from "./google_analytics";
import {clearCookie, deleteCookie} from "./cookie";

// Real row/toolbar, confirmation dialogs and removal helpers; no real Cookie APIs.
vi.mock("../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "", alert: {}, confirm_dialog: [], theme_mode: "dark",
        display_cookie: "default", customize_display_cookie: [{key: "name", display: true}], cookie_select: {}})};
});
vi.mock("./google_analytics", () => ({googleAnalytics: vi.fn()}));
vi.mock("../mobx/account.store", () => ({accountStore: {account: null}}));
vi.mock("../pages/Extension_sidepanel/components/popup/edit_cookie", () => ({default: () => null}));
vi.mock("../pages/Extension_sidepanel/components/popup/copy_cookie", () => ({default: () => null}));
vi.mock("../pages/Extension_sidepanel/components/popup/share_cookie", () => ({default: () => null}));
vi.mock("../pages/Extension_sidepanel/components/popup/add_cookie", () => ({default: () => null}));
vi.mock("../pages/Extension_sidepanel/components/popup/import_cookie", () => ({default: () => null}));
vi.mock("../pages/Extension_sidepanel/components/popup/export_cookie", () => ({default: () => null}));
vi.mock("../icons/delete", () => ({default: () => <span data-testid="remove-cookie-control" />}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const sourceUrl = "https://displayed.invalid/sub/page";
const tab = {id: 1, url: sourceUrl};
const fixture = {name: "fixture-cookie", value: "synthetic", domain: "displayed.invalid", path: "/", storeId: "0"};
let chromeMock;
beforeEach(() => {
    googleAnalytics.mockReset();
    runInAction(() => { settingStore.popup = ""; settingStore.alert = {}; settingStore.confirm_dialog = []; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 2, url: "https://different.invalid/"}])},
        cookies: {getAll: vi.fn(), set: vi.fn(), remove: vi.fn().mockResolvedValue({})},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in synthetic removal tests")));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
    ["row", false], ["row", true], ["toolbar", false], ["toolbar", true],
])("removes from the displayed page through the real %s path (confirmation: %s)", async (path, confirm) => {
    runInAction(() => { settingStore.confirm_dialog = confirm ? ["delete", "delete_all"] : []; });
    const Component = path === "row" ? DetailCookie : TopAction;
    render(<Component cookies={[{...fixture}]} tab={tab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    if (confirm) fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.remove).toHaveBeenCalledWith({url: sourceUrl, name: fixture.name, storeId: fixture.storeId});
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    if (confirm) await waitFor(() => expect(settingStore.popup).toBe(""));
});

it.each([false, true])("keeps the clear URL after a deferred removal and navigation (confirmation: %s)", async (confirm) => {
    let finishFirst;
    chromeMock.cookies.remove.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
    runInAction(() => { settingStore.confirm_dialog = confirm ? ["delete_all"] : []; });
    const displayedTab = {...tab};
    const cookies = [{...fixture}, {...fixture, name: "fixture-second", storeId: "1"}];
    const view = render(<TopAction cookies={cookies} tab={displayedTab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    if (confirm) fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    displayedTab.url = "https://different.invalid/";
    view.rerender(<TopAction cookies={cookies} tab={displayedTab} />);
    await act(async () => { finishFirst({}); });
    expect(chromeMock.cookies.remove.mock.calls).toEqual([
        [{url: sourceUrl, name: fixture.name, storeId: "0"}],
        [{url: sourceUrl, name: "fixture-second", storeId: "1"}],
    ]);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(googleAnalytics).toHaveBeenCalledWith({name: "clear_cookie", params: []});
});

it.each([
    ["row", false], ["row", true], ["toolbar", false], ["toolbar", true],
])("rejects an unsupported displayed page through the %s path (confirmation: %s)", async (path, confirm) => {
    runInAction(() => { settingStore.confirm_dialog = confirm ? ["delete", "delete_all"] : []; });
    const Component = path === "row" ? DetailCookie : TopAction;
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        render(<Component cookies={[{...fixture}]} tab={{id: 3, url: "chrome://settings/"}} />);
        fireEvent.click(screen.getByTestId("remove-cookie-control"));
        if (confirm) fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));
        await waitFor(() => expect(settingStore.alert).toEqual({type: "error", message: "msg_error"}));
        expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(googleAnalytics).not.toHaveBeenCalled();
        expect(settingStore.popup).toBe(confirm ? (path === "row" ? "delete_cookie" : "delete_all_cookie") : "");
    } finally {
        document.removeEventListener("update_cookie", update);
    }
});

it.each([undefined, null, "", "not a URL", "file:///synthetic", "chrome://settings/"])("fails closed for both helpers with source %s", async (source) => {
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        expect(await deleteCookie({...fixture}, source)).toBe(false);
        expect(await clearCookie([{...fixture}], source)).toBe(false);
        expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
        expect(chromeMock.tabs.query).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(googleAnalytics).not.toHaveBeenCalled();
        expect(settingStore.alert).toEqual({type: "error", message: "msg_error"});
    } finally {
        document.removeEventListener("update_cookie", update);
    }
});

it("preserves HTTP, Cookie names and store IDs without consulting the active tab", async () => {
    expect(await deleteCookie({...fixture, storeId: "1"}, "http://displayed.invalid/sub/page")).toBe(true);
    expect(chromeMock.cookies.remove).toHaveBeenCalledWith({url: "http://displayed.invalid/sub/page", name: fixture.name, storeId: "1"});
    expect(settingStore.alert).toEqual({type: "info", message: "alert_delete_cookie_success"});
    expect(googleAnalytics).toHaveBeenCalledWith({name: "delete_cookie", params: []});
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
});
