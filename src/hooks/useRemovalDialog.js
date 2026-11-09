import {useEffect, useRef, useState} from "react";
import {observe} from "mobx";
import {settingStore} from "../mobx/setting.store";
import {extension} from "../utils/chrome";

// Confirmation dialogs share one in-flight operation, but never share its UI result
// with a later dialog, selected Cookie or displayed page.
export function useRemovalDialog(popupName, tab, target) {
    const mounted = useRef(false);
    const session = useRef(0);
    const inProgress = useRef(false);
    const current = useRef({tab, target});
    const [removing, setRemoving] = useState(false);
    current.current = {tab, target};

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    // Observe each assignment, including an away/back replacement batched before
    // React renders. The disposer also removes this listener on unmount.
    useEffect(() => observe(settingStore, "popup", ({newValue}) => {
        if (newValue !== popupName) session.current++;
    }), [popupName]);
    useEffect(() => { session.current++; }, [tab?.id, tab?.url, target]);

    const close = () => {
        session.current++;
        settingStore.popup = "";
    };

    const runRemoval = async (remove) => {
        if (inProgress.current || settingStore.popup !== popupName) return;
        const url = tab?.url;
        const tabId = tab?.id;
        const operationSession = session.current;
        const isCurrent = () => mounted.current && session.current === operationSession &&
            current.current.tab?.id === tabId && current.current.tab?.url === url &&
            current.current.target === target && settingStore.popup === popupName;
        // Lock synchronously, before even a second click in the same render.
        inProgress.current = true;
        setRemoving(true);
        try {
            if (await remove(url, isCurrent) && isCurrent()) close();
        } catch {
            if (isCurrent()) settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
        } finally {
            // Cancel does not abort a started removal or batch. A reopened dialog
            // waits for that operation to settle before accepting another one.
            inProgress.current = false;
            if (mounted.current) setRemoving(false);
        }
    };

    return {removing, close, runRemoval};
}
