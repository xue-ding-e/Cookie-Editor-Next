import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
for (const mode of ['allow', 'cancel', 'replace', 'cancel-waiter', 'replace-waiter']) {
    test(`pending storage connection: ${mode}`, async () => {
        let completeWrite, writeCount = 0;
        let replacementOutcome, replacementSettled = false;
        const storage = {}, sockets = [], writes = [];
        class Socket {
            static OPEN = 1; static CONNECTING = 0;
            constructor() { this.readyState = 0; sockets.push(this); }
            close() { this.readyState = 3; }
            send() {}
        }
        const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket,
            chrome: {runtime: {id: 'synthetic', sendMessage: async () => {}}, alarms: {clear: async () => {}, create: async () => {}},
                storage: {local: {
                    get: (keys, done) => done(Object.fromEntries(keys.map(k => [k, storage[k]]))),
                    set: (data, done) => { writes.push({...data}); Object.assign(storage, data); if (++writeCount === 1) completeWrite = done; else done(); },
                    remove: (keys, done) => { keys.forEach(k => delete storage[k]); done(); }
                }}},
            checkN8nPermissions: async () => true,
            getN8nWsUrl: () => 'wss://relay.example.invalid/', setTimeout: () => 1, clearTimeout: () => {},
            setInterval: () => 1, clearInterval: () => {}
        });
        vm.runInContext(source, context);
        const connecting = context.service.connect('synthetic-a', {awaitConnected: mode.endsWith('-waiter')});
        const outcome = connecting.then(value => ({value}), error => ({error}));
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(typeof completeWrite, 'function');
        if (mode.startsWith('cancel')) await context.service.disconnect(true);
        if (mode === 'replace-waiter') {
            replacementOutcome = context.service.connect('synthetic-b', {awaitConnected: true})
                .then(value => { replacementSettled = true; return {value}; },
                    error => { replacementSettled = true; return {error}; });
            for (let i = 0; i < 10; i++) await Promise.resolve();
        } else if (mode === 'replace') {
            await context.service.connect('synthetic-b', {awaitConnected: false});
        }
        const writesBefore = writes.length;
        completeWrite();
        const result = await outcome;
        if (mode === 'replace-waiter') {
            assert.equal(replacementSettled, false, 'old completion must not settle the new waiter');
            assert.equal(sockets.length, 1, 'old completion must not replace the new socket');
            sockets[0].readyState = Socket.OPEN;
            sockets[0].onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-b-key'})});
            for (let i = 0; i < 30; i++) await Promise.resolve();
            assert.equal(replacementSettled, true, 'new handshake must resolve the preserved waiter');
            const replacement = await replacementOutcome;
            assert.equal(replacement.error, undefined);
            assert.equal(replacement.value.connected, true);
            assert.equal(replacement.value.clientKey, 'synthetic-b-key');
        }
        if (mode === 'allow') {
            assert.equal(result.error, undefined);
            assert.equal(sockets.length, 1);
            assert.equal(storage.n8n_password, 'synthetic-a');
        } else {
            assert.match(result.error?.message ?? '', /cancelled/);
            assert.equal(writes.length, writesBefore + (mode === 'replace-waiter' ? 1 : 0),
                'only the new handshake may write after the retired completion');
            assert.equal(sockets.length, mode.startsWith('replace') ? 1 : 0);
            assert.equal(storage.n8n_password, mode.startsWith('replace') ? 'synthetic-b' : undefined);
        }
    });
}
