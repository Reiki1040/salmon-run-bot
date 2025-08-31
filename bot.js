//---API設定---
//外部APIのベースURLを定義する
const API_BASE='https://spla3.yuu26.com/api';  //怖いのはここかなぁ？？
//現在進行中のサーモンラン情報のエンドポイントを組み立てる
const API_NOW_URL=`${API_BASE}/coop-grouping/now`;
//次に開始するサーモンラン情報のエンドポイントを組み立てる
const API_NEXT_URL=`${API_BASE}/coop-grouping/next`;
//今後のスケジュール一覧のエンドポイントを組み立てる
const API_SCHEDULE_URL=`${API_BASE}/coop-grouping/schedule`;

//---スクリプトプロパティキー---
//DiscordのWebhook URLを保存するキー名を定義する
const PROP_KEY_WEBHOOK='discordWebhookUrl';
//User-Agentを保存するキー名を定義する
const PROP_KEY_USER_AGENT='userAgent';
//直近に投稿済みのシフト開始時刻を保存するキー名を定義する
const PROP_KEY_LAST_START_TIME='lastShiftStart';
//直近に事前通知を実施したシフト開始時刻を保存するキー名を定義する
const PROP_KEY_PRE_NOTIFIED_START_TIME='preNotifiedStart';
//事前通知を何分前に行うかの数値を保存するキー名を定義する
const PROP_KEY_PRE_NOTIFY_MIN='preNotifyMin';
//Webhookの送信者アイコンURLを保存するキー名を定義する
const PROP_KEY_AVATAR_URL='avatarUrl';

//---スクリプト設定---
//既定のUser-Agent文字列を設定する
const DEFAULT_USER_AGENT='ReikiSalmonGAS/1.0';
//ロック取得の最大待機時間(ミリ秒)を設定する
const LOCK_TIMEOUT_MS=15000; //コメント:LockService待機ミリ秒
//1分をミリ秒で定義する
const MS_PER_MINUTE=60000; //コメント:1分のミリ秒
//事前通知の許容誤差(±秒)を設定する
const PRE_NOTIFY_TOLERANCE_MS=90*1000; //コメント:事前通知の±許容(90秒)
//nextが過去だった場合の保険再実行ディレイを設定する
const RETRY_AFTER_MS_ON_PAST=60*1000; //コメント:nextが過去時刻だったときの保険再実行
//API取得失敗時の保険再試行ディレイを設定する
const RETRY_AFTER_MS_ON_FETCH_FAIL=5*60*1000; //コメント:next取得失敗時の保険再試行
//Discordの1送信あたりのEmbed上限を定義する
const DISCORD_EMBED_LIMIT=10; //コメント:Discordの1送信あたりEmbed上限

//===初回セットアップ===
//次回シフトに合わせて必要なトリガーを張る
function bootstrap(){ setNextTriggers(); }

//本通知(シフト開始時刻に実行)
//シフト開始ぴったりにDiscordへ通知する
function postShiftNow(){
  const lock=LockService.getScriptLock();
  //並列実行を避けるためロック取得を試みる
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftNow)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    //Webhook URLを取得して未設定ならエラーにする
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK);
    if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
    //User-Agentを決定する
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    //現在のシフト情報を取得する
    const currentShift=getFirstResult(fetchJson(API_NOW_URL,userAgent));
    if(!currentShift){ Logger.log('現在のシフト情報が見つかりませんでした'); rescheduleTriggersSafely(); return; }

    //重複投稿を防ぐため最後に投稿した開始時刻と比較する
    const lastPostedStartTime=props.getProperty(PROP_KEY_LAST_START_TIME);
    if(lastPostedStartTime===currentShift.start_time){
      Logger.log('このシフトは既に通知済み。スキップ:'+currentShift.start_time);
      rescheduleTriggersSafely(); return;
    }

    //Discordに送るペイロードを生成する
    const payload=buildShiftPayload(currentShift,false);
    //Webhookへ投稿する
    const code=postToDiscord(webhookUrl,payload);
    Logger.log('Discord投稿ステータス:'+code);
    if(code<200||code>=300)throw new Error('Discordへの投稿に失敗:'+code);

    //投稿済みの開始時刻を保存する
    props.setProperty(PROP_KEY_LAST_START_TIME,currentShift.start_time);
    //次のトリガーを張り直す
    setNextTriggers();
  }catch(e){
    //失敗時はログを出して再スケジュールする
    Logger.log('postShiftNowエラー:'+e);
    rescheduleTriggersSafely();
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

//===事前通知(開始N分前)===
//事前通知のウィンドウに入ったらDiscordへ通知する
function postShiftPre(){
  const lock=LockService.getScriptLock();
  //並列実行を避けるためロック取得を試みる
  if(!lock.tryLock(LOCK_TIMEOUT_MS)){ Logger.log('Lock未取得のためスキップ(postShiftPre)'); return; }
  try{
    const props=PropertiesService.getScriptProperties();
    //事前通知分を取得して0/未設定なら終了する
    const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);
    if(!preNotifyMinutes)return;
    //Webhook URLが未設定なら終了する
    const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)return;
    const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

    //次シフト情報を取得する
    const nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent));
    if(!nextShift){ Logger.log('事前通知対象なし'); return; }

    //開始までの残り時間を計算して通知ウィンドウか判定する
    const startTimeMs=Date.parse(nextShift.start_time);
    const msToStart=startTimeMs-Date.now();
    const isWithinWindow=Math.abs(msToStart-preNotifyMinutes*MS_PER_MINUTE)<=PRE_NOTIFY_TOLERANCE_MS;
    //同じシフトに対して事前通知済みかを確認する
    const alreadyNotified=props.getProperty(PROP_KEY_PRE_NOTIFIED_START_TIME)===nextShift.start_time;

    //ウィンドウ内かつ未通知なら投稿する
    if(isWithinWindow&&!alreadyNotified){
      const code=postToDiscord(webhookUrl,buildShiftPayload(nextShift,true));
      Logger.log('事前通知ステータス:'+code);
      //今回のシフトを事前通知済みとして記録する
      props.setProperty(PROP_KEY_PRE_NOTIFIED_START_TIME,nextShift.start_time);
    }else{
      //対象外である理由をログする
      Logger.log('事前通知スキップ(時間外or既通知)');
    }
  }catch(e){
    Logger.log('postShiftPreエラー:'+e);
  }finally{ try{lock.releaseLock()}catch(_){ } }
}

