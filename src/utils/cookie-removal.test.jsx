import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import DetailCookie from "../pages/Extension_sidepanel/components/detail_cookie";
import TopAction from "../pages/Extension_sidepanel/components/top_action";
import DeleteCookie from "../pages/Extension_sidepanel/components/popup/delete_cookie";
import ClearCookie from "../pages/Extension_sidepanel/components/popup/clear_cookie";
import ShowCookie from "../pages/Extension_sidepanel/tabs/cookie";
import {settingStore} from "../mobx/setting.store";
import {googleAnalytics} from "./google_analytics";
import {clearCookie, deleteCookie} from "./cookie";

// Real row/toolbar, confirmation dialogs and removal helpers; no real Cookie APIs.
vi.mock("../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({tab: "home", popup: "", alert: {}, confirm_dialog: [], theme_mode: "dark",
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
const fixture = {name: "fixture-cookie", value: "synthetic", domain: "displayed.invalid", hostOnly: true, secure: true, path: "/", storeId: "0"};
let chromeMock;
beforeEach(() => {
    googleAnalytics.mockReset();
    runInAction(() => { settingStore.popup = ""; settingStore.alert = {}; settingStore.confirm_dialog = []; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 2, url: "https://different.invalid/"}]),
            onActivated: {addListener: vi.fn(), removeListener: vi.fn()}, onUpdated: {addListener: vi.fn(), removeListener: vi.fn()}},
        cookies: {getAll: vi.fn().mockImplementation(async details => [{...fixture, name: details.name ?? fixture.name, storeId: details.storeId ?? fixture.storeId}]), set: vi.fn(), remove: vi.fn().mockResolvedValue({})},
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
    if (path === "row") expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url: sourceUrl, name: fixture.name, storeId: fixture.storeId});
    else expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
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

it.each(["row", "toolbar"])("removal dialog: cancelling the pending %s operation preserves a newer popup", async path => {
    let finish;
    chromeMock.cookies.remove.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    runInAction(() => { settingStore.confirm_dialog = ["delete", "delete_all"]; });
    const Component = path === "row" ? DetailCookie : TopAction;
    render(<Component cookies={[{...fixture}]} tab={tab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {type: "info", message: "new-fixture-alert"}; }));
    const update = vi.spyOn(document, "dispatchEvent");
    await act(async () => { finish({}); });
    expect(settingStore.popup).toBe("new-fixture-popup");
    expect(settingStore.alert.message).toBe("new-fixture-alert");
    expect(update).not.toHaveBeenCalled();
});

