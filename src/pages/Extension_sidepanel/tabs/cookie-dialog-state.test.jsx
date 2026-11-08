import React from "react";
import CryptoJS from "crypto-js";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ShowCookie from "./cookie";
import {settingStore} from "../../../mobx/setting.store";
import {googleAnalytics} from "../../../utils/google_analytics";

// Keep the real ImportCookie and DetailCookie/EditCookie components and their state.
// Only unrelated toolbar controls, animation, the store fixture and API boundaries are replaced.
vi.mock("../components/top_action", async () => {
    const {default: ImportCookie} = await import("../components/popup/import_cookie");
    return {default: ({tab}) => <ImportCookie tab={tab}/>};
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

const fixture = {name: "fixture-cookie", value: "synthetic", domain: "example.invalid", hostOnly: false, path: "/", secure: false, session: true, storeId: "0"};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
let chromeMock;
beforeEach(() => {
    googleAnalytics.mockClear();
    runInAction(() => {
        settingStore.format_import = "text";
        settingStore.option_import = [];
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

async function openEdit() {
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    return screen.getByLabelText("Value");
}

it("binds the actual edit to its displayed tab/profile and disables edits and repeat saves in flight", async () => {
    const removal = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(removal.promise);
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "submitted-fixture"}});
    fireEvent.change(screen.getByLabelText("Name"), {target: {value: "renamed-fixture"}});
    // Saving must not issue a fresh active-tab query.
    const queriesBeforeSave = chromeMock.tabs.query.mock.calls.length;
    // A fresh active-tab query would now return a different tab: saving must not make it.
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    const save = screen.getByText("Edit");
    fireEvent.click(save);
    for (const label of ["Name", "Value", "Expiration Date", "Path", "HttpOnly", "SameSite", "Secure"]) {
        expect(screen.getByLabelText(label)).toBeDisabled();
    }
    expect(save).toBeDisabled();
    await userEvent.type(value, "must-not-change-submitted-draft");
    fireEvent.click(save);
    expect(value).toHaveValue("submitted-fixture");
    expect(settingStore.cookie_select.value).toBe("submitted-fixture");
    expect(chromeMock.tabs.query).toHaveBeenCalledTimes(queriesBeforeSave);
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith({url: "https://example.invalid/", name: fixture.name, storeId: "0"});
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    await act(async () => removal.resolve({}));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        url: "https://example.invalid/", name: "renamed-fixture", value: "submitted-fixture", storeId: "0",
    }));
    expect(settingStore.popup).toBe("");
    expect(settingStore.alert.type).toBe("info");
    expect(googleAnalytics).toHaveBeenCalledExactlyOnceWith({name: "edit_cookie", params: []});
});

it("does not let A's pending actual edit write B's data, refresh B, or close B's editor", async () => {
    const removal = deferred();
    chromeMock.cookies.remove.mockReturnValueOnce(removal.promise);
    const valueA = await openEdit();
    fireEvent.change(valueA, {target: {value: "submitted-a"}});
    fireEvent.change(screen.getByLabelText("Path"), {target: {value: "/changed-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1));

    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, name: "second-cookie", domain: "second.invalid", storeId: "fixture-store-b"}]);
    await act(async () => chromeMock.tabs.onActivated.addListener.mock.calls[0][0]());
    await screen.findByText("second-cookie");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    const valueB = screen.getByLabelText("Value");
    fireEvent.change(valueB, {target: {value: "unsaved-b"}});
    act(() => runInAction(() => { settingStore.alert = {type: "info", message: "editor-b-fixture"}; }));
    const readsBeforeCompletion = chromeMock.cookies.getAll.mock.calls.length;
    await act(async () => removal.resolve({}));

    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        url: "https://example.invalid/", name: fixture.name, domain: "example.invalid", path: "/changed-fixture", value: "submitted-a", storeId: "0",
    }));
    expect(settingStore.popup).toBe("edit_cookie");
    expect(settingStore.alert.message).toBe("editor-b-fixture");
    expect(screen.getByLabelText("Value")).toBe(valueB);
    expect(valueB).toHaveValue("unsaved-b");
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(readsBeforeCompletion);
});

