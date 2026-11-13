import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const mode of ['normal', 'replacement-connecting', 'replacement-connected']) {
    test(`delayed disconnect alarm completion: ${mode}`, async () => {
        const storage = {}, sockets = [], writes = [], removals = [], messages = [];
        const forbidden = {cookies: 0, crypto: 0, fetch: 0};
        const activeIntervals = new Set();
        let nextInterval = 0;
        let releaseClear, holdClear = false;
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
        assert.ok(activeIntervals.has(originalHeartbeat), 'original handshake starts a heartbeat');

        if (mode !== 'normal') {
            original.readyState = 3;
            await original.onclose();
        }

        holdClear = true;
        const disconnecting = context.service.disconnect(true);
        assert.equal(typeof releaseClear, 'function');
        let replacement;
        if (mode !== 'normal') {
            await context.service.connect('synthetic-b', {awaitConnected: false});
            replacement = sockets[1];
            assert.ok(replacement, 'replacement must be created before releasing the old disconnect');
            if (mode === 'replacement-connected') {
                replacement.readyState = Socket.OPEN;
                replacement.onopen();
                replacement.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-b-key'})});
                await flush();
            }
        }

        const before = {writes: writes.length, removals: removals.length, messages: messages.length, sends: replacement?.sent.length};
        const replacementHeartbeat = mode === 'replacement-connected' ? nextInterval : null;
        if (replacementHeartbeat !== null) {
            assert.notEqual(replacementHeartbeat, originalHeartbeat, 'replacement handshake starts its own heartbeat');
            assert.ok(activeIntervals.has(replacementHeartbeat));
        }

        releaseClear();
        const result = await disconnecting;
        assert.deepEqual(forbidden, {cookies: 0, crypto: 0, fetch: 0});
        if (mode === 'normal') {
            assert.equal(original.closes, 1);
            assert.equal(storage.n8n_password, undefined);
            assert.equal(storage.n8n_connected, false);
            assert.equal(activeIntervals.size, 0);
        } else {
            assert.equal(replacement.closes, 0, 'old disconnect must not close the replacement');
            assert.equal(storage.n8n_password, 'synthetic-b', 'old disconnect must not remove the replacement password');
            assert.equal(writes.length, before.writes, 'old disconnect must not write replacement state');
            assert.equal(removals.length, before.removals, 'old disconnect must not remove replacement state');
            assert.equal(messages.length, before.messages, 'old disconnect must not broadcast a retired completion');
            assert.equal(replacement.sent.length, before.sends, 'old disconnect must not send through the replacement');
            assert.equal(result.connected, mode === 'replacement-connected');
            assert.equal(result.hasPassword, true);
            if (replacementHeartbeat !== null) {
                assert.equal(result.clientKey, 'synthetic-b-key');
                assert.ok(activeIntervals.has(replacementHeartbeat), 'old alarm completion must not stop the replacement heartbeat');
            }
        }
    });
}
