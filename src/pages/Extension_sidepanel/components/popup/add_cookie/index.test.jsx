import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import AddCookie from "./index";
import TopAction from "../../top_action";
import {settingStore} from "../../../../../mobx/setting.store";
import {googleAnalytics} from "../../../../../utils/google_analytics";

// Mount the real form and exercise its controls with synthetic browser boundaries only.
vi.mock("../../../../../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "add_cookie", alert: {}, confirm_dialog: [], theme_mode: "dark"})};
});
vi.mock("../../../../../utils/google_analytics", () => ({googleAnalytics: vi.fn()}));
// Keep the real toolbar/Add wiring; replace only unrelated dialogs and account state.
vi.mock("../../../../../mobx/account.store", () => ({accountStore: {account: null}}));
vi.mock("../copy_cookie", () => ({default: () => null}));
vi.mock("../clear_cookie", () => ({default: () => null}));
vi.mock("../share_cookie", () => ({default: () => null}));
vi.mock("../import_cookie", () => ({default: () => null}));
vi.mock("../export_cookie", () => ({default: () => null}));
vi.mock("../../../../../icons/add", () => ({default: () => <span data-testid="add-cookie-control" />}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

const tab = {id: 1, url: "https://example.invalid/"};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
let chromeMock, updateEvents;
beforeEach(() => {
    googleAnalytics.mockClear();
    updateEvents = vi.fn();
    document.addEventListener("update_cookie", updateEvents);
    runInAction(() => { settingStore.popup = "add_cookie"; settingStore.alert = {}; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 1, url: "https://example.invalid/"}])},
        cookies: {set: vi.fn().mockResolvedValue({})},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in synthetic tests")));
});
afterEach(() => {
    cleanup();
    document.removeEventListener("update_cookie", updateEvents);
    vi.unstubAllGlobals();
});

function control(label, tag) {
    // Locate the existing label's control even on the baseline with broken label associations.
    return screen.getByText(label).parentElement.querySelector(tag);
}
function openForm(sourceTab = tab) {
    const view = render(<AddCookie tab={sourceTab} />);
    fireEvent.change(control("Name", "input"), {target: {value: "fixture-cookie"}});
    fireEvent.change(control("Value", "textarea"), {target: {value: "synthetic-value"}});
    return view;
}

it.each([true, false])("submits the selected HttpOnly %s as the supported boolean API field", async httpOnly => {
    openForm();
    await userEvent.selectOptions(control("HttpOnly", "select"), String(httpOnly));
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith({
        name: "fixture-cookie", value: "synthetic-value", url: "https://example.invalid/", httpOnly,
    });
    expect(chromeMock.cookies.set.mock.calls[0][0]).not.toHaveProperty("hostOnly");
    await waitFor(() => expect(settingStore.alert.type).toBe("info"));
    expect(settingStore.popup).toBe("");
});

it("shows the browser's false default when HttpOnly has not been selected", async () => {
    openForm();
    expect(control("HttpOnly", "select")).toHaveValue("false");
    expect(screen.getByLabelText("HttpOnly")).toBe(control("HttpOnly", "select"));
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith({
        name: "fixture-cookie", value: "synthetic-value", url: "https://example.invalid/",
    });
});

it("keeps the existing SameSite and Secure selections independent of HttpOnly", async () => {
    openForm();
    await userEvent.selectOptions(control("SameSite", "select"), "lax");
    await userEvent.selectOptions(control("Secure", "select"), "true");
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith({
        name: "fixture-cookie", value: "synthetic-value", url: "https://example.invalid/", sameSite: "lax", secure: true,
    });
});

it("does not submit a changed HttpOnly draft after cancellation", async () => {
    openForm();
    await userEvent.selectOptions(control("HttpOnly", "select"), "true");
    fireEvent.click(screen.getByText("Cancel"));
    expect(settingStore.popup).toBe("");
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
});

it("adds to the displayed tab even if a fresh active-tab query would return another site", async () => {
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    openForm();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(chromeMock.cookies.set.mock.calls[0][0].url).toBe(tab.url);
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
});

it("locks the submitted draft and ignores repeated Add clicks until the write settles", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    openForm();
    const name = control("Name", "input"), add = screen.getByText("Add");
    act(() => { fireEvent.click(add); fireEvent.click(add); });
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    expect(add).toBeDisabled();
    for (const input of document.querySelectorAll("input, textarea, select")) expect(input).toBeDisabled();
    await userEvent.type(name, "must-not-change");
    expect(name).toHaveValue("fixture-cookie");
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("");
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1);
});

