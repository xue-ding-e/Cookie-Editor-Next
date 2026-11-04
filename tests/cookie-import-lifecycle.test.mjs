import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseCookieImport} from '../src/utils/cookie_text_import.js';

// Match the repository's existing production-handler test mechanism.
// Only synthetic values and in-memory API doubles are used. No browser is loaded.
const source = readFileSync(new URL('../src/pages/Extension_sidepanel/components/popup/import_cookie/index.jsx', import.meta.url), 'utf8');
const marker = '    const handleImport = ';
const start = source.indexOf(marker);
const end = Math.min(...['    useEffect(', '    return ('].map(marker => source.indexOf(marker, start)).filter(index => index > start));
assert.ok(start >= 0 && end > start);
const handlerSource = source.slice(start + marker.length, end).trim();

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return {promise, resolve};
}

function createHarness({pending, reload = false, reject = false, onReload} = {}) {
    const calls = {writes: [], events: [], reloads: [], queries: 0};
    const store = {popup: 'import_cookie', alert: {}};
    const mounted = {current: true}, importSession = {current: 0}, importInProgress = {current: false};
    const importing = [];
    let activeTab = {id: 101, url: 'https://source.invalid/'};
    const context = {
        tab: {id: 101, url: 'https://source.invalid/'},
        mounted, importSession, importInProgress, setImporting: value => importing.push(value),
        closeImporter: () => { importSession.current++; store.popup = ''; },
        parseCookieImport, format: 'text', cookies: 'fixture=synthetic', password: '',
        url: 'https://source.invalid/', optionImport: reload ? ['reload_page'] : [],
        settingStore: store, extension: {getLang: key => key},
        console: {log() {}}, googleAnalytics() {},
        chrome: {
            cookies: {set: async details => { calls.writes.push({...details}); await pending?.promise; if (reject) throw new Error('Synthetic failure'); }},
            tabs: {
                query: async () => { calls.queries++; return [activeTab]; },
                reload: async id => { calls.reloads.push(id); await onReload?.({mounted, store}); },
            },
        },
        document: {dispatchEvent: event => calls.events.push(event.type)},
        CustomEvent: class { constructor(type) { this.type = type; } },
    };
    const importCookies = vm.runInNewContext(`(${handlerSource})`, context, {timeout: 1000});
    return {calls, store, importing, importCookies,
        allowWrites() { reject = false; },
        unmount() { mounted.current = false; },
        closeAndReopen() { importSession.current++; store.popup = 'import_cookie'; store.alert = {type: 'info', message: 'new-import-fixture'}; },
        activateB() { activeTab = {id: 202, url: 'https://destination.invalid/'}; },
        switchToB() {
        activeTab = {id: 202, url: 'https://destination.invalid/'};
        store.popup = 'edit_cookie';
        store.alert = {type: 'info', message: 'new-editor-fixture'};
    }};
}

test('positive control: a live import writes the captured synthetic source and completes', async () => {
    const h = createHarness();
    await h.importCookies();
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.calls.writes[0].url, 'https://source.invalid/');
    assert.equal(h.calls.writes[0].value, 'synthetic');
    assert.equal(h.store.popup, '');
    assert.equal(h.store.alert.type, 'info');
    assert.deepEqual(h.calls.events, ['update_cookie']);
});

test('a second click while the first import is pending must not start another write', async () => {
    const pending = deferred(), h = createHarness({pending});
    const first = h.importCookies(), second = h.importCookies();
    const writesWhilePending = h.calls.writes.length;
    pending.resolve();
    await Promise.all([first, second]);
    assert.equal(writesWhilePending, 1);
});

test('an old import completion must not close or refresh a newer editor or reload its tab', async () => {
    const pending = deferred(), h = createHarness({pending, reload: true});
    const first = h.importCookies();
    assert.equal(h.calls.writes.length, 1);
    h.switchToB();
    pending.resolve();
    await first;
    // The captured A write is allowed to finish. That is not a promise of rollback.
    assert.equal(h.calls.writes[0].url, 'https://source.invalid/');
    assert.deepEqual({popup: h.store.popup, alert: {...h.store.alert}, events: h.calls.events, reloads: h.calls.reloads}, {
        popup: 'edit_cookie', alert: {type: 'info', message: 'new-editor-fixture'}, events: [], reloads: [],
    });
});

test('closing and reopening the importer isolates the prior completion', async () => {
    const pending = deferred(), h = createHarness({pending, reload: true});
    const first = h.importCookies();
    h.closeAndReopen(); pending.resolve(); await first;
    assert.equal(h.store.popup, 'import_cookie');
    assert.equal(h.store.alert.message, 'new-import-fixture');
    assert.deepEqual(h.calls.events, []);
    assert.deepEqual(h.calls.reloads, []);
});

