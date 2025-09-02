//外部APIURL(有志の非公式)
const API_BASE = 'https://spla3.yuu26.com/api';
//現在進行中のサーモンラン情報
const API_NOW_URL = `${API_BASE}/coop-grouping/now`;
//次に開始するサーモンラン情報
const API_NEXT_URL = `${API_BASE}/coop-grouping/next`;
//今後のスケジュール一覧
const API_SCHEDULE_URL = `${API_BASE}/coop-grouping/schedule`;

//スクリプトプロパティキー
const PROP_KEY_WEBHOOK = 'discordWebhookUrl'; //DiscordのWebhook URL
const PROP_KEY_USER_AGENT = 'userAgent'; //User-Agent
const PROP_KEY_LAST_START_TIME = 'lastShiftStart'; //直近に投稿済みのシフト開始時刻
const PROP_KEY_PRE_NOTIFIED_START_TIME = 'preNotifiedStart'; //直近に事前通知を実施したシフト開始時刻
const PROP_KEY_PRE_NOTIFY_MIN = 'preNotifyMin'; //事前通知を何分前に行うか(数値)
const PROP_KEY_AVATAR_URL = 'avatarUrl'; //Webhook送信者アイコンURL

//スクリプト設定
const DEFAULT_USER_AGENT = 'ReikiSalmonGAS/1.0'; //既定のUser-Agent
const LOCK_TIMEOUT_MS = 15000; //LockService待機ミリ秒
const MS_PER_MINUTE = 60000; //1分のミリ秒
const PRE_NOTIFY_TOLERANCE_MS = 90 * 1000; //事前通知の±許容(90秒)
const RETRY_AFTER_MS_ON_PAST = 60 * 1000; //nextが過去時刻だったときの保険再実行
const RETRY_AFTER_MS_ON_FETCH_FAIL = 5 * 60 * 1000; //next取得失敗時の保険再試行
const DISCORD_EMBED_LIMIT = 10; //Discordの1送信あたりEmbed上限

/*.  関数概要
bootstrap: 初回セットアップ用の関数。手動で一度だけ実行し、次回シフトに合わせたトリガーを作成
postShiftNow: 現在のシフト情報をDiscordに通知する。シフト開始時刻に実行
postShiftPre: 次のシフトの事前通知を行う。シフト開始N分前に実行
backupHourly: 毎時実行されるバックアップ関数。トリガーのズレや投稿漏れを補う
setNextTriggers: 次回シフトに合わせて関連トリガー(本通知/事前通知/バックアップ)を再設定
rescheduleTriggersSafely: setNextTriggersをエラーを握りつぶして安全に呼び出すユーティリティ
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

/**
 * @brief 初回セットアップ用の関数。手動で一度だけ実行する。
 */
function bootstrap() {
    //ステップ1: トリガーの初期設定
    //`setNextTriggers`を呼び出し、APIから取得した次回シフト情報に基づいてトリガーを初めて設定する。
    setNextTriggers();
}

/**
 * @brief 現在のシフト情報をDiscordに通知する。
 */
