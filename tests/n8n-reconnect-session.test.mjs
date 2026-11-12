import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'const n8nService =');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
for (const mode of ['current', 'disconnect', 'replacement', 'late-entry', 'failed-replacement', 'new-timer-owner']) test(`reconnect storage continuation: ${mode}`, async () => {
    const storage = {}, sockets = [], timers = [];
    let holdReconnectRead = false, releaseReconnectRead, failNextSocket = false;
    class Socket {
        static OPEN = 1; static CONNECTING = 0;
        constructor() {
            if (failNextSocket) { failNextSocket = false; throw new Error('Synthetic constructor failure'); }
            this.readyState = 0; sockets.push(this);
        }
        close() { this.readyState = 3; }
        send() {}
    }
    const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket,
        chrome: {runtime: {id: 'synthetic', sendMessage: async () => {}},
            alarms: {create: async () => {}, clear: async () => {}},
            storage: {local: {
                get(keys, done) {
                    const data = Object.fromEntries(keys.map(k => [k, storage[k]]));
                    if (holdReconnectRead && keys.length === 2 && keys[0] === 'n8n_connected') {
                        holdReconnectRead = false; releaseReconnectRead = () => done(data);
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
    sockets[0].readyState = Socket.OPEN;
    sockets[0].onopen();
    sockets[0].readyState = 3;
    await sockets[0].onclose();
    const reconnect = timers.at(-1);
    if (mode === 'failed-replacement') {
        failNextSocket = true;
        await assert.rejects(context.service.connect('synthetic-b', {awaitConnected: false}), /Synthetic constructor failure/);
        await reconnect.fn(); await flush();
        await context.service.maintainConnection(); await flush();
        assert.equal(sockets.length, 2, 'retired timer handle blocked later recovery');
        return;
    }
    if (mode === 'new-timer-owner') {
        await context.service.connect('synthetic-b', {awaitConnected: false});
        sockets[1].readyState = 3;
        await sockets[1].onclose();
        const newerReconnect = timers.at(-1);
        assert.notEqual(newerReconnect, reconnect);
        await reconnect.fn(); await flush();
        await context.service.maintainConnection(); await flush();
        assert.equal(sockets.length, 2, 'old callback cleared the newer reconnect handle');
        await newerReconnect.fn(); await flush();
        assert.equal(sockets.length, 3, 'new reconnect must remain usable');
        return;
    }
    if (mode === 'late-entry') {
        await context.service.disconnect(true);
        await reconnect.fn(); await flush();
        assert.equal(sockets.length, 1);
        assert.equal(storage.n8n_password, undefined);
        return;
    }
    holdReconnectRead = true;
    const reconnecting = reconnect.fn();
    assert.equal(typeof releaseReconnectRead, 'function');
    if (mode === 'disconnect') await context.service.disconnect(true);
    if (mode === 'replacement') await context.service.connect('synthetic-b', {awaitConnected: false});
    releaseReconnectRead(); await reconnecting; await flush();
    assert.equal(sockets.length, mode === 'disconnect' ? 1 : 2, 'stale reconnect created an extra socket');
    assert.equal(storage.n8n_password, mode === 'disconnect' ? undefined : mode === 'replacement' ? 'synthetic-b' : 'synthetic-a',
        'reconnect must not restore or replace a newer password');
});
