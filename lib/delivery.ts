import { AppError, db, digest, errorMessage, splitLesson, telegram } from "./telegram-core.ts";
import type { Runtime, TelegramResult } from "./telegram-core.ts";
type Delivery = {content_hash:string;total_parts:number;sent_parts:number;status:string};
export function validateLesson(key:unknown,text:unknown):asserts key is string{
  if(typeof key!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw new AppError("Use a stable lesson key, such as ru_2026-10-09.");
  if(typeof text!=="string"||!text.trim()||text.length>25000)throw new AppError("Lesson text must contain 1–25,000 characters.");
}
export async function sendDestination(env:Runtime,user:string,token:string,chatId:string,name:string,key:string,text:string,owner=false){
  validateLesson(key,text);
  const chunks=splitLesson(text), hash=await digest(text), now=new Date().toISOString();
  // Preserve existing owner receipts. Subscribers and bot command replies have their own ledger.
  const table=owner?"telegram_deliveries":"telegram_recipient_deliveries";
  const columns=owner?"user_id,lesson_key":"user_id,chat_id,lesson_key";
  const parameters=owner?[user,key]:[user,chatId,key];
  const where=owner?"user_id=? AND lesson_key=?":"user_id=? AND chat_id=? AND lesson_key=?";
  const claim=await db(env).prepare(`INSERT INTO ${table} (${columns},content_hash,total_parts,status,created_at) VALUES (${parameters.map(()=>"?").join(",")},?,?,'sending',?) ON CONFLICT(${columns}) DO NOTHING`).bind(...parameters,hash,chunks.length,now).run();
  if(claim.meta.changes!==1){
    const old=await db(env).prepare(`SELECT * FROM ${table} WHERE ${where}`).bind(...parameters).first<Delivery>();
    if(!old||old.content_hash!==hash)throw new AppError("This lesson key already belongs to different text. Do not overwrite it.",409);
    if(old.status==="sent")return {sent:true,alreadySent:true,lessonKey:key,parts:old.sent_parts,destination:name};
    throw new AppError(`A previous delivery is ${old.status} (${old.sent_parts}/${old.total_parts} parts confirmed). Check Telegram before any retry.`,409);
  }
  let sent=0;
  try{
    for(const part of chunks){
      if(sent>0)await new Promise(resolve=>setTimeout(resolve,1100));
      const message=await telegram<TelegramResult>(token,"sendMessage",{chat_id:chatId,text:part,link_preview_options:{is_disabled:true}});
      if(!Number.isInteger(message.message_id)||String(message.chat?.id)!==chatId)throw new AppError("Telegram returned an unexpected delivery confirmation.",504);
      sent+=1;await db(env).prepare(`UPDATE ${table} SET sent_parts=? WHERE ${where}`).bind(sent,...parameters).run();
    }
    await db(env).prepare(`UPDATE ${table} SET status='sent',finished_at=? WHERE ${where}`).bind(new Date().toISOString(),...parameters).run();
    return {sent:true,alreadySent:false,lessonKey:key,parts:sent,destination:name};
  }catch(error){
    const status=error instanceof AppError&&![504,502,503].includes(error.status)?"failed":"uncertain";
    await db(env).prepare(`UPDATE ${table} SET status=?,finished_at=? WHERE ${where}`).bind(status,new Date().toISOString(),...parameters).run();
    if(error instanceof AppError&&error.status===403)await db(env).prepare("UPDATE telegram_subscriptions SET status='blocked',updated_at=? WHERE user_id=? AND chat_id=?").bind(new Date().toISOString(),user,chatId).run();
    throw new AppError(`${errorMessage(error)} ${sent}/${chunks.length} parts confirmed. Do not resend this lesson automatically.`,error instanceof AppError?error.status:503);
  }
}
