import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'const n8nService =');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
for (const mode of ['current', 'disconnect', 'replacement']) test(`alarm maintenance storage continuation: ${mode}`, async () => {
    const storage = {}, sockets = [], timers = [];
    let holdReconnectRead = false, releaseReconnectRead;
    class Socket {
        static OPEN = 1; static CONNECTING = 0;
        constructor() {
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
    holdReconnectRead = true;
    const maintaining = context.service.maintainConnection();
    assert.equal(typeof releaseReconnectRead, 'function');
    if (mode === 'disconnect') await context.service.disconnect(true);
    if (mode === 'replacement') await context.service.connect('synthetic-b', {awaitConnected: false});
    releaseReconnectRead(); await maintaining; await flush();
    assert.equal(sockets.length, mode === 'disconnect' ? 1 : 2, 'retired maintenance created an extra socket');
    assert.equal(storage.n8n_password, mode === 'disconnect' ? undefined : mode === 'replacement' ? 'synthetic-b' : 'synthetic-a');
});
