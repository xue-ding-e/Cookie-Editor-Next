import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const raw = fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url), 'utf8');
const source = raw.replace(/^import .*;\n/gm, '').replace('export const n8nService =', 'globalThis.service =');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

for (const phase of ['connecting', 'open-without-handshake']) {
for (const mode of ['handshake-control', 'disconnect', 'disconnect-then-replacement', 'disconnect-overlapping-replacement']) {
    test(`default connect waiter settlement (${phase}): ${mode}`, async () => {
        const storage = {}, sockets = [], timers = [];
        const forbidden = {cookies: 0, crypto: 0, fetch: 0};
        let holdClear = false, releaseClear;
        class Socket {
            static OPEN = 1; static CONNECTING = 0;
            constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
            close() { this.readyState = 3; }
            send(value) { this.sent.push(JSON.parse(value)); }
        }
        const chrome = {
            runtime: {id: 'synthetic', sendMessage: async () => {}},
            alarms: {create: async () => {}, clear: () => holdClear ? new Promise(resolve => { releaseClear = resolve; }) : Promise.resolve()},
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
        const observations = [];
        context.service.connect('synthetic-a').then(
            status => observations.push({state: 'resolved', status}),
            error => observations.push({state: 'rejected', message: error.message}),
        );
        await flush();
        const original = sockets[0];
        assert.ok(original);
        assert.equal(observations.length, 0, 'waiting for the handshake before the action');
        const oldTimeout = timers.find(timer => timer.ms === 15000);
        assert.ok(oldTimeout);
        if (phase === 'open-without-handshake') {
            original.readyState = Socket.OPEN;
            original.onopen();
        }
        if (mode === 'handshake-control') {
            original.readyState = Socket.OPEN;
            original.onopen();
            original.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-a-key'})});
            await flush();
            assert.equal(observations.length, 1);
            assert.equal(observations[0].state, 'resolved');
            assert.equal(observations[0].status.clientKey, 'synthetic-a-key');
        } else {
            holdClear = mode === 'disconnect-overlapping-replacement';
            const disconnecting = context.service.disconnect(true);
            await flush();
            if (!holdClear) await disconnecting;
            // Exercise the retired deadline too: it must not be the cancellation mechanism.
            if (!oldTimeout.cancelled) oldTimeout.fn();
            await flush();
            if (mode.includes('replacement')) {
                if (holdClear) {
                    assert.equal(typeof releaseClear, 'function');
                    // Remote closure allows a real connect() replacement while old cleanup waits.
                    original.readyState = 3;
                    await original.onclose();
                }
                const replacementResults = [];
                context.service.connect('synthetic-b').then(
                    status => replacementResults.push({state: 'resolved', status}),
                    error => replacementResults.push({state: 'rejected', message: error.message}),
                );
                await flush();
                assert.equal(replacementResults.length, 0);
                const replacement = sockets[1];
                assert.ok(replacement);
                if (holdClear) {
                    releaseClear();
                    await disconnecting;
                    await flush();
                    assert.equal(replacementResults.length, 0, 'old cleanup must not settle the replacement waiter');
                    assert.equal(replacement.readyState, Socket.CONNECTING);
                }
                replacement.readyState = Socket.OPEN;
                replacement.onopen();
                replacement.onmessage({data: JSON.stringify({type: 'connected', client_key: 'synthetic-b-key'})});
                await flush();
                assert.equal(replacementResults.length, 1);
                assert.equal(replacementResults[0].state, 'resolved');
                assert.equal(replacementResults[0].status.clientKey, 'synthetic-b-key');
            }
            assert.equal(observations.length, 1, 'disconnect must settle its pending connect request');
            assert.equal(observations[0].state, 'rejected');
            assert.match(observations[0].message, /cancelled/i);
        }
        assert.deepEqual(forbidden, {cookies: 0, crypto: 0, fetch: 0});
    });
}
}