function postShiftNow() {
    //ステップ1: スクリプトロックの取得
    //重複実行を防止するため、ロックを取得。取得できなければ処理を中断。
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
        Logger.log('Lock未取得のためスキップ(postShiftNow)');
        return;
    }

    try {
        //ステップ2: 必要なプロパティの読み込み
        const props = PropertiesService.getScriptProperties();
        const webhookUrl = props.getProperty(PROP_KEY_WEBHOOK);
        if (!webhookUrl) {
            throw new Error('プロパティ "discordWebhookUrl" が未設定');
        }
        const userAgent = props.getProperty(PROP_KEY_USER_AGENT) || DEFAULT_USER_AGENT;

        //ステップ3: 現在のシフト情報をAPIから取得
        const currentShift = getFirstResult(fetchJson(API_NOW_URL, userAgent));
        if (!currentShift) {
            Logger.log('現在のシフト情報が見つかりませんでした');
            rescheduleTriggersSafely();
            return;
        }

        //ステップ4: 重複投稿のチェック
        //既に通知済みのシフトであれば、処理を中断して次回トリガーを再設定。
        const lastPostedStartTime = props.getProperty(PROP_KEY_LAST_START_TIME);
        if (lastPostedStartTime === currentShift.start_time) {
            Logger.log('このシフトは既に通知済み。スキップ:' + currentShift.start_time);
            rescheduleTriggersSafely();
            return;
        }

        //ステップ5: Discordへ投稿
        //投稿用のペイロードを生成し、Webhookへ送信。
        const payload = buildShiftPayload(currentShift, false);
        const code = postToDiscord(webhookUrl, payload);
        Logger.log('Discord投稿ステータス:' + code);
        if (code < 200 || code >= 300) {
            throw new Error('Discordへの投稿に失敗:' + code);
        }

        //ステップ6: 成功記録と次回トリガー設定
        //通知したシフトの開始時刻をプロパティに保存し、重複投稿を防止。
        props.setProperty(PROP_KEY_LAST_START_TIME, currentShift.start_time);
        //次のシフトに向けてトリガーを再設定。
        setNextTriggers();

    } catch (e) {
        //ステップ7: エラーハンドリング
        //処理中にエラーが発生した場合、ログに記録し、トリガーの再設定を試みる。
        Logger.log('postShiftNowエラー:' + e);
        rescheduleTriggersSafely();
    } finally {
        //ステップ8: ロックの解放
        //処理が正常終了してもエラー終了しても、必ずロックを解放する。
        try {
            lock.releaseLock()
        } catch (_) {}
    }
}

/**
 * @brief 次のシフトの事前通知を行う。
 */
function postShiftPre() {
    //ステップ1: スクリプトロックの取得
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
        Logger.log('Lock未取得のためスキップ(postShiftPre)');
        return;
    }
    try {
        //ステップ2: 必要なプロパティの読み込み
        const props = PropertiesService.getScriptProperties();
        const preNotifyMinutes = parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN) || '0', 10);
        //事前通知が有効でなければ、ここで処理を終了。
        if (!preNotifyMinutes) {
            return;
        }
        const webhookUrl = props.getProperty(PROP_KEY_WEBHOOK);
        if (!webhookUrl) {
            return;
        }
        const userAgent = props.getProperty(PROP_KEY_USER_AGENT) || DEFAULT_USER_AGENT;

        //ステップ3: 次回シフト情報をAPIから取得
        const nextShift = getFirstResult(fetchJson(API_NEXT_URL, userAgent));
        if (!nextShift) {
            Logger.log('事前通知対象なし');
            return;
        }

        //ステップ4: 通知タイミングと重複のチェック
        //現在が、設定された事前通知時刻の許容範囲内であるか判定。
        const startTimeMs = Date.parse(nextShift.start_time);
        const msToStart = startTimeMs - Date.now();
        const isWithinWindow = Math.abs(msToStart - preNotifyMinutes * MS_PER_MINUTE) <= PRE_NOTIFY_TOLERANCE_MS;
        //このシフトの事前通知が既に完了しているか判定。
        const alreadyNotified = props.getProperty(PROP_KEY_PRE_NOTIFIED_START_TIME) === nextShift.start_time;

        //ステップ5: 条件を満たせばDiscordへ投稿
        //通知タイミングであり、かつ未通知の場合のみ実行。
        if (isWithinWindow && !alreadyNotified) {
            const code = postToDiscord(webhookUrl, buildShiftPayload(nextShift, true));
            Logger.log('事前通知ステータス:' + code);
            //事前通知したシフトの開始時刻をプロパティに保存し、重複を防止。
            props.setProperty(PROP_KEY_PRE_NOTIFIED_START_TIME, nextShift.start_time);
        } else {
            Logger.log('事前通知スキップ(時間外or既通知)');
        }
    } catch (e) {
        //ステップ6: エラーハンドリング
        Logger.log('postShiftPreエラー:' + e);
    } finally {
        //ステップ7: ロックの解放
        try {
            lock.releaseLock()
        } catch (_) {}
    }
}

/**
 * @brief 毎時実行されるバックアップ関数。
 */
function backupHourly() {
    //ステップ1: 通常の通知処理を実行
    //トリガーのズレや実行漏れを補うため、`postShiftNow`を呼び出す。
    //`postShiftNow`内部の重複チェックにより、不要な通知は行われない。
    try {
        postShiftNow();
    } catch (e) {
        //ステップ2: エラーハンドリング
        //`postShiftNow`が失敗した場合、トリガーの再設定を試みることで自己修復を図る。
        Logger.log('backupHourlyエラー:' + e);
        try {
            setNextTriggers();
        } catch (_) {}
    }
}

