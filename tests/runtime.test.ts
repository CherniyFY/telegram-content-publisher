import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { openRuntime } from "../runtime.ts";

test("standalone SQLite applies migrations once and keeps durable state",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"publisher-test-"));
  try{
    const path=join(directory,"publisher.sqlite"),first=openRuntime(path,"ab".repeat(32));
    await first.env.DB!.prepare("INSERT INTO telegram_connections (user_id,token_cipher,bot_username,bot_name,updated_at) VALUES (?,?,?,?,?)").bind("fixture","encrypted-fixture","fixture_bot","Fixture",new Date().toISOString()).run();
    first.close();
    const second=openRuntime(path,"ab".repeat(32));
    assert.equal((await second.env.DB!.prepare("SELECT bot_username FROM telegram_connections WHERE user_id=?").bind("fixture").first<{bot_username:string}>())?.bot_username,"fixture_bot");
    second.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test("standalone HTTP requires admin auth and rejects cross-origin writes",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"publisher-http-"));
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,"127.0.0.1",resolve));
  const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  const token="synthetic-test-admin-token-1234567890";
  const child=spawn(process.execPath,["server.ts"],{cwd:new URL("../",import.meta.url),env:{...process.env,ADMIN_API_TOKEN:token,TOKEN_ENCRYPTION_KEY:"ab".repeat(32),DATABASE_PATH:join(directory,"state.sqlite"),HOST:"127.0.0.1",PORT:String(port),PUBLIC_ORIGIN:`http://127.0.0.1:${port}`,POLL_INTERVAL_MS:"3000"},stdio:["ignore","pipe","pipe"]});
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Server startup timed out")),8000);child.stdout.on("data",()=>{clearTimeout(timer);resolve();});child.once("exit",()=>{clearTimeout(timer);reject(new Error("Server exited early"));});});
    const origin=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(origin+"/api/telegram/status")).status,401);
    const headers={Authorization:"Bearer "+token,"Content-Type":"application/json"};
    const response=await fetch(origin+"/api/telegram/status",{headers:{...headers,"oai-authenticated-user-id":"forged-user"}});
    assert.equal(response.status,200);assert.equal((await response.json() as {botSaved:boolean}).botSaved,false);
    assert.equal((await fetch(origin+"/api/telegram/disconnect",{method:"POST",headers:{...headers,Origin:"https://evil.invalid"},body:"{}"})).status,403);
    const discovery=await fetch(origin+"/mcp",{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
    assert.equal(discovery.status,200);assert.equal((await discovery.json() as {result:{tools:unknown[]}}).result.tools.length,5);
  }finally{
    child.kill("SIGTERM");await new Promise<void>(resolve=>child.once("exit",()=>resolve()));rmSync(directory,{recursive:true,force:true});
  }
});
