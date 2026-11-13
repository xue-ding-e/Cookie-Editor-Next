import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ExtensionN8n from "./index";
import {n8nStore} from "../../mobx/n8n.store";

// Real page, modal, MobX store and permission helper; only animation and Chrome APIs are replaced.
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

let chromeMock, permissionCount, holdPermission, releasePermission, denyNext, forbidden, sent;
beforeEach(() => {
    permissionCount = 0; holdPermission = 0; releasePermission = null; denyNext = false; sent = [];
    forbidden = vi.fn();
    const deny = () => { forbidden(); throw new Error("External data/network access forbidden"); };
    const event = () => ({addListener: vi.fn(), removeListener: vi.fn()});
    chromeMock = {
        i18n: {getMessage: key => key},
        permissions: {
            contains: vi.fn((details, done) => {
                permissionCount++;
                if (permissionCount === holdPermission) releasePermission = () => done(true);
                else if (denyNext) { denyNext = false; done(false); }
                else done(true);
            }),
            request: deny,
        },
        runtime: {id: "synthetic-extension", onMessage: event(), sendMessage: vi.fn(async request => {
            if (request.action === "n8n_get_status") return {success: true, data: {connected: false, clientKey: "", connectedAt: null, hasPassword: false, history: []}};
            if (request.action === "n8n_connect") { sent.push({...request}); return {success: false, message: "Synthetic connection refusal"}; }
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
        n8nStore.showConnectPopup = true; n8nStore.showConnectForm = true;
        n8nStore.password = "synthetic-submitted-a"; n8nStore.hasPermissions = true;
        n8nStore.showPermissionPopup = false; n8nStore.pendingConnectAfterPermission = false;
        n8nStore.alert = {type: "", message: ""};
    });
});
afterEach(() => { cleanup(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });

async function openPage() {
    render(<ExtensionN8n />);
    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({action: "n8n_get_status"}));
    return screen.getByPlaceholderText("pl_password");
}

it("sends the submitted draft in the normal permission flow", async () => {
    const input = await openPage();
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].password).toBe("synthetic-submitted-a");
});

for (const boundary of ["page", "store"]) {
    it(`retains the submitted draft across the ${boundary} permission callback`, async () => {
        const input = await openPage();
        holdPermission = permissionCount + (boundary === "page" ? 1 : 2);
        fireEvent.keyDown(input, {key: "Enter"});
        await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
        expect(sent).toHaveLength(0);
        fireEvent.change(input, {target: {value: "synthetic-unsubmitted-b"}});
        expect(n8nStore.password).toBe("synthetic-unsubmitted-b");
        await act(async () => releasePermission());
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0].password).toBe("synthetic-submitted-a");
        expect(input).toHaveValue("synthetic-unsubmitted-b");
    });
}

it("does not turn an empty submission into a later unsubmitted draft", async () => {
    const input = await openPage();
    fireEvent.change(input, {target: {value: "   "}});
    holdPermission = permissionCount + 1;
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
    fireEvent.change(input, {target: {value: "synthetic-unsubmitted-b"}});
    await act(async () => releasePermission());
    await waitFor(() => expect(
        screen.queryByText("Password is required") || screen.queryByText("Synthetic connection refusal"),
    ).toBeInTheDocument());
    expect(sent).toHaveLength(0);
    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(input).toHaveValue("synthetic-unsubmitted-b");
});

it("keeps the missing-permission flow without sending a connection", async () => {
    const input = await openPage();
    denyNext = true;
    fireEvent.keyDown(input, {key: "Enter"});
    await screen.findByText("n8n_permissions_title");
    expect(sent).toHaveLength(0);
    expect(n8nStore.pendingConnectAfterPermission).toBe(true);
});

it("keeps the existing no-argument store API tied to its invocation draft", async () => {
    holdPermission = permissionCount + 1;
    const connecting = n8nStore.connect();
    expect(releasePermission).toBeTypeOf("function");
    runInAction(() => { n8nStore.password = "synthetic-unsubmitted-b"; });
    releasePermission();
    await connecting;
    expect(sent).toHaveLength(1);
    expect(sent[0].password).toBe("synthetic-submitted-a");
    expect(n8nStore.password).toBe("synthetic-unsubmitted-b");
});
