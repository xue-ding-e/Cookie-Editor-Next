import React from "react";
import {cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import AddCookie from "./index";
import {settingStore} from "../../../../../mobx/setting.store";
import {googleAnalytics} from "../../../../../utils/google_analytics";

// Mount the real form and exercise its controls with synthetic browser boundaries only.
vi.mock("../../../../../mobx/setting.store", async () => {
    const {makeAutoObservable} = await import("mobx");
    return {settingStore: makeAutoObservable({popup: "add_cookie", alert: {}})};
});
vi.mock("../../../../../utils/google_analytics", () => ({googleAnalytics: vi.fn()}));
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

let chromeMock;
beforeEach(() => {
    googleAnalytics.mockClear();
    runInAction(() => { settingStore.popup = "add_cookie"; settingStore.alert = {}; });
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([{id: 1, url: "https://example.invalid/"}])},
        cookies: {set: vi.fn().mockResolvedValue({})},
        i18n: {getMessage: vi.fn(key => key)},
    };
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No network in synthetic tests")));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function control(label, tag) {
    // Locate the existing label's control even on the baseline with broken label associations.
    return screen.getByText(label).parentElement.querySelector(tag);
}
function openForm() {
    render(<AddCookie />);
    fireEvent.change(control("Name", "input"), {target: {value: "fixture-cookie"}});
    fireEvent.change(control("Value", "textarea"), {target: {value: "synthetic-value"}});
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