it("keeps an in-flight actual edit disabled across same-tab refresh and closes only its own dialog", async () => {
    const write = deferred(), refresh = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    chromeMock.cookies.getAll.mockResolvedValueOnce([{...fixture}]).mockReturnValueOnce(refresh.promise);
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "submitted-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    notifyCookieUpdate();
    await act(async () => refresh.resolve([{...fixture, value: "refreshed-fixture"}]));
    expect(screen.getByLabelText("Value")).toBe(value);
    expect(value).toHaveValue("submitted-fixture");
    expect(value).toBeDisabled();
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("");
    expect(settingStore.alert.type).toBe("info");
});

it.each(["remove", "set"])("keeps the actual edit draft after %s rejection, unlocks it and allows retry", async phase => {
    chromeMock.cookies[phase].mockRejectedValueOnce(new Error("Synthetic API failure"));
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "retry-fixture"}});
    // Retain remove-success then set-failure coverage as well as the direct-set cases below.
    fireEvent.change(screen.getByLabelText("Path"), {target: {value: "/changed-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("edit_cookie");
    expect(value).toHaveValue("retry-fixture");
    expect(value).not.toBeDisabled();
    expect(screen.getByText("Edit")).not.toBeDisabled();
    expect(chromeMock.cookies.remove).toHaveBeenCalledTimes(1);
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(phase === "remove" ? 0 : 1);
    expect(googleAnalytics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(settingStore.alert.type).toBe("info");
});

it("does not close a reopened actual editor when the cancelled save finishes", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    await openEdit();
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Cancel"));
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    const reopened = screen.getByLabelText("Value");
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("edit_cookie");
    expect(settingStore.alert).toEqual({});
    expect(screen.getByLabelText("Value")).toBe(reopened);
    expect(reopened).not.toBeDisabled();
});

it("locks the actual import draft and prevents another submission while its write is pending", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=synthetic"}});
    const submit = screen.getByText("btn_import");
    fireEvent.click(submit);
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(draft).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(screen.getByPlaceholderText("label_password_decrypt")).toBeDisabled();
    await userEvent.type(draft, "ignored-pending-draft");
    fireEvent.click(submit);
    expect(draft).toHaveValue("fixture=synthetic");
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve({}));
    await waitFor(() => expect(settingStore.popup).toBe(""));
});

it("does not let a cancelled actual import close a reopened importer", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=synthetic"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("btn_cancel"));
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "new-import-fixture"}; }));
    const reopened = screen.getByPlaceholderText("JSON/Header string/Netscape");
    expect(reopened).toHaveValue("");
    const readsBefore = chromeMock.cookies.getAll.mock.calls.length;
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("new-import-fixture");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(reopened);
    expect(reopened).not.toBeDisabled();
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(readsBefore);
    expect(chromeMock.tabs.reload).not.toHaveBeenCalled();
    fireEvent.change(reopened, {target: {value: "fixture=new-import-value"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(2);
    expect(chromeMock.cookies.set).toHaveBeenLastCalledWith(expect.objectContaining({value: "new-import-value"}));
});

it("does not let A's completed import close or refresh B's importer or reload B", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const draftA = await openImport();
    act(() => runInAction(() => { settingStore.option_import = ["reload_page"]; }));
    fireEvent.change(draftA, {target: {value: "fixture=synthetic-a"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, name: "second-cookie", domain: "second.invalid"}]);
    await act(async () => chromeMock.tabs.onActivated.addListener.mock.calls[0][0]());
    await screen.findByText("second-cookie");
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "import-b-fixture"}; }));
    const draftB = screen.getByPlaceholderText("JSON/Header string/Netscape");
    fireEvent.change(draftB, {target: {value: "fixture=unsaved-b"}});
    const readsBefore = chromeMock.cookies.getAll.mock.calls.length;
    await act(async () => write.resolve({}));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({url: "https://example.invalid/", value: "synthetic-a"}));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("import-b-fixture");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(draftB);
    expect(draftB).toHaveValue("fixture=unsaved-b");
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(readsBefore);
    expect(chromeMock.tabs.reload).not.toHaveBeenCalled();
});

