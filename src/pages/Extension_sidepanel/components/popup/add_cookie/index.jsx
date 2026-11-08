/*global chrome*/
import {motion} from "framer-motion";
import {useEffect, useRef, useState} from "react";
import {observer} from "mobx-react-lite";
import {googleAnalytics} from "../../../../../utils/google_analytics";
import {extension} from "../../../../../utils/chrome";
import {settingStore} from "../../../../../mobx/setting.store";
import {useClickOutside} from "../../../../../hooks/useClickOutside";
import ModalPopup from "../modal_popup";

const AddCookie = ({tab}) => {
    const ref = useRef(null);
    const mounted = useRef(false);
    const currentTab = useRef(tab);
    const addSession = useRef(0);
    const addInProgress = useRef(false);
    const [adding, setAdding] = useState(false);
    const [cookie, setCookie] = useState({});
    const popup = settingStore.popup;
    currentTab.current = tab;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => {
        if (popup !== "add_cookie") {
            // Other toolbar actions can replace this dialog without using its Cancel button.
            addSession.current++;
            setCookie({});
        }
    }, [popup]);
    const closeAdder = () => {
        addSession.current++;
        setCookie({});
        settingStore.popup = "";
    };
    useClickOutside(ref, closeAdder);

    const handleAddCookie = (key, value) => {
        if (addInProgress.current) return;
        setCookie(previous => ({...previous, [key]: value}));
    }

    const handleSetCookie = async () => {
        // Lock before any await so rapid repeated clicks cannot start another write.
        if (addInProgress.current || settingStore.popup !== "add_cookie") return;
        const url = tab?.url;
        if (typeof url !== "string" || !(url.startsWith("https://") || url.startsWith("http://"))) {
            settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
            return;
        }
        // Use the displayed tab and submitted draft, never a later active-tab query.
        const data = {...cookie, url};
        const sourceTabId = tab?.id;
        const session = addSession.current;
        const isCurrentAdder = () => mounted.current && addSession.current === session &&
            currentTab.current?.id === sourceTabId && currentTab.current?.url === url &&
            settingStore.popup === "add_cookie";
        addInProgress.current = true;
        setAdding(true);
        try {
            await chrome.cookies.set(data);
            // Closing does not cancel a started write; its result must not affect a newer dialog.
            if (isCurrentAdder()) {
                settingStore.alert = {type: "info", message: extension.getLang("alert_add_cookie_success")};
                document.dispatchEvent(new CustomEvent("update_cookie", {
                    detail: {action: "add"},
                    bubbles: true,
                }));
                if (isCurrentAdder()) closeAdder();
            }
            googleAnalytics({name: "add_cookie", params: []})
        } catch {
            // Preserve the current draft for correction or an explicit retry.
            if (isCurrentAdder()) settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
        } finally {
            addInProgress.current = false;
            if (mounted.current) setAdding(false);
        }
    }

    const handleFormatDate = (value) => {
        if (value) {
            const timestamp = value * 1000;
            const date = new Date(timestamp);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}`;
        } else {
            return ""
        }
    }

    return (
        <>
            {
                settingStore.popup === "add_cookie" && (
                    <>
                        <ModalPopup />
                        <motion.div
                            ref={ref}
                            initial={{opacity: 0, y: -50}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, y: -50}}
                            transition={{duration: 0.5}}
                            className={`fixed top-0 left-0 p-[10px] overflow-y-auto`}
                            style={{zIndex: 50, width: "calc(100% - 50px)", maxHeight: "calc(100vh - 100px)"}}
                        >
                            <div className={`bg-white rounded-[10px] p-5`}>
                                <p className={`font-bold text-[14px] mb-1`}>
                                    {extension.getLang("title_add_cookie")}
                                </p>
                                <p className={`text-[12px] mb-5`}>
                                    {extension.getLang("description_add_cookie")}
                                </p>
                                <div className={`w-full`}>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="hostOnly"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Name
                                        </label>
                                        <input
                                            disabled={adding}
                                            type="text"
                                            onChange={(e) => handleAddCookie("name", e.target.value)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2"
                                            value={cookie?.name ?? ""}
                                        />
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="hostOnly"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Value
                                        </label>
                                        <textarea
                                            disabled={adding}
                                            rows={3}
                                            value={cookie?.value ?? ""}
                                            onChange={(e) => handleAddCookie("value", e.target.value)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                        </textarea>
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="expirationDate"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            Expiration Date
                                        </label>
                                        <input
                                            disabled={adding}
                                            type="datetime-local"
                                            onChange={(e) => handleAddCookie("expirationDate", Math.round(new Date(e.target.value).getTime() / 1000))}
                                            id="expirationDate"
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2"
                                            value={handleFormatDate(cookie?.expirationDate)}
                                        />
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="add-cookie-httpOnly"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            HttpOnly
                                        </label>
                                        <select
                                            disabled={adding}
                                            id="add-cookie-httpOnly"
                                            onChange={(e) => handleAddCookie("httpOnly", e.target.value === "true")}
                                            value={String(cookie?.httpOnly ?? false)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            <option value={"true"}>True</option>
                                            <option value={"false"}>False</option>
                                        </select>
                                    </div>
                                    <div className={`w-full mb-2`}>
                                        <label
                                            htmlFor="hostOnly"
                                            className="block mb-2 text-[12px] font-medium text-gray-900">
                                            SameSite
                                        </label>
                                        <select
                                            disabled={adding}
                                            onChange={(e) => handleAddCookie("sameSite", e.target.value)}
                                            value={String(cookie?.sameSite)}
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
                                            disabled={adding}
                                            onChange={(e) => handleAddCookie("secure", e.target.value === "true")}
                                            value={String(cookie?.secure)}
                                            className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2">
                                            <option value={"false"}>False</option>
                                            <option value={"true"}>True</option>
                                        </select>
                                    </div>
                                    <div className={`w-full flex justify-between`}>
                                        <div className={"inline-block w-[59%]"}>
                                            <button
                                                onClick={handleSetCookie}
                                                disabled={adding}
                                                className={`h-[40px] w-full rounded-[10px] bg-blue-500 text-white px-5`}>
                                                Add
                                            </button>
                                        </div>
                                        <div className={"inline-block w-[39%]"}>
                                            <button
                                                onClick={closeAdder}
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

export default observer(AddCookie)
