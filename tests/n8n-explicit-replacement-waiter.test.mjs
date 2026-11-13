import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const mode of ['handshake-control', 'explicit-replacement', 'failed-explicit-replacement', 'automatic-reconnect']) {
    test(`connect waiter ownership: ${mode}`, async () => {
        const storage = {}, sockets = [], timers = [];
        const forbidden = {cookies: 0, crypto: 0, fetch: 0};
        let failNextSocket = false;
        class Socket {
            static OPEN = 1; static CONNECTING = 0;
            constructor() {
                if (failNextSocket) { failNextSocket = false; throw new Error('Synthetic socket construction failed'); }
                this.readyState = 0; this.sent = []; sockets.push(this);
            }
            close() { this.readyState = 3; }
            send(value) { this.sent.push(JSON.parse(value)); }
        }
        const chrome = {
            runtime: {id: 'synthetic', sendMessage: async () => {}},
            alarms: {create: async () => {}, clear: async () => {}},
            storage: {local: {
                get: (keys, done) => done(Object.fromEntries(keys.map(key => [key, storage[key]]))),
                set: (data, done) => { Object.assign(storage, data); done(); },
                remove: (keys, done) => { keys.forEach(key => delete storage[key]); done(); },
            }},
        };
        Object.defineProperty(chrome, 'cookies', {get() { forbidden.cookies++; throw new Error('Cookie access forbidden'); }});
        const context = vm.createContext({
            URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket, chrome,
            CryptoJS: {AES: {encrypt() { forbidden.crypto++; throw new Error('Crypto forbidden'); }}},
            fetch() { forbidden.fetch++; throw new Error('Network forbidden'); },
            checkN8nPermissions: async () => true,
            getN8nWsUrl: () => 'wss://relay.example.invalid/',
            setTimeout: (fn, ms) => { const timer = {fn, ms, cancelled: false}; timers.push(timer); return timer; },
            clearTimeout: timer => { if (timer) timer.cancelled = true; },
            setInterval: () => 1, clearInterval: () => {},
        });
        vm.runInContext(source, context);
        const a = [], b = [];
        const observe = (promise, results) => promise.then(
            status => results.push({state: 'resolved', status}),
            error => results.push({state: 'rejected', message: error.message}),
        );
        observe(context.service.connect('synthetic-a'), a);
        await flush();
        const original = sockets[0];
        assert.ok(original);
        assert.equal(a.length, 0);
        const originalTimeout = timers.find(timer => timer.ms === 15000);
        const acknowledge = async (socket, clientKey) => {
            socket.readyState = Socket.OPEN;
            socket.onopen();
            socket.onmessage({data: JSON.stringify({type: 'connected', client_key: clientKey})});
            await flush();
        };
        if (mode === 'handshake-control') {
            await acknowledge(original, 'synthetic-a-key');
            assert.equal(a.length, 1);
            assert.equal(a[0].state, 'resolved');
            assert.equal(a[0].status.clientKey, 'synthetic-a-key');
        } else if (mode === 'automatic-reconnect') {
            original.readyState = 3;
            await original.onclose();
            const reconnect = timers.find(timer => timer.ms < 15000 && !timer.cancelled);
            assert.ok(reconnect);
            await reconnect.fn();
            await flush();
            assert.equal(sockets.length, 2);
            assert.equal(a.length, 0, 'automatic reconnect must preserve the original waiter');
            await acknowledge(sockets[1], 'synthetic-reconnected-key');
            assert.equal(a.length, 1);
            assert.equal(a[0].state, 'resolved');
            assert.equal(a[0].status.clientKey, 'synthetic-reconnected-key');
        } else {
            failNextSocket = mode === 'failed-explicit-replacement';
            observe(context.service.connect('synthetic-b'), b);
            await flush();
            assert.equal(original.readyState, 3);
            if (!originalTimeout.cancelled) originalTimeout.fn();
            await flush();
            if (mode === 'failed-explicit-replacement') {
                assert.equal(sockets.length, 1);
                assert.equal(b.length, 1);
                assert.equal(b[0].state, 'rejected');
                assert.match(b[0].message, /Synthetic socket construction failed/);
            } else {
                assert.equal(sockets.length, 2);
                assert.equal(b.length, 0, 'B must await its own handshake');
                await acknowledge(sockets[1], 'synthetic-b-key');
                assert.equal(b.length, 1);
                assert.equal(b[0].state, 'resolved');
                assert.equal(b[0].status.clientKey, 'synthetic-b-key');
            }
            assert.equal(a.length, 1, 'an explicit replacement must settle the superseded request');
            assert.equal(a[0].state, 'rejected');
            assert.match(a[0].message, /replaced/i);
        }
        assert.deepEqual(forbidden, {cookies: 0, crypto: 0, fetch: 0});
    });
}