/**
 * @brief 次回シフトに合わせて関連トリガーを再設定する。
 */
function setNextTriggers() {
    //==================================================================
    //ステップ1: 既存トリガーの掃除
    //==================================================================
    //処理が重複しないよう、この関数で設定対象となるトリガーを一度すべて削除する。
    const targets = ['postShiftNow', 'postShiftPre', 'backupHourly'];
    ScriptApp.getProjectTriggers().forEach(tr => {
        if (targets.includes(tr.getHandlerFunction())) {
            ScriptApp.deleteTrigger(tr);
        }
    });


    //==================================================================
    //ステップ2: 次回シフト情報の取得と準備
    //==================================================================
    //APIから次回シフト情報を取得するために必要な設定を読み込む。
    const props = PropertiesService.getScriptProperties();
    const userAgent = props.getProperty(PROP_KEY_USER_AGENT) || DEFAULT_USER_AGENT;
    const preNotifyMinutes = parseInt(props.getProperty(PROP_KEY_PRE_NOTIFY_MIN) || '0', 10);

    //外部APIへアクセスし、次回シフト情報を取得。
    //通信失敗時はエラーをログに記録し、`nextShift`はnullのまま後続処理へ。
    let nextShift = null;
    try {
        nextShift = getFirstResult(fetchJson(API_NEXT_URL, userAgent));
    } catch (e) {
        Logger.log('次回取得失敗:' + e);
    }


    //==================================================================
    //ステップ3: 取得結果に応じた次回トリガーを設定
    //==================================================================
    const now = new Date();

    //---正常系: 次回シフト情報が取得できた場合---
    if (nextShift) {
        const startTime = new Date(nextShift.start_time);

        //---ケースA: シフト開始時刻が未来である (正常)---
        if (startTime > now) {
            //[本通知トリガー]: シフト開始時刻に`postShiftNow`を実行するよう設定。
            ScriptApp.newTrigger('postShiftNow').timeBased().at(startTime).create();
            Logger.log('本通知トリガー:' + startTime.toISOString());

            //[事前通知トリガー]: 事前通知の設定が有効な場合。
            if (preNotifyMinutes > 0) {
                const preNotifyTime = new Date(startTime.getTime() - preNotifyMinutes * MS_PER_MINUTE);
                //事前通知時刻が未来であれば、`postShiftPre`を実行するよう設定。
                if (preNotifyTime > now) {
                    ScriptApp.newTrigger('postShiftPre').timeBased().at(preNotifyTime).create();
                    Logger.log('事前通知トリガー:' + preNotifyTime.toISOString());
                } else {
                    Logger.log('事前通知時刻は過去');
                }
            }
        //---ケースB: シフト開始時刻が過去である (APIのキャッシュ等)---
        } else {
            //一定時間後に再試行するためのトリガーを設定。
            ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_PAST).create();
            Logger.log('過去時刻を掴んだため' + (RETRY_AFTER_MS_ON_PAST / 1000) + '秒後に再試行');
        }
    //---異常系: 次回シフト情報が取得できなかった場合---
    } else {
        //APIダウン等を想定し、一定時間後に再試行するためのトリガーを設定。
        ScriptApp.newTrigger('postShiftNow').timeBased().after(RETRY_AFTER_MS_ON_FETCH_FAIL).create();
        Logger.log('次回取得不可。' + (RETRY_AFTER_MS_ON_FETCH_FAIL / 60000) + '分後に再試行');
    }


    //==================================================================
    //ステップ4: バックアップトリガーの設定と最終確認
    //==================================================================
    //[バックアップトリガー]: どのような条件でも、1時間ごとに再実行する保険のトリガーを設定。
    //これにより、予期せぬエラーでトリガー設定が途絶えても自己修復を試みる。
    ScriptApp.newTrigger('backupHourly').timeBased().everyHours(1).create();
    Logger.log('バックアップ(毎時)設定完了');

    //[最終確認ログ]: 現在プロジェクトに設定されている全トリガーの情報をログに出力。
    const ts = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction() + ':' + t.getTriggerSource());
    Logger.log('現在のトリガー:' + JSON.stringify(ts));
}