test('an unmounted importer cannot update the popup or schedule a reload', async () => {
    const pending = deferred(), h = createHarness({pending, reload: true});
    const first = h.importCookies();
    h.unmount(); pending.resolve(); await first;
    assert.equal(h.store.popup, 'import_cookie');
    assert.deepEqual(h.store.alert, {});
    assert.deepEqual(h.calls.events, []);
    assert.deepEqual(h.calls.reloads, []);
    assert.deepEqual(h.importing, [true]);
});

test('reload targets the captured source tab rather than the later active tab', async () => {
    const pending = deferred(), h = createHarness({pending, reload: true});
    const first = h.importCookies();
    h.activateB(); pending.resolve(); await first;
    assert.deepEqual(h.calls.reloads, [101]);
    assert.equal(h.calls.queries, 0);
});

test('a failed import keeps the live draft open and unlocks the handler for retry', async () => {
    const h = createHarness({reject: true});
    await h.importCookies();
    assert.equal(h.store.popup, 'import_cookie');
    assert.equal(h.store.alert.type, 'error');
    assert.deepEqual(h.calls.events, []);
    assert.deepEqual(h.importing, [true, false]);
    h.allowWrites(); await h.importCookies();
    assert.equal(h.calls.writes.length, 2);
    assert.equal(h.store.popup, '');
    assert.equal(h.store.alert.type, 'info');
});

test('a stale failure cannot overwrite the next editor alert', async () => {
    const pending = deferred(), h = createHarness({pending, reject: true});
    const first = h.importCookies();
    h.switchToB(); pending.resolve(); await first;
    assert.equal(h.store.popup, 'edit_cookie');
    assert.equal(h.store.alert.message, 'new-editor-fixture');
    assert.deepEqual(h.calls.events, []);
});

test('an inactive importer cannot start a write', async () => {
    const h = createHarness(); h.store.popup = 'edit_cookie';
    await h.importCookies();
    assert.deepEqual(h.calls.writes, []);
});

test('success closes before reload can unmount and rebuild the toolbar', async () => {
    const h = createHarness({reload: true, onReload({mounted, store}) {
        assert.equal(store.popup, '');
        mounted.current = false;
    }});
    await h.importCookies();
    assert.equal(h.store.popup, '');
    assert.equal(h.store.alert.type, 'info');
    assert.deepEqual(h.calls.reloads, [101]);
});

test('a later reload failure does not misreport the completed import as a Cookie failure', async () => {
    const h = createHarness({reload: true, onReload() { throw new Error('Synthetic reload failure'); }});
    await h.importCookies();
    assert.equal(h.calls.writes.length, 1);
    assert.equal(h.store.popup, '');
    assert.equal(h.store.alert.message, 'alert_import_cookie_success');
});

function createDraftHarness() {
    const state = {cookies: 'old-fixture', password: 'synthetic-password', contentImport: 'old-file', linkImport: 'https://source.invalid/synthetic', url: 'https://other.invalid/'};
    const store = {popup: 'import_cookie'};
    const mounted = {current: true}, importSession = {current: 0}, importInProgress = {current: true};
    const readers = [];
    const context = {mounted, importSession, importInProgress, settingStore: store, tab: {url: 'https://source.invalid/'},
        FileReader: class { constructor() { readers.push(this); } readAsText() {} },
    };
    for (const key of Object.keys(state)) context['set' + key[0].toUpperCase() + key.slice(1)] = value => { state[key] = value; };
    const closeStart = source.indexOf('    const closeImporter = ');
    const closeEnd = source.indexOf('    useClickOutside(', closeStart);
    const fileStart = source.indexOf('    const handleFileChange = ');
    assert.ok(closeStart >= 0 && closeEnd > closeStart && fileStart > closeEnd);
    const close = vm.runInNewContext(`(${source.slice(closeStart + '    const closeImporter = '.length, closeEnd).trim().replace(/;$/, '')})`, context);
    const selectFile = vm.runInNewContext(`(${source.slice(fileStart + '    const handleFileChange = '.length, start).trim().replace(/;$/, '')})`, context);
    return {state, store, importSession, importInProgress, mounted, readers, close, selectFile};
}

test('the actual close helper clears hidden draft data without unlocking the pending write', () => {
    const h = createDraftHarness(); h.close();
    assert.deepEqual(h.state, {cookies: '', password: '', contentImport: '', linkImport: '', url: 'https://source.invalid/'});
    assert.equal(h.store.popup, '');
    assert.equal(h.importSession.current, 1);
    assert.equal(h.importInProgress.current, true);
});

test('an actual pending file read cannot restore discarded content after close and reopen', () => {
    const h = createDraftHarness(); h.selectFile({target: {files: [{}]}});
    h.close(); h.store.popup = 'import_cookie';
    h.readers[0].onload({target: {result: 'stale-file-fixture'}});
    assert.equal(h.state.contentImport, '');
    h.selectFile({target: {files: [{}]}});
    h.readers[1].onload({target: {result: 'new-file-fixture'}});
    assert.equal(h.state.contentImport, 'new-file-fixture');
});
