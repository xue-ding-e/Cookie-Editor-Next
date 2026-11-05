import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseCookieImport} from '../src/utils/cookie_text_import.js';

// Execute the production handlers with synthetic FileReader and Cookie boundaries.
const source = readFileSync(new URL('../src/pages/Extension_sidepanel/components/popup/import_cookie/index.jsx', import.meta.url), 'utf8');
function handler(name, next) {
    const marker = `    const ${name} = `;
    const start = source.indexOf(marker);
    const end = source.indexOf(next, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start + marker.length, end).trim().replace(/;$/, '');
}
function harness({throwOnRead = false} = {}) {
    const readers = [], writes = [];
    const context = {
        mounted: {current: true}, importSession: {current: 0}, importInProgress: {current: false},
        fileReadVersion: {current: 0}, fileReadInProgress: {current: false},
        settingStore: {popup: 'import_cookie'}, tab: {id: 101, url: 'https://example.invalid/'},
        format: 'file', contentImport: '', password: '', url: 'https://example.invalid/', optionImport: [],
        readingFile: false, setReadingFile(value) {context.readingFile = value;}, setImporting() {}, parseCookieImport,
        extension: {getLang: key => key}, googleAnalytics() {},
        FileReader: class {constructor() {readers.push(this);} readAsText() {if (throwOnRead) throw new Error('Synthetic read failure');}},
        chrome: {cookies: {set: async value => {writes.push(value);}}},
        document: {dispatchEvent() {}}, CustomEvent: class {},
    };
    for (const key of ['contentImport', 'cookies', 'password', 'linkImport', 'url']) {
        context['set' + key[0].toUpperCase() + key.slice(1)] = value => {context[key] = value;};
    }
    context.closeImporter = vm.runInNewContext(`(${handler('closeImporter', '    useClickOutside(')})`, context);
    const select = vm.runInNewContext(`(${handler('handleFileChange', '    const handleImport = ')})`, context);
    const run = vm.runInNewContext(`(${handler('handleImport', '    return (')})`, context);
    return {context, readers, writes, run, select: (files = [{}]) => select({target: {files}}),
        finish: (index, value) => readers[index].onload({target: {result: value}})};
}

test('positive control: a completed selected file imports its content', async () => {
    const h = harness(); h.select(); h.finish(0, 'fixture=new'); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].value, 'new');
});
test('a late earlier file cannot replace the latest selected file', async () => {
    const h = harness(); h.select(); h.select();
    h.finish(1, 'fixture=new'); h.finish(0, 'fixture=old'); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].value, 'new');
});
test('a new pending file cannot submit the previously loaded file', async () => {
    const h = harness(); h.select(); h.finish(0, 'fixture=old'); h.select(); await h.run();
    assert.equal(h.writes.length, 0);
    assert.equal(h.context.settingStore.popup, 'import_cookie');
    h.finish(1, 'fixture=new'); await h.run();
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].value, 'new');
});

test('an older read failure must not unlock a newer pending read', async () => {
    const h = harness(); h.select(); h.select(); h.readers[0].onerror();
    assert.equal(h.context.readingFile, true); await h.run(); assert.equal(h.writes.length, 0);
    h.finish(1, 'fixture=new'); await h.run(); assert.equal(h.writes[0].value, 'new');
});

for (const event of ['onerror', 'onabort']) test(`current ${event} clears stale content and permits a later selection`, async () => {
    const h = harness(); h.select(); h.finish(0, 'fixture=old'); h.select(); h.readers[1][event]();
    assert.equal(h.context.readingFile, false); assert.equal(h.context.contentImport, '');
    assert.equal(h.context.settingStore.alert.type, 'error'); await h.run(); assert.equal(h.writes.length, 0);
    h.select(); h.finish(2, 'fixture=retry'); await h.run(); assert.equal(h.writes[0].value, 'retry');
});

test('a synchronous FileReader rejection releases the read gate without writing', async () => {
    const h = harness({throwOnRead: true}); h.select();
    assert.equal(h.context.readingFile, false); assert.equal(h.context.settingStore.alert.type, 'error');
    await h.run(); assert.equal(h.writes.length, 0);
});

test('cancel and reopen discard delayed file completion and failure', async () => {
    const h = harness(); h.select(); h.context.closeImporter(); h.context.settingStore.popup = 'import_cookie';
    h.select(); h.finish(0, 'fixture=discarded'); h.readers[0].onerror();
    assert.equal(h.context.readingFile, true); assert.equal(h.context.contentImport, '');
    h.finish(1, 'fixture=current'); await h.run(); assert.equal(h.writes[0].value, 'current');
});

test('file reading does not block the independently selected text format', async () => {
    const h = harness(); h.select(); h.context.format = 'text'; h.context.cookies = 'fixture=text';
    await h.run(); assert.equal(h.writes[0].value, 'text');
    h.finish(0, 'fixture=discarded'); assert.equal(h.context.contentImport, '');
});

test('an empty file cannot report a successful import or close the dialog', async () => {
    const h = harness(); h.select(); h.finish(0, ' \n'); await h.run();
    assert.equal(h.writes.length, 0); assert.equal(h.context.settingStore.popup, 'import_cookie');
    assert.equal(h.context.settingStore.alert, undefined);
});

test('clearing the file selection invalidates its pending read and old content', async () => {
    const h = harness(); h.select(); h.select([]); h.finish(0, 'fixture=discarded');
    assert.equal(h.context.readingFile, false); assert.equal(h.context.contentImport, '');
    await h.run(); assert.equal(h.writes.length, 0); assert.equal(h.context.settingStore.popup, 'import_cookie');
});

test('an unmounted importer ignores file completion and failure', () => {
    const h = harness(); h.select(); h.context.mounted.current = false;
    h.finish(0, 'fixture=discarded'); h.readers[0].onerror();
    assert.equal(h.context.contentImport, ''); assert.equal(h.context.settingStore.alert, undefined);
    assert.equal(h.writes.length, 0);
});
