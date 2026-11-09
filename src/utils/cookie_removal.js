// remove(URL, name, storeId) can delete multiple matching Cookies. These checks
// refuse known ambiguity; a read followed by removal is still not atomic, and
// cannot prove browser identity fields that the extension API does not expose.
export const hasRemovalIdentity = cookie => Boolean(cookie && typeof cookie === "object" && !Array.isArray(cookie) &&
    typeof cookie.name === "string" && typeof cookie.domain === "string" && cookie.domain.length > 0 &&
    typeof cookie.path === "string" && cookie.path.startsWith("/") &&
    typeof cookie.hostOnly === "boolean" && typeof cookie.secure === "boolean" &&
    typeof cookie.storeId === "string" && cookie.storeId.length > 0 &&
    !Object.prototype.hasOwnProperty.call(cookie, "partitionKey"));

export const hasUniqueRemovalMatch = (selected, matches) => {
    if (!hasRemovalIdentity(selected) || !Array.isArray(matches) || matches.length !== 1 ||
        !hasRemovalIdentity(matches[0])) return false;
    // Do not equate domain Cookies with host-only Cookies, or normalize a changed
    // path/store into the selection. Values and expiration are not identity fields.
    return ["name", "domain", "path", "hostOnly", "secure", "storeId"]
        .every(key => selected[key] === matches[0][key]);
};