it("keeps a rejected actual import draft open, re-enables it and allows retry", async () => {
    chromeMock.cookies.set.mockRejectedValueOnce(new Error("Synthetic import failure"));
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=retry-value"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("import_cookie");
    expect(draft).toHaveValue("fixture=retry-value");
    expect(draft).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(2);
    expect(settingStore.alert.type).toBe("info");
});

it("does not let an outside-dismissed import rejection affect the reopened importer", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture=old-import"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    // Exercise the real document listener rather than calling the close helper directly.
    fireEvent.mouseDown(document.body);
    expect(settingStore.popup).toBe("");
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "reopened-import"}; }));
    const reopened = screen.getByPlaceholderText("JSON/Header string/Netscape");
    expect(reopened).toHaveValue("");
    expect(reopened).toBeDisabled();
    const readsBefore = chromeMock.cookies.getAll.mock.calls.length;
    await act(async () => write.reject(new Error("Synthetic stale write failure")));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("reopened-import");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(reopened);
    expect(reopened).not.toBeDisabled();
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(readsBefore);
    expect(chromeMock.tabs.reload).not.toHaveBeenCalled();
});

it("does not let a pending source reload rejection affect a reopened importer", async () => {
    const reload = deferred();
    chromeMock.tabs.reload.mockReturnValueOnce(reload.promise);
    const draft = await openImport();
    act(() => runInAction(() => { settingStore.option_import = ["reload_page"]; }));
    fireEvent.change(draft, {target: {value: "fixture=completed-import"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.tabs.reload).toHaveBeenCalledExactlyOnceWith(1));
    expect(settingStore.popup).toBe("");
    expect(settingStore.alert.message).toBe("alert_import_cookie_success");
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "new-import-after-reload"}; }));
    const reopened = screen.getByPlaceholderText("JSON/Header string/Netscape");
    expect(reopened).toHaveValue("");
    expect(reopened).toBeDisabled();
    const readsBefore = chromeMock.cookies.getAll.mock.calls.length;
    await act(async () => reload.reject(new Error("Synthetic delayed reload failure")));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("new-import-after-reload");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toBe(reopened);
    expect(reopened).not.toBeDisabled();
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
    expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(readsBefore);
    expect(chromeMock.tabs.reload).toHaveBeenCalledTimes(1);
});

it("closes the completed importer before its source reload rebuilds the toolbar", async () => {
    chromeMock.tabs.reload.mockImplementationOnce(async id => {
        expect(settingStore.popup).toBe("");
        chromeMock.tabs.onUpdated.addListener.mock.calls[0][0](id, {status: "complete"});
    });
    const draft = await openImport();
    act(() => runInAction(() => { settingStore.option_import = ["reload_page"]; }));
    fireEvent.change(draft, {target: {value: "fixture=reload-value"}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(chromeMock.tabs.reload).toHaveBeenCalledExactlyOnceWith(1));
    await screen.findByPlaceholderText("placeholder_search");
    expect(settingStore.popup).toBe("");
    expect(screen.queryByPlaceholderText("JSON/Header string/Netscape")).not.toBeInTheDocument();
});

it("rejects a cancelled file read's late content when the importer is reopened", async () => {
    const readers = [];
    vi.stubGlobal("FileReader", class { constructor() { readers.push(this); } readAsText() {} });
    await openImport();
    fireEvent.click(screen.getByLabelText("Use a file"));
    fireEvent.change(document.querySelector('input[type="file"]'), {target: {files: [new File(["fixture=old-file"], "old-fixture.txt")]}});
    fireEvent.click(screen.getByText("btn_cancel"));
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; }));
    act(() => readers[0].onload({target: {result: "fixture=old-file"}}));
    // Submit before choosing another file, so a later valid read cannot mask stale data.
    // No selected, completed file means there is nothing safe to submit.
    fireEvent.click(screen.getByText("btn_import"));
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect(settingStore.popup).toBe("import_cookie");
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    fireEvent.change(document.querySelector('input[type="file"]'), {target: {files: [new File(["fixture=new-file"], "new-fixture.txt")]}});
    act(() => readers[1].onload({target: {result: "fixture=new-file"}}));
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new-file"}));
});

