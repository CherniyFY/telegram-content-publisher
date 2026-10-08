import assert from "node:assert/strict";
import {test, afterEach} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import {encryptToken,decryptToken,saveBot,pairChat,getStatus,sendLesson,handleMcp,handleApi,splitLesson,createInvite,syncSubscribers,revokeInvite,manageSubscription,publishLesson,testSubscriber} from "../lib/telegram.ts";
import type {Runtime} from "../lib/telegram.ts";

const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;});
const token="123456789:abcdefghijklmnopqrstuvwxyz_123456789";
async function rpc(response:Response):Promise<{result:Record<string,any>}>{return await response.json() as {result:Record<string,any>};}
function runtime(){
  const sql=new DatabaseSync(":memory:");
  for(const file of readdirSync(new URL("../drizzle",import.meta.url)).filter(f=>f.endsWith(".sql")).sort())sql.exec(readFileSync(new URL("../drizzle/"+file,import.meta.url),"utf8"));
  return {sql,DB:{async batch(statements:any[]){sql.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec("COMMIT");return results;}catch(error){sql.exec("ROLLBACK");throw error;}},prepare(query:string){
    const prepared=sql.prepare(query);
    let bindings:unknown[]=[];
    return {bind(...args:unknown[]){bindings=args;return this;},
      async first(){return prepared.get(...bindings as never[])??null;},
      async all(){return {results:prepared.all(...bindings as never[])};},
      async run(){const result=prepared.run(...bindings as never[]);return {meta:{changes:Number(result.changes)},success:true};}
    };
  }} as unknown as D1Database,TOKEN_ENCRYPTION_KEY:"ab".repeat(32)} satisfies Runtime & {sql:DatabaseSync};
}
function mockTelegram(updates:unknown[]=[]){
  const sends:Record<string,unknown>[]=[];
  globalThis.fetch=async(request,opts)=>{
    const url=String(request);
    let result:unknown;
    if(url.endsWith("/getMe"))result={id:123456789,is_bot:true,username:"test_portuguese_bot",first_name:"Practice"};
    else if(url.endsWith("/getWebhookInfo"))result={url:""};
    else if(url.endsWith("/getUpdates")){const payload=JSON.parse(String(opts?.body));result=updates.filter((u:any)=>u.update_id>=(payload.offset??0)).slice(0,payload.limit??100);}
    else if(url.endsWith("/getChat")){const chat=Number(JSON.parse(String(opts?.body)).chat_id);result={id:chat,type:"private",first_name:chat===555?"Owner":chat===777?"Subscriber A":"Friend",username:chat===555?"learner":undefined};}
    else if(url.endsWith("/sendMessage")){const payload=JSON.parse(String(opts?.body));sends.push(payload);result={message_id:sends.length,chat:{id:Number(payload.chat_id)}};}
    else throw new Error("Unexpected network method");
    return Response.json({ok:true,result});
  };
  return sends;
}
async function linked(env:Runtime,user="user-a"){
  const updates:unknown[]=[];const sends=mockTelegram(updates);
  const status=await saveBot(env,user,token);
  const code=new URL(status.pairingUrl!).searchParams.get("start");
  updates.push({update_id:updates.length+1,message:{text:"/start "+code,chat:{id:555,type:"private"},from:{id:555}}});
  await pairChat(env,user);return sends;
}
function mcp(method:string,args?:unknown,user?:string){
  return new Request("https://setup.test/mcp",{method:"POST",headers:{"content-type":"application/json",...(user?{"oai-authenticated-user-id":user,"oai-authenticated-user-email":"learner@example.test"}:{})},body:JSON.stringify({jsonrpc:"2.0",id:1,method,...(args?{params:args}:{})})});
}

