/*global chrome*/
import CryptoJS from "crypto-js";
import {useEffect, useRef, useState} from "react";
import { motion } from "framer-motion";
import ModalPopup from "../modal_popup";
import {googleAnalytics} from "../../../../../utils/google_analytics";
import {extension} from "../../../../../utils/chrome";
import {observer} from "mobx-react-lite";
import {settingStore} from "../../../../../mobx/setting.store";
import {useClickOutside} from "../../../../../hooks/useClickOutside";
import {parseCookieImport} from "../../../../../utils/cookie_text_import";

const ImportCookie = ({tab}) => {
    const ref = useRef(null);
    const mounted = useRef(false);
    const importSession = useRef(0);
    const importInProgress = useRef(false);
    const fileReadVersion = useRef(0);
    const fileReadInProgress = useRef(false);
    const [importing, setImporting] = useState(false);
    const [readingFile, setReadingFile] = useState(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const closeImporter = () => {
        importSession.current++;
        fileReadVersion.current++;
        fileReadInProgress.current = false;
        setReadingFile(false);
        setCookies("");
        setPassword("");
        setContentImport("");
        setLinkImport("");
        setUrl(tab?.url ?? "");
        settingStore.popup = "";
    };
    useClickOutside(ref, closeImporter);

    const format = settingStore.format_import;
    const optionImport = settingStore.option_import;

    const [password, setPassword] = useState("");
    const [url, setUrl] = useState(tab?.url ?? "");
    const [linkImport, setLinkImport] = useState("");
    const [cookies, setCookies] = useState("");
    const [contentImport, setContentImport] = useState("");

    const listFormats = [
        {title: "Use text", id: "import_from_text", value: "text"},
        {title: "Use a file", id: "import_from_file", value: "file"},
        // {title: "Use a link", id: "import_from_url", value: "link"}
    ];

    const handleFormatChange = (e) => {
        const nextFormat = e.target.value;
        if (format === "file" && nextFormat !== "file") {
            // Switching away unmounts the native file input. Its hidden content and
            // pending callbacks must not survive when an empty input is mounted later.
            fileReadVersion.current++;
            fileReadInProgress.current = false;
            setReadingFile(false);
            setContentImport("");
        }
        settingStore.setFormatImport(nextFormat);
    };

    const handleFileChange = (e) => {
        const input = e.target;
        const file = input.files[0];
        const version = ++fileReadVersion.current;
        // A new selection invalidates the old content before its asynchronous read starts.
        setContentImport("");
        fileReadInProgress.current = !!file;
        setReadingFile(!!file);
        if (!file) return;

        const session = importSession.current;
        const reader = new FileReader();
        const isCurrentRead = () => mounted.current && importSession.current === session &&
            fileReadVersion.current === version && settingStore.popup === "import_cookie";
        const finishRead = () => {
            fileReadInProgress.current = false;
            setReadingFile(false);
        };
        reader.onload = (e) => {
            // A file selected before Cancel must not repopulate a later import dialog.
            // Nor may an older, slower file replace the latest selection in the same dialog.
            if (isCurrentRead()) {
                setContentImport(String(e.target.result ?? ""));
                finishRead();
            }
        };
        reader.onerror = reader.onabort = () => {
            if (isCurrentRead()) {
                finishRead();
                // Clear synchronously so a later selection cannot be reset by a queued render.
                input.value = "";
                settingStore.alert = {type: "error", message: extension.getLang("alert_import_cookie_error")};
            }
        };
        try {
            reader.readAsText(file);
        } catch {
            reader.onerror();
        }
    };

    const handleImport = async () => {
        // Lock before any await; React may not have disabled the button for a second click yet.
        if (importInProgress.current || settingStore.popup !== "import_cookie") return;
        if (format === "file" && (fileReadInProgress.current || !contentImport.trim())) return;
        const session = importSession.current;
        const sourceTabId = tab?.id;
        const reloadSource = optionImport.includes("reload_page");
        const isCurrentImporter = () => mounted.current && importSession.current === session &&
            settingStore.popup === "import_cookie";
        importInProgress.current = true;
        setImporting(true);
        try {
            let dataCookies;
            switch (format) {
                case "text":
                    dataCookies = cookies;
                    break;

                case "file":
                    dataCookies = contentImport;
                    break;

                case "link":
                    const res = await fetch(linkImport);
                    const dataRes = await res.text();
                    dataCookies = dataRes;
                    break;
            }

            if (password.length > 0) {
                dataCookies = CryptoJS.AES.decrypt(dataCookies.trim(), password).toString(CryptoJS.enc.Utf8);
            }

            // Parse and validate every row before any Cookie write. Browser API failures
            // can still interrupt writes: chrome.cookies does not provide transactions.
            const expirationDate = Math.round(Date.now() / 1000) + 365 * 86400;
            const cookiesToSet = parseCookieImport(dataCookies, url, expirationDate);
            for (const cookie of cookiesToSet) {
                await chrome.cookies.set(cookie);
            }
            // Started writes are not rolled back on close. Their completion must not affect
            // another tab's dialog or a newly opened import, and reload stays bound to the source.
            if (isCurrentImporter()) {
                settingStore.alert = {type: "info", message: extension.getLang("alert_import_cookie_success")}
                document.dispatchEvent(new CustomEvent("update_cookie", {
                    detail: {action: "import"},
                    bubbles: true,
                }));
                if (isCurrentImporter()) {
                    // Close before reload can remount the source tab's toolbar. The completed
                    // Cookie writes remain successful even if the subsequent reload rejects.
                    closeImporter();
                    if (reloadSource && Number.isInteger(sourceTabId)) await chrome.tabs.reload(sourceTabId);
                }
            }
            googleAnalytics({name: "import_cookie", params: []});
        } catch {
            // Keep the live draft available for correction or retry. No raw Cookie data is logged.
            if (isCurrentImporter()) settingStore.alert = {type: "error", message: extension.getLang("alert_import_cookie_error")}
        } finally {
            importInProgress.current = false;
            if (mounted.current) setImporting(false);
        }
    }

    return (
        <>
            {
                settingStore.popup === "import_cookie" && (
                    <>
                        <ModalPopup />
                        <motion.div
                            ref={ref}
                            initial={{opacity: 0, y: -50}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0, y: -50}}
                            transition={{duration: 0.5}}
                            className={`fixed top-0 left-0 p-[10px]`}
                            style={{zIndex: 50, width: "calc(100% - 50px)"}}
                        >
                            <div className={`bg-white rounded-[10px] overflow-y-auto p-5`} style={{maxHeight: "calc(100vh - 80px)"}}>
                                <p className={`font-bold text-[14px] mb-2`}>
                                    {extension.getLang("title_import_cookie")}
                                </p>
                                <p className={`text-[12px] mb-5`}>
                                    {extension.getLang("description_import_cookie")}
                                </p>
                                <div className={`w-full flex flex-wrap justify-between mb-2`}>
                                    {
                                        listFormats.map((item, key) => (
                                            <div key={key} className="inline-flex w-fit pr-3 items-center mb-4">
                                                <input
                                                    disabled={importing}
                                                    id={item.id}
                                                    type="radio"
                                                    value={item.value}
                                                    name="format"
                                                    onClick={handleFormatChange}
                                                    checked={format === item.value}
                                                    className="w-4 h-4 text-blue-600 bg-gray-400 border-gray-300 focus:ring-blue-500"
                                                />
                                                <label
                                                    htmlFor={item.id}
                                                    className="ms-2 text-[12px] cursor-pointer font-medium text-gray-900"
                                                >
                                                    {item.title}
                                                </label>
                                            </div>
                                        ))
                                    }
                                </div>
                                <div className={`w-full mb-5`}>
                                    <input
                                        disabled={importing}
                                        type="text"
                                        onChange={(e) => setUrl(e.target.value)}
                                        className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2.5 mb-1"
                                        value={url}
                                    />
                                </div>
                                <div className={`w-full mb-5`}>
                                    {
                                        format === "text" && (
                                            <>
                                                <label className="block mb-2 text-[12px] font-medium text-gray-900">
                                                    Cookie value
                                                </label>
                                                <textarea
                                                    disabled={importing}
                                                    rows={5}
                                                    value={cookies}
                                                    onChange={(e) => setCookies(e.target.value)}
                                                    placeholder={"JSON/Header string/Netscape"}
                                                    className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2.5 mb-1"
                                                />
                                            </>
                                        )
                                    }

                                    {
                                        format === "file" && (
                                            <>
                                                <label className="block mb-2 text-[12px] font-medium text-gray-900">
                                                    {extension.getLang("label_select_file_import")}
                                                </label>
                                                <input
                                                    disabled={importing}
                                                    onChange={handleFileChange}
                                                    accept=".txt, .json"
                                                    className="block w-full mb-5 text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none"
                                                    type="file"
                                                />
                                            </>
                                        )
                                    }

                                    {
                                        format === "link" && (
                                            <>
                                                <label className="block mb-2 text-[12px] font-medium text-gray-900">
                                                    {extension.getLang("lable_link_import")} (<span className={"text-red-500"}>*</span>)
                                                </label>
                                                <input
                                                    disabled={importing}
                                                    type="text"
                                                    placeholder={"http://example.com/cookie"}
                                                    onChange={(e) => setLinkImport(e.target.value)}
                                                    className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg block w-full p-2.5 mb-1"
                                                    value={linkImport}
                                                />
                                            </>
                                        )
                                    }
                                </div>
                                <div className={`w-full mb-5`}>
                                    <label
                                        htmlFor="hostOnly"
                                        className="block mb-2 text-[12px] font-medium text-gray-900">
                                        {extension.getLang("label_password_decrypt")}
                                    </label>
                                    <input
                                        disabled={importing}
                                        type="password"
                                        placeholder={extension.getLang("label_password_decrypt")}
                                        onChange={(e) => setPassword(e.target.value)}
                                        className="bg-gray-50 border border-gray-300 text-gray-900 text-[12px] rounded-lg block w-full p-2.5 mb-1"
                                        value={password}
                                    />
                                    <p className={`text-gray-500`}>
                                        {extension.getLang("description_password_decrypt")}
                                    </p>
                                </div>
                                <div className={`w-full flex justify-between`}>
                                    <div className={"inline-block w-[59%]"}>
                                        <button
                                            disabled={importing || (format === "file" && (readingFile || !contentImport.trim()))}
                                            onClick={handleImport}
                                            className={`h-[40px] w-full rounded-[10px] bg-blue-500 text-white px-5`}>
                                            {extension.getLang("btn_import")}
                                        </button>
                                    </div>
                                    <div className={"inline-block w-[39%]"}>
                                        <button
                                            onClick={closeImporter}
                                            className={`h-[40px] w-full rounded-[10px] bg-gray-200 text-gray-900 px-5`}>
                                            {extension.getLang("btn_cancel")}
                                        </button>
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

export default observer(ImportCookie)