/**
 * @brief `setNextTriggers`をエラーを握りつぶして安全に呼び出すユーティリティ。
 */
function rescheduleTriggersSafely() {
    //ステップ1: `setNextTriggers`の実行
    //`try...catch`で囲むことで、この関数内でエラーが発生してもスクリプト全体の実行が停止するのを防ぐ。
    try {
        setNextTriggers();
    } catch (e) {
        Logger.log('再設定中エラー:' + e);
    }
}

/**
 * @brief 指定URLからJSONデータを取得する。リトライ機能付き。
 */
function fetchJson(url, userAgent) {
    //ステップ1: リトライ処理のループを開始
    const maxRetry = 2;
    let lastErr = null;
    for (let i = 0; i <= maxRetry; i++) {
        try {
            //ステップ2: UrlFetchAppを使用してHTTPリクエストを送信
            const res = UrlFetchApp.fetch(url, {
                headers: {
                    'User-Agent': userAgent,
                    'Cache-Control': 'no-cache'
                },
                muteHttpExceptions: true
            });
            const code = res.getResponseCode();
            Logger.log('Fetch:' + url + ' Status:' + code + ' Try:' + i);

            //ステップ3: HTTPステータスコードに応じた処理
            //成功(200)なら、JSONをパースして返す。
            if (code === 200) {
                return JSON.parse(res.getContentText());
            }
            //リトライ対象(429:レート制限, 5xx:サーバーエラー)なら、待機して次のループへ。
            if (code === 429 || (code >= 500 && code <= 599)) {
                Utilities.sleep(800 * (i + 1));
                continue;
            }
            //それ以外のコードは即時失敗とみなし、エラーを投げる。
            throw new Error('Fetch失敗:' + code + ' body:' + safeBody(res));
        } catch (e) {
            //ステップ4: 例外発生時の処理
            //ネットワークエラー等の例外発生時、エラーを記録し、待機して次のループへ。
            lastErr = e;
            Utilities.sleep(500 * (i + 1));
        }
    }
    //ステップ5: リトライ上限到達時の処理
    //すべてのリトライが失敗した場合、最終的なエラーを投げる。
    throw lastErr || new Error('Fetch失敗(原因不明)');
}

/**
 * @brief ログ出力用に、レスポンス本文を安全な長さに切り詰める。
 */
function safeBody(res) {
    //ステップ1: レスポンスボディをテキストとして取得
    //長すぎる本文がログを汚染するのを防ぐ。
    try {
        const t = res.getContentText();
        //ステップ2: 200文字を超える場合は省略
        return (t && t.length > 200) ? t.slice(0, 200) + '...' : t;
    } catch (_) {
        return '';
    }
}

/**
 * @brief APIの標準形式{results:[...]}から先頭の結果を取得する。
 */
function getFirstResult(json) {
    //ステップ1: `results`プロパティの存在を確認
    //安全にアクセスするため、jsonオブジェクトとresultsプロパティの存在を確認。
    const results = json && json.results;
    //ステップ2: 配列であり要素が存在すれば、最初の要素を返す
    return Array.isArray(results) && results.length ? results[0] : null;
}

/**
 * @brief DiscordのWebhookへJSONペイロードをPOSTする。リトライ機能付き。
 */
function postToDiscord(webhookUrl, payload) {
    //ステップ1: リトライ処理のループを開始
    const maxRetry = 2;
    let code = -1;
    for (let i = 0; i <= maxRetry; i++) {
        //ステップ2: Webhook URLへPOSTリクエストを送信
        const res = UrlFetchApp.fetch(webhookUrl, {
            method: 'post',
            contentType: 'application/json',
            payload: JSON.stringify(payload),
            muteHttpExceptions: true
        });
        code = res.getResponseCode();
        Logger.log('Discord POST Status:' + code + ' Try:' + i);

        //ステップ3: HTTPステータスコードに応じた処理
        //成功(204 No Content等)なら、ステータスコードを返して終了。
        if (code === 204 || (code >= 200 && code < 300)) {
            return code;
        }
        //リトライ対象(429:レート制限, 5xx:サーバーエラー)なら、待機して次のループへ。
        if (code === 429) {
            Utilities.sleep(1500 * (i + 1));
            continue;
        }
        if (code >= 500 && code <= 599) {
            Utilities.sleep(800 * (i + 1));
            continue;
        }
        //それ以外のコードは即時失敗とみなし、ステータスコードを返して終了。
        return code;
    }
    //ステップ4: リトライ上限到達時の処理
    //最後に試行した際のステータスコードを返す。
    return code;
}

