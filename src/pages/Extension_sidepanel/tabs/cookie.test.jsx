import React, {StrictMode} from "react";
import {act, cleanup, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import ShowCookie from "./cookie";

// Mount the real tab component, but never load a browser profile or runtime network client.
vi.mock("mobx-react-lite", () => ({observer: component => component}));
vi.mock("../../../mobx/setting.store", () => ({settingStore: {tab: "home", theme_mode: "dark"}}));
vi.mock("../../../constants/icon", () => ({icons: {chrome: "fixture-default-icon"}}));
vi.mock("../components/top_action", () => ({default: () => <div data-testid="cookie-actions" />}));
vi.mock("../components/detail_cookie", () => ({default: ({cookies = []}) => <div>{cookies.map(cookie => cookie.name).join(",")}</div>}));

const event = () => {
    const listeners = new Set();
    return {listeners, addListener: vi.fn(fn => listeners.add(fn)), removeListener: vi.fn(fn => listeners.delete(fn)), emit: (...args) => listeners.forEach(fn => fn(...args))};
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};

let chromeMock, fetchMock;
beforeEach(() => {
    chromeMock = {
        tabs: {query: vi.fn().mockResolvedValue([]), onActivated: event(), onUpdated: event()},
        cookies: {getAll: vi.fn().mockResolvedValue([])},
        i18n: {getMessage: vi.fn(key => key)},
    };
    fetchMock = vi.fn().mockRejectedValue(new Error("Synthetic network is offline"));
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("active-tab Cookie loading with synthetic APIs only", () => {
    it.each([
        {label: "empty list", tabs: []},
        {label: "undefined tab", tabs: [undefined]},
        {label: "null tab", tabs: [null]},
        {label: "missing result", tabs: undefined},
    ])("settles an absent active tab: $label", async ({tabs}) => {
        chromeMock.tabs.query.mockResolvedValue(tabs);
        render(<ShowCookie />);
        expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(screen.queryByTestId("cookie-actions")).not.toBeInTheDocument();
        expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(["chrome://extensions/", "about:blank", "file:///fixture", undefined])("skips unsupported URL %s", async url => {
        chromeMock.tabs.query.mockResolvedValue([{id: 1, url}]);
        render(<ShowCookie />);
        expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
        expect(screen.queryByTestId("cookie-actions")).not.toBeInTheDocument();
        expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("shows a loading status until the query settles", async () => {
        const response = deferred();
        chromeMock.tabs.query.mockReturnValue(response.promise);
        render(<ShowCookie />);
        expect(screen.getByRole("status")).toHaveTextContent("button_loading");
        expect(screen.queryByTestId("cookie-actions")).not.toBeInTheDocument();
        await act(async () => response.resolve([]));
        expect(screen.getByText("msg_no_cookies")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("shows a query error, then recovers on the next activation", async () => {
        chromeMock.tabs.query.mockRejectedValueOnce(new Error("Synthetic query failure"));
        render(<ShowCookie />);
        expect(await screen.findByRole("alert")).toHaveTextContent("msg_error");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByText("msg_no_cookies")).not.toBeInTheDocument();
        expect(chromeMock.cookies.getAll).not.toHaveBeenCalled();
        await act(async () => chromeMock.tabs.onActivated.emit());
        expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("turns a Cookie API rejection into an error instead of an empty-success result", async () => {
        chromeMock.tabs.query.mockResolvedValue([{id: 1, url: "https://example.invalid/"}]);
        chromeMock.cookies.getAll.mockRejectedValue(new Error("Synthetic Cookie rejection"));
        render(<ShowCookie />);
        expect(await screen.findByRole("alert")).toHaveTextContent("msg_error");
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.queryByTestId("cookie-actions")).not.toBeInTheDocument();
        expect(screen.queryByText("msg_no_cookies")).not.toBeInTheDocument();
    });

    it("keeps successful Cookie data when the favicon request rejects", async () => {
        chromeMock.tabs.query.mockResolvedValue([{id: 1, url: "https://example.invalid/"}]);
        chromeMock.cookies.getAll.mockResolvedValue([{name: "synthetic-cookie", value: "fixture-only"}]);
        render(<ShowCookie />);
        expect(await screen.findByText("synthetic-cookie")).toBeInTheDocument();
        expect(screen.getByRole("img")).toHaveAttribute("src", "fixture-default-icon");
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("ignores stale Cookie and favicon responses after the tab disappears", async () => {
        const cookies = deferred(), favicon = deferred();
        chromeMock.tabs.query.mockResolvedValueOnce([{id: 1, url: "https://example.invalid/"}]);
        chromeMock.cookies.getAll.mockReturnValue(cookies.promise);
        fetchMock.mockReturnValue(favicon.promise);
        render(<ShowCookie />);
        await waitFor(() => expect(chromeMock.cookies.getAll).toHaveBeenCalledTimes(1));
        await act(async () => chromeMock.tabs.onActivated.emit());
        expect(await screen.findByText("msg_no_cookies")).toBeInTheDocument();
        await act(async () => {
            cookies.resolve([{name: "stale-cookie", value: "fixture-only"}]);
            favicon.resolve({status: 200});
        });
        expect(screen.queryByText("stale-cookie")).not.toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });

    it("cleans listeners under StrictMode and on unmount", async () => {
        const view = render(<StrictMode><ShowCookie /></StrictMode>);
        await screen.findByText("msg_no_cookies");
        expect(chromeMock.tabs.onActivated.listeners.size).toBe(1);
        expect(chromeMock.tabs.onUpdated.listeners.size).toBe(1);
        view.unmount();
        expect(chromeMock.tabs.onActivated.listeners.size).toBe(0);
        expect(chromeMock.tabs.onUpdated.listeners.size).toBe(0);
        const calls = chromeMock.tabs.query.mock.calls.length;
        act(() => document.dispatchEvent(new CustomEvent("update_cookie", {detail: {action: "import"}})));
        expect(chromeMock.tabs.query).toHaveBeenCalledTimes(calls);
    });

    it("does not reset the editor for unrelated/background tab updates", async () => {
        chromeMock.tabs.query.mockResolvedValue([{id: 1, url: "https://example.invalid/"}]);
        render(<ShowCookie />);
        await screen.findByTestId("cookie-actions");
        await act(async () => {
            chromeMock.tabs.onUpdated.emit(2, {status: "complete"});
            chromeMock.tabs.onUpdated.emit(1, {title: "Fixture title change"});
        });
        expect(chromeMock.tabs.query).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("cookie-actions")).toBeInTheDocument();
    });
});