it.each(["row", "toolbar"])("removal dialog: repeated %s confirmation clicks start only one removal", async path => {
    let finish;
    chromeMock.cookies.remove.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    runInAction(() => { settingStore.confirm_dialog = ["delete", "delete_all"]; });
    const Component = path === "row" ? DetailCookie : TopAction;
    render(<Component cookies={[{...fixture}]} tab={tab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    const button = screen.getByRole("button", {name: "btn_delete"});
    act(() => {
        fireEvent.click(button);
        fireEvent.click(button);
    });
    await act(async () => { finish({}); });
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    expect(settingStore.popup).toBe("");
});

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const popupFor = path => path === "row" ? "delete_cookie" : "delete_all_cookie";
function openConfirmation(path, cookies = [{...fixture}], displayedTab = tab) {
    runInAction(() => { settingStore.confirm_dialog = ["delete", "delete_all"]; });
    const Component = path === "row" ? DetailCookie : TopAction;
    const view = render(<Component cookies={cookies} tab={displayedTab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    return view;
}
const confirmRemoval = () => fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));

it.each(["row", "toolbar"])("removal dialog: %s failure keeps the confirmation available for an explicit retry", async path => {
    chromeMock.cookies.remove.mockRejectedValueOnce(new Error("Synthetic removal rejection"));
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        openConfirmation(path);
        confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(settingStore.alert).toEqual({type: "error", message: "msg_error"}));
        expect(settingStore.popup).toBe(popupFor(path));
        expect(screen.getByRole("button", {name: "btn_delete"})).not.toBeDisabled();
        expect(update).not.toHaveBeenCalled();
        expect(googleAnalytics).not.toHaveBeenCalled();
        confirmRemoval();
        await waitFor(() => expect(settingStore.popup).toBe(""));
        expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"])("removal dialog: %s stale failure leaves a newer alert and popup intact", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    openConfirmation(path);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; }));
    await act(async () => { write.reject(new Error("Synthetic stale rejection")); });
    expect(settingStore.popup).toBe("new-fixture-popup");
    expect(settingStore.alert.message).toBe("new-fixture-alert");
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it.each(["row", "toolbar"].flatMap(path => ["Cancel", "outside", "replacement"].map(method => [path, method])))
("removal dialog: %s waits for its old operation after %s and reopening", async (path, method) => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    openConfirmation(path);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", {name: "btn_delete"})).toBeDisabled();
    if (method === "Cancel") fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    else if (method === "outside") fireEvent.mouseDown(document.body);
    else act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; }));
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    expect(screen.getByRole("button", {name: "btn_delete"})).toBeDisabled();
    confirmRemoval();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(settingStore.popup).toBe(popupFor(path));
        expect(update).not.toHaveBeenCalled();
        expect(screen.getByRole("button", {name: "btn_delete"})).not.toBeDisabled();
        confirmRemoval();
        await waitFor(() => expect(settingStore.popup).toBe(""));
        expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"])("removal dialog: unmounted %s completion cannot update another dialog", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const view = openConfirmation(path);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    view.unmount();
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; }));
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(settingStore.popup).toBe("new-fixture-popup");
        expect(settingStore.alert.message).toBe("new-fixture-alert");
        expect(update).not.toHaveBeenCalled();
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"].flatMap(path => ["tab ID", "URL", "URL and back"].map(change => [path, change])))
("removal dialog: %s ignores completion across a changed %s", async (path, change) => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const cookie = {...fixture};
    const Component = path === "row" ? DeleteCookie : ClearCookie;
    const props = {cookie, cookies: [cookie]};
    runInAction(() => { settingStore.popup = popupFor(path); });
    const view = render(<Component {...props} tab={tab} />);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    const changedTab = change === "tab ID" ? {...tab, id: 2} : {...tab, url: "https://different.invalid/"};
    view.rerender(<Component {...props} tab={changedTab} />);
    if (change === "URL and back") view.rerender(<Component {...props} tab={tab} />);
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(settingStore.popup).toBe(popupFor(path));
        expect(update).not.toHaveBeenCalled();
        expect(settingStore.alert).toEqual({});
    } finally { document.removeEventListener("update_cookie", update); }
});

it("removal dialog: changing the selected Cookie does not inherit the older selection's result", async () => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    runInAction(() => { settingStore.popup = "delete_cookie"; });
    const view = render(<DeleteCookie cookie={{...fixture}} tab={tab} />);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    view.rerender(<DeleteCookie cookie={{...fixture, name: "fixture-next"}} tab={tab} />);
    await act(async () => { write.resolve({}); });
    expect(settingStore.popup).toBe("delete_cookie");
    expect(settingStore.alert).toEqual({});
    confirmRemoval();
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.remove).toHaveBeenLastCalledWith({url: sourceUrl, name: "fixture-next", storeId: "0"});
});

it("removal dialog: a clear keeps its submitted list after cancellation and external list mutation", async () => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const cookies = [{...fixture}, {...fixture, name: "fixture-second", storeId: "1"}];
    openConfirmation("toolbar", cookies);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    cookies[1].name = "fixture-mutated";
    cookies[1].storeId = "2";
    cookies.push({...fixture, name: "fixture-later"});
    await act(async () => { write.resolve({}); });
    expect(chromeMock.cookies.remove.mock.calls).toEqual([
        [{url: sourceUrl, name: fixture.name, storeId: "0"}],
        [{url: sourceUrl, name: "fixture-second", storeId: "1"}],
    ]);
    expect(settingStore.popup).toBe("");
});

