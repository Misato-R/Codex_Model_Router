import {mkdir,readFile,appendFile} from "node:fs/promises";
import {join} from "node:path";
import type {MemoryStore} from "./types.js";
export class FileMemory implements MemoryStore {
 private path(project:string){return join(project,".router-memory","history.md")}
 async read(project:string){try{return (await readFile(this.path(project),"utf8")).slice(-12000)}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return "";throw e}}
 async append(project:string,task:string,summary:string){const p=join(project,".router-memory");await mkdir(p,{recursive:true});await appendFile(this.path(project),`\n## ${new Date().toISOString()}\nTask: ${task.replaceAll("\n"," ")}\nResult: ${summary.replaceAll("\n"," ").slice(0,600)}\n`)}
}
