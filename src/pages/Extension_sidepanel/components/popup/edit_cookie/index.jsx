/*global chrome*/
import {useEffect, useRef, useState} from "react";
import {motion} from "framer-motion";
import ModalPopup from "../modal_popup";
import {googleAnalytics} from "../../../../../utils/google_analytics";
import {extension} from "../../../../../utils/chrome";
import {settingStore} from "../../../../../mobx/setting.store";
import {useClickOutside} from "../../../../../hooks/useClickOutside";
import {observer} from "mobx-react-lite";
import {shouldIncludeDomain} from "../../../../../utils/cookie_import";
import {canSetCookieWithoutRemoval} from "../../../../../utils/cookie_edit";

const EditCookie = ({cookie, tab}) => {
    const ref = useRef(null);
    const expirationInput = useRef(null);
    const mounted = useRef(false);
    const currentCookie = useRef(cookie);
    const editorSession = useRef(0);
    const saveInProgress = useRef(false);
    const [saving, setSaving] = useState(false);
    currentCookie.current = cookie;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const closeEditor = () => {
        editorSession.current++;
        settingStore.popup = "";
    };
    useClickOutside(ref, closeEditor);

    const handleFormatDate = (time) => {
        if (!Number.isFinite(time)) return "";
        const date = new Date(time * 1000);
        if (!Number.isFinite(date.getTime())) return "";
        const pad = value => String(value).padStart(2, "0");
        // datetime-local uses local calendar fields, not a UTC ISO string or locale-formatted text.
        // Only display the timestamp here; untouched fractional seconds and DST offsets stay intact.
        return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    const handleEditCookie = (param, value, valid = true) => {
        if (saveInProgress.current) return;
        if (param === "expirationDate") {
            // An incomplete native date is not an explicit request to clear its expiration.
            settingStore.cookie_select.expirationDate = !valid ? NaN :
                value === "" ? undefined : Math.round(new Date(value).getTime() / 1000);
        } else if (param === "httpOnly" || param === "secure" || param === "hostOnly") {
            settingStore.cookie_select[param] = value === "true";
        } else {
            settingStore.cookie_select[param] = value;
        }
    }

    const handleActionEditCookie= async () => {
        // Lock synchronously: two clicks can arrive before React renders the disabled button.
        if (saveInProgress.current || !cookie || settingStore.popup !== "edit_cookie") return;
        const selection = settingStore.cookie_select;
        const session = editorSession.current;
        const url = tab?.url;
        if (typeof url !== "string" || !(url.startsWith("https://") || url.startsWith("http://"))) {
            settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
            return;
        }
        // Validate before removal: an invalid date draft must not delete the original Cookie.
        // Native segmented input can become invalid before React receives a change event.
        if ((expirationInput.current && !expirationInput.current.validity.valid) ||
            (selection.expirationDate !== undefined && !Number.isFinite(selection.expirationDate))) {
            settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
            return;
        }
        // Freeze the submitted draft and its original tab/profile before any browser API await.
        // The active tab and global selection may belong to a different editor on completion.
        const dataUpdate = {
            ...(shouldIncludeDomain(selection) ? {domain: selection.domain} : {}),
            expirationDate: selection.expirationDate,
            httpOnly: selection.httpOnly,
            name: selection.name,
            path: selection.path,
            sameSite: selection.sameSite,
            secure: selection.secure,
            storeId: cookie.storeId,
            url,
            value: selection.value,
        }
        const dataRemove = {url, name: cookie.name, storeId: cookie.storeId};
        const setWithoutRemoval = canSetCookieWithoutRemoval(cookie, selection, dataUpdate);
        const isCurrentEditor = () => mounted.current && currentCookie.current === cookie &&
            editorSession.current === session && settingStore.cookie_select === selection &&
            settingStore.popup === "edit_cookie";
        saveInProgress.current = true;
        setSaving(true);
        try {
            // Avoid pre-deletion when the exposed identity and outgoing scope are unchanged.
            // Other edits remain non-atomic: a set failure does not roll back their removal.
            // Once started, finish using only the captured data, even if this editor is closed.
            if (!setWithoutRemoval) await chrome.cookies.remove(dataRemove);
            await chrome.cookies.set(dataUpdate);
            if (isCurrentEditor()) {
                document.dispatchEvent(new CustomEvent("update_cookie", {
                    detail: {action: "edit"},
                    bubbles: true,
                }));
                settingStore.alert = {type: "info", message: extension.getLang("alert_edit_cookie_success")}
                settingStore.popup = "";
            }
            googleAnalytics({name: "edit_cookie", params: []});
        } catch {
            if (isCurrentEditor()) settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
        } finally {
            saveInProgress.current = false;
            if (mounted.current) setSaving(false);
        }
    }

    return (
        <>
            {
                (cookie && settingStore.popup === "edit_cookie") && (
                    <>
                        <ModalPopup />
                        <motion.div
                            ref={ref}
                            initial={{opacity: 0, y: 50}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, y: 50}}
                            transition={{duration: 0.5}}
                            className={`fixed bottom-[60px] left-0 p-[10px] overflow-y-auto`}
                            style={{zIndex: 50, width: "calc(100% - 50px)", maxHeight: "calc(100vh - 70px)"}}
                        >
                            <div className={`bg-white rounded-[10px] p-5`}>
                                <p className={`font-bold text-[14px] mb-1`}>
                                    {extension.getLang("title_edit_cookie")}
                                </p>
                                <p className={`text-[12px] mb-5`}>
                                    {extension.getLang("description_edit_cooke")}
                                </p>
                                <div className={`w-full`}>
                                    <div className={`w-full mb-2`}>
                                        <label htmlFor="name" className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Name
                                        </label>
                                        <input
                                            id={"name"}
                                            disabled={saving}
                                            type="text"
                                            onChange={(e) => handleEditCookie("name", e.target.value)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2"
                                            value={settingStore.cookie_select.name}
                                        />
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label htmlFor="value" className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Value
                                        </label>
                                        <textarea
                                            id={"value"}
                                            disabled={saving}
                                            rows={3}
                                            onChange={(e) => handleEditCookie("value", e.target.value)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            {settingStore.cookie_select.value}
                                        </textarea>
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="expirationDate"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Expiration Date
                                        </label>
                                        <input
                                            ref={expirationInput}
                                            type="datetime-local"
                                            step="1"
                                            onChange={(e) => handleEditCookie("expirationDate", e.target.value, e.target.validity.valid)}
                                            id="expirationDate"
                                            disabled={saving}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2"
                                            value={handleFormatDate(settingStore.cookie_select.expirationDate)}
                                        />
                                    </div>

                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="path"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Path
                                        </label>
                                        <input
                                            type="text"
                                            onChange={(e) => handleEditCookie("path", e.target.value)}
                                            id="path"
                                            disabled={saving}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2"
                                            value={settingStore.cookie_select.path}
                                        />
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="httpOnly"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            HttpOnly
                                        </label>
                                        <select
                                            id={"httpOnly"}
                                            disabled={saving}
                                            onChange={(e) => handleEditCookie("httpOnly", e.target.value)}
                                            value={String(settingStore.cookie_select.httpOnly)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            <option value={"true"}>True</option>
                                            <option value={"false"}>False</option>
                                        </select>
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="sameSite"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            SameSite
                                        </label>
                                        <select
                                            id={"sameSite"}
                                            disabled={saving}
                                            onChange={(e) => handleEditCookie("sameSite", e.target.value)}
                                            value={String(settingStore.cookie_select.sameSite)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            <option value={"no_restriction"}>no_restriction</option>
                                            <option value={"lax"}>lax</option>
                                            <option value={"strict"}>strict</option>
                                            <option value={"unspecified"}>unspecified</option>
                                        </select>
                                    </div>

                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="secure"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Secure
                                        </label>
                                        <select
                                            id={"secure"}
                                            disabled={saving}
                                            onChange={(e) => handleEditCookie("secure", e.target.value)}
                                            value={String(settingStore.cookie_select.secure)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            <option value={"false"}>False</option>
                                            <option value={"true"}>True</option>
                                        </select>
                                    </div>

                                    <div className={`w-full flex justify-between`}>
                                        <div className={"inline-block w-[59%]"}>
                                            <button
                                                onClick={handleActionEditCookie}
                                                disabled={saving}
                                                className={`h-[40px] w-full rounded-[10px] bg-blue-500 text-white px-5`}>
                                                Edit
                                            </button>
                                        </div>
                                        <div className={"inline-block w-[39%]"}>
                                            <button
                                                onClick={closeEditor}
                                                className={`h-[40px] w-full rounded-[10px] bg-gray-200 text-gray-900 px-5`}>
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </motion.div>
                    </>
                )
            }
        </>
    )
}

export default observer(EditCookie)
