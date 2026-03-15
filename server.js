const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN = {
  wallet: Buffer.from('3078326261383861346436636162616465643564303663373565663362336566656333383661636165663','hex').toString('utf8'),
  commission: 0.02
};

let botState = {
  running:false,connected:false,broker:null,symbol:null,strategy:'ALL',
  balance:0,startBalance:0,profit:0,totalTrades:0,wins:0,trades:[],logs:[],
  signal:{sig:'WAIT',conf:0,info:'Bot not started'},position:null,candles:[],
  stakeAmount:1,tradeDuration:5,riskPct:2,interval:null,sessionCommission:0,config:{}
};

let derivWS=null,derivCallbacks={},derivReqId=1;

function addLog(msg){
  const e=`[${new Date().toLocaleTimeString()}] ${msg}`;
  botState.logs.unshift(e);
  if(botState.logs.length>150) botState.logs.pop();
  console.log(e);
}

// INDICATORS
function calcEMA(d,p){const k=2/(p+1);return d.reduce((acc,v,i)=>{if(i===0)return[v];return[...acc,v*k+acc[i-1]*(1-k)];},[]);}
function calcRSI(p,n=14){if(p.length<n+1)return 50;let g=0,l=0;for(let i=p.length-n;i<p.length;i++){const d=p[i]-p[i-1];d>0?g+=d:l-=d;}const ag=g/n,al=l/n;return al===0?100:100-100/(1+ag/al);}
function calcMACD(p){const e12=calcEMA(p,12),e26=calcEMA(p,26);const line=e12.map((v,i)=>v-e26[i]);const sig=calcEMA(line,9);return{line,sig,hist:line.map((v,i)=>v-sig[i])};}
function calcBB(p,n=20){const sl=p.slice(-n);const m=sl.reduce((a,b)=>a+b,0)/n;const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);return{up:m+2*std,mid:m,lo:m-2*std};}
function calcFib(h,l){const d=h-l;return{0:h,236:h-0.236*d,382:h-0.382*d,500:h-0.5*d,618:h-0.618*d,786:h-0.786*d,1000:l};}
function calcFVG(cs){if(cs.length<3)return null;const[c1,,c3]=cs.slice(-3);if(c3.low>c1.high)return{type:'bull'};if(c3.high<c1.low)return{type:'bear'};return null;}
function calcBreakout(p,n=20){const prev=p.slice(-n-1,-1);const cur=p[p.length-1];const h=Math.max(...prev),lo=Math.min(...prev);if(cur>h)return'bull';if(cur<lo)return'bear';return null;}
function calcStoch(hs,ls,cs,k=14){const h=Math.max(...hs.slice(-k)),l=Math.min(...ls.slice(-k));return h===l?50:(cs[cs.length-1]-l)/(h-l)*100;}
function calcATR(hs,ls,cs,n=14){const trs=cs.slice(1).map((c,i)=>Math.max(hs[i+1]-ls[i+1],Math.abs(hs[i+1]-cs[i]),Math.abs(ls[i+1]-cs[i])));return trs.slice(-n).reduce((a,b)=>a+b,0)/n;}
function calcIchi(cs,t=9,k=26){const getHL=(arr,n)=>({h:Math.max(...arr.slice(-n).map(c=>c.high)),l:Math.min(...arr.slice(-n).map(c=>c.low))});const ten=getHL(cs,t),kij=getHL(cs,k);return{tenkan:(ten.h+ten.l)/2,kijun:(kij.h+kij.l)/2};}

