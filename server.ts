import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { openRuntime } from "./runtime.ts";
import { handleApi, handleMcp, publishLesson, syncSubscribers } from "./lib/telegram.ts";
import { AppError, connection, errorMessage, input, json } from "./lib/telegram-core.ts";

const adminToken=process.env.ADMIN_API_TOKEN??"",encryptionKey=process.env.TOKEN_ENCRYPTION_KEY??"";
if(adminToken.length<32||!/^[a-f0-9]{64}$/.test(encryptionKey))throw new Error("Set ADMIN_API_TOKEN (at least 32 characters) and TOKEN_ENCRYPTION_KEY (64 lowercase hex characters).");
const host=process.env.HOST??"127.0.0.1",port=Number(process.env.PORT??8787),owner="publisher-owner";
if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid PORT.");
const origin=process.env.PUBLIC_ORIGIN??`http://127.0.0.1:${port}`;
const parsedOrigin=new URL(origin);
if(parsedOrigin.origin!==origin||!["http:","https:"].includes(parsedOrigin.protocol))throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash or path.");
const runtime=openRuntime(process.env.DATABASE_PATH??"./data/publisher.sqlite",encryptionKey);
function authenticated(value:string|undefined){
  const candidate=Buffer.from(value??""),expected=Buffer.from("Bearer "+adminToken);
  return candidate.length===expected.length&&timingSafeEqual(candidate,expected);
}
const server=createServer(async(incoming,outgoing)=>{
  try{
    if(!authenticated(incoming.headers.authorization)){outgoing.writeHead(401,{"Content-Type":"application/json"});outgoing.end('{"error":"Admin authorization required."}');return;}
    const path=incoming.url??"/";
    if(!path.startsWith("/")||path.startsWith("//"))throw new AppError("Invalid path.");
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of incoming){size+=chunk.length;if(size>90000)throw new AppError("Request too large.",413);chunks.push(chunk);}
    const headers=new Headers();
    // Incoming identity headers are never trusted. The validated admin credential owns this single-publisher instance.
    headers.set("oai-authenticated-user-id",owner);headers.set("oai-authenticated-user-email","owner@publisher.invalid");
    headers.set("content-type","application/json");
    if(incoming.headers.origin)headers.set("origin",incoming.headers.origin);
    else headers.set("origin",origin);
    if(incoming.headers["mcp-protocol-version"])headers.set("mcp-protocol-version",String(incoming.headers["mcp-protocol-version"]));
    const method=incoming.method??"GET",request=new Request(new URL(path,origin),{method,headers,...(["GET","HEAD"].includes(method)?{}:{body:Buffer.concat(chunks)})});
    let response:Response;
    if(new URL(request.url).pathname==="/mcp")response=await handleMcp(request,runtime.env);
    else if(new URL(request.url).pathname==="/api/publish"&&method==="POST"){
      if(headers.get("origin")!==origin)throw new AppError("Cross-origin writes are forbidden.",403);
      const body=await input(request,90000);
      if(Object.keys(body).some(key=>!["content_key","copies","include_owner"].includes(key)))throw new AppError("Unknown publish arguments.");
      response=json(await publishLesson(runtime.env,owner,body.content_key,body.copies as never,body.include_owner===true));
    }else{
      const match=/^\/api\/telegram\/([a-z-]+)$/.exec(new URL(request.url).pathname);
      response=match?await handleApi(request,runtime.env,match[1]):json({error:"Unknown route."},404);
    }
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){outgoing.writeHead(error instanceof AppError?error.status:503,{"Content-Type":"application/json"});outgoing.end(JSON.stringify({error:errorMessage(error)}));}
});
let polling=false;
const configured=Number(process.env.POLL_INTERVAL_MS??3000);
const pollMs=Number.isFinite(configured)?Math.max(1000,configured):3000;
const timer=setInterval(async()=>{
  if(polling)return;polling=true;
  try{if((await connection(runtime.env,owner))?.chat_id)await syncSubscribers(runtime.env,owner);}
  catch(error){if(!(error instanceof AppError&&error.status===409))process.stderr.write("Registration check failed; inspect connection status.\n");}
  finally{polling=false;}
},pollMs);
server.listen(port,host,()=>process.stdout.write(`Publisher listening on ${host}:${port}. Keep the process running for registrations.\n`));
let closing=false;
function stop(){if(closing)return;closing=true;clearInterval(timer);server.close(()=>{runtime.close();process.exit(0);});}
process.on("SIGTERM",stop);process.on("SIGINT",stop);
