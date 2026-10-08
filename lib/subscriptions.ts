import { AppError, chatDisplay, connection, db, decryptToken, digest, hex, language, telegram } from "./telegram-core.ts";
import { sendDestination } from "./delivery.ts";
import type { Runtime, Connection, Language, TelegramResult } from "./telegram-core.ts";
export type Subscription = {id:string;user_id:string;chat_id:string;chat_name:string;invite_id:string;language:Language;status:string};
type Invite = {id:string;user_id:string;language:Language;redeemed_chat_id:string|null;expires_at:number;revoked_at:string|null};
type Update = {update_id:number;message?:{date?:number;text?:string;chat?:{id:number;type:string};from?:{id:number;is_bot?:boolean}}};
export async function listSubscriptions(env:Runtime,user:string){
  const subscribers=await db(env).prepare(`SELECT s.id,s.chat_name AS name,s.language,s.status,s.created_at,s.updated_at,
    (SELECT status FROM telegram_recipient_deliveries d WHERE d.user_id=s.user_id AND d.chat_id=s.chat_id AND d.lesson_key NOT LIKE 'command_%' AND d.lesson_key NOT LIKE 'welcome_%' ORDER BY d.created_at DESC LIMIT 1) AS last_delivery
    FROM telegram_subscriptions s WHERE s.user_id=? ORDER BY s.created_at`).bind(user).all();
  const invites=await db(env).prepare(`SELECT id,label,language,created_at,expires_at,revoked_at,redeemed_at FROM telegram_invites WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).bind(user).all();
  return {subscribers:subscribers.results,invites:invites.results};
}
export async function createInvite(env:Runtime,user:string,labelInput:unknown="Guest",languageInput:unknown="ru"){
  const row=await connection(env,user);if(!row?.chat_id)throw new AppError("Link your private Telegram chat first.",409);
  const label=typeof labelInput==="string"?labelInput.trim():"";
  if(!label||label.length>80)throw new AppError("Give the invitation a short label (1–80 characters).");
  const preferred=language(languageInput),code="invite_"+hex(crypto.getRandomValues(new Uint8Array(16))),id=crypto.randomUUID();
  const expires=Date.now()+7*24*60*60*1000;
  await db(env).prepare("INSERT INTO telegram_invites (id,user_id,code_hash,label,language,created_at,expires_at) VALUES (?,?,?,?,?,?,?)")
    .bind(id,user,await digest(code),label,preferred,new Date().toISOString(),expires).run();
  return {id,label,language:preferred,expiresAt:new Date(expires).toISOString(),url:`https://t.me/${row.bot_username}?start=${code}`,singleUse:true};
}
export async function revokeInvite(env:Runtime,user:string,id:unknown){
  if(typeof id!=="string")throw new AppError("Select an invitation.");
  const changed=await db(env).prepare("UPDATE telegram_invites SET revoked_at=? WHERE user_id=? AND id=? AND redeemed_at IS NULL AND revoked_at IS NULL").bind(new Date().toISOString(),user,id).run();
  if(!changed.meta.changes)throw new AppError("This invitation was used, revoked, or does not exist.",409);
  return listSubscriptions(env,user);
}
export async function manageSubscription(env:Runtime,user:string,id:unknown,state:unknown){
  if(typeof id!=="string"||!["active","paused","revoked"].includes(String(state)))throw new AppError("Select a recipient and valid subscription status.");
  const changed=await db(env).prepare("UPDATE telegram_subscriptions SET status=?,updated_at=? WHERE user_id=? AND id=? AND status<>'revoked'").bind(state,new Date().toISOString(),user,id).run();
  if(!changed.meta.changes)throw new AppError("The recipient does not exist or needs a new invitation.",409);
  return listSubscriptions(env,user);
}
const words={
  ru:{welcome:"Вы подписаны на сообщения от автора. /stop — остановить; /start — возобновить; /language ru, en или pt — язык объяснений. Содержание и расписание определяет автор уроков.",stop:"Подписка приостановлена. Новые уроки отправляться не будут. /start — возобновить.",resume:"Подписка возобновлена. Вы будете получать новые уроки.",invite:"Для подписки нужна личная ссылка-приглашение от автора уроков. Откройте её и нажмите Start. Использованная или просроченная ссылка не подходит.",preference:"Язык объяснений сохранён. Урок придёт, когда автор предоставит копию на выбранном языке."},
  en:{welcome:"You are subscribed to messages from the publisher. /stop pauses lessons; /start resumes; /language ru, en or pt changes your explanation language. The publisher chooses content and timing.",stop:"Your subscription is paused. You will not receive new lessons. Use /start to resume.",resume:"Your subscription is active. You will receive new lessons.",invite:"Ask the publisher for a personal invitation link, open it, and press Start. Used or expired invitations cannot register another recipient.",preference:"Explanation language saved. You will receive a message when the publisher supplies a copy in that language."},
  pt:{welcome:"Você está inscrito nos mensagens do autor. /stop pausa; /start retoma; /language ru, en ou pt muda o idioma das explicações. O autor escolhe o conteúdo e o horário.",stop:"Sua inscrição está pausada. Você não receberá novos exercícios. Use /start para retomar.",resume:"Sua inscrição está ativa. Você receberá novos exercícios.",invite:"Peça um convite pessoal ao autor dos exercícios, abra o link e toque em Start. Um convite usado ou vencido não inscreve outra pessoa.",preference:"Idioma das explicações salvo. Você receberá os exercícios quando houver uma cópia nesse idioma."}
};
async function reply(env:Runtime,row:Connection,token:string,chatId:string,key:string,text:string){
  // Replies get the same durable receipt protection as lessons. An uncertain reply is never resent.
  try{await sendDestination(env,row.user_id,token,chatId,"Telegram command reply",key,text);}catch{/* Safe receipt is retained; one failed acknowledgement must not prevent opt-out. */}
}
async function processUpdate(env:Runtime,row:Connection,token:string,update:Update){
  const message=update.message;
  if(!message?.chat||!message.from||message.chat.type!=="private"||message.from.is_bot||message.from.id!==message.chat.id||!Number.isSafeInteger(message.chat.id)||message.chat.id<=0)return;
  const chatId=String(message.chat.id), text=message.text?.trim()??"", now=new Date().toISOString();
  const existing=await db(env).prepare("SELECT * FROM telegram_subscriptions WHERE user_id=? AND chat_id=?").bind(row.user_id,chatId).first<Subscription>();
  const preferred=existing?.language??"ru";
  const match=/^\/start(?:@[A-Za-z0-9_]+)?\s+(invite_[a-f0-9]{32})$/.exec(text);
  if(match){
    const invitation=await db(env).prepare("SELECT * FROM telegram_invites WHERE user_id=? AND code_hash=?").bind(row.user_id,await digest(match[1])).first<Invite>();
    if(!invitation||invitation.revoked_at||invitation.expires_at<=Date.now()||(invitation.redeemed_chat_id&&invitation.redeemed_chat_id!==chatId)){
      await reply(env,row,token,chatId,`command_${update.update_id}`,words[preferred].invite);return;
    }
    if(invitation.redeemed_chat_id===chatId){
      await reply(env,row,token,chatId,`welcome_${invitation.id}`,words[invitation.language].welcome);return;
    }
    const chat=await telegram<TelegramResult>(token,"getChat",{chat_id:chatId});
    if(String(chat.id)!==chatId||chat.type!=="private")throw new AppError("Telegram could not verify the invited private chat.",502);
    // D1 batch is transactional: the second statement inserts only for the winning update.
    await db(env).batch([
      db(env).prepare("UPDATE telegram_invites SET redeemed_chat_id=?,redeemed_update_id=?,redeemed_at=? WHERE user_id=? AND id=? AND redeemed_chat_id IS NULL AND revoked_at IS NULL AND expires_at>?").bind(chatId,update.update_id,now,row.user_id,invitation.id,Date.now()),
      db(env).prepare(`INSERT INTO telegram_subscriptions (id,user_id,chat_id,chat_name,invite_id,language,status,created_at,updated_at)
        SELECT ?,user_id,redeemed_chat_id,?,id,language,'active',?,? FROM telegram_invites WHERE user_id=? AND id=? AND redeemed_chat_id=? AND redeemed_update_id=?
        ON CONFLICT(user_id,chat_id) DO UPDATE SET chat_name=excluded.chat_name,invite_id=excluded.invite_id,language=excluded.language,status='active',updated_at=excluded.updated_at`)
        .bind(crypto.randomUUID(),chatDisplay(chat),now,now,row.user_id,invitation.id,chatId,update.update_id),
    ]);
    const verified=await db(env).prepare("SELECT id FROM telegram_subscriptions WHERE user_id=? AND chat_id=? AND invite_id=? AND status='active'").bind(row.user_id,chatId,invitation.id).first();
    if(verified)await reply(env,row,token,chatId,`welcome_${invitation.id}`,words[invitation.language].welcome);
    return;
  }
  if(/^\/stop(?:@[A-Za-z0-9_]+)?$/.test(text)){
    await db(env).prepare("UPDATE telegram_subscriptions SET status='paused',updated_at=? WHERE user_id=? AND chat_id=? AND status<>'revoked'").bind(now,row.user_id,chatId).run();
    if(chatId===row.chat_id)await db(env).prepare("UPDATE telegram_connections SET owner_delivery_enabled=0 WHERE user_id=?").bind(row.user_id).run();
    if(existing||chatId===row.chat_id)await reply(env,row,token,chatId,`command_${update.update_id}`,words[preferred].stop);
    return;
  }
  if(/^\/start(?:@[A-Za-z0-9_]+)?$/.test(text)){
    if((existing&&existing.status!=="revoked")||chatId===row.chat_id){
      await db(env).prepare("UPDATE telegram_subscriptions SET status='active',updated_at=? WHERE user_id=? AND chat_id=? AND status<>'revoked'").bind(now,row.user_id,chatId).run();
      if(chatId===row.chat_id)await db(env).prepare("UPDATE telegram_connections SET owner_delivery_enabled=1 WHERE user_id=?").bind(row.user_id).run();
      await reply(env,row,token,chatId,`command_${update.update_id}`,words[preferred].resume);
    }else await reply(env,row,token,chatId,`command_${update.update_id}`,words[preferred].invite);
    return;
  }
  const choice=/^\/language(?:@[A-Za-z0-9_]+)?\s+(ru|en|pt)$/.exec(text);
  if(choice&&existing&&existing.status!=="revoked"){
    await db(env).prepare("UPDATE telegram_subscriptions SET language=?,updated_at=? WHERE user_id=? AND chat_id=?").bind(choice[1],now,row.user_id,chatId).run();
    await reply(env,row,token,chatId,`command_${update.update_id}`,words[language(choice[1])].preference);
  }
}
export async function syncSubscribers(env:Runtime,user:string){
  const row=await connection(env,user);if(!row?.chat_id)throw new AppError("Link your private Telegram chat first.",409);
  const lock=crypto.randomUUID();
  const claim=await db(env).prepare("UPDATE telegram_connections SET poll_lock_until=?,poll_lock_id=? WHERE user_id=? AND token_cipher=? AND poll_lock_until<?").bind(Date.now()+120000,lock,user,row.token_cipher,Date.now()).run();
  if(claim.meta.changes!==1)throw new AppError("A registration check is already running. Try again shortly.",409);
  let processed=0,pending=false;
  try{
    const token=await decryptToken(env,row.token_cipher,user);
    const updates=await telegram<Update[]>(token,"getUpdates",{offset:row.update_offset,limit:25,timeout:0,allowed_updates:["message"]});
    if(!Array.isArray(updates)||updates.some(u=>!Number.isSafeInteger(u.update_id)))throw new AppError("Telegram returned invalid registration updates.",502);
    const sorted=updates.filter(u=>u.update_id>=row.update_offset).sort((a,b)=>a.update_id-b.update_id);
    for(const update of sorted){
      await processUpdate(env,row,token,update);
      const changed=await db(env).prepare("UPDATE telegram_connections SET update_offset=?,poll_lock_until=? WHERE user_id=? AND token_cipher=? AND poll_lock_id=?").bind(update.update_id+1,Date.now()+120000,user,row.token_cipher,lock).run();
      if(changed.meta.changes!==1)throw new AppError("The bot settings changed during registration. Check the current connection.",409);
      processed+=1;
    }
    pending=updates.length===25;
    return {processed,morePending:pending,...await listSubscriptions(env,user)};
  }finally{
    await db(env).prepare("UPDATE telegram_connections SET poll_lock_until=0,poll_lock_id=NULL WHERE user_id=? AND poll_lock_id=?").bind(user,lock).run();
  }
}
export async function testSubscriber(env:Runtime,user:string,id:unknown){
  await syncSubscribers(env,user);
  if(typeof id!=="string")throw new AppError("Select a recipient.");
  const sub=await db(env).prepare("SELECT * FROM telegram_subscriptions WHERE user_id=? AND id=? AND status='active'").bind(user,id).first<Subscription>();
  if(!sub)throw new AppError("This recipient has no active verified subscription.",409);
  const row=(await connection(env,user))!;
  const text={ru:"Доставка проверена: русские копии уроков будут приходить в этот чат. /stop — приостановить.",en:"Delivery verified. Lesson copies will arrive in this chat. /stop pauses them.",pt:"Entrega verificada. As cópias dos exercícios chegarão neste chat. /stop pausa a inscrição."}[sub.language];
  return sendDestination(env,user,await decryptToken(env,row.token_cipher,user),sub.chat_id,sub.chat_name,`test_${crypto.randomUUID()}`,text);
}