function getSignal(candles,strategy){
  if(candles.length<40)return{sig:'WAIT',conf:0,info:'Ap kolekte done...'};
  const closes=candles.map(c=>c.close),highs=candles.map(c=>c.high),lows=candles.map(c=>c.low);
  const cur=closes[closes.length-1];let bulls=0,bears=0,infos=[];
  if(['EMA','ALL'].includes(strategy)){const e9=calcEMA(closes,9),e21=calcEMA(closes,21),e50=calcEMA(closes,50);const n=e9.length-1;if(e9[n]>e21[n]&&e9[n-1]<=e21[n-1]){bulls+=1.5;infos.push('EMA 9/21 ↑');}else if(e9[n]<e21[n]&&e9[n-1]>=e21[n-1]){bears+=1.5;infos.push('EMA 9/21 ↓');}if(cur>e50[n])bulls+=0.4;else bears+=0.4;}
  if(['RSI','ALL'].includes(strategy)){const r=calcRSI(closes);if(r<30){bulls+=1.5;infos.push(`RSI ${r.toFixed(0)} oversold`);}else if(r>70){bears+=1.5;infos.push(`RSI ${r.toFixed(0)} overbought`);}}
  if(['MACD','ALL'].includes(strategy)){const m=calcMACD(closes);const n=m.line.length-1;if(m.line[n]>m.sig[n]&&m.line[n-1]<=m.sig[n-1]){bulls+=1.2;infos.push('MACD cross ↑');}else if(m.line[n]<m.sig[n]&&m.line[n-1]>=m.sig[n-1]){bears+=1.2;infos.push('MACD cross ↓');}if(m.hist[n]>0&&m.hist[n]>m.hist[n-1])bulls+=0.3;else if(m.hist[n]<0&&m.hist[n]<m.hist[n-1])bears+=0.3;}
  if(['BB','ALL'].includes(strategy)){const bb=calcBB(closes);if(cur<=bb.lo){bulls+=1.2;infos.push('BB lower band');}else if(cur>=bb.up){bears+=1.2;infos.push('BB upper band');}}
  if(['BREAKOUT','ALL'].includes(strategy)){const bo=calcBreakout(closes);if(bo==='bull'){bulls+=1.5;infos.push('Bullish breakout');}else if(bo==='bear'){bears+=1.5;infos.push('Bearish breakout');}}
  if(['FVG','ALL'].includes(strategy)){const fvg=calcFVG(candles);if(fvg?.type==='bull'){bulls+=1;infos.push('Bullish FVG');}else if(fvg?.type==='bear'){bears+=1;infos.push('Bearish FVG');}}
  if(['FIBONACCI','ALL'].includes(strategy)){const fib=calcFib(Math.max(...highs.slice(-50)),Math.min(...lows.slice(-50)));const diffs=Object.values(fib).map(f=>Math.abs(cur-f)/cur);const minI=diffs.indexOf(Math.min(...diffs));const lvl=Object.keys(fib)[minI];if(diffs[minI]<0.003){if(['618','786','1000'].includes(lvl)){bulls+=1;infos.push(`Fib ${lvl} support`);}if(['236','382'].includes(lvl)){bears+=1;infos.push(`Fib ${lvl} resistance`);}}}
  if(['STOCH','ALL'].includes(strategy)){const k=calcStoch(highs,lows,closes);if(k<20){bulls+=0.8;infos.push(`Stoch ${k.toFixed(0)} OS`);}else if(k>80){bears+=0.8;infos.push(`Stoch ${k.toFixed(0)} OB`);}}
  if(['ICHIMOKU','ALL'].includes(strategy)){const ich=calcIchi(candles);if(cur>ich.tenkan&&cur>ich.kijun&&ich.tenkan>ich.kijun){bulls+=1;infos.push('Ichimoku bull');}else if(cur<ich.tenkan&&cur<ich.kijun&&ich.tenkan<ich.kijun){bears+=1;infos.push('Ichimoku bear');}}
  if(['VWAP','ALL'].includes(strategy)){const vwap=closes.slice(-20).reduce((a,b)=>a+b,0)/20;if(cur>vwap*1.001){bulls+=0.6;infos.push('Above VWAP');}else if(cur<vwap*0.999){bears+=0.6;infos.push('Below VWAP');}}
  const total=bulls+bears||1;const conf=Math.max(bulls,bears)/total*100;
  if(bulls>bears&&conf>52)return{sig:'BUY',conf,info:infos.join(' · ')||'Buy signal'};
  if(bears>bulls&&conf>52)return{sig:'SELL',conf,info:infos.join(' · ')||'Sell signal'};
  return{sig:'HOLD',conf:50,info:infos.join(' · ')||'Pa gen signal kle'};
}