it.each(["row", "toolbar"])("removal dialog: %s refresh listeners may open a newer popup", async path => {
    const update = () => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; });
    document.addEventListener("update_cookie", update);
    try {
        openConfirmation(path);
        confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(settingStore.popup).toBe("new-fixture-popup"));
        expect(settingStore.alert.message).toBe("new-fixture-alert");
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"].flatMap(path => ["throw", "reject"].map(failure => [path, failure])))
("removal dialog: completed %s deletion is not reported as failed when analytics %s", async (path, failure) => {
    if (failure === "throw") googleAnalytics.mockImplementation(() => { throw new Error("Synthetic analytics failure"); });
    else googleAnalytics.mockRejectedValue(new Error("Synthetic analytics rejection"));
    openConfirmation(path);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(settingStore.alert.type).not.toBe("error");
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
});

it.each(["row", "toolbar"])("removal dialog: %s cannot inherit an old result across batched popup replacement", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    openConfirmation(path);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => {
        settingStore.popup = "new-fixture-popup";
        settingStore.popup = popupFor(path);
        settingStore.alert = {message: "new-fixture-alert"};
    }));
    await act(async () => { write.resolve({}); });
    expect(settingStore.popup).toBe(popupFor(path));
    expect(settingStore.alert.message).toBe("new-fixture-alert");
});

it.each(["row", "toolbar"])("removal dialog: actual ShowCookie refreshes and closes the successful %s confirmation", async path => {
    runInAction(() => { settingStore.confirm_dialog = ["delete", "delete_all"]; });
    chromeMock.tabs.query.mockResolvedValue([tab]);
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockImplementation(async details => details.name !== undefined ? [{...fixture}] : []);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getAllByTestId("remove-cookie-control")[path === "toolbar" ? 0 : 1]);
    confirmRemoval();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(path === "row" ? 3 : 2);
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith({url: sourceUrl, name: fixture.name, storeId: "0"});
    expect(chromeMock.tabs.query).toHaveBeenCalledTimes(1);
});

it.each(["row", "toolbar"])("direct removal: repeated %s clicks start one operation", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValue(write.promise);
    const Component = path === "row" ? DetailCookie : TopAction;
    render(<Component cookies={[{...fixture}]} tab={tab} />);
    const control = screen.getByTestId("remove-cookie-control");
    act(() => { fireEvent.click(control); fireEvent.click(control); });
    expect(control.parentElement).toHaveAttribute("aria-disabled", "true");
    await act(async () => { write.resolve({}); });
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    expect(control.parentElement).toHaveAttribute("aria-disabled", "false");
});

it.each(["row", "toolbar"])("direct removal: old %s completion cannot affect a newer popup", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const Component = path === "row" ? DetailCookie : TopAction;
    render(<Component cookies={[{...fixture}]} tab={tab} />);
    fireEvent.click(screen.getByTestId("remove-cookie-control"));
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; }));
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(update).not.toHaveBeenCalled();
        expect(settingStore.alert.message).toBe("new-fixture-alert");
        expect(settingStore.popup).toBe("new-fixture-popup");
    } finally { document.removeEventListener("update_cookie", update); }
});

function renderDirect(path, cookies = [{...fixture}], displayedTab = tab) {
    const Component = path === "row" ? DetailCookie : TopAction;
    return render(<Component cookies={cookies} tab={displayedTab} />);
}
const clickDirect = () => fireEvent.click(screen.getByTestId("remove-cookie-control"));

it.each(["row", "toolbar"])("direct removal: %s failure is handled and permits an explicit retry", async path => {
    chromeMock.cookies.remove.mockRejectedValueOnce(new Error("Synthetic direct rejection"));
    renderDirect(path);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(settingStore.alert).toEqual({type: "error", message: "msg_error"}));
    expect(screen.getByTestId("remove-cookie-control").parentElement).toHaveAttribute("aria-disabled", "false");
    expect(googleAnalytics).not.toHaveBeenCalled();
    clickDirect();
    await waitFor(() => expect(googleAnalytics).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(2);
});