//===バックアップ(毎時)===
//毎時の保険実行で投稿漏れやトリガーずれを補正する
function backupHourly(){
  try{ postShiftNow(); }
  catch(e){ Logger.log('backupHourlyエラー:'+e); try{ setNextTriggers(); }catch(_){ } }
}

//===次回シフトにあわせてトリガー設定===
//既存トリガーを掃除してから本通知/事前通知/毎時をセットする
function setNextTriggers(){
  const targets=['postShiftNow','postShiftPre','backupHourly'];
  //関連トリガーのみ削除して上限超過を防止する
  ScriptApp.getProjectTriggers().forEach(tr=>{ if(targets.includes(tr.getHandlerFunction()))ScriptApp.deleteTrigger(tr); });

  const props=PropertiesService.getScriptProperties();
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const preNotifyMinutes=parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN)||'0',10);

  //次シフトを取得する(失敗時はnullのまま進める)
  let nextShift=null;
  try{ nextShift=getFirstResult(fetchJson(API_NEXT_URL,userAgent)); }catch(e){ Logger.log('次回取得失敗:'+e); }

  const now=new Date();
  if(nextShift){
    const startTime=new Date(nextShift.start_time);
    //開始が未来なら正確な時刻に本通知トリガーを張る
    if(startTime>now){
      ScriptApp.newTrigger('postShiftNow').timeBased().at(startTime).create();
      Logger.log('本通知トリガー:'+startTime.toISOString());
      //事前通知設定がある場合のみ事前通知トリガーを張る
      if(preNotifyMinutes>0){
        const pre=new Date(startTime.getTime()-preNotifyMinutes*MS_PER_MINUTE);
        if(pre>now){ ScriptApp.newTrigger('postShiftPre').timeBased().at(pre).create(); Logger.log('事前通知トリガー:'+pre.toISOString()); }
        else{ Logger.log('事前通知時刻は過去'); }
      }
    }else{
      //境界で過去を掴んだ場合は短い遅延で本通知を再試行する
      ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_PAST).create();
      Logger.log('過去時刻を掴んだため'+(RETRY_AFTER_MS_ON_PAST/1000)+'秒後に再試行');
    }
  }else{
    //次シフト取得に失敗した場合は少し待って再試行トリガーを張る
    ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_FETCH_FAIL).create();
    Logger.log('次回取得不可。'+(RETRY_AFTER_MS_ON_FETCH_FAIL/60000)+'分後に再試行');
  }

  //毎時バックアップトリガーを張る
  ScriptApp.newTrigger('backupHourly').timeBased().everyHours(1).create();
  Logger.log('バックアップ(毎時)設定完了');

  //現在のトリガー一覧を可視化してログに残す
  const ts=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction()+':'+t.getTriggerSource());
  Logger.log('現在のトリガー:'+JSON.stringify(ts));
}

//===安全に再スケジュール===
//トリガー再設定を例外握りつぶしで実施する
function rescheduleTriggersSafely(){ try{ setNextTriggers(); }catch(e){ Logger.log('再設定中エラー:'+e); } }

//===HTTP(JSON取得) リトライ付き===
//APIからJSONを取得してパースする(429/5xxはリトライする)
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

//===レスポンス本文の一部だけログ用に安全抽出===
//巨大レスポンスでもログが暴れないよう先頭のみ抜き出す
function safeBody(res){
  try{
    const t=res.getContentText();
    return (t&&t.length>200)?t.slice(0,200)+'...':t;
  }catch(_){ return ''; }
}

//===resultsの先頭を返す===
//API標準のresults配列から先頭要素を安全に取り出す
function getFirstResult(json){
  const results=json&&json.results;
  return Array.isArray(results)&&results.length?results[0]:null;
}

