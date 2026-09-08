import { createServer } from "node:http";
let posts = [], auths = [], statuses = [];
let failFirst = true;
const srv = createServer((req,res)=>{
  let c=[]; req.on("data",x=>c.push(x));
  req.on("end",()=>{
    posts.push(Buffer.concat(c)); auths.push(req.headers.authorization ?? "(none)");
    if (failFirst) { failFirst = false; statuses.push(500); res.writeHead(500).end(); }
    else { statuses.push(200); res.writeHead(200).end(); }
  });
});
await new Promise(r=>srv.listen(0,"127.0.0.1",r));
process.env.PHOENIX_OTEL_ENDPOINT=`http://127.0.0.1:${srv.address().port}/v1/traces`;
process.env.PHOENIX_CAPTURE_CONTENT="0"; // metadata-only mode
process.env.PHOENIX_API_KEY="sk-test-123";
const {default:extension} = await import("./extensions/phoenix-otel.ts");
const handlers={}; const pi={on:(e,h)=>(handlers[e]??=[]).push(h),registerCommand:()=>{}};
extension(pi);
const ctx={cwd:"/tmp/demo-repo",hasUI:false,model:{provider:"anthropic",id:"m"},sessionManager:{getSessionId:()=>"s1",getSessionFile:()=>undefined}};
const fire=async(e,ev,c=ctx)=>{for(const h of handlers[e]??[])await h(ev,c);};
await fire("session_start",{reason:"new"});
await fire("input",{text:"SECRET-prompt-should-not-leak-XYZZY",images:[]});
await fire("before_agent_start",{prompt:"SECRET",systemPrompt:"SECRET-sys"});
await fire("before_provider_request",{payload:{temperature:0.9,messages:[{role:"user"}],tools:[{}]}});
await fire("agent_start",{});
await fire("turn_start",{turnIndex:0});
await fire("message_end",{message:{role:"assistant",model:"m",provider:"p",stopReason:"stop",content:[{type:"text",text:"SECRET-answer"}],usage:{input:1,output:1,totalTokens:2,cost:{total:0.5}}}});
await fire("turn_end",{});
await fire("agent_end",{});
await fire("session_shutdown",{},{hasUI:false});
srv.close();

const A=(c,m)=>{console.log(`${c?"ok":"FAIL"}: ${m}`); if(!c) process.exitCode=1;};
A(statuses.join(",")==="500,200,200,200", `retry after 500 then single-shot flushes (${statuses.join(",")})`);
A(auths[0]==="Bearer sk-test-123", "Authorization header sent");
A(auths[2]==="Bearer sk-test-123", "Authorization header on later flushes");

// decode spans, check attributes only (span names carry prompt preview by design)
function rv(b,o){let v=0n,s=0n;for(;;){v|=BigInt(b[o]&0x7f)<<s;if(!(b[o]&0x80))return[v,o+1];o++;s+=7n;}}
function flds(b){const out=[];let o=0;while(o<b.length){const[t,o1]=rv(b,o);const f=Number(t>>3n),w=Number(t&7n);let v;if(w===2){const[l,o2]=rv(b,o1);v=b.subarray(o2,o2+Number(l));o=o2+Number(l);}else if(w===0){const[x,o2]=rv(b,o1);v=x;o=o2;}else if(w===1){v=b.subarray(o1,o1+8);o=o1+8;}else if(w===5){v=b.subarray(o1,o1+4);o=o1+4;}else throw new Error("w"+w);out.push([f,w,v]);}return out;}
const attrsAll={};
for (const buf of posts) for (const[, ,rs] of flds(buf).filter(([f])=>f===1)) for (const[, ,ss] of flds(rs).filter(([f])=>f===2)) for (const[, ,sp] of flds(ss).filter(([f])=>f===2)) {
  let name; for (const[f,,v] of flds(sp)) {
    if (f===5) name=v.toString();
    if (f===9) { let k,val; for (const[kf,,kv] of flds(v)) { if(kf===1)k=kv.toString(); if(kf===2){ for(const[vf,,vv] of flds(kv)){ if(vf===1)val=vv.toString(); if(vf===3)val=Number(vv); if(vf===4)val=new DataView(vv.buffer,vv.byteOffset).getFloat64(0,true); if(vf===2)val=!!vv; } } } if (attrsAll[k]===undefined || name.startsWith("pi.run")) attrsAll[k]=val; } } }
A(attrsAll["input.value"]==="(redacted)", `input.value redacted (got ${JSON.stringify(attrsAll["input.value"])})`);
A(attrsAll["output.value"]==="", `output.value empty (got ${JSON.stringify(attrsAll["output.value"])})`);
A(!("tool.arguments" in attrsAll), "no tool.arguments attr");
A(!("gen_ai.prompt.system" in attrsAll), "no system prompt attr");
A(!("llm.invocation_parameters" in attrsAll), "no invocation params attr");
A(attrsAll["gen_ai.usage.cost"]===0.5, "metadata (cost) still captured");
A(!JSON.stringify(attrsAll).includes("SECRET"), "no SECRET in any attribute value");
