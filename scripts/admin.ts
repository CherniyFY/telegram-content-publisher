import { readFileSync } from "node:fs";
const [action,...args]=process.argv.slice(2);
const token=process.env.ADMIN_API_TOKEN??"";
const origin=process.env.ADMIN_URL??`http://127.0.0.1:${process.env.PORT??8787}`;
const url=new URL(origin);
if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw new Error("Use HTTPS for a remote admin endpoint.");
if(!token)throw new Error("Set ADMIN_API_TOKEN in .env.");
let route="/api/telegram/"+action,body:unknown={},method="POST";
if(action==="status")method="GET";
else if(action==="save")body=JSON.parse(readFileSync(0,"utf8"));
else if(action==="invite")body={label:args[0]??"Guest",language:args[1]??"ru"};
else if(action==="test"){route="/api/telegram/subscriber-test";body={id:args[0]};}
else if(["pause","resume","remove"].includes(action)){route="/api/telegram/subscription";body={id:args[0],status:{pause:"paused",resume:"active",remove:"revoked"}[action]};}
else if(action==="revoke"){route="/api/telegram/revoke-invite";body={id:args[0]};}
else if(action==="publish"){if(!args[0])throw new Error("Provide the content JSON filename.");route="/api/publish";body=JSON.parse(readFileSync(args[0],"utf8"));}
else if(!["pair","sync"].includes(action))throw new Error("Actions: status, save, pair, invite LABEL [ru|en|pt], sync, test ID, pause ID, resume ID, remove ID, revoke ID, publish FILE.");
const response=await fetch(new URL(route,origin),{method,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},...(method==="GET"?{}:{body:JSON.stringify(body)})});
const result=await response.json();process.stdout.write(JSON.stringify(result,null,2)+"\n");
if(!response.ok||(action==="publish"&&(result as {allSent?:boolean}).allSent!==true))process.exitCode=1;