//===Webhook送信 リトライ付き===
//Discord WebhookへJSONをPOSTする(429/5xxはリトライする)
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
    return code; //コメント:4xx(429以外)は即終了
  }
  return code;
}

//===avatarUrl取得(プロパティから)===
//送信者アイコンのURLをプロパティから取得する
function getAvatarUrl(){
  const url=PropertiesService.getScriptProperties().getProperty(PROP_KEY_AVATAR_URL);
  return url&&url.trim()?url.trim():null;
}

//===シフト通知ペイロード===
//メイン情報と武器小アイコンを含むEmbed配列を構築する
function buildShiftPayload(shiftData,isPreNotification){
  const stageName=shiftData.stage?.name||'不明ステージ';
  const bossName=shiftData.boss?.name||'不明';
  const isBigRun=!!shiftData.is_big_run;

  //武器の名前と画像URLを正規化する
  const weapons=(shiftData.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));

  //開始・終了の時刻文字列をJSTで整形する
  const start=new Date(shiftData.start_time);
  const end=new Date(shiftData.end_time);
  const startStr=Utilities.formatDate(start,'Asia/Tokyo','MM/dd HH:mm');
  const endStr=Utilities.formatDate(end,'Asia/Tokyo','MM/dd HH:mm');

  //事前通知かビッグランかでタイトルを変える
  const title=isPreNotification?'サーモンラン 事前通知(まもなく開始)':(isBigRun?'サーモンラン(ビッグラン)':'サーモンラン');

  //メインEmbedを構築する
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
  //ステージ画像がある場合はサムネイルに設定する
  if(shiftData.stage?.image)mainEmbed.thumbnail={url:shiftData.stage.image};

  //各武器を小型のAuthorアイコンとして並べる
  const weaponEmbeds=weapons.map(w=>({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}));

  //送信者名とアイコンURLを設定して返す
  const avatar=getAvatarUrl();
  return { username:'クマサン商会', ...(avatar?{avatar_url:avatar}:{}), embeds:[mainEmbed,...weaponEmbeds] };
}

//===スケジュール用メインEmbed===
//スケジュール一覧の見出しEmbedを構築する
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
  //ステージ画像がある場合はサムネイルに設定する
  if(shiftData?.stage?.image)emb.thumbnail={url:shiftData.stage.image};
  return emb;
}

//===直近3シフト(武器画像付き=Author小アイコン)を投稿===
//スケジュールAPIから3件取り出し、Embedを分割して投稿する
function postNextThreeShiftsWithWeapons(){
  const props=PropertiesService.getScriptProperties();
  const webhookUrl=props.getProperty(PROP_KEY_WEBHOOK); if(!webhookUrl)throw new Error('プロパティ "discordWebhookUrl" が未設定');
  const userAgent=props.getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;

  //スケジュール一覧を取得する
  const scheduleData=fetchJson(API_SCHEDULE_URL,userAgent);
  const list=Array.isArray(scheduleData?.results)?scheduleData.results:[];
  if(list.length===0){ postToDiscord(webhookUrl,{content:'直近のサーモンラン予定取得失敗'}); return; }

  //先頭3件だけを使う
  const head=list.slice(0,3);
  const embeds=[];
  head.forEach((shift,idx)=>{
    //見出しEmbedを追加する
    embeds.push(buildScheduleEmbedMain(shift,idx));
    //武器を小アイコンEmbedで追加する
    const weapons=(shift?.weapons||[]).map(w=>({name:w?.name||'???',image:w?.image||null}));
    weapons.forEach(w=>{ embeds.push({author:{name:w.name,icon_url:w.image||undefined},description:'\u200B'}); });
  });

  //DiscordのEmbed上限に合わせて分割送信する
  const avatar=getAvatarUrl();
  for(let i=0;i<embeds.length;i+=DISCORD_EMBED_LIMIT){
    const chunk=embeds.slice(i,i+DISCORD_EMBED_LIMIT);
    postToDiscord(webhookUrl,{username:'クマサン商会',...(avatar?{avatar_url:avatar}:{}),content:(i===0?'直近3シフトのスケジュール':'(続き)'),embeds:chunk});
  }
}

//===デバッグ===
//重複防止キーを削除して次の本通知を強制可能にする
function debugResetLast(){
  PropertiesService.getScriptProperties().deleteProperty(PROP_KEY_LAST_START_TIME);
  Logger.log('プロパティ "'+PROP_KEY_LAST_START_TIME+'" を削除');
}
//直ちに本通知を試行して動作確認する
function postShiftNowForce(){ debugResetLast(); postShiftNow(); }

//===観測用(任意)===
//次シフトの生JSONをログ出力してAPI疎通を確認する
function dryRunNext(){
  const ua=PropertiesService.getScriptProperties().getProperty(PROP_KEY_USER_AGENT)||DEFAULT_USER_AGENT;
  const next=getFirstResult(fetchJson(API_NEXT_URL,ua));
  Logger.log(JSON.stringify(next,null,2));
}