export const UUID_RE: RegExp;
export type EnvMap=Record<string,string|undefined>;
export type AgentRef={options?:{neoTaskId?:unknown;neoRunToken?:unknown};parent?:{options?:{neoTaskId?:unknown;neoRunToken?:unknown}}};
export function resolveTaskId(arg?:string,env?:EnvMap,agent?:AgentRef):string|undefined;
export function requireTaskId(arg?:string,env?:EnvMap,agent?:AgentRef):string;
export function taskHeaders(env?:EnvMap,agent?:AgentRef):Record<string,string>;
export function controlUrl(env?:EnvMap,override?:string):string;
export function readJson(fetchImpl:any,url:string,init?:any):Promise<{status:number;body:any}>;
export function ensureRunIdentity(env?:EnvMap,agent?:any,fetchImpl?:any,signal?:AbortSignal):Promise<{id:string;run_token:string}>;