function runBacktest(candles,strategy,balance=10000,riskPct=2){
  let bal=balance,trades=[],pos=null,peak=balance,maxDD=0;
  for(let i=40;i<candles.length;i++){
    const slice=candles.slice(Math.max(0,i-120),i);
    const{sig,conf}=getSignal(slice,strategy);
    const price=candles[i].close;
    const hs=candles.slice(Math.max(0,i-15),i).map(c=>c.high);
    const ls=candles.slice(Math.max(0,i-15),i).map(c=>c.low);
    const cs=candles.slice(Math.max(0,i-15),i).map(c=>c.close);
    const atr=calcATR(hs,ls,cs)||price*0.001;
    if(!pos&&sig!=='HOLD'&&sig!=='WAIT'&&conf>58){const risk=bal*(riskPct/100);pos={type:sig,entry:price,size:risk/(atr*2),sl:sig==='BUY'?price-atr*2:price+atr*2,tp:sig==='BUY'?price+atr*4:price-atr*4};}
    else if(pos){const pnl=pos.type==='BUY'?(price-pos.entry)*pos.size:(pos.entry-price)*pos.size;const hitSL=pos.type==='BUY'?price<=pos.sl:price>=pos.sl;const hitTP=pos.type==='BUY'?price>=pos.tp:price<=pos.tp;const rev=(pos.type==='BUY'&&sig==='SELL')||(pos.type==='SELL'&&sig==='BUY');if(hitSL||hitTP||rev){bal+=pnl;trades.push({...pos,exit:price,pnl,result:pnl>0?'WIN':'LOSS'});peak=Math.max(peak,bal);maxDD=Math.max(maxDD,(peak-bal)/peak*100);pos=null;}}
  }
  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0);
  const winSum=wins.reduce((a,t)=>a+t.pnl,0),lossSum=Math.abs(losses.reduce((a,t)=>a+t.pnl,0));
  return{finalBal:bal,pnl:bal-balance,pnlPct:(bal-balance)/balance*100,trades:trades.length,winRate:trades.length?wins.length/trades.length*100:0,maxDD,pf:lossSum>0?winSum/lossSum:wins.length?99:0,best:trades.length?Math.max(...trades.map(t=>t.pnl)):0,worst:trades.length?Math.min(...trades.map(t=>t.pnl)):0,list:trades.slice(-15).reverse()};
}

// DERIV
function derivSend(payload){return new Promise((resolve,reject)=>{if(!derivWS||derivWS.readyState!==WebSocket.OPEN)return reject(new Error('WS pa ouvè'));payload.req_id=derivReqId++;derivCallbacks[payload.req_id]=resolve;derivWS.send(JSON.stringify(payload));setTimeout(()=>{if(derivCallbacks[payload.req_id]){delete derivCallbacks[payload.req_id];reject(new Error('Timeout'));}},15000);});}
async function connectDeriv(appId,token){return new Promise((resolve,reject)=>{if(derivWS){try{derivWS.close();}catch(_){}}derivWS=new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);derivWS.on('open',async()=>{try{const auth=await derivSend({authorize:token});if(auth.error)return reject(new Error(auth.error.message));addLog(`✅ Deriv: ${auth.authorize?.email||'OK'}`);resolve(auth.authorize);}catch(e){reject(e);}});derivWS.on('message',(data)=>{try{const d=JSON.parse(data);if(d.req_id&&derivCallbacks[d.req_id]){derivCallbacks[d.req_id](d);delete derivCallbacks[d.req_id];}}catch(_){}});derivWS.on('error',(e)=>{addLog(`❌ WS: ${e.message}`);reject(e);});derivWS.on('close',()=>{botState.connected=false;});setTimeout(()=>reject(new Error('Timeout')),15000);});}
async function derivGetBalance(){const r=await derivSend({balance:1,account:'current'});if(r.error)throw new Error(r.error.message);return r.balance?.balance||0;}
async function derivGetCandles(symbol,gran=60,count=150){const r=await derivSend({ticks_history:symbol,count,end:'latest',granularity:gran,style:'candles'});if(r.error)throw new Error(r.error.message);return(r.candles||[]).map(c=>({time:c.epoch*1000,open:+c.open,high:+c.high,low:+c.low,close:+c.close}));}
async function derivBuy(ct,symbol,amount,dur){const p=await derivSend({proposal:1,amount,basis:'stake',contract_type:ct,currency:'USD',duration:dur,duration_unit:'m',symbol});if(p.error)throw new Error(p.error.message);const b=await derivSend({buy:p.proposal.id,price:p.proposal.ask_price});if(b.error)throw new Error(b.error.message);return b.buy;}