async function openFileImport() {
    const readers = [];
    vi.stubGlobal("FileReader", class {constructor() {readers.push(this);} readAsText() {}});
    await openImport();
    fireEvent.click(screen.getByLabelText("Use a file"));
    const select = name => fireEvent.change(document.querySelector('input[type="file"]'), {
        target: {files: [new File(["synthetic"], `${name}.txt`)]},
    });
    return {readers, select, finish: (index, value) => act(() => readers[index].onload({target: {result: value}}))};
}

it("imports only the latest selected file when older reads complete out of order", async () => {
    const h = await openFileImport(); h.select("old"); h.select("new");
    expect(screen.getByText("btn_import")).toBeDisabled();
    h.finish(1, "fixture=new-file"); h.finish(0, "fixture=old-file");
    expect(screen.getByText("btn_import")).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new-file"}));
});

it("blocks stale file submission while reading a replacement but allows another selection", async () => {
    const h = await openFileImport(); h.select("old"); h.finish(0, "fixture=old-file");
    h.select("new");
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect(document.querySelector('input[type="file"]')).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_import"));
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    h.finish(1, "fixture=new-file"); fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new-file"}));
});

it("keeps a failed selected file un-submittable and supports choosing a replacement", async () => {
    const h = await openFileImport(); h.select("old"); h.finish(0, "fixture=old-file");
    h.select("failed"); act(() => h.readers[1].onerror());
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect(settingStore.alert.type).toBe("error");
    fireEvent.click(screen.getByText("btn_import")); expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    h.select("retry"); h.finish(2, "fixture=retry"); fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "retry"}));
});

it("permits text import while an unrelated file read is pending", async () => {
    const h = await openFileImport(); h.select("pending");
    fireEvent.click(screen.getByLabelText("Use text"));
    fireEvent.change(screen.getByPlaceholderText("JSON/Header string/Netscape"), {target: {value: "fixture=text"}});
    expect(screen.getByText("btn_import")).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe("")); h.finish(0, "fixture=discarded");
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "text"}));
});

it("discards a completed file when switching away and back to an empty file input", async () => {
    const h = await openFileImport();
    h.select("old");
    h.finish(0, "fixture=old-file");
    const originalInput = document.querySelector('input[type="file"]');
    fireEvent.click(screen.getByLabelText("Use text"));
    fireEvent.click(screen.getByLabelText("Use a file"));
    const emptyInput = document.querySelector('input[type="file"]');
    expect(emptyInput).not.toBe(originalInput);
    expect(emptyInput.files).toHaveLength(0);
    fireEvent.click(screen.getByText("btn_import"));
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect(settingStore.popup).toBe("import_cookie");
});

it.each(["onload", "onerror", "onabort"])("ignores a pending file's %s after switching away and back, then accepts a new selection", async event => {
    const h = await openFileImport();
    h.select("old");
    fireEvent.click(screen.getByLabelText("Use text"));
    fireEvent.click(screen.getByLabelText("Use a file"));
    const priorAlert = {...settingStore.alert};
    act(() => h.readers[0][event]({target: {result: "fixture=old-file"}}));
    expect(document.querySelector('input[type="file"]').files).toHaveLength(0);
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect({...settingStore.alert}).toEqual(priorAlert);
    fireEvent.click(screen.getByText("btn_import"));
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    h.select("new");
    h.finish(1, "fixture=new-file");
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new-file"}));
});

it("keeps the selected file when clicking the already active file format", async () => {
    const h = await openFileImport();
    h.select("selected");
    h.finish(0, "fixture=selected");
    const fileInput = document.querySelector('input[type="file"]');
    fireEvent.click(screen.getByLabelText("Use a file"));
    expect(document.querySelector('input[type="file"]')).toBe(fileInput);
    expect(screen.getByText("btn_import")).not.toBeDisabled();
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "selected"}));
});

