const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('game.js','utf8');
function app(){
 const elements={};
 class Element{constructor(){this.value='';this.classList={add(){},remove(){}};this.disabled=false}set innerHTML(v){this.html=v;if(this===elements.stage){for(const id of ['start','next','answer','answerForm'])delete elements[id];for(const id of ['start','next','answer','answerForm'])if(v.includes(`id="${id}"`))elements[id]=new Element()}}get innerHTML(){return this.html}}
 for(const id of ['home','room','name','create','join','roomCode','toast','codeLabel','copy','leave','playerCount','players','roomTitle','status','stage','roundCount','history'])elements[id]=new Element();
 class Emitter{constructor(){this.events={}}on(n,f){this.events[n]=f}emit(n,...a){this.events[n]?.(...a)}}
 let peer;class Peer extends Emitter{constructor(id){super();this.id=id;peer=this}destroy(){this.destroyed=true}reconnect(){}connect(){return this.connection=new Emitter()}}
 let now=0,next=1;const timers=new Map();function timeout(f,ms){const id=next++;timers.set(id,{f,at:now+ms});return id}function advance(ms){now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.f()}}
 const context={window:{Peer},Peer,document:{getElementById:id=>elements[id]||null},location:{href:'https://example.com/',search:''},navigator:{clipboard:{}},crypto:{getRandomValues(a){a.fill(1);return a}},URL,URLSearchParams,setTimeout:timeout,clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source,context);return {elements,get peer(){return peer},Emitter,advance};
}
const host=app();host.elements.name.value='房主';host.elements.create.onclick();host.peer.emit('open',host.peer.id);
const c=new host.Emitter();c.peer='guest';c.open=true;c.send=()=>{};c.close=()=>{c.closed=true};host.peer.emit('connection',c);host.advance(15000);assert.equal(c.closed,undefined,'slow transport must not be closed before it opens');c.emit('open');c.emit('data',{type:'join',name:'玩家'});assert.equal(host.elements.playerCount.textContent,2);
host.peer.emit('disconnected');host.peer.emit('open',host.peer.id);assert.equal(host.elements.playerCount.textContent,2,'reconnecting signaling must preserve the room');host.elements.start.onclick();assert.match(host.elements.stage.innerHTML,/写下你的答案/);
const guest=app();guest.elements.name.value='玩家';guest.elements.roomCode.value='BBBBBB';guest.elements.join.onclick();assert.equal(guest.elements.join.textContent,'正在连接…');guest.advance(30000);assert.equal(guest.elements.join.disabled,false);assert.match(guest.elements.toast.textContent,/连接超时/);
console.log('Connection lifecycle tests passed');