/**
 * @brief スクリプトプロパティから送信者アイコンURLを取得する。
 */
function getAvatarUrl() {
    //ステップ1: プロパティを取得
    const url = PropertiesService.getScriptProperties().getProperty(PROP_KEY_AVATAR_URL);
    //ステップ2: 値が存在し、空文字列でなければ返す
    return url && url.trim() ? url.trim() : null;
}

/**
 * @brief シフト情報からDiscord投稿用のペイロード(Embed)を生成する。
 */
function buildShiftPayload(shiftData, isPreNotification) {
    //ステップ1: シフトデータから各情報を抽出・整形
    const stageName = shiftData.stage?.name || '不明ステージ';
    const bossName = shiftData.boss?.name || '不明';
    const isBigRun = !!shiftData.is_big_run;
    const weapons = (shiftData.weapons || []).map(w => ({
        name: w?.name || '???',
        image: w?.image || null
    }));
    //ステップ2: 日時情報をJST(日本時間)の指定フォーマットに変換
    const start = new Date(shiftData.start_time);
    const end = new Date(shiftData.end_time);
    const startStr = Utilities.formatDate(start, 'Asia/Tokyo', 'MM/dd HH:mm');
    const endStr = Utilities.formatDate(end, 'Asia/Tokyo', 'MM/dd HH:mm');
    //ステップ3: 通知種別に応じてタイトルを決定
    const title = isPreNotification ? 'サーモンラン 事前通知(まもなく開始)' : (isBigRun ? 'サーモンラン(ビッグラン)' : 'サーモンラン');

    //ステップ4: メインとなるEmbedオブジェクトを生成
    //シフトの基本情報（ステージ、オカシラ、期間、ブキ一覧）を格納。
    const mainEmbed = {
        title: title,
        fields: [{
            name: 'ステージ',
            value: stageName,
            inline: true
        }, {
            name: 'オカシラ',
            value: bossName,
            inline: true
        }, {
            name: '期間(JST)',
            value: `${startStr} ～ ${endStr}`,
            inline: false
        }, {
            name: 'ブキ(一覧)',
            value: weapons.map(w => '• ' + w.name).join('\n') || '(不明)',
            inline: false
        }],
        timestamp: shiftData.start_time
    };
    if (shiftData.stage?.image) {
        mainEmbed.thumbnail = {
            url: shiftData.stage.image
        };
    }

    //ステップ5: 各ブキの画像を表示するためのEmbedオブジェクトを生成
    const weaponEmbeds = weapons.map(w => ({
        author: {
            name: w.name,
            icon_url: w.image || undefined
        },
        description: '\u200B'
    }));

    //ステップ6: 最終的なペイロードを組み立て
    //投稿者名、アバターURL、メインEmbed、ブキEmbedをすべて結合する。
    const avatar = getAvatarUrl();
    return {
        username: 'クマサン商会',
        ...(avatar ? {
            avatar_url: avatar
        } : {}),
        embeds: [mainEmbed, ...weaponEmbeds]
    };
}

/**
 * @brief スケジュール一覧の各行に相当する見出しEmbedを生成する。
 */
function buildScheduleEmbedMain(shiftData, absoluteIndex) {
    //ステップ1: シフトデータから各情報を抽出
    const stageName = shiftData?.stage?.name || '不明ステージ';
    const bossName = shiftData?.boss?.name || '不明';

    //ステップ2: 日時情報をJSTの指定フォーマットに変換
    const start = new Date(shiftData.start_time);
    const end = new Date(shiftData.end_time);
    const startStr = Utilities.formatDate(start, 'Asia/Tokyo', 'MM/dd HH:mm');
    const endStr = Utilities.formatDate(end, 'Asia/Tokyo', 'MM/dd HH:mm');

    //ステップ3: タイトルを生成
    const title = `#${absoluteIndex + 1} ${shiftData?.is_big_run ? 'ビッグラン' : 'サーモンラン'}`;

    //ステップ4: Embedオブジェクトを生成して返す
    const emb = {
        title: title,
        fields: [{
            name: 'ステージ',
            value: stageName,
            inline: true
        }, {
            name: 'オカシラ',
            value: bossName,
            inline: true
        }, {
            name: '期間(JST)',
            value: `${startStr} ～ ${endStr}`,
            inline: false
        }],
        timestamp: shiftData.start_time
    };
    if (shiftData?.stage?.image) {
        emb.thumbnail = {
            url: shiftData.stage.image
        };
    }
    return emb;
}