it("retains the independent text draft while discarding a file on format change", async () => {
    const h = await openFileImport();
    fireEvent.click(screen.getByLabelText("Use text"));
    fireEvent.change(screen.getByPlaceholderText("JSON/Header string/Netscape"), {target: {value: "fixture=text-draft"}});
    fireEvent.click(screen.getByLabelText("Use a file"));
    h.select("pending");
    fireEvent.click(screen.getByLabelText("Use text"));
    h.finish(0, "fixture=discarded");
    expect(screen.getByPlaceholderText("JSON/Header string/Netscape")).toHaveValue("fixture=text-draft");
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "text-draft"}));
});

function nativeResettableFileInput() {
    const input = document.querySelector('input[type="file"]');
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    // user-event 13 installs an own `files` property instead of a native FileList.
    // Restore the browser's empty-value-clears-files contract for that test double.
    Object.defineProperty(input, "value", {
        configurable: true,
        get() { return nativeValue.get.call(this); },
        set(value) {
            nativeValue.set.call(this, value);
            if (value === "") delete this.files;
        },
    });
    return input;
}

it.each(["onerror", "onabort", "throw"])("can select the same file again after a read %s", async failure => {
    const readers = [];
    vi.stubGlobal("FileReader", class {
        constructor() { readers.push(this); }
        readAsText() {
            if (failure === "throw" && this === readers[0]) throw new Error("Synthetic read failure");
        }
    });
    await openImport();
    fireEvent.click(screen.getByLabelText("Use a file"));
    const input = nativeResettableFileInput();
    const file = new File(["fixture=retry"], "retry-fixture.txt");
    act(() => userEvent.upload(input, file));
    expect(readers).toHaveLength(1);
    if (failure !== "throw") act(() => readers[0][failure]());
    expect(screen.getByText("btn_import")).toBeDisabled();
    expect(settingStore.alert.type).toBe("error");
    expect(input.files).toHaveLength(0);
    // userEvent preserves native same-selection behavior: the identical file
    // does not emit a second change unless the failed selection was cleared.
    act(() => userEvent.upload(input, file));
    expect(readers).toHaveLength(2);
    act(() => readers[1].onload({target: {result: "fixture=retry"}}));
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "retry"}));
});

it("keeps the newer native file selection when an older read fails", async () => {
    const h = await openFileImport();
    const input = nativeResettableFileInput();
    const oldFile = new File(["fixture=old"], "old-fixture.txt");
    const newFile = new File(["fixture=new"], "new-fixture.txt");
    act(() => userEvent.upload(input, oldFile));
    act(() => userEvent.upload(input, newFile));
    act(() => h.readers[0].onerror());
    expect(document.querySelector('input[type="file"]')).toBe(input);
    expect(input.files[0]).toBe(newFile);
    h.finish(1, "fixture=new");
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new"}));
});

it("preserves a successful file selection when choosing the same file again", async () => {
    const h = await openFileImport();
    const input = nativeResettableFileInput();
    const file = new File(["fixture=selected"], "selected-fixture.txt");
    act(() => userEvent.upload(input, file));
    h.finish(0, "fixture=selected");
    act(() => userEvent.upload(input, file));
    expect(h.readers).toHaveLength(1);
    expect(document.querySelector('input[type="file"]')).toBe(input);
    expect(input.files[0]).toBe(file);
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "selected"}));
});

it("retains a replacement file when failure and selection share a render batch", async () => {
    const h = await openFileImport();
    const input = nativeResettableFileInput();
    const oldFile = new File(["fixture=old"], "old-fixture.txt");
    const newFile = new File(["fixture=new"], "new-fixture.txt");
    act(() => userEvent.upload(input, oldFile));
    act(() => {
        h.readers[0].onerror();
        userEvent.upload(input, newFile);
    });
    expect(document.querySelector('input[type="file"]')).toBe(input);
    expect(input.files[0]).toBe(newFile);
    h.finish(1, "fixture=new");
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({value: "new"}));
});

