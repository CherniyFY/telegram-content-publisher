import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Runtime } from "./lib/telegram-core.ts";

export function openRuntime(path:string,encryptionKey:string){
  const filename=resolve(path);mkdirSync(dirname(filename),{recursive:true,mode:0o700});
  const sql=new DatabaseSync(filename);sql.exec("PRAGMA journal_mode=WAL");
  sql.exec("CREATE TABLE IF NOT EXISTS _publisher_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)");
  for(const file of readdirSync(new URL("./drizzle/",import.meta.url)).filter(f=>f.endsWith(".sql")).sort()){
    const migration=readFileSync(new URL("./drizzle/"+file,import.meta.url),"utf8");
    const hash=createHash("sha256").update(migration).digest("hex");
    const applied=sql.prepare("SELECT hash FROM _publisher_migrations WHERE name=?").get(file) as {hash:string}|undefined;
    if(applied){if(applied.hash!==hash)throw new Error("An applied migration changed: "+file);continue;}
    sql.exec("BEGIN IMMEDIATE");
    try{sql.exec(migration);sql.prepare("INSERT INTO _publisher_migrations (name,hash) VALUES (?,?)").run(file,hash);sql.exec("COMMIT");}
    catch(error){sql.exec("ROLLBACK");throw error;}
  }
  const DB={
    prepare(query:string){
      const prepared=sql.prepare(query);let values:unknown[]=[];
      const execute=()=>{const result=prepared.run(...values as never[]);return {success:true,meta:{changes:Number(result.changes)}};};
      return {bind(...args:unknown[]){values=args;return this;},async first(){return prepared.get(...values as never[])??null;},async all(){return {success:true,results:prepared.all(...values as never[])};},async run(){return execute();},execute};
    },
    async batch(statements:{execute():unknown}[]){
      sql.exec("BEGIN IMMEDIATE");
      try{const results=statements.map(statement=>statement.execute());sql.exec("COMMIT");return results;}
      catch(error){sql.exec("ROLLBACK");throw error;}
    },
  };
  return {env:{DB:DB as unknown as D1Database,TOKEN_ENCRYPTION_KEY:encryptionKey} satisfies Runtime,close:()=>sql.close()};
}
