import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'const n8nService =');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
for (const mode of ['current', 'replacement', 'disconnect', 'replacement-reject', 'late-entry']) test(`close continuation: ${mode}`, async () => {
    const storage = {}, sockets = [], timers = [];
    let holdCloseRead = false, releaseCloseRead;
    class Socket {
        static OPEN = 1; static CONNECTING = 0;
        constructor() { this.readyState = 0; sockets.push(this); }
        close() { this.readyState = 3; }
        send() {}
    }
    const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket,
        chrome: {runtime: {id: 'synthetic', sendMessage: async () => {}},
            alarms: {create: async () => {}, clear: async () => {}},
            storage: {local: {
                get(keys, done) {
                    const data = Object.fromEntries(keys.map(k => [k, storage[k]]));
                    if (holdCloseRead && keys.length === 1 && keys[0] === 'n8n_connected') {
                        holdCloseRead = false; releaseCloseRead = () => done(data);
                    } else done(data);
                },
                set(data, done) { Object.assign(storage, data); done(); },
                remove(keys, done) { for (const k of keys) delete storage[k]; done(); }
            }}},
        getN8nWsUrl: () => 'wss://relay.example.invalid/', checkN8nPermissions: async () => true,
        setTimeout: (fn, ms) => { const t = {fn, ms, cancelled: false}; timers.push(t); return t; },
        clearTimeout: t => { if (t) t.cancelled = true; }, setInterval: () => 1, clearInterval: () => {}
    });
    vm.runInContext(source + '\nglobalThis.service=n8nService;', context);
    await context.service.connect('synthetic-a', {awaitConnected: false});
    const oldClose = sockets[0].onclose;
    if (mode === 'late-entry') {
        await context.service.connect('synthetic-b', {awaitConnected: false});
        sockets[1].readyState = Socket.OPEN;
        const before = timers.length;
        await oldClose();
        assert.equal((await context.service.getStatus()).connected, true, 'old entry cleared new socket');
        assert.equal(timers.length, before, 'old entry scheduled reconnect');
        return;
    }
    sockets[0].readyState = 3;
    if (mode === 'replacement-reject') storage.n8n_connected = false;
    holdCloseRead = true;
    const closing = oldClose();
    assert.equal(typeof releaseCloseRead, 'function');
    let replacementRejected = false;
    if (mode === 'replacement') await context.service.connect('synthetic-b', {awaitConnected: false});
    if (mode === 'replacement-reject') {
        context.service.connect('synthetic-b').catch(() => { replacementRejected = true; });
        await flush();
        assert.equal(sockets.length, 2);
    }
    if (mode === 'disconnect') await context.service.disconnect(true);
    const before = timers.length;
    releaseCloseRead(); await closing; await flush();
    assert.equal(replacementRejected, false, 'old close rejected the new waiter');
    assert.equal(timers.length, before + (mode === 'current' ? 1 : 0), 'stale close scheduled a reconnect');
    if (mode === 'current') {
        await timers.at(-1).fn(); await flush();
        assert.equal(sockets.length, 2, 'current close should retain automatic reconnect');
    }
});
