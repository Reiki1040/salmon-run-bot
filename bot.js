//外部APIのベースURL
const API_BASE='https://spla3.yuu26.com/api';  //怖いのはここかなぁ？？
//現在進行中のサーモンラン情報
const API_NOW_URL=`${API_BASE}/coop-grouping/now`;
//次に開始するサーモンラン情報
const API_NEXT_URL=`${API_BASE}/coop-grouping/next`;
//今後のスケジュール一覧
const API_SCHEDULE_URL=`${API_BASE}/coop-grouping/schedule`;

//---スクリプトプロパティキー---
//DiscordのWebhook URL
const PROP_KEY_WEBHOOK='discordWebhookUrl';
//User-Agent
const PROP_KEY_USER_AGENT='userAgent';
//直近に投稿済みのシフト開始時刻
const PROP_KEY_LAST_START_TIME='lastShiftStart';
//直近に事前通知を実施したシフト開始時刻
const PROP_KEY_PRE_NOTIFIED_START_TIME='preNotifiedStart';
//事前通知を何分前に行うか(数値)
const PROP_KEY_PRE_NOTIFY_MIN='preNotifyMin';
//Webhook送信者アイコンURL
const PROP_KEY_AVATAR_URL='avatarUrl';

//---スクリプト設定---
//既定のUser-Agent
const DEFAULT_USER_AGENT='ReikiSalmonGAS/1.0';
//ロック取得の最大待機時間(ms)
const LOCK_TIMEOUT_MS=15000; //コメント:LockService待機ミリ秒
//1分をmsに
const MS_PER_MINUTE=60000; //コメント:1分のミリ秒
//事前通知の許容誤差(±秒→ms)
const PRE_NOTIFY_TOLERANCE_MS=90*1000; //コメント:事前通知の±許容(90秒)
//nextが過去だった場合の保険再実行ディレイ(ms)
const RETRY_AFTER_MS_ON_PAST=60*1000; //コメント:nextが過去時刻だったときの保険再実行
//API取得失敗時の保険再試行ディレイ(ms)
const RETRY_AFTER_MS_ON_FETCH_FAIL=5*60*1000; //コメント:next取得失敗時の保険再試行
//Discordの1送信あたりのEmbed上限
const DISCORD_EMBED_LIMIT=10; //コメント:Discordの1送信あたりEmbed上限

//初回セットアップ
//bootstrap:最初の一回だけ呼び出して、次回シフトに合わせたトリガーを作成
function bootstrap(){ setNextTriggers(); }