it("keeps a rejected add draft open and permits one explicit retry", async () => {
    chromeMock.cookies.set.mockRejectedValueOnce(new Error("Synthetic write failure"));
    openForm();
    await userEvent.selectOptions(control("HttpOnly", "select"), "true");
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("add_cookie");
    expect(control("Name", "input")).toHaveValue("fixture-cookie");
    expect(control("Value", "textarea")).toHaveValue("synthetic-value");
    expect(control("HttpOnly", "select")).toHaveValue("true");
    expect(screen.getByText("Add")).not.toBeDisabled();
    expect(updateEvents).not.toHaveBeenCalled();
    expect(googleAnalytics).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(2);
    expect(chromeMock.cookies.set.mock.calls[1][0]).toEqual(chromeMock.cookies.set.mock.calls[0][0]);
    expect(updateEvents).toHaveBeenCalledTimes(1);
    expect(settingStore.alert.type).toBe("info");
});

it.each(["success", "failure"])("ignores a cancelled add's late %s after reopening the form", async outcome => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    openForm();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Cancel"));
    act(() => runInAction(() => { settingStore.popup = "add_cookie"; }));
    expect(screen.getByText("Add")).toBeDisabled();
    expect(control("Name", "input")).toBeDisabled();
    await act(async () => outcome === "success" ? write.resolve({}) : write.reject(new Error("Synthetic late failure")));
    expect(settingStore.popup).toBe("add_cookie");
    expect(settingStore.alert).toEqual({});
    expect(updateEvents).not.toHaveBeenCalled();
    expect(control("Name", "input")).toHaveValue("");
    expect(control("Value", "textarea")).toHaveValue("");
    expect(screen.getByText("Add")).not.toBeDisabled();
    fireEvent.change(control("Name", "input"), {target: {value: "new-fixture"}});
    fireEvent.change(control("Value", "textarea"), {target: {value: "new-synthetic-value"}});
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledTimes(2);
    expect(chromeMock.cookies.set.mock.calls[1][0]).toEqual({name: "new-fixture", value: "new-synthetic-value", url: tab.url});
});

it("does not update another dialog after the original form unmounts", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const view = openForm();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    view.unmount();
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; settingStore.alert = {type: "info", message: "new-dialog-fixture"}; }));
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("import_cookie");
    expect(settingStore.alert.message).toBe("new-dialog-fixture");
    expect(updateEvents).not.toHaveBeenCalled();
});

it("retires a pending session when another popup replaces and then reopens Add", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    openForm();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    act(() => runInAction(() => { settingStore.popup = "import_cookie"; }));
    act(() => runInAction(() => { settingStore.popup = "add_cookie"; }));
    await act(async () => write.resolve({}));
    expect(settingStore.popup).toBe("add_cookie");
    expect(settingStore.alert).toEqual({});
    expect(updateEvents).not.toHaveBeenCalled();
});

it.each([{}, {id: 3, url: "chrome://extensions/"}])("rejects an unsupported displayed tab without querying a different tab: %j", async sourceTab => {
    openForm(sourceTab);
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(settingStore.alert.type).toBe("error"));
    expect(settingStore.popup).toBe("add_cookie");
    expect(control("Name", "input")).toHaveValue("fixture-cookie");
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
    expect(chromeMock.cookies.set).not.toHaveBeenCalled();
});

it("passes the displayed tab through the real toolbar into the actual Add form", async () => {
    act(() => runInAction(() => { settingStore.popup = ""; }));
    chromeMock.tabs.query.mockResolvedValue([{id: 2, url: "https://second.invalid/"}]);
    render(<TopAction cookies={[]} tab={tab} />);
    fireEvent.click(screen.getByTestId("add-cookie-control"));
    fireEvent.change(control("Name", "input"), {target: {value: "toolbar-fixture"}});
    fireEvent.change(control("Value", "textarea"), {target: {value: "synthetic-toolbar-value"}});
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(settingStore.popup).toBe(""));
    expect(chromeMock.cookies.set).toHaveBeenCalledExactlyOnceWith({name: "toolbar-fixture", value: "synthetic-toolbar-value", url: tab.url});
    expect(chromeMock.tabs.query).not.toHaveBeenCalled();
});

it("suppresses late completion if the same instance receives a different displayed tab", async () => {
    const write = deferred();
    chromeMock.cookies.set.mockReturnValueOnce(write.promise);
    const view = openForm();
    fireEvent.click(screen.getByText("Add"));
    await waitFor(() => expect(chromeMock.cookies.set).toHaveBeenCalledTimes(1));
    view.rerender(<AddCookie tab={{id: 2, url: "https://second.invalid/"}} />);
    await act(async () => write.resolve({}));
    expect(chromeMock.cookies.set.mock.calls[0][0].url).toBe(tab.url);
    expect(settingStore.popup).toBe("add_cookie");
    expect(settingStore.alert).toEqual({});
    expect(updateEvents).not.toHaveBeenCalled();
    expect(screen.getByText("Add")).not.toBeDisabled();
});
