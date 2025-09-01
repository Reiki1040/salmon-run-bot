//外部APIURL(有志の非公式)
const API_BASE='https://spla3.yuu26.com/api';
//現在進行中のサーモンラン情報
const API_NOW_URL=`${API_BASE}/coop-grouping/now`;
//次に開始するサーモンラン情報
const API_NEXT_URL=`${API_BASE}/coop-grouping/next`;
//今後のスケジュール一覧
const API_SCHEDULE_URL=`${API_BASE}/coop-grouping/schedule`;

//スクリプトプロパティキー
const PROP_KEY_WEBHOOK='discordWebhookUrl'; //DiscordのWebhook URL
const PROP_KEY_USER_AGENT='userAgent'; //User-Agent
const PROP_KEY_LAST_START_TIME='lastShiftStart'; //直近に投稿済みのシフト開始時刻
const PROP_KEY_PRE_NOTIFIED_START_TIME='preNotifiedStart'; //直近に事前通知を実施したシフト開始時刻
const PROP_KEY_PRE_NOTIFY_MIN='preNotifyMin'; //事前通知を何分前に行うか(数値)
const PROP_KEY_AVATAR_URL='avatarUrl'; //Webhook送信者アイコンURL

//スクリプト設定
const DEFAULT_USER_AGENT='ReikiSalmonGAS/1.0'; //既定のUser-Agent
const LOCK_TIMEOUT_MS=15000; //LockService待機ミリ秒
const MS_PER_MINUTE=60000; //1分のミリ秒
const PRE_NOTIFY_TOLERANCE_MS=90*1000; //事前通知の±許容(90秒)
const RETRY_AFTER_MS_ON_PAST=60*1000; //nextが過去時刻だったときの保険再実行
const RETRY_AFTER_MS_ON_FETCH_FAIL=5*60*1000; //next取得失敗時の保険再試行
const DISCORD_EMBED_LIMIT=10; //Discordの1送信あたりEmbed上限

/*.  関数概要
bootstrap: 初回セットアップ用の関数。手動で一度だけ実行し、次回シフトに合わせたトリガーを作成
postShiftNow: 現在のシフト情報をDiscordに通知する。シフト開始時刻に実行
postShiftPre: 次のシフトの事前通知を行う。シフト開始N分前に実行
backupHourly: 毎時実行されるバックアップ関数。トリガーのズレや投稿漏れを補う
etNextTriggers: 次回シフトに合わせて関連トリガー(本通知/事前通知/バックアップ)を再設定
escheduleTriggersSafely: setNextTriggersをエラーを握りつぶして安全に呼び出すユーティリティ
fetchJson: 指定URLからJSONデータを取得する。リトライ機能付き
safeBody: ログ出力用に、レスポンス本文を安全な長さに切り詰め
getFirstResult: APIの標準形式{results:[...]}から先頭の結果を取得
postToDiscord: DiscordのWebhookへJSONペイロードをPOSTする。リトライ機能付き
getAvatarUrl: スクリプトプロパティから送信者アイコンURLを取得
buildShiftPayload: シフト情報からDiscord投稿用のペイロード(Embed)を生成
buildScheduleEmbedMain: スケジュール一覧の各行に相当する見出しEmbedを生成
postNextThreeShiftsWithWeapons: 直近3シフトのスケジュールを武器アイコン付きで投稿
debugResetLast: 重複投稿防止キーを削除し、次の本通知を強制可能にするデバッグ用関数
postShiftNowForce: debugResetLastの実行後、postShiftNowを即時実行するデバッグ用関数
dryRunNext: 次シフトの生JSONをログ出力し、API疎通を確認するデバッグ用関数
*/

function bootstrap(){ setNextTriggers(); }

