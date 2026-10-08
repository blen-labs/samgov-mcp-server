import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {opportunityInput,searchOpportunities,SamError} from '../src/opportunities.js';

const key=process.env.SAM_GOV_API_KEY;
if(!key)throw new Error('Set SAM_GOV_API_KEY securely in the environment; never pass it as a CLI argument.');
const format=(date:Date)=>`${String(date.getUTCMonth()+1).padStart(2,'0')}/${String(date.getUTCDate()).padStart(2,'0')}/${date.getUTCFullYear()}`;
const end=new Date(),start=new Date(end);start.setUTCDate(start.getUTCDate()-7);
const input=opportunityInput.parse({posted_from:process.env.SAM_TEST_POSTED_FROM??format(start),posted_to:process.env.SAM_TEST_POSTED_TO??format(end),limit:2});
await mkdir('.local',{recursive:true});
try{
 const first=await searchOpportunities(input,key);
 assert.ok(first.opportunities.length>0,'Live search must return at least one record to verify a real lookup.');
 let paginated=false;
 if(first.next_offset!==null){
  const second=await searchOpportunities({...input,offset:first.next_offset},key);
  const ids=new Set(first.opportunities.map(x=>x.noticeId));
  assert.ok(second.opportunities.length>0,'Next page unexpectedly empty.');
  assert.ok(second.opportunities.every(x=>!ids.has(x.noticeId)),'Pagination returned duplicate notices.');paginated=true;
 }
 const id=String(first.opportunities[0]!.noticeId);
 const detail=await searchOpportunities({...input,notice_id:id,limit:1},key);
 assert.equal(detail.opportunities[0]?.noticeId,id,'Notice-ID lookup must return the requested notice.');
 const evidence={verifiedAt:new Date().toISOString(),result:'PASS',endpoint:first.source,dateRange:first.date_range,total:first.total,paginationVerified:paginated,noticeIdVerified:id};
 await writeFile('.local/live-sam.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(evidence));
}catch(error){
 const evidence={verifiedAt:new Date().toISOString(),result:'FAIL',code:error instanceof SamError?error.code:'ASSERTION_FAILURE',message:error instanceof SamError?error.message:'Live acceptance did not satisfy the required checks.'};
 await writeFile('.local/live-sam.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 console.error(JSON.stringify(evidence));process.exitCode=1;
}
