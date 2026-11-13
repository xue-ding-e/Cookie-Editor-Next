import React from "react";
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {runInAction} from "mobx";
import N8nConnectModal from "./N8nConnectModal";
import {n8nStore} from "../../../mobx/n8n.store";

// Keep the real modal, MobX store, icons and event handlers. Replace animation only.
vi.mock("framer-motion", async () => {
    const {forwardRef} = await import("react");
    return {motion: {div: forwardRef(({initial, animate, exit, transition, ...props}, ref) => <div {...props} ref={ref} />)}};
});

let forbidden;
beforeEach(() => {
    forbidden = {cookies: vi.fn(), permissions: vi.fn(), messages: vi.fn(), fetch: vi.fn()};
    const deny = name => () => { forbidden[name](); throw new Error(`${name} access forbidden`); };
    const chrome = {i18n: {getMessage: key => key}};
    for (const key of ["cookies", "permissions", "runtime"]) {
        Object.defineProperty(chrome, key, {get: deny(key === "runtime" ? "messages" : key)});
    }
    vi.stubGlobal("chrome", chrome);
    vi.stubGlobal("fetch", deny("fetch"));
    runInAction(() => {
        n8nStore.showConnectPopup = true;
        n8nStore.showConnectForm = true;
        n8nStore.password = "synthetic-password";
        n8nStore.loading = false;
    });
});
afterEach(() => {
    cleanup();
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
});

const setLoading = value => act(() => runInAction(() => { n8nStore.loading = value; }));
const setup = () => {
    const submit = vi.fn();
    render(<N8nConnectModal error="" onSubmitConnect={submit} />);
    return {submit, input: screen.getByPlaceholderText("pl_password"), button: screen.getByRole("button", {name: "n8n_btn_connect"})};
};

it("submits an idle modal once with Enter", () => {
    const {submit, input} = setup();
    fireEvent.keyDown(input, {key: "Enter"});
    expect(submit).toHaveBeenCalledTimes(1);
});

it("does not submit with Enter while the real store marks the modal loading", () => {
    setLoading(true);
    const {submit, input, button} = setup();
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, {key: "Enter"});
    expect(submit).not.toHaveBeenCalled();
});

it("honors loading changes for keyboard submissions and allows a later retry", () => {
    const {submit, input, button} = setup();
    fireEvent.keyDown(input, {key: "Enter"});
    expect(submit).toHaveBeenCalledTimes(1);
    setLoading(true);
    expect(button).toBeDisabled();
    fireEvent.keyDown(input, {key: "Enter"});
    fireEvent.keyDown(input, {key: "Enter", repeat: true});
    expect(submit).toHaveBeenCalledTimes(1);
    setLoading(false);
    expect(button).toBeEnabled();
    fireEvent.keyDown(input, {key: "Enter"});
    expect(submit).toHaveBeenCalledTimes(2);
});

it("keeps the existing idle and loading button behavior", () => {
    const {submit, button} = setup();
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
    setLoading(true);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
});

it("does not submit other keys", () => {
    const {submit, input} = setup();
    for (const key of ["a", "Escape", "Tab"]) fireEvent.keyDown(input, {key});
    expect(submit).not.toHaveBeenCalled();
});

it("keeps cancellation available while loading without submitting", () => {
    setLoading(true);
    const {submit} = setup();
    fireEvent.click(screen.getByRole("button", {name: "btn_cancel"}));
    expect(n8nStore.showConnectPopup).toBe(false);
    expect(n8nStore.password).toBe("");
    expect(screen.queryByPlaceholderText("pl_password")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
});