function postShiftNow(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftNow)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK);
    if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    const currentShift=getFirstResult(fetchJson(API_NOW_URL,userAgent));
    if(!currentShift){ Logger.log('現在のシフト情報が見つかりませんでした'); rescheduleTriggersSafely(); return; }

    const lastPostedStartTime=props.getProperty(PROP_KEY_LAST_START_TIME);
    if(lastPostedStartTime===currentShift.start_time){
      Logger.log('このシフトは既に通知済み。スキップ:'+currentShift.start_time);
      rescheduleTriggersSafely(); return;
    }

    const payload=buildShiftPayload(currentShift,false);
    const code=postToDiscord(webhookUrl,payload);
    Logger.log('Discord投稿ステータス:'+code);
    if(code<200||code>=300)throw new Error('Discordへの投稿に失敗:'+code);

    props.setProperty(PROP_KEY_LAST_START_TIME,currentShift.start_time);
    setNextTriggers();
  }catch(e){
    Logger.log('postShiftNowエラー:'+e);
    rescheduleTriggersSafely();
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

function postShiftPre(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftPre)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);
    if(!preNotifyMinutes)return;
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)return;
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    const nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent));
    if(!nextShift){ Logger.log('事前通知対象なし'); return; }

    const startTimeMs=Date.parse(nextShift.start_time);
    const msToStart=startTimeMs-Date.now();
    const isWithinWindow=Math.abs(msToStart-preNotifyMinutes*MS_PER_MINUTE)<=PRE_NOTIFY_TOLERANCE_MS;
    const alreadyNotified=props.getProperty(PROP_KEY_PRE_NOTIFIED_START_TIME)===nextShift.start_time;

    if(isWithinWindow&&!alreadyNotified){
      const code=postToDiscord(webhookUrl,buildShiftPayload(nextShift,true));
      Logger.log('事前通知ステータス:'+code);
      props.setProperty(PROP_KEY_PRE_NOTIFIED_START_TIME,nextShift.start_time);
    }else{
      Logger.log('事前通知スキップ(時間外or既通知)');
    }
  }catch(e){
    Logger.log('postShiftPreエラー:'+e);
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

function backupHourly(){
  try{ postShiftNow(); }
  catch(e){ Logger.log('backupHourlyエラー:'+e); try{ setNextTriggers(); }catch(_){ } }
}

function setNextTriggers(){
  const targets=['postShiftNow','postShiftPre','backupHourly'];
  ScriptApp.getProjectTriggers().forEach(tr=>{ if(targets.includes(tr.getHandlerFunction()))ScriptApp.deleteTrigger(tr); });

  const props=PropertiesService.getScriptProperties();
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);

  let nextShift=null;
  try{ nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent)); }catch(e){ Logger.log('次回取得失敗:'+e); }

  const now=new Date();
  if(nextShift){
    const startTime=new Date(nextShift.start_time);
    if(startTime>now){
      ScriptApp.newTrigger('postShiftNow').timeBased().at(startTime).create();
      Logger.log('本通知トリガー:'+startTime.toISOString());
      if(preNotifyMinutes>0){
        const pre=new Date(startTime.getTime()-preNotifyMinutes*MS_PER_MINUTE);
        if(pre>now){ ScriptApp.newTrigger('postShiftPre').timeBased().at(pre).create(); Logger.log('事前通知トリガー:'+pre.toISOString()); }
        else{ Logger.log('事前通知時刻は過去'); }
      }
    }else{
      ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_PAST).create();
      Logger.log('過去時刻を掴んだため'+(RETRY_AFTER_MS_ON_PAST/1000)+'秒後に再試行');
    }
  }else{
    ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_FETCH_FAIL).create();
    Logger.log('次回取得不可。'+(RETRY_AFTER_MS_ON_FETCH_FAIL/60000)+'分後に再試行');
  }

  ScriptApp.newTrigger('backupHourly').timeBased().everyHours(1).create();
  Logger.log('バックアップ(毎時)設定完了');

  const ts=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction()+':'+t.getTriggerSource());
  Logger.log('現在のトリガー:'+JSON.stringify(ts));
}

function rescheduleTriggersSafely(){ try{ setNextTriggers(); }catch(e){ Logger.log('再設定中エラー:'+e); } }

function fetchJson(url,userAgent){
  const maxRetry=2;
  let lastErr=null;
  for(let i=0;i<=maxRetry;i++){
    try{
      const res=UrlFetchApp.fetch(url,{headers:{'User-Agent':userAgent,'Cache-Control':'no-cache'},muteHttpExceptions:true});
      const code=res.getResponseCode();
      Logger.log('Fetch:'+url+' Status:'+code+' Try:'+i);
      if(code===200)return JSON.parse(res.getContentText());
      if(code===429 || (code>=500 && code<=599)){ Utilities.sleep(800*(i+1)); continue; }
      throw new Error('Fetch失敗:'+code+' body:'+safeBody(res));
    }catch(e){
      lastErr=e; Utilities.sleep(500*(i+1));
    }
  }
  throw lastErr||new Error('Fetch失敗(原因不明)');
}

function safeBody(res){
  try{
    const t=res.getContentText();
    return (t&&t.length>200)?t.slice(0,200)+'...':t;
  }catch(_){ return ''; }
}

function getFirstResult(json){
  const results=json&&json.results;
  return Array.isArray(results)&&results.length?results[0]:null;
}

