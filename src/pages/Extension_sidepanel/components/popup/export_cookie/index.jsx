/*global chrome*/
import CryptoJS from "crypto-js";
import {useEffect, useRef, useState} from "react";
import { motion } from "framer-motion";
import ModalPopup from "../modal_popup";
import CookieExample from "../../cookie_example";
import {cookieFormats} from "../../../../../constants";
import {googleAnalytics} from "../../../../../utils/google_analytics";
import {extension} from "../../../../../utils/chrome";
import {useClickOutside} from "../../../../../hooks/useClickOutside";
import {settingStore} from "../../../../../mobx/setting.store";
import {observer} from "mobx-react-lite";
import {serializeNetscapeCookies} from "../../../../../utils/cookie_text_export";

const ExportCookie = ({tab}) => {
    const ref = useRef(null);
    const mounted = useRef(false);
    const currentTab = useRef(tab);
    const exportSession = useRef(0);
    const exportInProgress = useRef(false);
    const [exporting, setExporting] = useState(false);
    const [password, setPassword] = useState("");
    const format = settingStore.format_export;
    const popup = settingStore.popup;
    currentTab.current = tab;

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    useEffect(() => {
        if (popup !== "export_cookie") exportSession.current++;
    }, [popup]);
    useEffect(() => {
        exportSession.current++;
    }, [tab?.id, tab?.url]);
    const closeExporter = () => {
        exportSession.current++;
        settingStore.popup = "";
    };
    useClickOutside(ref, closeExporter);

    const handleActionExport = async () => {
        if (exportInProgress.current || settingStore.popup !== "export_cookie") return;
        // Bind the export to the displayed site and submitted options before any await.
        const url = tab?.url;
        if (typeof url !== "string" || !(url.startsWith("https://") || url.startsWith("http://"))) {
            settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
            return;
        }
        const sourceTabId = tab?.id;
        const session = exportSession.current;
        const isCurrentExporter = () => mounted.current && exportSession.current === session &&
            currentTab.current?.id === sourceTabId && currentTab.current?.url === url &&
            settingStore.popup === "export_cookie";
        // Lock synchronously so rapid repeated clicks cannot produce duplicate downloads.
        // Closing hides the form; reopening waits for the old read to settle before a new request.
        exportInProgress.current = true;
        setExporting(true);
        try {
            let blob;
            const downloadLink = document.createElement('a');
            let dataExport = "";
            let typeFile;
            const cookies = await chrome.cookies.getAll({url});
            // A cancelled or replaced export must not turn a late read into a file download.
            if (!isCurrentExporter()) return;
            if (format === "netscape") {
                dataExport = serializeNetscapeCookies(cookies);
                typeFile = "txt";
            } else if (format === "header_string") {
                for (let i = 0; i < cookies.length; i++) {
                    dataExport = dataExport + `${i > 0 ? ";" : ""}${cookies[i].name}=${cookies[i].value}`
                }

                typeFile = "txt";
            } else {
                dataExport = JSON.stringify(cookies, null, 2);
                typeFile = "json";
            }
            if (password.length === 0) {
                blob = new Blob([dataExport], {type: typeFile === "json" ? 'application/json' : "application/txt"});
                downloadLink.download = `${url.split("/")[2]}_${format}_${new Date().getTime()}.${typeFile}`;
            } else {
                const cipherText = CryptoJS.AES.encrypt(JSON.stringify(dataExport), password).toString();
                blob = new Blob([cipherText], {type: 'application/txt'});
                downloadLink.download = `E2EE_${url.split("/")[2]}_${format}_${new Date().getTime()}.txt`;
            }


            downloadLink.href = URL.createObjectURL(blob);
            document.body.appendChild(downloadLink);
            try {
                downloadLink.click();
            } finally {
                document.body.removeChild(downloadLink);
            }
            try {
                googleAnalytics({name: "export_cookie", params: []})
            } catch {
                // A telemetry error must not report a started download as a failed export.
            }
            if (isCurrentExporter()) settingStore.popup = "";
        } catch {
            if (isCurrentExporter()) settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
        } finally {
            exportInProgress.current = false;
            if (mounted.current) setExporting(false);
        }
    }

    return (
        <>
            {
                settingStore.popup === "export_cookie" && (
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
                                    {extension.getLang("title_export_cookie")}
                                </p>
                                <p className={`text-[12px] mb-5`}>
                                    {extension.getLang("description_export_cookie")}
                                </p>
                                <div className={`w-full flex flex-wrap justify-between mb-2`}>
                                    {
                                        cookieFormats.map((item, key) => (
                                            <div key={key} className="inline-flex w-fit pr-3 items-center mb-4">
                                                <input
                                                    id={`cookie_format_${key}`}
                                                    type="radio"
                                                    value={item.value}
                                                    name="format"
                                                    disabled={exporting}
                                                    onClick={(e) => { if (!exportInProgress.current) settingStore.setFormatExport(e.target.value); }}
                                                    checked={format === item.value}
                                                    className="w-4 h-4 text-blue-600 bg-gray-400 border-gray-300 focus:ring-blue-500"
                                                />
                                                <label
                                                    htmlFor={`cookie_format_${key}`}
                                                    className="ms-2 text-[12px] cursor-pointer font-medium text-gray-900"
                                                >
                                                    {item.title}
                                                </label>
                                            </div>
                                        ))
                                    }
                                </div>
                                <p className={`text-[12px] font-medium mb-2`}>{extension.getLang("str_example")}</p>
                                <div className={`w-full mb-4 bg-gray-300 rounded-[10px] p-[10px]`}>
                                    <CookieExample format={format}/>
                                </div>
                                <div className={`w-full mb-5`}>
                                    <label
                                        htmlFor="hostOnly"
                                        className="block mb-2 text-[12px] font-medium text-gray-900">
                                        {extension.getLang("label_password_encrypt")}
                                    </label>
                                    <input
                                        type="password"
                                        placeholder={extension.getLang("label_password_encrypt")}
                                        disabled={exporting}
                                        onChange={(e) => { if (!exportInProgress.current) setPassword(e.target.value); }}
                                        className="bg-gray-50 border border-gray-300 text-gray-900 text-[12px] rounded-lg block w-full p-2.5 mb-1"
                                        value={password}
                                    />
                                    <p className={`text-gray-500`}>
                                        {extension.getLang("description_password")}
                                    </p>
                                </div>
                                <div className={`w-full flex justify-between`}>
                                    <div className={"inline-block w-[59%]"}>
                                        <button
                                            onClick={handleActionExport}
                                            disabled={exporting}
                                            className={`h-[40px] w-full rounded-[10px] bg-blue-500 text-white px-5`}>
                                            {extension.getLang("btn_export")}
                                        </button>
                                    </div>
                                    <div className={"inline-block w-[39%]"}>
                                        <button
                                            onClick={closeExporter}
                                            className={`h-[40px] w-full rounded-[10px] bg-gray-200 text-gray-900 px-5`}>
                                            {extension.getLang("btn_cancel")}
                                        </button>
                                    </div>
                                </div>
                                <div className={`w-full mt-4`}>
                                    <p className={`text-gray-800 text-xs`}>
                                        {extension.getLang("str_convert_share_link")} <span
                                        onClick={() => {
                                            exportSession.current++;
                                            settingStore.popup = "share_cookie";
                                            googleAnalytics({name: "cta_share_link_export_cc", params: []})
                                        }}
                                        className={`text-blue-600 font-bold underline cursor-pointer`}>{extension.getLang("cta_convert_share_link")}</span>
                                    </p>
                                </div>
                            </div>
                        </motion.div>
                    </>
                )
            }
        </>
    )
}

export default observer(ExportCookie)
