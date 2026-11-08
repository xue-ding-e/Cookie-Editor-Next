// cookies.set can overwrite equivalent Cookies without an explicit pre-deletion.
// This conservative check uses the exposed identity fields; it is not a transaction
// or a guarantee about browser-specific identity fields that the API does not expose.
export const canSetCookieWithoutRemoval = (original, draft, details) => {
    if (!original || !draft || !details ||
        typeof original.name !== "string" || typeof original.domain !== "string" || !original.domain ||
        typeof original.path !== "string" || !original.path.startsWith("/") ||
        typeof original.hostOnly !== "boolean" || typeof original.storeId !== "string" ||
        original.partitionKey !== undefined || draft.partitionKey !== undefined || details.partitionKey !== undefined) return false;

    if (draft.name !== original.name || draft.path !== original.path || draft.domain !== original.domain ||
        draft.hostOnly !== original.hostOnly || details.name !== original.name ||
        details.path !== original.path || details.storeId !== original.storeId) return false;

    let target;
    try {
        target = new URL(details.url);
    } catch {
        return false;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return false;
    if (original.hostOnly) {
        return !Object.prototype.hasOwnProperty.call(details, "domain") && target.hostname === original.domain;
    }
    // Prefix handling may omit Domain even when the draft still has a domain field.
    return details.domain === original.domain;
};
