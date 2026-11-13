import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const boundary of ['remove', 'set', 'status']) {
    for (const mode of ['normal', 'replacement-connecting', 'replacement-connected']) {
        for (const clearPassword of [true, false]) {
            test(`disconnect ${boundary} completion: ${mode}, clearPassword=${clearPassword}`, async () => {
                const storage = {}, sockets = [], writes = [], removals = [], messages = [];
                const activeIntervals = new Set();
                const forbidden = {cookies: 0, crypto: 0, fetch: 0};
                let nextInterval = 0, armed = false, held = false, release;
                const complete = (kind, done) => {
                    if (armed && !held && kind === boundary) {
                        held = true;
                        release = done;
                    } else done();
                };
                class Socket {
                    static OPEN = 1; static CONNECTING = 0;
                    constructor() { this.readyState = 0; this.sent = []; this.closes = 0; sockets.push(this); }
                    close() { this.closes++; this.readyState = 3; }
                    send(value) { this.sent.push(JSON.parse(value)); }
                }
                const chrome = {
                    runtime: {id: 'synthetic', sendMessage: async message => { messages.push(message); }},
                    alarms: {create: async () => {}, clear: async () => {}},
                    storage: {local: {
                        get: (keys, done) => {
                            const snapshot = Object.fromEntries(keys.map(key => [key, storage[key]]));
                            complete(keys.includes('n8n_history') ? 'status' : 'other', () => done(snapshot));
                        },
                        set: (data, done) => {
                            writes.push({...data});
                            Object.assign(storage, data);
                            complete(data.n8n_connected === false ? 'set' : 'other', done);
                        },
                        remove: (keys, done) => {
                            removals.push([...keys]);
                            keys.forEach(key => delete storage[key]);
                            complete('remove', done);
                        },
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

                armed = true;
                const disconnecting = context.service.disconnect(clearPassword);
                await flush();
                assert.equal(typeof release, 'function', 'requested disconnect boundary must be reached');
                assert.equal(original.closes, 1, 'original socket closes before storage cleanup');
                let replacement, replacementHeartbeat;
                if (mode !== 'normal') {
                    await context.service.connect('synthetic-b', {awaitConnected: false});
                    replacement = sockets[1];
                    assert.ok(replacement, 'replacement socket exists before releasing cleanup');
                    if (mode === 'replacement-connected') {
                        replacement.readyState = Socket.OPEN;
                        replacement.onopen();
                        replacement.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-b-key'})});
                        await flush();
                        replacementHeartbeat = nextInterval;
                        assert.notEqual(replacementHeartbeat, originalHeartbeat);
                        assert.ok(activeIntervals.has(replacementHeartbeat));
                    }
                }
                const before = {writes: writes.length, removals: removals.length, messages: messages.length, sends: replacement?.sent.length};
                release();
                const result = await disconnecting;
                assert.deepEqual(forbidden, {cookies: 0, crypto: 0, fetch: 0});

                if (mode === 'normal') {
                    assert.equal(result.connected, false);
                    assert.equal(storage.n8n_connected, false);
                    assert.equal(storage.n8n_password, clearPassword ? undefined : 'synthetic-a');
                    assert.equal(result.hasPassword, !clearPassword);
                    assert.equal(activeIntervals.size, 0);
                    assert.equal(messages.length, before.messages + 2, 'current disconnect broadcasts status and history');
                } else {
                    assert.equal(writes.length, before.writes, 'retired cleanup must not issue a state write');
                    assert.equal(removals.length, before.removals, 'retired cleanup must not issue another removal');
                    assert.equal(messages.length, before.messages, 'retired cleanup must not broadcast stale status');
                    assert.equal(storage.n8n_password, 'synthetic-b');
                    assert.equal(storage.n8n_connected, true);
                    assert.equal(replacement.closes, 0);
                    assert.equal(replacement.sent.length, before.sends);
                    assert.equal(result.connected, mode === 'replacement-connected');
                    assert.equal(result.hasPassword, true);
                    if (replacementHeartbeat !== undefined) {
                        assert.ok(activeIntervals.has(replacementHeartbeat));
                        assert.equal(result.clientKey, 'synthetic-b-key');
                    }
                }
            });
        }
    }
}