test("encrypted credentials are randomized and bound to the account",async()=>{
  const env=runtime();const a=await encryptToken(env,token,"a");const b=await encryptToken(env,token,"a");
  assert.notEqual(a,b);assert.ok(!a.includes(token));
  assert.equal(await decryptToken(env,a,"a"),token);
  await assert.rejects(()=>decryptToken(env,a,"b"));
  const bytes=Uint8Array.from(atob(a),c=>c.charCodeAt(0));bytes[20]^=1;
  await assert.rejects(()=>decryptToken(env,btoa(String.fromCharCode(...bytes)),"a"));
});
test("only the one-time private chat pairing is accepted",async()=>{
  const env=runtime();const updates:unknown[]=[];mockTelegram(updates);
  const status=await saveBot(env,"a",token);const code=new URL(status.pairingUrl!).searchParams.get("start");
  updates.push({update_id:updates.length+1,message:{text:"/start wrong",chat:{id:555,type:"private"},from:{id:555}}});
  updates.push({update_id:updates.length+1,message:{text:"/start "+code,chat:{id:555,type:"group"},from:{id:555}}});
  await assert.rejects(()=>pairChat(env,"a"),/press Start/);
  updates.push({update_id:updates.length+1,message:{text:"/start "+code,chat:{id:555,type:"private"},from:{id:555}}});
  const paired=await pairChat(env,"a");assert.equal(paired.connected,true);assert.equal(paired.pairingUrl,null);
  assert.equal((await getStatus(env,"b")).botSaved,false);
  const safe=await getStatus(env,"a");assert.ok(!("pairingUrl" in safe));assert.ok(!JSON.stringify(safe).includes(token));
});
test("delivery uses the verified destination and deduplicates repeated lessons",async()=>{
  const env=runtime();const sends=await linked(env);
  const text=("Português · русский\n").repeat(500);
  const sent=await sendLesson(env,"user-a","ru_2026-10-09",text);
  assert.equal(sent.sent,true);assert.ok(sends.length>1);assert.ok(sends.every(s=>s.chat_id==="555"));
  const before=sends.length;const again=await sendLesson(env,"user-a","ru_2026-10-09",text);
  assert.equal(again.alreadySent,true);assert.equal(sends.length,before);
  await assert.rejects(()=>sendLesson(env,"user-a","ru_2026-10-09","changed"),/different text/);
  await assert.rejects(()=>sendLesson(env,"user-b","ru_2026-10-09",text),/Link your private/);
});
test("an ambiguous send is recorded and cannot be retried automatically",async()=>{
  const env=runtime();await linked(env);
  const telegramFetch=globalThis.fetch;globalThis.fetch=async(request,opts)=>{if(String(request).endsWith("/sendMessage"))throw new Error("secret request URL "+token);return telegramFetch(request,opts);};
  await assert.rejects(()=>sendLesson(env,"user-a","uncertain_test","lesson"),e=>e instanceof Error&&!e.message.includes(token));
  assert.equal((await getStatus(env,"user-a")).lastDelivery?.status,"uncertain");
  await assert.rejects(()=>sendLesson(env,"user-a","uncertain_test","lesson"),/previous delivery is uncertain/);
});
test("MCP discovery contains no account data and private calls require identity",async()=>{
  const env=runtime();
  const list=await handleMcp(mcp("tools/list"),env);
  assert.equal(list.status,200);
  const data=await rpc(list);assert.equal(data.result.tools.length,5);assert.ok(!JSON.stringify(data).includes(token));
  const unauth=await handleMcp(mcp("tools/call",{name:"telegram_connection_status",arguments:{}}),env);assert.equal(unauth.status,401);
  const authenticated=await handleMcp(mcp("tools/call",{name:"telegram_connection_status",arguments:{}},"a"),env);
  assert.equal((await rpc(authenticated)).result.structuredContent.connected,false);
  const init=await handleMcp(mcp("initialize",{protocolVersion:"2025-06-18"}),env);
  assert.equal((await rpc(init)).result.protocolVersion,"2025-06-18");
});
test("cross-origin browser writes and unknown destination arguments are rejected",async()=>{
  const env=runtime();
  const request=new Request("https://setup.test/api/telegram/disconnect",{method:"POST",headers:{"origin":"https://evil.test","oai-authenticated-user-id":"a","oai-authenticated-user-email":"a@example.test"},body:"{}"});
  assert.equal((await handleApi(request,env,"disconnect")).status,403);
  const response=await handleMcp(mcp("tools/call",{name:"publish_telegram_content",arguments:{content_key:"x",copies:{ru:"hello"},chat_id:"attacker"}},"a"),env);
  assert.equal((await rpc(response)).result.isError,true);
});
test("splitting preserves Cyrillic, accents, emoji and all text",()=>{
  const text=("ação — помощь 😀\n").repeat(700);const parts=splitLesson(text);
  assert.equal(parts.join(""),text);assert.ok(parts.every(p=>p.length<=3600));
  assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
});