/**
 * @brief 直近3シフトのスケジュールを武器アイコン付きで投稿する。
 */
function postNextThreeShiftsWithWeapons() {
    //ステップ1: 必要なプロパティを読み込み、スケジュールAPIを取得
    const props = PropertiesService.getScriptProperties();
    const webhookUrl = props.getProperty(PROP_KEY_WEBHOOK);
    if (!webhookUrl) {
        throw new Error('プロパティ "discordWebhookUrl" が未設定');
    }
    const userAgent = props.getProperty(PROP_KEY_USER_AGENT) || DEFAULT_USER_AGENT;

    const scheduleData = fetchJson(API_SCHEDULE_URL, userAgent);
    const list = Array.isArray(scheduleData?.results) ? scheduleData.results : [];
    if (list.length === 0) {
        postToDiscord(webhookUrl, {
            content: '直近のサーモンラン予定取得失敗'
        });
        return;
    }

    //ステップ2: 直近3シフト分のEmbedを生成
    const head = list.slice(0, 3);
    const embeds = [];
    head.forEach((shift, idx) => {
        //各シフトの見出しEmbedを生成
        embeds.push(buildScheduleEmbedMain(shift, idx));
        //各シフトのブキEmbedを生成
        const weapons = (shift?.weapons || []).map(w => ({
            name: w?.name || '???',
            image: w?.image || null
        }));
        weapons.forEach(w => {
            embeds.push({
                author: {
                    name: w.name,
                    icon_url: w.image || undefined
                },
                description: '\u200B'
            });
        });
    });

    //ステップ3: Embedを分割してDiscordへ投稿
    //Discordの1投稿あたりのEmbed上限(10件)を超えないよう、配列を分割(chunk)してループ投稿。
    const avatar = getAvatarUrl();
    for (let i = 0; i < embeds.length; i += DISCORD_EMBED_LIMIT) {
        const chunk = embeds.slice(i, i + DISCORD_EMBED_LIMIT);
        postToDiscord(webhookUrl, {
            username: 'クマサン商会',
            ...(avatar ? {
                avatar_url: avatar
            } : {}),
            content: (i === 0 ? '直近3シフトのスケジュール' : '(続き)'),
            embeds: chunk
        });
    }
}

/**
 * @brief デバッグ用: 重複投稿防止キーを削除する。
 */
function debugResetLast() {
    //ステップ1: `lastShiftStart`プロパティを削除
    //これにより、次回の`postShiftNow`実行時に重複チェックを回避し、強制的に通知を再実行できる。
    PropertiesService.getScriptProperties().deleteProperty(PROP_KEY_LAST_START_TIME);
    Logger.log('プロパティ "' + PROP_KEY_LAST_START_TIME + '" を削除');
}

/**
 * @brief デバッグ用: 重複投稿防止をリセットして即時通知する。
 */
function postShiftNowForce() {
    //ステップ1: 重複投稿防止キーを削除
    debugResetLast();
    //ステップ2: 現在のシフト通知を即時実行
    postShiftNow();
}

/**
 * @brief デバッグ用: 次シフトの生JSONをログ出力する。
 */
function dryRunNext() {
    //ステップ1: APIから次回シフト情報を取得
    const ua = PropertiesService.getScriptProperties().getProperty(PROP_KEY_USER_AGENT) || DEFAULT_USER_AGENT;
    const next = getFirstResult(fetchJson(API_NEXT_URL, ua));
    //ステップ2: 取得したJSONを整形してログに出力
    //APIとの疎通確認や、データ構造の確認に使用。
    Logger.log(JSON.stringify(next, null, 2));
}