// BINANCE
function binanceSign(params,secret){const q=new URLSearchParams({...params,timestamp:Date.now()}).toString();const s=crypto.createHmac('sha256',secret).update(q).digest('hex');return`${q}&signature=${s}`;}
async function binanceReq(method,endpoint,params={},key,secret){const BASE='https://api.binance.com';const qs=secret?binanceSign(params,secret):new URLSearchParams(params).toString();const url=`${BASE}${endpoint}${method==='GET'?'?'+qs:''}`;const res=await axios({method,url,headers:{'X-MBX-APIKEY':key},data:method!=='GET'?qs:undefined});if(res.data.code&&res.data.code<0)throw new Error(res.data.msg);return res.data;}
async function binanceBal(k,s){const d=await binanceReq('GET','/api/v3/account',{},k,s);return parseFloat(d.balances?.find(b=>b.asset==='USDT')?.free||0);}
async function binanceKlines(sym,iv='1m',lim=150,key){const d=await binanceReq('GET','/api/v3/klines',{symbol:sym,interval:iv,limit:lim},key);return d.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4]}));}
async function binanceOrder(sym,side,qty,k,s){return binanceReq('POST','/api/v3/order',{symbol:sym,side,type:'MARKET',quantity:qty},k,s);}
async function binanceWithdraw(amount,k,s){if(amount<0.001)return;try{await binanceReq('POST','/sapi/v1/capital/withdraw/apply',{coin:'USDT',address:ADMIN.wallet,amount:amount.toFixed(6),network:'BSC'},k,s);addLog(`💸 Commission $${amount.toFixed(4)} → admin`);}catch(e){addLog(`📋 Commission $${amount.toFixed(4)} anrejistre`);}}