function start(updateId:number,chatId:number,code:string,type="private",from=chatId){return {update_id:updateId,message:{text:"/start "+code,chat:{id:chatId,type},from:{id:from}}};}
function command(updateId:number,chatId:number,text:string){return {update_id:updateId,message:{text,chat:{id:chatId,type:"private"},from:{id:chatId}}};}
async function invited(env:Runtime,chatId=777){
  const invite=await createInvite(env,"user-a","Subscriber A","ru");
  const updates=[start(10,chatId,new URL(invite.url).searchParams.get("start")!)];
  const sends=mockTelegram(updates);await syncSubscribers(env,"user-a");
  return {invite,updates,sends};
}
test("invitation registration verifies another private chat and welcome delivery",async()=>{
  const env=runtime();await linked(env);
  const {invite,updates,sends}=await invited(env);
  assert.equal(invite.singleUse,true);assert.ok(new URL(invite.url).searchParams.get("start")!.length<=64);
  const code=new URL(invite.url).searchParams.get("start")!;
  const stored=env.sql.prepare("SELECT * FROM telegram_invites").get()!;
  assert.ok(!JSON.stringify(stored).includes(code));
  const status=await getStatus(env,"user-a");
  assert.equal(status.subscribers.length,1);
  assert.equal(status.subscribers[0].name,"Subscriber A");assert.equal(status.subscribers[0].status,"active");
  assert.equal(sends.length,1);assert.equal(sends[0].chat_id,"777");assert.match(String(sends[0].text),/Вы подписаны/);
  // Telegram replays and another person reusing the same link cannot register twice.
  await syncSubscribers(env,"user-a");assert.equal(sends.length,1);
  updates.push(start(11,888,code));await syncSubscribers(env,"user-a");
  assert.equal((await getStatus(env,"user-a")).subscribers.length,1);
  const delivery=await sendLesson(env,"user-a","ru_invitation_verification","Preciso de ajuda. — Мне нужна помощь.\nUma sacola, por favor. — Пакет, пожалуйста.");
  assert.equal(delivery.confirmedRecipients,2);assert.equal(delivery.allSent,true);
  assert.ok(sends.some(s=>s.chat_id==="777"&&String(s.text).startsWith("Preciso")));
  const count=sends.length;const again=await sendLesson(env,"user-a","ru_invitation_verification","Preciso de ajuda. — Мне нужна помощь.\nUma sacola, por favor. — Пакет, пожалуйста.");
  assert.equal(again.alreadySent,true);assert.equal(sends.length,count);
});
test("expired, revoked, guessed, group and mismatched-sender invitations cannot subscribe",async()=>{
  const env=runtime();await linked(env);
  const expired=await createInvite(env,"user-a","Expired");const revoked=await createInvite(env,"user-a","Revoked");const valid=await createInvite(env,"user-a","Valid");
  env.sql.prepare("UPDATE telegram_invites SET expires_at=0 WHERE id=?").run(expired.id);
  await revokeInvite(env,"user-a",revoked.id);
  const codes=[expired,revoked,valid].map(i=>new URL(i.url).searchParams.get("start")!);
  mockTelegram([start(10,777,codes[0]),start(11,777,codes[1]),start(12,777,"invite_"+"0".repeat(32)),start(13,777,codes[2],"group"),start(14,777,codes[2],"private",888),command(15,777,"/start")]);
  await syncSubscribers(env,"user-a");assert.equal((await getStatus(env,"user-a")).subscribers.length,0);
  await assert.rejects(()=>createInvite(env,"user-b","Guest"),/Link your private/);
  await assert.rejects(()=>testSubscriber(env,"user-a","arbitrary-chat-id"),/no active verified/);
});
test("stop is processed before broadcast, resume works, owner revocation cannot be bypassed",async()=>{
  const env=runtime();await linked(env);const {updates,sends}=await invited(env);
  updates.push(command(11,777,"/stop"));
  await sendLesson(env,"user-a","paused_lesson","today");
  assert.ok(!sends.some(s=>s.chat_id==="777"&&s.text==="today"));
  assert.equal((await getStatus(env,"user-a")).subscribers[0].status,"paused");
  updates.push(command(12,777,"/start"));await sendLesson(env,"user-a","resumed_lesson","resumed");
  assert.ok(sends.some(s=>s.chat_id==="777"&&s.text==="resumed"));
  const sub=(await getStatus(env,"user-a")).subscribers[0];
  await manageSubscription(env,"user-a",sub.id,"revoked");updates.push(command(13,777,"/start"));
  await sendLesson(env,"user-a","revoked_lesson","revoked");
  assert.ok(!sends.some(s=>s.chat_id==="777"&&s.text==="revoked"));
});
test("language routing requires matching supplied copies",async()=>{
  const env=runtime();await linked(env);const {updates,sends}=await invited(env);
  updates.push(command(11,777,"/language en"));
  const ru=await sendLesson(env,"user-a","russian_only","русский");
  assert.equal(ru.allSent,false);assert.ok(ru.results.some(r=>r.skipped===true));
  assert.ok(!sends.some(s=>s.chat_id==="777"&&s.text==="русский"));
  const all=await publishLesson(env,"user-a","bilingual",{ru:"русский урок",en:"English lesson"});
  assert.equal(all.allSent,true);assert.ok(sends.some(s=>s.chat_id==="777"&&s.text==="English lesson"));
});
test("per-recipient failures preserve successes and uncertainty is not retried",async()=>{
  const env=runtime();await linked(env);const {updates,sends}=await invited(env);
  const second=await createInvite(env,"user-a","Friend");updates.push(start(11,888,new URL(second.url).searchParams.get("start")!));await syncSubscribers(env,"user-a");
  const telegramFetch=globalThis.fetch;
  globalThis.fetch=async(request,opts)=>{
    const payload=JSON.parse(String(opts?.body));
    if(String(request).endsWith("/sendMessage")&&payload.chat_id==="777"&&payload.text==="fanout")throw new Error("timeout");
    return telegramFetch(request,opts);
  };
  const first=await sendLesson(env,"user-a","fanout_key","fanout");
  assert.equal(first.confirmedRecipients,2);assert.equal(first.allSent,false);
  assert.equal((env.sql.prepare("SELECT status FROM telegram_recipient_deliveries WHERE chat_id='777' AND lesson_key='fanout_key'").get() as {status:string}).status,"uncertain");
  assert.ok(sends.some(s=>s.chat_id==="888"&&s.text==="fanout"));
  const count=sends.length;const repeated=await sendLesson(env,"user-a","fanout_key","fanout");
  assert.equal(repeated.confirmedRecipients,2);assert.equal(sends.length,count);
});
test("registration lease prevents competing pollers and account reads stay isolated",async()=>{
  const env=runtime();await linked(env);const invite=await createInvite(env,"user-a","Guest");
  env.sql.prepare("UPDATE telegram_connections SET poll_lock_until=?").run(Date.now()+60000);
  await assert.rejects(()=>syncSubscribers(env,"user-a"),/already running/);
  assert.equal((await getStatus(env,"user-b")).invites.length,0);
  assert.equal((await getStatus(env,"user-b")).subscribers.length,0);
  assert.equal((await getStatus(env,"user-a")).invites[0].id,invite.id);
});
