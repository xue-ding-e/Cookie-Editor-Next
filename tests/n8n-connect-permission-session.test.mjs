import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
for (const mode of ['allow', 'deny', 'cancel-grant', 'cancel-deny', 'replace']) {
    test(`pending permission connection: ${mode}`, async () => {
        let grant, permissionChecks = 0;
        const pendingPermission = new Promise(resolve => { grant = resolve; });
        const storage = {}, sockets = [], writes = [];
        class Socket {
            static OPEN = 1; static CONNECTING = 0;
            constructor() { this.readyState = 0; sockets.push(this); }
            close() { this.readyState = 3; }
            send() {}
        }
        const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket,
            chrome: {runtime: {id: 'synthetic', sendMessage: async () => {}}, alarms: {clear: async () => {}},
                storage: {local: {
                    get: (keys, done) => done(Object.fromEntries(keys.map(k => [k, storage[k]]))),
                    set: (data, done) => { writes.push({...data}); Object.assign(storage, data); done(); },
                    remove: (keys, done) => { keys.forEach(k => delete storage[k]); done(); }
                }}},
            checkN8nPermissions: () => ++permissionChecks === 1 ? pendingPermission : Promise.resolve(true),
            getN8nWsUrl: () => 'wss://relay.example.invalid/', setTimeout: () => 1, clearTimeout: () => {},
            setInterval: () => 1, clearInterval: () => {}
        });
        vm.runInContext(source, context);
        const connecting = context.service.connect('synthetic-a', {awaitConnected: false});
        const outcome = connecting.then(value => ({value}), error => ({error}));
        if (mode.startsWith('cancel')) await context.service.disconnect(true);
        if (mode === 'replace') await context.service.connect('synthetic-b', {awaitConnected: false});
        const writesBefore = writes.length;
        grant(!['deny', 'cancel-deny'].includes(mode));
        const result = await outcome;
        if (mode === 'allow') {
            assert.equal(result.error, undefined);
            assert.equal(sockets.length, 1);
            assert.equal(storage.n8n_password, 'synthetic-a');
        } else {
            assert.match(result.error?.message ?? '', mode === 'deny' ? /Missing n8n permissions/ : /cancelled/);
            assert.equal(writes.length, writesBefore, 'retired request must not write storage');
            assert.equal(sockets.length, mode === 'replace' ? 1 : 0);
            assert.equal(storage.n8n_password, mode === 'replace' ? 'synthetic-b' : undefined);
        }
    });
}
