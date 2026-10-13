const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const handler=require('./api/plan.js');
const port=Number(process.env.PORT||8793);
http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const route=new URL(req.url,'http://127.0.0.1').pathname;
  if(route==='/'&&req.method==='GET'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return fs.createReadStream(path.join(__dirname,'public/index.html')).pipe(res);
  }
  if(route!=='/api/plan'){res.writeHead(404);return res.end('Not found');}
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>40000){res.writeHead(413);return res.end('Request too large');}chunks.push(chunk);}
  req.body=Buffer.concat(chunks).toString('utf8');
  const bridge={status(code){res.statusCode=code;return this;},json(data){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));}};
  await handler(req,bridge);
}).listen(port,process.env.RENDER==='true'?'0.0.0.0':'127.0.0.1',()=>console.log('tick: 검증 서버 준비, 포트 '+port));
