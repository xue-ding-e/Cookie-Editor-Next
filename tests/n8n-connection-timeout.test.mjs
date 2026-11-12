import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const raw=fs.readFileSync(new URL('../src/services/n8n.js', import.meta.url),'utf8');
const source=raw.replace(/^import .*;\n/gm,'').replace('export const n8nService =','const n8nService =');
for (const mode of ['replacement', 'disconnect', 'active', 'opened']) test(`socket timeout isolation: ${mode}`,async()=>{
 const storage={},sockets=[],timers=[];
 class Socket{static OPEN=1;static CONNECTING=0;constructor(){this.readyState=0;sockets.push(this);}close(){this.readyState=3;}send(){}}
 const context=vm.createContext({URL,Date,JSON,Boolean,Promise,String,Math,Error,WebSocket:Socket,
 chrome:{runtime:{id:'synthetic',sendMessage:async()=>{}},alarms:{create:async()=>{},clear:async()=>{}},storage:{local:{get(keys,done){done(Object.fromEntries(keys.map(k=>[k,storage[k]])));},set(data,done){Object.assign(storage,data);done();},remove(keys,done){for(const k of keys)delete storage[k];done();}}}},
 getN8nWsUrl:()=> 'wss://relay.example.invalid/',checkN8nPermissions:async()=>true,
 setTimeout:(fn,ms)=>{const t={fn,ms,cancelled:false};timers.push(t);return t;},clearTimeout:t=>{if(t)t.cancelled=true;},setInterval:()=>1,clearInterval:()=>{}});
 vm.runInContext(source+'\nglobalThis.service=n8nService;',context);
 let activeRejected=false;
 if(mode==='active') {
  context.service.connect('synthetic-a').catch(()=>{activeRejected=true;});
  for(let i=0;i<10;i++)await Promise.resolve();
 } else await context.service.connect('synthetic-a',{awaitConnected:false});
 const oldTimeout=timers.find(t=>t.ms===15000);
 let replacementRejected=false;
 if (mode==='replacement') {
  context.service.connect('synthetic-b').catch(()=>{replacementRejected=true;});
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(sockets.length,2);assert.equal(sockets[0].readyState,3);
 } else if(mode==='disconnect') await context.service.disconnect(true);
 else if(mode==='opened') {sockets[0].readyState=1;sockets[0].onopen();}
 const timerCountBefore=timers.length;
 if(!oldTimeout.cancelled)oldTimeout.fn();
 for(let i=0;i<10;i++)await Promise.resolve();
 if(mode==='replacement') {assert.equal(replacementRejected,false);assert.equal(timers.length,timerCountBefore);}
 if(mode==='active') {assert.equal(activeRejected,true);assert.equal(timers.length,timerCountBefore+1,'active timeout schedules reconnect');}
 if(mode==='replacement') assert.equal(sockets[1].readyState,0,'old timeout closed replacement');
 if(mode==='active') assert.equal(sockets[0].readyState,3,'active timeout must still close stalled socket');
 if(mode==='opened') assert.equal(sockets[0].readyState,1,'open socket must stay open');
 if(mode==='disconnect') assert.equal(sockets.length,1,'disconnected timeout must not reconnect');
});
