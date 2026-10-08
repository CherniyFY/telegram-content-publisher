import { AppError, chatDisplay, connection, db, decryptToken, encryptToken, errorMessage, hex, identity, input, json, telegram, validateOrigin } from "./telegram-core.ts";
import { sendDestination, validateLesson } from "./delivery.ts";
import { createInvite, listSubscriptions, manageSubscription, revokeInvite, syncSubscribers, testSubscriber } from "./subscriptions.ts";
import type { Runtime, TelegramResult, Language } from "./telegram-core.ts";
import type { Subscription } from "./subscriptions.ts";
export { AppError, encryptToken, decryptToken, splitLesson } from "./telegram-core.ts";
export type { Runtime } from "./telegram-core.ts";
export { createInvite, listSubscriptions, syncSubscribers, revokeInvite, manageSubscription, testSubscriber } from "./subscriptions.ts";
const protocols=["2025-03-26","2025-06-18","2025-11-25"];
export async function getStatus(env:Runtime,user:string,browser=false){
  const row=await connection(env,user);
  const last=await db(env).prepare("SELECT lesson_key,status,total_parts,sent_parts,created_at,finished_at FROM telegram_deliveries WHERE user_id=? ORDER BY created_at DESC LIMIT 1").bind(user).first<{lesson_key:string;status:string;total_parts:number;sent_parts:number}>();
  const subscriptions=await listSubscriptions(env,user);
  return {botSaved:!!row,connected:!!row?.chat_id,botUsername:row?.bot_username??null,botName:row?.bot_name??null,chatName:row?.chat_name??null,lastDelivery:last??null,ownerDeliveryEnabled:!!row?.owner_delivery_enabled,
    pairingExpired:!!row?.pairing_code&&(row.pairing_expires??0)<Date.now(),...subscriptions,
    registrationMode:"Registration is checked before each lesson and when Check registrations is pressed. Keep this page open for checks every 15 seconds.",
    ...(browser?{pairingUrl:row?.pairing_code&&(row.pairing_expires??0)>Date.now()?`https://t.me/${row.bot_username}?start=${row.pairing_code}`:null}:{})};
}
export async function saveBot(env:Runtime,user:string,raw:unknown){
  const token=typeof raw==="string"?raw.trim():"";
  if(!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))throw new AppError("Paste the complete token from BotFather.");
  const cipher=await encryptToken(env,token,user),bot=await telegram<TelegramResult>(token,"getMe");
  if(!bot.is_bot||!bot.username||!/^[A-Za-z0-9_]{5,32}$/.test(bot.username))throw new AppError("This token does not identify a Telegram bot.");
  const other=await db(env).prepare("SELECT user_id FROM telegram_connections WHERE lower(bot_username)=lower(?) AND user_id<>?").bind(bot.username,user).first();
  if(other)throw new AppError("This bot is already registered to another account.",409);
  const webhook=await telegram<TelegramResult>(token,"getWebhookInfo");
  if(webhook.url)throw new AppError("This bot is already connected to another service. Create a separate bot for these lessons.");
  const old=await connection(env,user);
  if(old?.chat_id)throw new AppError("Disconnect the current bot before replacing it. Existing subscriber access will be removed.",409);
  const code=hex(crypto.getRandomValues(new Uint8Array(16)));
  const changed=await db(env).prepare(`INSERT INTO telegram_connections (user_id,token_cipher,bot_username,bot_name,pairing_code,pairing_expires,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_cipher=excluded.token_cipher,bot_username=excluded.bot_username,bot_name=excluded.bot_name,pairing_code=excluded.pairing_code,pairing_expires=excluded.pairing_expires,chat_id=NULL,chat_name=NULL,update_offset=0,owner_delivery_enabled=1,updated_at=excluded.updated_at WHERE telegram_connections.poll_lock_until<?`)
    .bind(user,cipher,bot.username,bot.first_name??bot.username,code,Date.now()+30*60*1000,new Date().toISOString(),Date.now()).run();
  if(changed.meta.changes!==1)throw new AppError("Registration is being checked. Try again shortly.",409);
  return getStatus(env,user,true);
}
export async function pairChat(env:Runtime,user:string){
  const row=await connection(env,user);if(!row)throw new AppError("Save your bot token first.");if(row.chat_id)return getStatus(env,user,true);
  if(!row.pairing_code||(row.pairing_expires??0)<Date.now())throw new AppError("The pairing link expired. Save the bot token again to make a new link.");
  const token=await decryptToken(env,row.token_cipher,user);
  type Update={message?:{text?:string;chat?:{id:number;type:string};from?:{id:number;is_bot?:boolean}}};
  const updates=await telegram<Update[]>(token,"getUpdates",{limit:100,timeout:0,allowed_updates:["message"]});
  const message=updates.map(u=>u.message).find(m=>m?.text===`/start ${row.pairing_code}`&&m.chat?.type==="private"&&!m.from?.is_bot&&m.from?.id===m.chat.id);
  if(!message?.chat)throw new AppError("Open your bot using the link on this page, press Start in Telegram, then click Verify chat.");
  const chat=await telegram<TelegramResult>(token,"getChat",{chat_id:message.chat.id});
  if(chat.id!==message.chat.id||chat.type!=="private")throw new AppError("Telegram could not verify this private chat.");
  const changed=await db(env).prepare("UPDATE telegram_connections SET chat_id=?,chat_name=?,pairing_code=NULL,pairing_expires=NULL,updated_at=? WHERE user_id=? AND token_cipher=? AND pairing_code=?")
    .bind(String(chat.id),chatDisplay(chat),new Date().toISOString(),user,row.token_cipher,row.pairing_code).run();
  if(changed.meta.changes!==1)throw new AppError("Your bot settings changed. Please start pairing again.",409);return getStatus(env,user,true);
}
export async function publishLesson(env:Runtime,user:string,key:unknown,variants:Partial<Record<Language,string>>,includeOwner=true){
  if(!variants||typeof variants!=="object"||Array.isArray(variants)||!Object.keys(variants).length||Object.keys(variants).some(k=>!["ru","en","pt"].includes(k)))throw new AppError("Provide lesson copies keyed by ru, en, or pt.");
  for(const text of Object.values(variants))validateLesson(key,text);
  // Consume /stop and invitation events before taking the recipient snapshot.
  const sync=await syncSubscribers(env,user);
  if(sync.morePending)throw new AppError("More Telegram commands are waiting. Check registrations again before sending a lesson.",409);
  const row=(await connection(env,user))!,token=await decryptToken(env,row.token_cipher,user);
  const recipients=(await db(env).prepare("SELECT * FROM telegram_subscriptions WHERE user_id=? AND status='active' ORDER BY created_at").bind(user).all<Subscription>()).results;
  const outcomes:Record<string,unknown>[]=[];
  // A chat appears once even if the owner redeems a test invitation.
  const ownerWillSend=includeOwner&&!!row.owner_delivery_enabled&&!!variants.ru;
  const targets=recipients.filter(s=>s.chat_id!==row.chat_id||!ownerWillSend);
  if(ownerWillSend&&variants.ru){
    try{outcomes.push({owner:true,...await sendDestination(env,user,token,row.chat_id!,row.chat_name??"Owner",key as string,variants.ru,true)});}
    catch(error){outcomes.push({owner:true,sent:false,error:errorMessage(error)});}
  }
  for(const recipient of targets){
    const text=variants[recipient.language];
    if(!text){outcomes.push({recipientId:recipient.id,destination:recipient.chat_name,sent:false,skipped:true,reason:`No ${recipient.language} copy supplied.`});continue;}
    // One failed destination does not suppress delivery to other subscribers.
    await new Promise(resolve=>setTimeout(resolve,100));
    try{outcomes.push({recipientId:recipient.id,...await sendDestination(env,user,token,recipient.chat_id,recipient.chat_name,key as string,text)});}
    catch(error){outcomes.push({recipientId:recipient.id,destination:recipient.chat_name,sent:false,error:errorMessage(error)});}
  }
  if(!outcomes.length)throw new AppError("No active recipients match these lesson copies.",409);
  const sent=outcomes.filter(o=>o.sent===true).length;
  return {sent:sent>0,allSent:outcomes.every(o=>o.sent===true),lessonKey:key,recipientCount:outcomes.length,confirmedRecipients:sent,results:outcomes};
}
export async function sendLesson(env:Runtime,user:string,keyInput:unknown,textInput:unknown){
  validateLesson(keyInput,textInput);
  const row=await connection(env,user);if(!row?.chat_id)throw new AppError("Link your private Telegram chat on the setup page first.",409);
  const result=await publishLesson(env,user,keyInput,{ru:textInput as string});
  if(!result.sent){const first=result.results.find(o=>o.error);throw new AppError(String(first?.error??"No deliveries were confirmed."),409);}
  return {...result,alreadySent:result.results.every(o=>o.alreadySent===true),parts:result.results[0]?.parts};
}
export async function handleApi(request:Request,env:Runtime,action:string):Promise<Response>{
  try{
    const user=identity(request);
    if(request.method==="GET"&&action==="status")return json(await getStatus(env,user,true));
    if(request.method!=="POST")return json({error:"Method not allowed."},405);
    validateOrigin(request,true);const body=await input(request,4096);
    if(action==="save")return json(await saveBot(env,user,body.token));
    if(action==="pair")return json(await pairChat(env,user));
    if(action==="sync"){const result=await syncSubscribers(env,user);return json({...await getStatus(env,user,true),processed:result.processed,morePending:result.morePending});}
    if(action==="invite")return json(await createInvite(env,user,body.label,body.language??"ru"));
    if(action==="revoke-invite")return json(await revokeInvite(env,user,body.id));
    if(action==="subscription")return json(await manageSubscription(env,user,body.id,body.status));
    if(action==="subscriber-test")return json(await testSubscriber(env,user,body.id));
    if(action==="test"){
      const row=await connection(env,user);if(!row?.chat_id)throw new AppError("Link your private Telegram chat first.",409);
      return json(await sendDestination(env,user,await decryptToken(env,row.token_cipher,user),row.chat_id,row.chat_name??"Owner",`test_${crypto.randomUUID()}`,"Подключение проверено. Уроки португальского можно отправлять в этот чат.",true));
    }
    if(action==="disconnect"){
      const row=await connection(env,user);if(row&&row.poll_lock_until>Date.now())throw new AppError("Registration is being checked. Try again shortly.",409);
      await db(env).batch([
        db(env).prepare("DELETE FROM telegram_subscriptions WHERE user_id=?").bind(user),
        db(env).prepare("DELETE FROM telegram_invites WHERE user_id=?").bind(user),
        db(env).prepare("DELETE FROM telegram_recipient_deliveries WHERE user_id=?").bind(user),
        db(env).prepare("DELETE FROM telegram_connections WHERE user_id=?").bind(user),
      ]);return json(await getStatus(env,user,true));
    }
    return json({error:"Unknown action."},404);
  }catch(error){return json({error:errorMessage(error)},error instanceof AppError?error.status:503);}
}
const empty={type:"object",properties:{},additionalProperties:false};
const tools=[
  {name:"telegram_connection_status",title:"Telegram connection status",description:"Read the current user's saved bot, verified owner chat, invited recipients and delivery status. Never returns tokens, chat IDs, or invitation codes. This read does not process pending Telegram commands.",inputSchema:empty,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
  {name:"publish_telegram_content",title:"Publish selected content to Telegram",description:"Publish only explicitly authorized content copies to active invited subscribers using their language preferences. Provide a stable content_key and already translated ru, en, or pt copies. The server does not translate or read ChatGPT conversations. Return per-recipient receipts; never retry uncertain sends automatically.",inputSchema:{type:"object",properties:{content_key:{type:"string"},copies:{type:"object",properties:{ru:{type:"string"},en:{type:"string"},pt:{type:"string"}},additionalProperties:false,minProperties:1},include_owner:{type:"boolean",default:false}},required:["content_key","copies"],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:true}},
  {name:"telegram_create_invite",title:"Create a Telegram invitation",description:"Create a single-use, seven-day invitation for an authorized recipient. Share the returned URL with that person. They must open it and press Start; then check registrations. No arbitrary chat IDs accepted.",inputSchema:{type:"object",properties:{label:{type:"string"},language:{type:"string",enum:["ru","en","pt"],default:"ru"}},required:["label"],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},
  {name:"telegram_sync_subscribers",title:"Check Telegram registrations",description:"Process real Telegram invitation starts, language preferences, and stop/resume commands. Registration verifies each private chat using Telegram. Returns invited recipients and registration outcomes. May send opt-in acknowledgements to people who contacted the bot.",inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
  {name:"telegram_test_subscriber",title:"Verify subscriber delivery",description:"Send one delivery test to an authorized active subscriber by their stored recipient ID from connection status. Cannot send to arbitrary destinations.",inputSchema:{type:"object",properties:{recipient_id:{type:"string"}},required:["recipient_id"],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true}},
];
export async function handleMcp(request:Request,env:Runtime):Promise<Response>{
  let id:unknown=null;try{
    validateOrigin(request);if(request.method!=="POST")return new Response(null,{status:405,headers:{Allow:"POST"}});
    const version=request.headers.get("mcp-protocol-version");if(version&&!protocols.includes(version))throw new AppError("Unsupported MCP protocol version.");
    const body=await input(request);id=body.id??null;if(body.jsonrpc!=="2.0"||typeof body.method!=="string")throw new AppError("Invalid JSON-RPC request.");
    if(body.id===undefined){if(body.method.startsWith("notifications/"))return new Response(null,{status:202});throw new AppError("A request ID is required.");}
    const params=body.params as Record<string,unknown>|undefined;let result:unknown;
    if(body.method==="initialize")result={protocolVersion:protocols.includes(String(params?.protocolVersion))?params?.protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"telegram-content-publisher",version:"2.0.0"},instructions:"Deliver only authorized lessons. Invited recipients must press Start on their single-use link. Check registrations before lesson delivery; honour stop commands. Check per-recipient receipts. Never expose tokens or retry uncertain deliveries automatically."};
    else if(body.method==="ping")result={};else if(body.method==="tools/list")result={tools};
    else if(body.method==="tools/call"){
      const user=identity(request),args=params?.arguments as Record<string,unknown>|undefined;
      try{
        if(args&&(typeof args!=="object"||Array.isArray(args)))throw new AppError("Expected tool arguments as an object.");
        let value:unknown;
        if(params?.name==="telegram_connection_status"||params?.name==="telegram_sync_subscribers"){
          if(args&&Object.keys(args).length)throw new AppError("This tool takes no arguments.");
          value=params.name==="telegram_connection_status"?await getStatus(env,user):await syncSubscribers(env,user);
        }else if(params?.name==="publish_telegram_content"){
          if(!args||Object.keys(args).some(k=>!["content_key","copies","include_owner"].includes(k)))throw new AppError("Invalid publish arguments.");value=await publishLesson(env,user,args.content_key,args.copies as Partial<Record<Language,string>>,args.include_owner===true);
        }else if(params?.name==="telegram_create_invite"){
          if(!args||Object.keys(args).some(k=>!["label","language"].includes(k)))throw new AppError("Invalid invitation arguments.");value=await createInvite(env,user,args.label,args.language??"ru");
        }else if(params?.name==="telegram_test_subscriber"){
          if(!args||Object.keys(args).some(k=>k!=="recipient_id"))throw new AppError("Invalid recipient arguments.");value=await testSubscriber(env,user,args.recipient_id);
        }else throw new AppError("Unknown tool.");
        result={content:[{type:"text",text:JSON.stringify(value)}],structuredContent:value};
      }catch(error){result={content:[{type:"text",text:errorMessage(error)}],isError:true};}
    }else return json({jsonrpc:"2.0",id,error:{code:-32601,message:"Method not found."}});
    return json({jsonrpc:"2.0",id,result});
  }catch(error){return json({jsonrpc:"2.0",id,error:{code:-32600,message:errorMessage(error)}},error instanceof AppError?error.status:503);}
}
