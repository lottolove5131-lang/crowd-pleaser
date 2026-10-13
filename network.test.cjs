const {test}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('./api/plan.js');
function responseCollector(){let status=200;let body;return{status(x){status=x;return this;},json(x){body=x;},get value(){return{status,body};}};}
test('real orchestration retries rate limit and labels explanation fallback',{timeout:60000},async()=>{
  console.log('tick: 네트워크 대체경로·호출제한 회귀 검증');
  const original=global.fetch;
  const previousQloo=process.env.QLOO_API_KEY,previousGemini=process.env.GEMINI_API_KEY;
  process.env.QLOO_API_KEY='unit-test-only';process.env.GEMINI_API_KEY='unit-test-only';
  let calls=0;let blocked=false;
  global.fetch=async(url,options)=>{
    assert.ok(options.signal);
    if(String(url).includes('googleapis.com'))return new Response('{}',{status:503});
    assert.equal(options.headers['X-Api-Key'],'unit-test-only');calls++;
    if(!blocked){blocked=true;return new Response('{}',{status:429,headers:{'Retry-After':'1'}});}
    const parsed=new URL(url);
    if(parsed.pathname==='/search')return Response.json({results:[{entity_id:parsed.searchParams.get('query'),name:parsed.searchParams.get('query'),types:['urn:entity:artist']}]});
    const ids=parsed.searchParams.get('signal.interests.entities');
    const candidates=ids==='B'?[{entity_id:'two',name:'Second'},{entity_id:'one',name:'First'}]:[{entity_id:'one',name:'First'},{entity_id:'two',name:'Second'}];
    return Response.json({results:{entities:candidates}});
  };
  try{
    const res=responseCollector();
    const work=handler({method:'POST',body:{city:'Test City',friends:[{name:'A',favorites:['A']},{name:'B',favorites:['B']}]}},res);
    await new Promise(resolve=>setImmediate(resolve));
    const duplicate=responseCollector();await handler({method:'POST',body:{}},duplicate);
    assert.equal(duplicate.value.status,429);
    await work;
    assert.equal(res.value.status,200);assert.ok(blocked);assert.equal(calls,12);
    assert.equal(res.value.body.explanationSource,'ranking-template');
    assert.deepEqual(res.value.body.picks.dinner[0].scores,[1,.5]);
    assert.equal(res.value.body.scoreMeaning,'relative-rank');
  }finally{global.fetch=original;if(previousQloo===undefined)delete process.env.QLOO_API_KEY;else process.env.QLOO_API_KEY=previousQloo;if(previousGemini===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previousGemini;}
});
test('upstream timeout does not leak secret error text',async()=>{
  const original=global.fetch;const old=process.env.QLOO_API_KEY;process.env.QLOO_API_KEY='unit-test-only';
  global.fetch=async()=>{throw new DOMException('private secret must not be reflected','TimeoutError');};
  try{const res=responseCollector();await handler({method:'POST',body:{city:'Test City',friends:[{name:'A',favorites:['A']},{name:'B',favorites:['B']}]}},res);assert.equal(res.value.status,502);assert.doesNotMatch(res.value.body.error,/private|secret/);}finally{global.fetch=original;if(old===undefined)delete process.env.QLOO_API_KEY;else process.env.QLOO_API_KEY=old;}
});
