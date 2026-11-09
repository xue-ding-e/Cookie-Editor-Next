import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import DetailCookie from "../pages/Extension_sidepanel/components/detail_cookie";
import {settingStore} from "../mobx/setting.store";
import {googleAnalytics} from "./google_analytics";
import {clearCookie} from "./cookie";

// Real row, delete confirmation and editor. All browser/network boundaries are synthetic.
vi.mock("../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "", alert: {}, confirm_dialog: ["delete"], theme_mode: "dark",
        display_cookie: "default", customize_display_cookie: [{key: "name", display: true}], cookie_select: {}})};
});
vi.mock("./google_analytics", () => ({googleAnalytics: vi.fn()}));
vi.mock("../icons/delete", () => ({default: () => <span data-testid="remove-cookie-control" />}));
vi.mock("../icons/edit", () => ({default: () => <span data-testid="edit-cookie-control" />}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const tab = {id: 1, url: "https://example.invalid/account/view"};
const fixture = {name: "fixture-cookie", value: "synthetic", domain: "example.invalid", hostOnly: true, path: "/", secure: true, httpOnly: false, session: true, storeId: "0"};
let chromeMock;
beforeEach(() => {
    googleAnalytics.mockReset();
    runInAction(() => { settingStore.popup = ""; settingStore.alert = {}; settingStore.cookie_select = {}; settingStore.confirm_dialog = ["delete"]; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([tab])},
        cookies: {getAll: vi.fn().mockResolvedValue([{...fixture}]), remove: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue({})},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in synthetic preflight tests")));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function begin(operation, cookie = {...fixture}) {
    const view = render(<DetailCookie cookies={[cookie]} tab={tab} />);
    fireEvent.click(screen.getByTestId(operation === "delete" ? "remove-cookie-control" : "edit-cookie-control"));
    if (operation === "delete") {
        if (settingStore.confirm_dialog.includes("delete")) fireEvent.click(screen.getByRole("button", {name: "btn_delete"}));
    }
    else {
        fireEvent.change(screen.getByLabelText("Name"), {target: {value: "renamed-fixture"}});
        fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    }
    return view;
}

it.each(["delete", "edit"].flatMap(operation => ["path", "domain"].map(collision => [operation, collision])))
("preflight: %s refuses a same-name %s collision before requesting mutation", async (operation, collision) => {
    const sibling = collision === "path" ? {...fixture, path: "/account"} : {...fixture, domain: ".example.invalid", hostOnly: false};
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture}, sibling]);
    begin(operation);
    await act(async () => {});
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(settingStore.alert).toEqual({type: "error", message: "alert_cookie_removal_unverified"});
});

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const popupFor = operation => operation === "delete" ? "delete_cookie" : "edit_cookie";
const clickSubmit = operation => fireEvent.click(screen.getByRole("button", {name: operation === "delete" ? "btn_delete" : "Edit"}));
const cancel = operation => fireEvent.click(screen.getByRole("button", {name: operation === "delete" ? "btn_cancel" : "Cancel"}));
const expectNoMutation = () => {
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
};

it.each(["delete", "edit"])("preflight: %s queries only the captured URL/name/store and permits a unique match", async operation => {
    begin(operation);
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledExactlyOnceWith({url: tab.url, name: fixture.name, storeId: fixture.storeId});
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith({url: tab.url, name: fixture.name, storeId: fixture.storeId});
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(operation === "edit" ? 1 : 0);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
});

it.each(["delete", "edit"].flatMap(operation => ["empty", "undefined", "malformed", "changed identity"].map(response => [operation, response])))
("preflight: %s refuses a %s response without success effects", async (operation, response) => {
    const result = {empty: [], undefined: undefined, malformed: {}, "changed identity": [{...fixture, path: "/account"}]}[response];
    chromeMock.cookies.getAll.mockResolvedValue(result);
    const update = vi.fn();
    document.addEventListener("update_cookie", update);
    try {
        begin(operation);
        await waitFor(() => expect(settingStore.alert.message).toBe("alert_cookie_removal_unverified"));
        expectNoMutation();
        expect(update).not.toHaveBeenCalled();
        expect(googleAnalytics).not.toHaveBeenCalled();
        expect(settingStore.popup).toBe(popupFor(operation));
    } finally { document.removeEventListener("update_cookie", update); }
});

it.each(["delete", "edit"].flatMap(operation => ["unknown hostOnly", "missing store", "partitioned"].map(shape => [operation, shape])))
("preflight: %s refuses %s identity before any Cookie API read", async (operation, shape) => {
    const selected = {...fixture};
    if (shape === "unknown hostOnly") delete selected.hostOnly;
    if (shape === "missing store") delete selected.storeId;
    if (shape === "partitioned") selected.partitionKey = {topLevelSite: "https://example.invalid"};
    begin(operation, selected);
    await waitFor(() => expect(settingStore.alert.message).toBe("alert_cookie_removal_unverified"));
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expectNoMutation();
});

it.each(["delete", "edit"])("preflight: %s handles read rejection, retains its draft and permits explicit retry", async operation => {
    chromeMock.cookies.getAll.mockRejectedValueOnce(new Error("Synthetic preflight read failure"));
    begin(operation);
    await waitFor(() => expect(settingStore.alert.message).toBe("alert_cookie_removal_unverified"));
    expectNoMutation();
    expect(settingStore.popup).toBe(popupFor(operation));
    if (operation === "edit") expect(screen.getByLabelText("Name")).toHaveValue("renamed-fixture");
    clickSubmit(operation);
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(2);
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
});

it.each(["delete", "edit"])("preflight: %s permits an explicit retry after known ambiguity disappears", async operation => {
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}, {...fixture, path: "/account"}]);
    begin(operation);
    await waitFor(() => expect(settingStore.alert.message).toBe("alert_cookie_removal_unverified"));
    expectNoMutation();
    clickSubmit(operation);
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
});