it.each([
    ["host-only", "example.invalid", true, "fixture-cookie", false],
    ["domain", ".example.invalid", false, "fixture-cookie", true],
    ["explicit domain without a leading dot", "example.invalid", false, "fixture-cookie", true],
    ["__Host-", "example.invalid", true, "__Host-fixture", false],
    ["legacy domain", ".example.invalid", undefined, "fixture-cookie", true],
    ["legacy host-only", "example.invalid", undefined, "fixture-cookie", false],
])("preserves the %s Cookie scope when editing only its value", async (_kind, domain, hostOnly, name, includeDomain) => {
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, domain, hostOnly, name, secure: true}]);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "synthetic-updated"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    const details = chromeMock.cookies.set.mock.calls[0][0];
    expect(details).toMatchObject({name, value: "synthetic-updated", path: "/", secure: true, storeId: "0", url: "https://example.invalid/"});
    if (includeDomain) expect(details.domain).toBe(domain);
    else expect(details).not.toHaveProperty("domain");
    expect(details).not.toHaveProperty("hostOnly");
    await waitFor(() => expect(settingStore.popup).toBe(""));
});

it("omits the domain when an existing domain Cookie is renamed with the __Host- prefix", async () => {
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, domain: ".example.invalid", hostOnly: false, secure: true}]);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Name"), {target: {value: "__Host-renamed-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.remove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: fixture.name, storeId: "0"}));
    expect(chromeMock.cookies.set.mock.calls[0][0]).toMatchObject({name: "__Host-renamed-fixture", path: "/", secure: true, storeId: "0"});
    expect(chromeMock.cookies.set.mock.calls[0][0]).not.toHaveProperty("domain");
    await waitFor(() => expect(settingStore.popup).toBe(""));
});

it.each(["", " \t\n", "[]", "# Netscape HTTP Cookie File\n# synthetic comment\n"])("keeps zero-entry text import %j open without claiming success", async value => {
    const draft = await openImport();
    fireEvent.change(draft, {target: {value}});
    act(() => runInAction(() => { settingStore.option_import = ["reload_page"]; }));
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("import_cookie");
    expect(draft).toHaveValue(value);
    expect(screen.getByText("btn_import")).not.toBeDisabled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(chromeMock.tabs.reload).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("retains an encrypted empty list and its password instead of reporting an import", async () => {
    const password = "synthetic-empty-list-password";
    const encrypted = CryptoJS.AES.encrypt("[]", password).toString();
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: encrypted}});
    const passwordInput = screen.getByPlaceholderText("label_password_decrypt");
    fireEvent.change(passwordInput, {target: {value: password}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("import_cookie");
    expect(draft).toHaveValue(encrypted);
    expect(passwordInput).toHaveValue(password);
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("keeps a comment-only file open instead of reporting a successful import", async () => {
    const h = await openFileImport();
    h.select("comment-only");
    h.finish(0, "# Netscape HTTP Cookie File\n# synthetic comment\n");
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("import_cookie");
    expect(document.querySelector('input[type="file"]').files).toHaveLength(1);
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("still imports a valid Cookie whose value is empty", async () => {
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: "fixture="}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: "fixture", value: ""}));
    expect(settingStore.alert.type).toBe("info");
});

it("still decrypts and imports an encrypted nonempty Cookie list", async () => {
    const password = "synthetic-valid-list-password";
    const plaintext = JSON.stringify([{name: "fixture", value: "synthetic-encrypted", path: "/"}]);
    const encrypted = CryptoJS.AES.encrypt(plaintext, password).toString();
    const draft = await openImport();
    fireEvent.change(draft, {target: {value: encrypted}});
    fireEvent.change(screen.getByPlaceholderText("label_password_decrypt"), {target: {value: password}});
    fireEvent.click(screen.getByText("btn_import"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: "fixture", value: "synthetic-encrypted"}));
    expect(settingStore.alert.type).toBe("info");
});

