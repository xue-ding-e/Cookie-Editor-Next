import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ExtensionN8n from "./index";
import {n8nStore} from "../../mobx/n8n.store";

// Real page, modal, MobX store and permission helper. Only animation and Chrome APIs are replaced.
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

let chromeMock, permissionCount, holdPermission, releasePermission, forbidden, sent, holdConnect, releaseConnect;
beforeEach(() => {
    permissionCount = 0; holdPermission = 0; releasePermission = null; sent = [];
    holdConnect = false; releaseConnect = null;
    forbidden = vi.fn();
    const deny = () => { forbidden(); throw new Error("External data/network access forbidden"); };
    const event = () => ({addListener: vi.fn(), removeListener: vi.fn()});
    chromeMock = {
        i18n: {getMessage: key => key},
        permissions: {
            contains: vi.fn((details, done) => {
                permissionCount++;
                if (permissionCount === holdPermission) releasePermission = granted => done(granted);
                else done(true);
            }),
            request: deny,
        },
        runtime: {id: "synthetic-extension", onMessage: event(), sendMessage: vi.fn(async request => {
            if (request.action === "n8n_get_status") return {success: true, data: {
                connected: false, clientKey: "", connectedAt: null, hasPassword: false, history: [],
            }};
            if (request.action === "n8n_connect") {
                sent.push({...request});
                const response = {success: true, data: {
                    connected: true, clientKey: "synthetic-a-key", connectedAt: 1, hasPassword: true, history: [],
                }};
                if (holdConnect) return new Promise(resolve => { releaseConnect = () => resolve(response); });
                return response;
            }
            return deny();
        })},
        storage: {onChanged: event()},
    };
    Object.defineProperty(chromeMock, "cookies", {get: deny});
    vi.stubGlobal("chrome", chromeMock);
    vi.stubGlobal("fetch", deny);
    vi.stubGlobal("WebSocket", deny);
    runInAction(() => {
        n8nStore.connected = false; n8nStore.clientKey = ""; n8nStore.connectedAt = null;
        n8nStore.hasPassword = false; n8nStore.history = []; n8nStore.loading = false;
        n8nStore.showStatusPanel = false; n8nStore.hasPermissions = true;
        n8nStore.showPermissionPopup = false; n8nStore.pendingConnectAfterPermission = false;
        n8nStore.alert = {type: "", message: ""};
        n8nStore.openConnectPopup();
        n8nStore.password = "synthetic-submitted-a";
    });
});
afterEach(() => { cleanup(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

async function openPage() {
    render(<ExtensionN8n />);
    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({action: "n8n_get_status"}));
    return screen.getByPlaceholderText("pl_password");
}

for (const boundary of ["page", "store"]) {
    for (const mode of ["cancel", "reopen", "reopen-denied"]) {
        it(`retires the ${boundary} permission continuation after ${mode}`, async () => {
            const original = await openPage();
            holdPermission = permissionCount + (boundary === "page" ? 1 : 2);
            fireEvent.keyDown(original, {key: "Enter"});
            await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
            expect(n8nStore.loading).toBe(false);
            expect(sent).toHaveLength(0);

            fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
            expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument();
            if (mode !== "cancel") {
                // Exercise the real header button, not a direct call to the store's open method.
                fireEvent.click(screen.getByRole("button", {name: "n8n_btn_connect"}));
                const replacement = await screen.findByPlaceholderText("pl_password");
                fireEvent.change(replacement, {target: {value: "synthetic-unsubmitted-b"}});
            }

            await act(async () => { releasePermission(mode !== "reopen-denied"); });
            expect(sent).toHaveLength(0);
            expect(screen.queryByText("n8n_permissions_title")).not.toBeInTheDocument();
            if (mode === "cancel") {
                expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument();
            } else {
                expect(screen.getByPlaceholderText("pl_password")).toHaveValue("synthetic-unsubmitted-b");
            }
            expect(n8nStore.loading).toBe(false);
            if (mode === "reopen") {
                fireEvent.keyDown(screen.getByPlaceholderText("pl_password"), {key: "Enter"});
                await waitFor(() => expect(sent).toHaveLength(1));
                expect(sent[0].password).toBe("synthetic-unsubmitted-b");
                await waitFor(() => expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument());
                expect(n8nStore.loading).toBe(false);
            }
        });
    }
}

it("still closes the current form on a normal successful submission", async () => {
    const input = await openPage();
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument());
    expect(sent[0].password).toBe("synthetic-submitted-a");
    expect(n8nStore.connected).toBe(true);
    expect(n8nStore.loading).toBe(false);
});

for (const boundary of ["page", "store"]) {
    it(`preserves the ${boundary} permission flow for the current form`, async () => {
        const input = await openPage();
        holdPermission = permissionCount + (boundary === "page" ? 1 : 2);
        fireEvent.keyDown(input, {key: "Enter"});
        await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
        await act(async () => { releasePermission(false); });
        await screen.findByText("n8n_permissions_title");
        expect(n8nStore.pendingConnectAfterPermission).toBe(true);
        expect(sent).toHaveLength(0);
    });
}

it("releases loading after an already-sent connection completes following dismissal", async () => {
    const input = await openPage();
    holdConnect = true;
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(releaseConnect).toBeTypeOf("function"));
    expect(n8nStore.loading).toBe(true);
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    const dismissedSession = n8nStore.connectPopupSession;
    expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument();
    await act(async () => { releaseConnect(); });
    expect(sent).toHaveLength(1);
    expect(n8nStore.connected).toBe(true);
    expect(n8nStore.loading).toBe(false);
    expect(n8nStore.connectPopupSession).toBe(dismissedSession);
});