it.each(["delete", "edit"])("preflight: rapid repeated %s submissions share one pending read", async operation => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    begin(operation);
    act(() => { clickSubmit(operation); clickSubmit(operation); });
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1);
    expectNoMutation();
    await act(async () => { read.resolve([{...fixture}]); });
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
});

it.each(["delete", "edit"].flatMap(operation => ["Cancel", "unmount", "tab", "tab and back", "popup and back"].map(change => [operation, change])))
("preflight: %s does not start mutation after %s during the read", async (operation, change) => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    const selected = {...fixture};
    const view = begin(operation, selected);
    expectNoMutation();
    if (change === "Cancel") cancel(operation);
    else if (change === "unmount") view.unmount();
    else if (change === "popup and back") act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.popup = popupFor(operation); }));
    else {
        view.rerender(<DetailCookie cookies={[selected]} tab={{id: 2, url: "https://different.invalid/"}} />);
        if (change === "tab and back") view.rerender(<DetailCookie cookies={[selected]} tab={tab} />);
    }
    act(() => runInAction(() => { settingStore.alert = {message: "new-fixture-alert"}; }));
    await act(async () => { read.resolve([{...fixture}]); });
    expectNoMutation();
    expect(settingStore.alert.message).toBe("new-fixture-alert");
});

it.each(["delete", "edit"])("preflight: stale %s read rejection cannot replace a newer popup", async operation => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    begin(operation);
    cancel(operation);
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.alert = {message: "new-fixture-alert"}; }));
    await act(async () => { read.reject(new Error("Synthetic stale preflight rejection")); });
    expectNoMutation();
    expect(settingStore.popup).toBe("new-fixture-popup");
    expect(settingStore.alert.message).toBe("new-fixture-alert");
});

it("preflight: cancellation after editor removal starts still completes its captured replacement", async () => {
    const removal = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(removal.promise);
    begin("edit");
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));
    cancel("edit");
    act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; }));
    await act(async () => { removal.resolve({}); });
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: "renamed-fixture", value: fixture.value, url: tab.url, storeId: fixture.storeId}));
    expect(settingStore.popup).toBe("new-fixture-popup");
});

it("preflight: editor snapshots the original identity rather than its mutable renamed draft", async () => {
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    begin("edit");
    act(() => runInAction(() => { settingStore.cookie_select.name = "later-fixture-draft"; }));
    await act(async () => { read.resolve([{...fixture}]); });
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith({url: tab.url, name: fixture.name, storeId: fixture.storeId});
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: "renamed-fixture"}));
});

it("preflight: no-confirm deletion uses the same ambiguity refusal", async () => {
    runInAction(() => { settingStore.confirm_dialog = []; });
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture}, {...fixture, path: "/account"}]);
    begin("delete");
    await waitFor(() => expect(settingStore.alert.message).toBe("alert_cookie_removal_unverified"));
    expectNoMutation();
});

it.each(["popup and back", "tab", "unmount"])
("preflight: no-confirm deletion does not start mutation after %s during its read", async change => {
    runInAction(() => { settingStore.confirm_dialog = []; });
    const read = deferred();
    chromeMock.cookies.getAll.mockReturnValueOnce(read.promise);
    const selected = {...fixture};
    const view = begin("delete", selected);
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1);
    expectNoMutation();
    if (change === "unmount") view.unmount();
    else if (change === "tab") view.rerender(<DetailCookie cookies={[selected]} tab={{id: 2, url: "https://different.invalid/"}} />);
    else act(() => runInAction(() => { settingStore.popup = "new-fixture-popup"; settingStore.popup = ""; }));
    act(() => runInAction(() => { settingStore.alert = {message: "new-fixture-alert"}; }));
    await act(async () => { read.resolve([{...fixture}]); });
    expectNoMutation();
    expect(settingStore.alert.message).toBe("new-fixture-alert");
});

it("preflight: bulk clear retains its separate contract without new reads", async () => {
    await clearCookie([{...fixture}, {...fixture, path: "/account"}], tab.url);
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(2);
});

it("preflight: an eligible same-identity edit still sets directly without a new read or removal", async () => {
    render(<DetailCookie cookies={[{...fixture}]} tab={tab} />);
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "synthetic-new"}});
    fireEvent.click(screen.getByRole("button", {name: "Edit"}));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
});