function postToDiscord(webhookUrl,payload){
  const maxRetry=2;
  let code=-1;
  for(let i=0;i<=maxRetry;i++){
    const res=UrlFetchApp.fetch(webhookUrl,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true});
    code=res.getResponseCode();
    Logger.log('Discord POST Status:'+code+' Try:'+i);
    if(code===204 || (code>=200 && code<300))return code;
    if(code===429){ Utilities.sleep(1500*(i+1)); continue; }
    if(code>=500 && code<=599){ Utilities.sleep(800*(i+1)); continue; }
    return code;
  }
  return code;
}

function getAvatarUrl(){
  const url=PropertiesService.getScriptProperties().getProperty(PROP_KEY_AVATAR_URL);
  return url&&url.trim()?url.trim():null;
}

function buildShiftPayload(shiftData,isPreNotification){
  const stageName=shiftData.stage?.name||'不明ステージ';
  const bossName=shiftData.boss?.name||'不明';
  const isBigRun=!!shiftData.is_big_run;
  const weapons=(shiftData.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));
  const start=new Date(shiftData.start_time);
  const end=new Date(shiftData.end_time);
  const startStr=Utilities.formatDate(start,'Asia/Tokyo','MM/dd HH:mm');
  const endStr=Utilities.formatDate(end,'Asia/Tokyo','MM/dd HH:mm');
  const title=isPreNotification?'サーモンラン 事前通知(まもなく開始)':(isBigRun?'サーモンラン(ビッグラン)':'サーモンラン');

  const mainEmbed={
    title:title,
    fields:[
      {name:'ステージ',value:stageName,inline:true},
      {name:'オカシラ',value:bossName,inline:true},
      {name:'期間(JST)',value:`${startStr} ～ ${endStr}`,inline:false},
      {name:'ブキ(一覧)',value:weapons.map(w=>'• '+w.name).join('\n')||'(不明)',inline:false}
    ],
    timestamp:shiftData.start_time
  };
  if(shiftData.stage?.image)mainEmbed.thumbnail={url:shiftData.stage.image};

  const weaponEmbeds=weapons.map(w=>({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}));
  const avatar=getAvatarUrl();
  return { username:'クマサン商会', ...(avatar?{avatar_url:avatar}:{}), embeds:[mainEmbed,...weaponEmbeds] };
}

function buildScheduleEmbedMain(shiftData,absoluteIndex){
  const stageName=shiftData?.stage?.name||'不明ステージ';
  const bossName=shiftData?.boss?.name||'不明';
  const start=new Date(shiftData.start_time);
  const end=new Date(shiftData.end_time);
  const startStr=Utilities.formatDate(start,'Asia/Tokyo','MM/dd HH:mm');
  const endStr=Utilities.formatDate(end,'Asia/Tokyo','MM/dd HH:mm');
  const title=`#${absoluteIndex+1} ${shiftData?.is_big_run?'ビッグラン':'サーモンラン'}`;

  const emb={
    title:title,
    fields:[
      {name:'ステージ',value:stageName,inline:true},
      {name:'オカシラ',value:bossName,inline:true},
      {name:'期間(JST)',value:`${startStr} ～ ${endStr}`,inline:false}
    ],
    timestamp:shiftData.start_time
  };
  if(shiftData?.stage?.image)emb.thumbnail={url:shiftData.stage.image};
  return emb;
}

function postNextThreeShiftsWithWeapons(){
  const props=PropertiesService.getScriptProperties();
  const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

  const scheduleData=fetchJson(API_SCHEDULE_URL,userAgent);
  const list=Array.isArray(scheduleData?.results)?scheduleData.results:[];
  if(list.length===0){ postToDiscord(webhookUrl,{content:'直近のサーモンラン予定取得失敗'}); return; }

  const head=list.slice(0,3);
  const embeds=[];
  head.forEach((shift,idx)=>{
    embeds.push(buildScheduleEmbedMain(shift,idx));
    const weapons=(shift?.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));
    weapons.forEach(w=>{ embeds.push({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}); });
  });

  const avatar=getAvatarUrl();
  for(let i=0;i<embeds.length;i+=DISCORD_EMBED_LIMIT){
    const chunk=embeds.slice(i,i+DISCORD_EMBED_LIMIT);
    postToDiscord(webhookUrl,{username:'クマサン商会',...(avatar?{avatar_url:avatar}:{}),content:(i===0?'直近3シフトのスケジュール':'(続き)'),embeds:chunk});
  }
}

function debugResetLast(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEY_LAST_START_TIME);
  Logger.log('プロパティ "'+PROP_KEY_LAST_START_TIME+'" を削除');
}

function postShiftNowForce(){ debugResetLast(); postShiftNow(); }

function dryRunNext(){
  const ua=PropertiesService.getScriptProperties().getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const next=getFirstResult(fetchJson(API_NEXT_URL,ua));
  Logger.log(JSON.stringify(next,null,2));
}