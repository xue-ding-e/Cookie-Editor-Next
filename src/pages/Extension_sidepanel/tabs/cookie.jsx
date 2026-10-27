/*global chrome*/
import WebsiteInfo from "../components/webiste_info";
import TopAction from "../components/top_action";
import DetailCookie from "../components/detail_cookie";
import {useEffect, useState} from "react";
import {icons} from "../../../constants/icon";
import EmptyCookie from "../components/empty_cookie";
import {observer} from "mobx-react-lite";
import {settingStore} from "../../../mobx/setting.store";
import {extension} from "../../../utils/chrome";

const ShowCookie = () => {
    const [tab, setTab] = useState(undefined);
    const [favicon, setFavicon] = useState("");
    const [cookieInfo, setCookieInfo] = useState(undefined);
    const [loadError, setLoadError] = useState(false);
    const [hasCookieData, setHasCookieData] = useState(false);

    const isValidCookieUrl = (url) => {
        return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
    };

    useEffect(() => {
        let active = true;
        let requestId = 0;
        let currentTabId;
        let currentTab;

        const refreshCookies = async (tabCurrent, id, preserveData = false) => {
            let data;
            try {
                data = await chrome.cookies.getAll({url: tabCurrent.url});
            } catch {
                if (active && id === requestId) {
                    if (!preserveData) setCookieInfo([]);
                    setLoadError(true);
                }
                return;
            }
            // A tab switch or unmount can finish before an older browser API request.
            if (active && id === requestId) {
                setCookieInfo(data);
                setHasCookieData(true);
            }
        };

        const refresh = async () => {
            const id = ++requestId;
            const isCurrent = () => active && id === requestId;
            setCookieInfo(undefined);
            setLoadError(false);
            setHasCookieData(false);
            setTab(undefined);
            setFavicon(icons.chrome);
            currentTab = undefined;

            let tabs;
            try {
                tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
            } catch {
                if (isCurrent()) {
                    setCookieInfo([]);
                    setLoadError(true);
                }
                return;
            }
            if (!isCurrent()) return;
            const tabCurrent = tabs?.[0] ?? undefined;
            currentTabId = tabCurrent?.id;
            currentTab = tabCurrent;
            setTab(tabCurrent);
            if (!isValidCookieUrl(tabCurrent?.url)) {
                setCookieInfo([]);
                return;
            }

            const getFavicon = async () => {
                if (tabCurrent.url.startsWith("https://chromewebstore.google.com/")) return;
                const linkFavicon = `https://t3.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${tabCurrent.url}&size=32`;
                let response;
                try {
                    response = await fetch(linkFavicon);
                } catch {
                    // A missing favicon must not prevent loading Cookies; keep the default icon.
                    return;
                }
                if (isCurrent() && response.status !== 404) setFavicon(linkFavicon);
            };
            void getFavicon();

            await refreshCookies(tabCurrent, id);
        };
        const handleUpdateCookie = (e) => {
            if (["add", "delete", "clear", "edit", "import"].includes(e.detail?.action) && isValidCookieUrl(currentTab?.url)) {
                // Keep same-tab dialogs mounted while their Cookie data refreshes.
                setLoadError(false);
                void refreshCookies(currentTab, ++requestId, true);
            }
        };
        const handleTabUpdated = (tabId, changeInfo) => {
            // Unrelated/background tab updates must not reset an open editor dialog.
            if ((currentTabId === undefined || tabId === currentTabId) &&
                (changeInfo.url !== undefined || changeInfo.status === "complete")) void refresh();
        };

        void refresh();
        chrome.tabs.onActivated.addListener(refresh);
        chrome.tabs.onUpdated.addListener(handleTabUpdated);
        document.addEventListener("update_cookie", handleUpdateCookie);
        return () => {
            active = false;
            chrome.tabs.onActivated.removeListener(refresh);
            chrome.tabs.onUpdated.removeListener(handleTabUpdated);
            document.removeEventListener("update_cookie", handleUpdateCookie);
        };
    }, []);

    return (
        <>
            {
                settingStore.tab === "home" && (
                    <>
                        <WebsiteInfo
                            tab={tab}
                            favicon={favicon}
                        />

                        {
                            hasCookieData && isValidCookieUrl(tab?.url) && (
                                <TopAction
                                    key={`${tab.id}:${tab.url}`}
                                    tab={tab}
                                    cookies={cookieInfo}
                                />
                            )
                        }

                        <div className={`w-full mb-3`}>
                            {cookieInfo === undefined && !loadError && <p role="status">{extension.getLang("button_loading")}</p>}
                            {loadError && <p role="alert">{extension.getLang("msg_error")}</p>}
                            {
                                (!loadError || hasCookieData) && typeof cookieInfo === "object" && (
                                    <>
                                        {
                                            hasCookieData && (
                                                // An empty refresh must not discard an open edit draft either.
                                                <DetailCookie
                                                    key={`${tab.id}:${tab.url}`}
                                                    cookies={cookieInfo.length > 0 ? cookieInfo : undefined}
                                                />
                                            )
                                        }
                                        {cookieInfo.length === 0 && <EmptyCookie />}
                                    </>
                                )
                            }
                        </div>
                    </>
                )
            }
        </>
    )
}

export default observer(ShowCookie)