//本通知
//postShiftNow:シフト開始時刻に実行され、現在のシフトをDiscordに通知
function postShiftNow(){
  const lock=LockService.getScriptLock();
  //並列起動での二重実行防止
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftNow)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    //Webhook必須チェック
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK);
    if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
    //UA決定(未設定ならデフォルト)
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    //現在シフト取得
    const currentShift=getFirstResult(fetchJson(API_NOW_URL,userAgent));
    if(!currentShift){ Logger.log('現在のシフト情報が見つかりませんでした'); rescheduleTriggersSafely(); return; }

    //重複投稿防止(開始時刻キーで比較)
    const lastPostedStartTime=props.getProperty(PROP_KEY_LAST_START_TIME);
    if(lastPostedStartTime===currentShift.start_time){
      Logger.log('このシフトは既に通知済み。スキップ:'+currentShift.start_time);
      rescheduleTriggersSafely(); return;
    }

    //Discord用ペイロード生成→投稿
    const payload=buildShiftPayload(currentShift,false);
    const code=postToDiscord(webhookUrl,payload);
    Logger.log('Discord投稿ステータス:'+code);
    if(code<200||code>=300)throw new Error('Discordへの投稿に失敗:'+code);

    //投稿済み開始時刻を保存→次回に備えてトリガー更新
    props.setProperty(PROP_KEY_LAST_START_TIME,currentShift.start_time);
    setNextTriggers();
  }catch(e){
    //失敗時もトリガーを立て直す(止まりっぱなし防止)
    Logger.log('postShiftNowエラー:'+e);
    rescheduleTriggersSafely();
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

//事前通知(開始N分前のウィンドウ)
//postShiftPre:「開始N分前±許容90秒」のタイミングでDiscordに事前通知
function postShiftPre(){
  const lock=LockService.getScriptLock();
  //二重実行防止
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftPre)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    //事前通知の設定値を取得(0または未設定なら即終了)
    const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);
    if(!preNotifyMinutes)return;
    //Webhook未設定なら何もしない
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)return;
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    //次のシフト(開始予定)を取得
    const nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent));
    if(!nextShift){ Logger.log('事前通知対象なし'); return; }

    //開始まで残り時間を計算→通知ウィンドウ内か判定
    const startTimeMs=Date.parse(nextShift.start_time);
    const msToStart=startTimeMs-Date.now();
    const isWithinWindow=Math.abs(msToStart-preNotifyMinutes*MS_PER_MINUTE)<=PRE_NOTIFY_TOLERANCE_MS;

    //同一シフトへの重複事前通知を防止
    const alreadyNotified=props.getProperty(PROP_KEY_PRE_NOTIFIED_START_TIME)===nextShift.start_time;

    //ウィンドウ内かつ未通知なら送信
    if(isWithinWindow&&!alreadyNotified){
      const code=postToDiscord(webhookUrl,buildShiftPayload(nextShift,true));
      Logger.log('事前通知ステータス:'+code);
      //今回のシフトを事前通知済みに記録
      props.setProperty(PROP_KEY_PRE_NOTIFIED_START_TIME,nextShift.start_time);
    }else{
      Logger.log('事前通知スキップ(時間外or既通知)');
    }
  }catch(e){
    Logger.log('postShiftPreエラー:'+e);
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

//バックアップ(毎時)
//backupHourly:毎時の保険実行。万一のトリガーずれや投稿漏れを救済する
function backupHourly(){
  try{ postShiftNow(); }
  catch(e){ Logger.log('backupHourlyエラー:'+e); try{ setNextTriggers(); }catch(_){ } }
}

//次回シフトに合わせてトリガー設定
//setNextTriggers:関係する既存トリガーを掃除→本通知/事前通知/毎時バックアップを再設定する
function setNextTriggers(){
  const targets=['postShiftNow','postShiftPre','backupHourly'];
  //関連トリガーのみ削除(上限超過や多重起動を防止)
  ScriptApp.getProjectTriggers().forEach(tr=>{ if(targets.includes(tr.getHandlerFunction()))ScriptApp.deleteTrigger(tr); });

  const props=PropertiesService.getScriptProperties();
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);

  //次シフト取得(失敗は握りつぶしてnull)
  let nextShift=null;
  try{ nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent)); }catch(e){ Logger.log('次回取得失敗:'+e); }

  const now=new Date();
  if(nextShift){
    const startTime=new Date(nextShift.start_time);
    //開始が未来→本通知トリガー(正確時刻)を設定
    if(startTime>now){
      ScriptApp.newTrigger('postShiftNow').timeBased().at(startTime).create();
      Logger.log('本通知トリガー:'+startTime.toISOString());
      //事前通知設定が有効なら事前通知トリガーも設定
      if(preNotifyMinutes>0){
        const pre=new Date(startTime.getTime()-preNotifyMinutes*MS_PER_MINUTE);
        if(pre>now){ ScriptApp.newTrigger('postShiftPre').timeBased().at(pre).create(); Logger.log('事前通知トリガー:'+pre.toISOString()); }
        else{ Logger.log('事前通知時刻は過去'); }
      }
    }else{
      //過去シフトを掴んだ場合の保険
      ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_PAST).create();
      Logger.log('過去時刻を掴んだため'+(RETRY_AFTER_MS_ON_PAST/1000)+'秒後に再試行');
    }
  }else{
    //次シフト取得に失敗→少し待って再試行トリガー
    ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_FETCH_FAIL).create();
    Logger.log('次回取得不可。'+(RETRY_AFTER_MS_ON_FETCH_FAIL/60000)+'分後に再試行');
  }

  //毎時バックアップ(恒常)
  ScriptApp.newTrigger('backupHourly').timeBased().everyHours(1).create();
  Logger.log('バックアップ(毎時)設定完了');

  //現在のトリガー構成を可視化
  const ts=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction()+':'+t.getTriggerSource());
  Logger.log('現在のトリガー:'+JSON.stringify(ts));
}

//再スケジュール
//rescheduleTriggersSafely:setNextTriggersを例外握りつぶしで呼ぶユーティリティ
function rescheduleTriggersSafely(){ try{ setNextTriggers(); }catch(e){ Logger.log('再設定中エラー:'+e); } }

