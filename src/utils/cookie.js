/*global chrome*/
import {googleAnalytics} from "./google_analytics";
import {extension} from "./chrome";
import {settingStore} from "../mobx/setting.store";
import {serializeNetscapeCookies} from "./cookie_text_export";

export const copyCookie = (cookies, format = null) => {
    let type = format;
    if (format === null) {
        const dataFormatCopyCookie = localStorage.getItem("format_copy");
        type = typeof dataFormatCopyCookie === "string" ? dataFormatCopyCookie : "header_string"
    }

    let dataCookie = "";
    switch (type) {
        case "header_string":
            for (let i = 0; i < cookies.length; i++) {
                dataCookie = dataCookie + `${i > 0 ? ";" : ""}${cookies[i].name}=${cookies[i].value}`
            }

            break;

        case "netscape":
            dataCookie = serializeNetscapeCookies(cookies);
            break;

        default:
            dataCookie = JSON.stringify(cookies, null, 2);
            break;
    }

    navigator.clipboard.writeText(dataCookie)
        .then(() => {
            googleAnalytics({name: "copy_all_cookie", params: []})
            settingStore.alert = {type: "info", message: extension.getLang("alert_copy_cookie_success")}
        })
        .catch(err => {
            console.error('Failed to copy: ', err);
        });
}

const hasRemovalContext = (url) => {
    try {
        if (typeof url === "string" && ["http:", "https:"].includes(new URL(url).protocol)) return true;
    } catch {
        // A missing or invalid displayed page must never fall back to the active tab.
    }
    settingStore.alert = {type: "error", message: extension.getLang("msg_error")};
    return false;
};

export const clearCookie = async (cookies, sourceUrl) => {
    if (!hasRemovalContext(sourceUrl)) return false;
    for (let i = 0; i < cookies.length; i++) {
        await chrome.cookies.remove({
            url: sourceUrl,
            name: cookies[i].name,
            storeId: cookies[i].storeId
        })
    }

    googleAnalytics({name: "clear_cookie", params: []})
    document.dispatchEvent(new CustomEvent("update_cookie", {
        detail: {action: "clear"},
        bubbles: true,
    }));
    return true;
}

export const deleteCookie = async (cookie, sourceUrl) => {
    if (!hasRemovalContext(sourceUrl)) return false;
    await chrome.cookies.remove({
        url: sourceUrl,
        name: cookie.name,
        storeId: cookie.storeId
    });

    document.dispatchEvent(new CustomEvent("update_cookie", {
        detail: {action: "delete"},
        bubbles: true,
    }));
    settingStore.alert = {type: "info", message: extension.getLang("alert_delete_cookie_success")}
    googleAnalytics({name: "delete_cookie", params: []})
    return true;
}