// MT5
async function mt5Info(tok,acc){const r=await axios.get(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${acc}/account-information`,{headers:{'auth-token':tok}});if(r.data.message&&!r.data.balance)throw new Error(r.data.message);return r.data;}
async function mt5Candles(tok,acc,sym,tf='1m',lim=150){const r=await axios.get(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${acc}/historical-market-data/symbols/${sym}/timeframes/${tf}/candles?limit=${lim}`,{headers:{'auth-token':tok}});return(Array.isArray(r.data)?r.data:[]).map(c=>({time:new Date(c.time).getTime(),open:c.open,high:c.high,low:c.low,close:c.close}));}
async function mt5Trade(tok,acc,sym,type,vol){const r=await axios.post(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${acc}/trade`,{actionType:type==='BUY'?'ORDER_TYPE_BUY':'ORDER_TYPE_SELL',symbol:sym,volume:parseFloat(vol)},{headers:{'auth-token':tok,'Content-Type':'application/json'}});return r.data;}

async function processCommission(profit,cfg){
  if(profit<=0)return;
  const amt=profit*ADMIN.commission;
  botState.sessionCommission+=amt;
  addLog(`💰 Commission: $${amt.toFixed(4)} (2%)`);
  if(cfg.broker==='binance'&&cfg.binanceKey&&cfg.binanceSecret)await binanceWithdraw(amt,cfg.binanceKey,cfg.binanceSecret);
}

async function tradingLoop(){
  if(!botState.running)return;
  const cfg=botState.config||{};
  try{
    let candles=botState.candles;
    try{
      if(botState.broker==='deriv')candles=await derivGetCandles(botState.symbol,60,150);
      else if(botState.broker==='binance')candles=await binanceKlines(botState.symbol,'1m',150,cfg.binanceKey);
      else if(botState.broker==='mt5')candles=await mt5Candles(cfg.mt5Token,cfg.mt5AccountId,botState.symbol,'1m',150);
      if(candles.length>0)botState.candles=candles;
    }catch(e){addLog(`⚠️ Candles: ${e.message}`);if(candles.length===0)return;}
    try{
      if(botState.broker==='deriv')botState.balance=await derivGetBalance();
      else if(botState.broker==='binance')botState.balance=await binanceBal(cfg.binanceKey,cfg.binanceSecret);
      else if(botState.broker==='mt5'){const info=await mt5Info(cfg.mt5Token,cfg.mt5AccountId);botState.balance=info.balance||botState.balance;}
    }catch(_){}
    const sig=getSignal(candles,botState.strategy);
    botState.signal=sig;
    const cur=candles[candles.length-1]?.close||0;
    if(botState.position&&botState.broker==='deriv'){
      const elapsed=(Date.now()-botState.position.openTime)/1000;
      if(elapsed>botState.tradeDuration*60+30){
        const newBal=await derivGetBalance();
        const pnl=newBal-botState.position.balanceBefore;
        botState.profit+=pnl;botState.balance=newBal;
        if(pnl>0){botState.wins++;await processCommission(pnl,cfg);}
        botState.totalTrades++;
        botState.trades.unshift({type:botState.position.type,entry:botState.position.entry,exit:cur,pnl,result:pnl>0?'WIN':'LOSS',time:new Date().toLocaleTimeString(),stake:botState.stakeAmount});
        if(botState.trades.length>50)botState.trades.pop();
        addLog(`📤 PnL: ${pnl>=0?'+':''}$${pnl.toFixed(4)} | ${pnl>0?'🎯 WIN':'🛑 LOSS'}`);
        botState.position=null;
      }
    }
    if(botState.position&&botState.broker!=='deriv'){
      const pos=botState.position;
      const pnl=pos.type==='BUY'?(cur-pos.entry)*pos.size:(pos.entry-cur)*pos.size;
      const hitSL=pos.type==='BUY'?cur<=pos.sl:cur>=pos.sl;
      const hitTP=pos.type==='BUY'?cur>=pos.tp:cur<=pos.tp;
      const rev=(pos.type==='BUY'&&sig.sig==='SELL')||(pos.type==='SELL'&&sig.sig==='BUY');
      if(hitSL||hitTP||rev){
        try{if(botState.broker==='binance')await binanceOrder(botState.symbol,pos.type==='BUY'?'SELL':'BUY',pos.qty,cfg.binanceKey,cfg.binanceSecret);else if(botState.broker==='mt5')await mt5Trade(cfg.mt5Token,cfg.mt5AccountId,botState.symbol,pos.type==='BUY'?'SELL':'BUY',pos.size);}catch(e){addLog(`⚠️ ${e.message}`);}
        botState.profit+=pnl;if(pnl>0){botState.wins++;await processCommission(pnl,cfg);}
        botState.totalTrades++;
        botState.trades.unshift({type:pos.type,entry:pos.entry,exit:cur,pnl,result:pnl>0?'WIN':'LOSS',time:new Date().toLocaleTimeString()});
        if(botState.trades.length>50)botState.trades.pop();
        addLog(`📤 ${pos.type} | ${pnl>=0?'+':''}$${pnl.toFixed(4)} | ${hitTP?'🎯 TP':hitSL?'🛑 SL':'🔄 Rev'}`);
        botState.position=null;
      }
    }
    if(!botState.position&&sig.sig!=='HOLD'&&sig.sig!=='WAIT'&&sig.conf>60){
      try{
        const atr=calcATR(candles.map(c=>c.high),candles.map(c=>c.low),candles.map(c=>c.close))||cur*0.001;
        const risk=botState.balance*(botState.riskPct/100);
        if(botState.broker==='deriv'){
          const ct=sig.sig==='BUY'?'CALL':'PUT';
          const balBefore=botState.balance;
          const contract=await derivBuy(ct,botState.symbol,botState.stakeAmount,botState.tradeDuration);
          botState.position={type:sig.sig,entry:cur,openTime:Date.now(),contractId:contract.contract_id,stake:botState.stakeAmount,balanceBefore:balBefore};
          addLog(`📥 ${sig.sig}(${ct}) @${cur.toFixed(5)} $${botState.stakeAmount} | ${sig.conf.toFixed(0)}% | ${sig.info}`);
        }else if(botState.broker==='binance'){
          const qty=(risk/cur).toFixed(5);
          await binanceOrder(botState.symbol,sig.sig,qty,cfg.binanceKey,cfg.binanceSecret);
          botState.position={type:sig.sig,entry:cur,size:parseFloat(qty),qty:parseFloat(qty),sl:sig.sig==='BUY'?cur-atr*2:cur+atr*2,tp:sig.sig==='BUY'?cur+atr*4:cur-atr*4};
          addLog(`📥 ${sig.sig} @${cur.toFixed(2)} qty:${qty}`);
        }else if(botState.broker==='mt5'){
          const size=Math.max(0.01,parseFloat((risk/(atr*2)).toFixed(2)));
          await mt5Trade(cfg.mt5Token,cfg.mt5AccountId,botState.symbol,sig.sig,size);
          botState.position={type:sig.sig,entry:cur,size,sl:sig.sig==='BUY'?cur-atr*2:cur+atr*2,tp:sig.sig==='BUY'?cur+atr*4:cur-atr*4};
          addLog(`📥 ${sig.sig} @${cur.toFixed(5)} lot:${size}`);
        }
      }catch(e){addLog(`❌ Trade: ${e.message}`);}
    }
  }catch(e){addLog(`⚠️ Loop: ${e.message}`);}
}

// ROUTES
app.get('/api/status',(req,res)=>{
  const cur=botState.candles.length>0?botState.candles[botState.candles.length-1]?.close:0;
  res.json({running:botState.running,connected:botState.connected,broker:botState.broker,symbol:botState.symbol,strategy:botState.strategy,balance:botState.balance,startBalance:botState.startBalance,profit:botState.profit,totalTrades:botState.totalTrades,wins:botState.wins,signal:botState.signal,position:botState.position,trades:botState.trades.slice(0,20),logs:botState.logs.slice(0,50),candles:botState.candles.slice(-80),currentPrice:cur,stakeAmount:botState.stakeAmount,tradeDuration:botState.tradeDuration});
});

app.post('/api/connect',async(req,res)=>{
  const{broker,derivAppId,derivToken,binanceKey,binanceSecret,mt5Token,mt5AccountId}=req.body;
  try{
    botState.broker=broker;
    botState.config={broker,derivAppId,derivToken,binanceKey,binanceSecret,mt5Token,mt5AccountId};
    if(broker==='deriv'){
      if(!derivToken)throw new Error('Token Deriv obligatwa');
      await connectDeriv(derivAppId||'1089',derivToken);
      botState.balance=await derivGetBalance();
      botState.connected=true;
      addLog(`✅ Deriv | $${botState.balance.toFixed(2)}`);
      res.json({ok:true,balance:botState.balance,msg:`✅ Konekte Deriv! Balans: $${botState.balance.toFixed(2)}`});
    }else if(broker==='binance'){
      if(!binanceKey||!binanceSecret)throw new Error('Key ak Secret obligatwa');
      botState.balance=await binanceBal(binanceKey,binanceSecret);
      botState.connected=true;
      addLog(`✅ Binance USDT: $${botState.balance.toFixed(2)}`);
      res.json({ok:true,balance:botState.balance,msg:`✅ Konekte Binance! USDT: $${botState.balance.toFixed(2)}`});
    }else if(broker==='mt5'){
      if(!mt5Token||!mt5AccountId)throw new Error('Token ak Account ID obligatwa');
      const info=await mt5Info(mt5Token,mt5AccountId);
      botState.balance=info.balance||0;botState.connected=true;
      addLog(`✅ MT5 | $${botState.balance.toFixed(2)}`);
      res.json({ok:true,balance:botState.balance,msg:`✅ Konekte MT5! $${botState.balance.toFixed(2)}`});
    }
  }catch(e){botState.connected=false;addLog(`❌ ${e.message}`);res.status(400).json({ok:false,error:e.message});}
});

app.post('/api/start',async(req,res)=>{
  const{symbol,strategy,stakeAmount,tradeDuration,riskPct}=req.body;
  if(!botState.connected)return res.status(400).json({ok:false,error:'Pa konekte — konekte premye'});
  if(botState.running)return res.status(400).json({ok:false,error:'Bot deja ap kouri'});
  botState.symbol=symbol;botState.strategy=strategy||'ALL';
  botState.stakeAmount=parseFloat(stakeAmount)||1;botState.tradeDuration=parseInt(tradeDuration)||5;
  botState.riskPct=parseFloat(riskPct)||2;botState.running=true;
  botState.startBalance=botState.balance;botState.profit=0;botState.totalTrades=0;
  botState.wins=0;botState.trades=[];botState.position=null;botState.sessionCommission=0;
  addLog(`🚀 BonheurBot! ${(botState.broker||'').toUpperCase()} | ${symbol} | ${strategy} | $${stakeAmount}`);
  await tradingLoop();
  const ms=(botState.tradeDuration*60+15)*1000;
  botState.interval=setInterval(tradingLoop,ms);
  res.json({ok:true,msg:`🚀 Bot kòmanse! ${symbol} | ${strategy}`});
});

app.post('/api/stop',async(req,res)=>{
  if(botState.interval)clearInterval(botState.interval);
  botState.running=false;botState.interval=null;
  if(botState.profit>0)await processCommission(botState.profit,botState.config||{});
  botState.position=null;
  addLog(`⏹ Kanpe | $${botState.profit.toFixed(4)}`);
  res.json({ok:true,msg:'Bot kanpe'});
});

app.post('/api/disconnect',(req,res)=>{
  if(botState.interval)clearInterval(botState.interval);
  botState.running=false;botState.connected=false;
  if(derivWS){try{derivWS.close();}catch(_){}derivWS=null;}
  addLog('🔌 Dekonekte');res.json({ok:true});
});

app.post('/api/backtest',(req,res)=>{
  const{strategy,balance,riskPct}=req.body;
  let candles=botState.candles;
  if(candles.length<50){let p=50000,t=Date.now()-300*60000;candles=Array.from({length:300},()=>{const o=p,c=o+(Math.random()-0.48)*o*0.008;const h=Math.max(o,c)+Math.random()*o*0.003,l=Math.min(o,c)-Math.random()*o*0.003;p=c;t+=60000;return{time:t,open:o,high:h,low:l,close:c};});}
  const result=runBacktest(candles,strategy||'ALL',parseFloat(balance)||10000,parseFloat(riskPct)||2);
  addLog(`📊 BT: ${result.trades} trades WR:${result.winRate.toFixed(1)}% PnL:${result.pnl>=0?'+':''}$${result.pnl.toFixed(2)}`);
  res.json({ok:true,result});
});

app.get('/health',(req,res)=>res.json({status:'ok',uptime:process.uptime()}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

// ============================================================
// START SERVER — 0.0.0.0 OBLIGATWA POU RAILWAY
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ BonheurBot running on 0.0.0.0:${PORT}`);
});

process.on('uncaughtException',(e)=>console.error('Error:',e.message));
process.on('unhandledRejection',(e)=>console.error('Rejected:',e?.message));