//HTTP(JSON取得) リトライ付き
//fetchJson:UrlFetchAppでJSONを取得
function fetchJson(url,userAgent){
  const maxRetry=2; //コメント:合計3回(0,1,2)
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

//レスポンス本文の一部だけログ用に安全抽出
//safeBody:巨大レスポンスでもログが暴れないように先頭のみ抜粋
function safeBody(res){
  try{
    const t=res.getContentText();
    return (t&&t.length>200)?t.slice(0,200)+'...':t;
  }catch(_){ return ''; }
}

//resultsの先頭を返す
//getFirstResult:APIの標準フォーマット{results:[...]}の先頭を安全取得
function getFirstResult(json){
  const results=json&&json.results;
  return Array.isArray(results)&&results.length?results[0]:null;
}

//Webhook送信 リトライ付き
//postToDiscord:DiscordのWebhookへJSONをPOST
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

//avatarUrl取得(プロパティから)
//getAvatarUrl:送信者アイコンURLをプロパティから取得(空文字はnullに正規化)
function getAvatarUrl(){
  const url=PropertiesService.getScriptProperties().getProperty(PROP_KEY_AVATAR_URL);
  return url&&url.trim()?url.trim():null;
}

//シフト通知ペイロード生成
//buildShiftPayload:Embed(メイン+ブキアイコン列)を生成。事前通知/通常を切替
function buildShiftPayload(shiftData,isPreNotification){
  const stageName=shiftData.stage?.name||'不明ステージ';
  const bossName=shiftData.boss?.name||'不明';
  const isBigRun=!!shiftData.is_big_run;

  //ブキ名と画像URLを正規化
  const weapons=(shiftData.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));

  //開始・終了をJSTの短い形式に整形
  const start=new Date(shiftData.start_time);
  const end=new Date(shiftData.end_time);
  const startStr=Utilities.formatDate(start,'Asia/Tokyo','MM/dd HH:mm');
  const endStr=Utilities.formatDate(end,'Asia/Tokyo','MM/dd HH:mm');

  //タイトル事前通知
  const title=isPreNotification?'サーモンラン 事前通知(まもなく開始)':(isBigRun?'サーモンラン(ビッグラン)':'サーモンラン');

  //メインEmbed
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
  //ステージ画像があればサムネに
  if(shiftData.stage?.image)mainEmbed.thumbnail={url:shiftData.stage.image};

  //ブキごとにAuthorアイコンを作る
  const weaponEmbeds=weapons.map(w=>({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}));

  //botのプロフィール(名前、アイコン)を付与
  const avatar=getAvatarUrl();
  return { username:'クマサン商会', ...(avatar?{avatar_url:avatar}:{}), embeds:[mainEmbed,...weaponEmbeds] };
}

//スケジュール用メインEmbed生成
//buildScheduleEmbedMain:スケジュール一覧の各行に相当する見出しEmbedを生成
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

//直近3シフトを武器画像付きで投稿
//postNextThreeShiftsWithWeapons:スケジュールAPIから3件取得→Embedを分割してDiscord投稿
function postNextThreeShiftsWithWeapons(){
  const props=PropertiesService.getScriptProperties();
  const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

  //スケジュール一覧を取得
  const scheduleData=fetchJson(API_SCHEDULE_URL,userAgent);
  const list=Array.isArray(scheduleData?.results)?scheduleData.results:[];
  if(list.length===0){ postToDiscord(webhookUrl,{content:'直近のサーモンラン予定取得失敗'}); return; }

  //先頭3件に限定
  const head=list.slice(0,3);
  const embeds=[];
  head.forEach((shift,idx)=>{
    //見出しEmbed
    embeds.push(buildScheduleEmbedMain(shift,idx));
    //武器を小アイコンEmbedで追加
    const weapons=(shift?.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));
    weapons.forEach(w=>{ embeds.push({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}); });
  });

  //DiscordのEmbed上限に合わせて分割送信
  const avatar=getAvatarUrl();
  for(let i=0;i<embeds.length;i+=DISCORD_EMBED_LIMIT){
    const chunk=embeds.slice(i,i+DISCORD_EMBED_LIMIT);
    postToDiscord(webhookUrl,{username:'クマサン商会',...(avatar?{avatar_url:avatar}:{}),content:(i===0?'直近3シフトのスケジュール':'(続き)'),embeds:chunk});
  }
}

//デバッグ系ユーティリティ
//debugResetLast:重複防止キーを削除して次の本通知を強制可能にする
function debugResetLast(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEY_LAST_START_TIME);
  Logger.log('プロパティ "'+PROP_KEY_LAST_START_TIME+'" を削除');
}
//postShiftNowForce:debugResetLast後にpostShiftNowを即実行して動作確認
function postShiftNowForce(){ debugResetLast(); postShiftNow(); }

//疎通確認
//dryRunNext:次シフトの生JSONをログ出力してAPI疎通を確認
function dryRunNext(){
  const ua=PropertiesService.getScriptProperties().getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const next=getFirstResult(fetchJson(API_NEXT_URL,ua));
  Logger.log(JSON.stringify(next,null,2));
}