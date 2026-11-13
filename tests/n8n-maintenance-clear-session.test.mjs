import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const missing of ['connected', 'password']) {
    for (const mode of ['current', 'replacement-connecting', 'replacement-connected']) {
        test(`delayed maintenance alarm clear (${missing} missing): ${mode}`, async () => {
            const storage = {}, sockets = [], writes = [], removals = [], messages = [];
            const forbidden = {cookies: 0, crypto: 0, fetch: 0};
            const activeIntervals = new Set();
            let nextInterval = 0, releaseClear, holdClear = false;
            class Socket {
                static OPEN = 1; static CONNECTING = 0;
                constructor() { this.readyState = 0; this.sent = []; this.closes = 0; sockets.push(this); }
                close() { this.closes++; this.readyState = 3; }
                send(value) { this.sent.push(JSON.parse(value)); }
            }
            const chrome = {
                runtime: {id: 'synthetic', sendMessage: async message => { messages.push(message); }},
                alarms: {create: async () => {}, clear: () => holdClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve()},
                storage: {local: {
                    get: (keys, done) => done(Object.fromEntries(keys.map(key => [key, storage[key]]))),
                    set: (data, done) => { writes.push({...data}); Object.assign(storage, data); done(); },
                    remove: (keys, done) => { removals.push([...keys]); keys.forEach(key => delete storage[key]); done(); },
                }},
            };
            Object.defineProperty(chrome, 'cookies', {get() { forbidden.cookies++; throw new Error('Cookie access forbidden'); }});
            const context = vm.createContext({
                URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket, chrome,
                CryptoJS: {AES: {encrypt() { forbidden.crypto++; throw new Error('Crypto forbidden'); }}},
                fetch() { forbidden.fetch++; throw new Error('Network forbidden'); },
                checkN8nPermissions: async () => true,
                getN8nWsUrl: () => 'wss://relay.example.invalid/',
                setTimeout: () => 1, clearTimeout: () => {},
                setInterval: () => { const id = ++nextInterval; activeIntervals.add(id); return id; },
                clearInterval: id => { activeIntervals.delete(id); },
            });
            vm.runInContext(source, context);
            await context.service.connect('synthetic-a', {awaitConnected: false});
            const original = sockets[0];
            original.readyState = Socket.OPEN;
            original.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-a-key'})});
            await flush();
            const originalHeartbeat = nextInterval;
            assert.ok(activeIntervals.has(originalHeartbeat));

            // Model missing persisted state before maintenance starts, not a delayed read.
            delete storage[`n8n_${missing}`];
            original.readyState = 3;
            await original.onclose();
            holdClear = true;
            const maintaining = context.service.maintainConnection();
            await flush();
            assert.equal(typeof releaseClear, 'function', 'maintenance must reach alarm cleanup');
            assert.ok(activeIntervals.has(originalHeartbeat), 'cleanup is still suspended');

            let replacement, replacementHeartbeat;
            if (mode !== 'current') {
                await context.service.connect('synthetic-b', {awaitConnected: false});
                replacement = sockets[1];
                assert.ok(replacement);
                if (mode === 'replacement-connected') {
                    replacement.readyState = Socket.OPEN;
                    replacement.onopen();
                    replacement.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-b-key'})});
                    await flush();
                    replacementHeartbeat = nextInterval;
                    assert.notEqual(replacementHeartbeat, originalHeartbeat);
                    assert.ok(activeIntervals.has(replacementHeartbeat));
                    assert.ok(!activeIntervals.has(originalHeartbeat));
                }
            }
            const before = {writes: writes.length, removals: removals.length, messages: messages.length, sends: replacement?.sent.length};
            releaseClear();
            await maintaining;
            assert.deepEqual(forbidden, {cookies: 0, crypto: 0, fetch: 0});
            assert.equal(writes.length, before.writes);
            assert.equal(removals.length, before.removals);
            assert.equal(messages.length, before.messages);
            if (mode === 'current') {
                assert.equal(activeIntervals.size, 0, 'current maintenance must still stop its own heartbeat');
            } else {
                assert.equal(replacement.closes, 0);
                assert.equal(replacement.sent.length, before.sends);
                assert.equal(storage.n8n_password, 'synthetic-b');
                assert.equal(storage.n8n_connected, true);
                if (replacementHeartbeat !== undefined) {
                    assert.ok(activeIntervals.has(replacementHeartbeat), 'retired maintenance must not stop the replacement heartbeat');
                }
            }
        });
    }
}
