import React from "react";
import {act, cleanup, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import ExtensionN8n from "./index";
import {n8nStore} from "../../mobx/n8n.store";

// Real page/modal/store and permissions; synthetic Chrome responses, no browser or network.
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

let chromeMock, permissionCount, holdPermission, releasePermission, sent, replies, forbidden;
beforeEach(() => {
    permissionCount = 0; holdPermission = 0; releasePermission = null; sent = []; replies = [];
    forbidden = vi.fn();
    const deny = () => { forbidden(); throw new Error("External data/network access forbidden"); };
    const event = () => ({addListener: vi.fn(), removeListener: vi.fn()});
    chromeMock = {
        i18n: {getMessage: key => key},
        permissions: {
            contains: vi.fn((details, done) => {
                permissionCount++;
                if (permissionCount === holdPermission) releasePermission = () => done(true);
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
                return new Promise(resolve => { replies.push(() => resolve({success: false, message: "Synthetic refusal"})); });
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
        n8nStore.openConnectPopup(); n8nStore.password = "synthetic-submission";
    });
});
afterEach(async () => {
    await act(async () => { releasePermission?.(); });
    await act(async () => { replies.forEach(reply => reply()); });
    cleanup(); expect(forbidden).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});

async function openPage() {
    render(<ExtensionN8n />);
    await waitFor(() => expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({action: "n8n_get_status"}));
    return screen.getByPlaceholderText("pl_password");
}

for (const boundary of ["page", "store"]) {
    for (const repeatedAction of ["Enter", "button"]) {
        it(`does not duplicate a submission during the ${boundary} permission wait via ${repeatedAction}`, async () => {
            const input = await openPage();
            holdPermission = permissionCount + (boundary === "page" ? 1 : 2);
            fireEvent.keyDown(input, {key: "Enter"});
            await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
            expect(n8nStore.loading).toBe(false);
            expect(sent).toHaveLength(0);
            await act(async () => {
                if (repeatedAction === "Enter") fireEvent.keyDown(input, {key: "Enter"});
                else {
                    const buttons = screen.getAllByRole("button", {name: "n8n_btn_connect"});
                    expect(buttons).toHaveLength(2);
                    fireEvent.click(buttons.at(-1));
                }
            });
            await act(async () => { releasePermission(); });
            await waitFor(() => expect(sent.length).toBeGreaterThan(0));
            expect(sent).toHaveLength(1);
        });
    }
}

it("still sends one ordinary submission", async () => {
    const input = await openPage();
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].password).toBe("synthetic-submission");
});

it("keeps the existing loading guard after dispatch", async () => {
    const input = await openPage();
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(n8nStore.loading).toBe(true);
    await act(async () => { fireEvent.keyDown(input, {key: "Enter"}); });
    expect(sent).toHaveLength(1);
});

it("allows the same form to retry after a failed submission", async () => {
    const input = await openPage();
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(1));
    await act(async () => { replies[0](); });
    await screen.findByText("Synthetic refusal");
    expect(n8nStore.loading).toBe(false);
    fireEvent.keyDown(input, {key: "Enter"});
    await waitFor(() => expect(sent).toHaveLength(2));
});

it("keeps a replacement form's pending submission protected after the old permission returns", async () => {
    const original = await openPage();
    holdPermission = permissionCount + 1;
    fireEvent.keyDown(original, {key: "Enter"});
    await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
    const releaseOriginal = releasePermission;
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    fireEvent.click(screen.getByRole("button", {name: "n8n_btn_connect"}));
    const replacement = await screen.findByPlaceholderText("pl_password");
    fireEvent.change(replacement, {target: {value: "synthetic-replacement"}});
    holdPermission = permissionCount + 1;
    releasePermission = null;
    fireEvent.keyDown(replacement, {key: "Enter"});
    await waitFor(() => expect(releasePermission).toBeTypeOf("function"));
    const releaseReplacement = releasePermission;
    await act(async () => { releaseOriginal(); });
    expect(sent).toHaveLength(0);
    expect(n8nStore.loading).toBe(false);
    await act(async () => { fireEvent.keyDown(replacement, {key: "Enter"}); });
    await act(async () => { releaseReplacement(); });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent).toHaveLength(1);
    expect(sent[0].password).toBe("synthetic-replacement");
});
