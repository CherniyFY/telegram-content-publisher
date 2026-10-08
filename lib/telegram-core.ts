export type Runtime = { DB?: D1Database; TOKEN_ENCRYPTION_KEY?: string };
export type Connection = { user_id:string; token_cipher:string; bot_username:string; bot_name:string; pairing_code:string|null; pairing_expires:number|null; chat_id:string|null; chat_name:string|null; updated_at:string; update_offset:number; poll_lock_until:number; poll_lock_id:string|null; owner_delivery_enabled:number };
export type TelegramResult = { id:number; is_bot?:boolean; username?:string; first_name?:string; last_name?:string; type?:string; url?:string; chat?:{id:number}; message_id?:number };
export type Language = "ru"|"en"|"pt";
export class AppError extends Error {
  status:number;
  constructor(message:string,status=400){super(message);this.status=status;}
}
export const encoder=new TextEncoder();
export function db(env:Runtime){if(!env.DB)throw new AppError("Connection storage is temporarily unavailable.",503);return env.DB;}
export function identity(request:Request){
  const id=request.headers.get("oai-authenticated-user-id");
  if(!id||!request.headers.get("oai-authenticated-user-email"))throw new AppError("Sign in with ChatGPT to access your connection.",401);
  return id;
}
export function validateOrigin(request:Request,required=false){
  const origin=request.headers.get("origin");
  if((required&&!origin)||(origin&&origin!==new URL(request.url).origin))throw new AppError("This request must come from your setup page.",403);
}
export function json(value:unknown,status=200){return Response.json(value,{status,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});}
export async function input(request:Request,max=60000):Promise<Record<string,unknown>>{
  if(Number(request.headers.get("content-length")??0)>max)throw new AppError("Request is too large.",413);
  const raw=await request.text();if(raw.length>max)throw new AppError("Request is too large.",413);
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new AppError("Invalid JSON.");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new AppError("Expected an object.");return value as Record<string,unknown>;
}
export function errorMessage(error:unknown){return error instanceof AppError?error.message:"The connection is temporarily unavailable. Please try again.";}
export function hex(bytes:Uint8Array){return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
export async function digest(value:string){return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));}
async function encryptionKey(env:Runtime){
  if(!env.TOKEN_ENCRYPTION_KEY||!/^[a-f0-9]{64}$/.test(env.TOKEN_ENCRYPTION_KEY))throw new AppError("Secure token storage is unavailable.",503);
  const bytes=Uint8Array.from(env.TOKEN_ENCRYPTION_KEY.match(/../g)!,b=>parseInt(b,16));
  return crypto.subtle.importKey("raw",bytes,"AES-GCM",false,["encrypt","decrypt"]);
}
export async function encryptToken(env:Runtime,token:string,user:string){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode(user)},await encryptionKey(env),encoder.encode(token));
  const bytes=new Uint8Array(iv.length+cipher.byteLength);bytes.set(iv);bytes.set(new Uint8Array(cipher),iv.length);return btoa(String.fromCharCode(...bytes));
}
export async function decryptToken(env:Runtime,cipher:string,user:string){
  const bytes=Uint8Array.from(atob(cipher),c=>c.charCodeAt(0));
  const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:encoder.encode(user)},await encryptionKey(env),bytes.slice(12));return new TextDecoder().decode(plain);
}
export async function telegram<T>(token:string,method:string,params:Record<string,unknown>={}):Promise<T>{
  let response:Response;
  try{response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(params),signal:AbortSignal.timeout(12000)});}
  catch{throw new AppError("Telegram did not confirm the request. Check delivery status before retrying.",504);}
  // Never expose the request URL, response description, or bot token.
  let payload:{ok?:boolean;result?:T;error_code?:number};
  try{payload=await response.json() as typeof payload;}catch{throw new AppError("Telegram returned an unreadable response.",502);}
  if(!response.ok||!payload.ok||payload.result===undefined){
    if(response.status===401||payload.error_code===401)throw new AppError("Telegram did not accept this bot token. Check the token from BotFather.",401);
    if(response.status===403||payload.error_code===403)throw new AppError("This recipient blocked the bot or Telegram denied delivery.",403);
    if(response.status===429||payload.error_code===429)throw new AppError("Telegram is limiting requests. Please try again later.",429);
    throw new AppError("Telegram rejected the request. Check the bot and linked chat.",502);
  }return payload.result;
}
export async function connection(env:Runtime,user:string){return db(env).prepare("SELECT * FROM telegram_connections WHERE user_id=?").bind(user).first<Connection>();}
export function chatDisplay(chat:TelegramResult){
  const name=[chat.first_name,chat.last_name].filter(Boolean).join(" ")||chat.username||"Private Telegram chat";
  return (chat.username?`${name} (@${chat.username})`:name).slice(0,200);
}
export function language(value:unknown):Language{
  if(value!=="ru"&&value!=="en"&&value!=="pt")throw new AppError("Choose ru, en, or pt.");return value;
}
export function splitLesson(text:string,max=3600):string[]{
  const chunks:string[]=[];while(text.length>max){let cut=text.lastIndexOf("\n",max);if(cut<max/2)cut=text.lastIndexOf(" ",max);if(cut<max/2)cut=max;else cut+=1;if(cut>max)cut=max;
    const last=text.charCodeAt(cut-1);if(last>=0xD800&&last<=0xDBFF)cut-=1;chunks.push(text.slice(0,cut));text=text.slice(cut);}if(text)chunks.push(text);return chunks;
}