it.each(["row", "toolbar"])("direct removal: stale %s rejection does not replace a newer alert", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    renderDirect(path);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; }));
    await act(async () => { write.reject(new Error("Synthetic stale direct rejection")); });
    expect(settingStore.alert.message).toBe("new-fixture-alert");
    expect(settingStore.popup).toBe("new-fixture-popup");
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it.each(["row", "toolbar"])("direct removal: %s result stays invalid after a batched popup opens and closes", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    renderDirect(path);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.popup = ""; settingStore.alert = {message: "new-fixture-alert"}; }));
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(update).not.toHaveBeenCalled();
        expect(settingStore.alert.message).toBe("new-fixture-alert");
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"].flatMap(path => ["tab", "tab and back", "unmount"].map(change => [path, change])))
("direct removal: %s ignores completion after %s", async (path, change) => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const cookies = [{...fixture}];
    const Component = path === "row" ? DetailCookie : TopAction;
    const view = renderDirect(path, cookies);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    if (change === "unmount") view.unmount();
    else {
        view.rerender(<Component cookies={cookies} tab={{id: 2, url: "https://different.invalid/"}} />);
        if (change === "tab and back") view.rerender(<Component cookies={cookies} tab={tab} />);
    }
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        await act(async () => { write.resolve({}); });
        expect(update).not.toHaveBeenCalled();
        expect(settingStore.alert).toEqual({});
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["row", "toolbar"])("direct removal: %s stays locked through opening and closing another popup", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    renderDirect(path);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; }));
    act(() => runInAction(() => { settingStore.popup = ""; }));
    clickDirect();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    await act(async () => { write.resolve({}); });
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(2));
});

it.each(["row", "toolbar"])("direct removal: %s cannot begin behind an already open popup", async path => {
    runInAction(() => { settingStore.popup = "new-fixture-popup"; });
    renderDirect(path);
    clickDirect();
    await act(async () => {});
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(settingStore.popup).toBe("new-fixture-popup");
});

it("direct removal: clear snapshots each submitted Cookie before waiting", async () => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    const cookies = [{...fixture}, {...fixture, name: "fixture-second", storeId: "1"}];
    renderDirect("toolbar", cookies);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    cookies[1].name = "fixture-mutated";
    cookies[1].storeId = "2";
    cookies.push({...fixture, name: "fixture-later"});
    await act(async () => { write.resolve({}); });
    expect(chromeMock.cookies.remove.mock.calls).toEqual([
        [{url: sourceUrl, name: fixture.name, storeId: "0"}],
        [{url: sourceUrl, name: "fixture-second", storeId: "1"}],
    ]);
});

it.each(["row", "toolbar"])("direct removal: actual ShowCookie refreshes after successful %s removal", async path => {
    chromeMock.tabs.query.mockResolvedValue([tab]);
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockImplementation(async details => details.name !== undefined ? [{...fixture}] : []);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getAllByTestId("remove-cookie-control")[path === "toolbar" ? 0 : 1]);
    expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(path === "row" ? 3 : 2);
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith({url: sourceUrl, name: fixture.name, storeId: "0"});
    expect(chromeMock.tabs.query).toHaveBeenCalledTimes(1);
});

it.each(["row", "toolbar"])("direct removal: pending %s cannot open its confirmation after the preference changes", async path => {
    const write = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(write.promise);
    renderDirect(path);
    clickDirect();
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.confirm_dialog = ["delete", "delete_all"]; }));
    clickDirect();
    expect(settingStore.popup).toBe("");
    expect(screen.queryByRole("button", {name: "btn_delete"})).not.toBeInTheDocument();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    await act(async () => { write.resolve({}); });
    clickDirect();
    expect(screen.getByRole("button", {name: "btn_delete"})).toBeInTheDocument();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
});