it.each([
    ["invalid persistent date", false, "not a date"],
    ["cleared persistent date", false, ""],
    ["invalid session-date draft", true, "2030-02-03T04:05:06Z"],
])("does not remove or write a Cookie for %s", async (_kind, session, input) => {
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, session, expirationDate: session ? undefined : 1893456000}]);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "unsaved-expiry-fixture"}});
    fireEvent.change(screen.getByLabelText("Expiration Date"), {target: {value: input}});
    expect(Number.isFinite(settingStore.cookie_select.expirationDate)).toBe(false);
    fireEvent.click(screen.getByText("Edit"));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(googleAnalytics).not.toHaveBeenCalled();
    expect(settingStore.popup).toBe("edit_cookie");
    expect(screen.getByLabelText("Value")).toHaveValue("unsaved-expiry-fixture");
    expect(screen.getByText("Edit")).not.toBeDisabled();
    if (session) {
        fireEvent.click(screen.getByText("Cancel"));
        expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    } else {
        fireEvent.change(screen.getByLabelText("Expiration Date"), {target: {value: "2030-02-03T04:05:06Z"}});
        fireEvent.click(screen.getByText("Edit"));
        await waitFor(() => expect(settingStore.popup).toBe(""));
        expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
        expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({expirationDate: 1896321906, value: "unsaved-expiry-fixture"}));
    }
});

it.each([["session", undefined], ["persistent", 1893456000]])("continues to save a valid %s Cookie expiration", async (_kind, expirationDate) => {
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, session: expirationDate === undefined, expirationDate}]);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getByTestId("edit-cookie-control"));
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "valid-expiry-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({expirationDate, value: "valid-expiry-fixture"}));
});

it("direct-set: does not pre-delete an unchanged Cookie when its replacement is rejected", async () => {
    chromeMock.cookies.set.mockRejectedValueOnce(new Error("Synthetic replacement rejected"));
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "replacement-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: fixture.name, value: "replacement-fixture", path: "/", storeId: "0"}));
    expect(settingStore.popup).toBe("edit_cookie");
    expect(value).toHaveValue("replacement-fixture");
    expect(screen.getByText("Edit")).not.toBeDisabled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("direct-set: targets the original explicit path without name-only removal among same-name Cookies", async () => {
    chromeMock.tabs.query.mockResolvedValue([{id: 1, url: "https://example.invalid/account/view"}]);
    chromeMock.cookies.getAll.mockResolvedValue([
        {...fixture, hostOnly: true, path: "/"},
        {...fixture, hostOnly: true, path: "/account"},
    ]);
    render(<ShowCookie />);
    await screen.findByPlaceholderText("placeholder_search");
    fireEvent.click(screen.getAllByTestId("edit-cookie-control")[0]);
    fireEvent.change(screen.getByLabelText("Value"), {target: {value: "root-path-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: fixture.name, value: "root-path-fixture", path: "/", url: "https://example.invalid/account/view", storeId: "0"}));
    expect(chromeMock.cookies.set.mock.calls[0][0]).not.toHaveProperty("domain");
});

it("direct-set: still locks repeated clicks and the draft while a replacement is pending", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "pending-replacement-fixture"}});
    const save = screen.getByText("Edit");
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(save).toBeDisabled();
    expect(value).toBeDisabled();
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("");
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
});

it("direct-set: preserves explicit domain scope when editing from a subdomain", async () => {
    chromeMock.tabs.query.mockResolvedValue([{id: 1, url: "https://sub.example.invalid/account"}]);
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, domain: ".example.invalid", hostOnly: false, storeId: "fixture-store-domain"}]);
    const value = await openEdit();
    fireEvent.change(value, {target: {value: "domain-replacement-fixture"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({domain: ".example.invalid", path: "/", storeId: "fixture-store-domain", url: "https://sub.example.invalid/account"}));
});

it("direct-set: leaves prefix security enforcement to set without pre-deletion or silent flag repair", async () => {
    chromeMock.cookies.getAll.mockResolvedValue([{...fixture, name: "__Host-fixture", hostOnly: true, secure: true}]);
    chromeMock.cookies.set.mockRejectedValueOnce(new Error("Synthetic prefix policy rejection"));
    await openEdit();
    fireEvent.change(screen.getByLabelText("Secure"), {target: {value: "false"}});
    fireEvent.click(screen.getByText("Edit"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(chromeMock.cookies.remove).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name: "__Host-fixture", secure: false, path: "/"}));
    expect(chromeMock.cookies.set.mock.calls[0][0]).not.toHaveProperty("domain");
    expect(settingStore.popup).toBe("edit_cookie");
});
