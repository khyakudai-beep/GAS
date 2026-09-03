// =============================================================================
// リプレイス依頼 Jira起票 Google Apps Script（アレンジ版）
// ver1.1 改訂0007ベース / 株式会社GA technologies リプレイス依頼対応
//
// 変更点（元スクリプトからの差分）:
//  - 対象シート        : 「リプレイス用」
//  - 起票条件          : 「Jiraチケット管理番号」が空 かつ 「送り状」に値あり
//  - チケットタイトル  : 固定「株式会社GA technologies:リプレイス依頼」
//  - 起票先プロジェクト   : JOM / issuetype 12313（Josys Service Request）
//  - 「新端末の発送日」→ customfield_14981（および duedate に同値を設定）
//  - 依頼種別/PC種別 は送信しない
//  - 企業名(14986)/opskey(14987)/担当者自動割当 は維持
//  - 新端末の発送日が実行日より前なら起票直後に「完了」へ遷移（transition id:51）
//  - チケット番号の出力（HYPERLINK）・ヘッダー行検出は既存踏襲
//  - Phase複数チケット生成ロジック（ディアーズブレイン様向け）は除去（1行=1チケット）
//  - ヘッダー名照合は改行/空白を無視する正規化マッチに変更（セル内改行対応）
// =============================================================================

// =============================================================================
// 定数設定セクション - メンテナンス時はここを編集してください
// =============================================================================

// JIRA関連設定
const JIRA_CONFIG = {
  BASE_URL: 'https://josys-outsource.atlassian.net',
  PROJECT_NAME: 'JOM',
  ISSUE_TYPE_STORY: '12313',          // Josys Service Request
  ISSUE_TYPE_STORY_CHILD: '10013',    // ※現状未使用（Phase生成ロジックは除去済み）
  DONE_TRANSITION_ID: '51'            // 「完了」への遷移ID
};

// スプレッドシート関連設定
const SHEET_CONFIG = {
  ASSIGNED_MEMBERS_SHEET_ID: '1HC9VdPBgopIXmNzkanM5k7Oa9f5vynCXGnAqM7qVNxs',
  MEMBER_LIST_SHEET_ID: '17dKm7GUSP-P8rTnReDgGC-RHFVS5odGUP1sW_usBBok',
  REQUEST_SHEET_NAME: 'リプレイス用',        // ← 対象シート名
  MEMBERLIST_SHEET_NAME: 'Memberlist',
  ASSIGNED_MEMBERS_SHEET_NAME: 'AssignedMembers'
};

// リプレイス依頼 固有設定
const REPLACE_CONFIG = {
  TICKET_TITLE: '株式会社GA technologies:リプレイス依頼',  // チケットタイトル（固定）
  TASK_TYPE_VALUE: 'キッティング（PC）'                    // タスク種別（customfield_15004）へ出力する固定値
};

// ヘッダー検出設定
const HEADER_CONFIG = {
  KEY_COLUMN: 'A',                              // ヘッダー検索の基準列
  KEY_VALUE: 'No.',                             // 検索するキー値
  DATA_START_COLUMN_NAME: 'Jiraチケット管理番号',  // description生成の開始基準カラム名
  // 動的カラム検索設定（照合は正規化マッチ：改行/空白を無視）
  COLUMN_MAPPING: {
    TICKET_NUMBER: 'Jiraチケット管理番号',  // 完全一致（正規化後）：起票済み判定＆リンク出力先
    SHIPPING: '送り状',                     // 部分一致（正規化後）：起票トリガー
    SHIPPING_DATE: '新端末の発送日'          // 完全一致（正規化後）：customfield_14981 / duedate
  }
};

// メンバー関連設定
const MEMBER_CONFIG = {
  DEFAULT_ASSIGNEE: 'Ryota Fujie',
  // メンバー名検索用のヘッダー候補
  MEMBER_HEADER_CANDIDATES: ['members', 'member', 'name', '名前', 'メンバー'],
  // ID検索用のヘッダー候補
  ID_HEADER_CANDIDATES: ['id', 'account_id', 'accountid', 'user_id', 'userid']
};

// カスタムフィールド設定
const CUSTOM_FIELDS = {
  CLIENT_NAME: 'customfield_14986',    // 企業名（クライアント名 A1）
  OPSKEY: 'customfield_14987',         // Opskey（C1の値）
  SHIPPING_DATE: 'customfield_14981',  // 新端末の発送日（duedate にも同値を設定）
                                       //   ※createmeta実測では 14981 の正式名は「完了日」。
                                       //     本来の「発送日」は customfield_12024。要確認事項。
  COMPLETION_DATE: 'customfield_14981',// 完了日（リースアップ返却で使用・日付）
  TASK_TYPE: 'customfield_15004'       // タスク種別（Checkboxes型）
};

// リースアップ返却 起票 固有設定
const LEASEUP_CONFIG = {
  REQUEST_SHEET_NAME: 'リースアップ用',                        // 対象シート名
  // タイトルはリプレイス用タイトルの「リプレイス」を「リースアップ返却」に置換したもの
  TICKET_TITLE: '株式会社GA technologies:リースアップ返却依頼',
  TASK_TYPE_VALUES: ['受領', '初期化', '発送のみ'],           // customfield_15004 へ固定で入れる値
  // 企業名(14986)/opskey(14987) はシートにセルが無いため固定値で送信（要確認）
  CLIENT_NAME: '株式会社GA technologies',
  OPSKEY: 'ga-tech',
  COLUMN_MAPPING: {
    TICKET_NUMBER: 'Jiraチケット管理番号',  // A列：起票トリガー（空の行が対象）＆リンク出力先
    ASSET: 'josys取得',                     // B列：資産（空白行の誤起票防止判定に使用）
    DATE: 'date'                            // C列：完了日(customfield_14981)へ出力
  }
};

// 退職休職リスト 起票 固有設定
const OFFBOARD_CONFIG = {
  REQUEST_SHEET_NAME: '退職休職リスト',       // 対象シート名
  TITLE_SUFFIX: '：退職休職対応',             // タイトル = 会社名 + この接尾辞（固定）
  EMAIL_TASK_TYPE: 'SaaS削除',               // メールアドレス由来チケットのタスク種別
  EMAIL_TICKET_COUNT: 2,                     // メールアドレスに値があれば作成する枚数
  COLUMN_MAPPING: {
    TICKET_NUMBER: 'Jiraチケット管理番号',  // A列：起票トリガー（空）＆リンク出力先
    REQUEST_TYPE: '依頼種別',               // F列：起票トリガー（値あり）
    EMAIL: 'ﾒｰﾙｱﾄﾞﾚｽ',                       // J列：値あり→SaaS削除チケット×2
    LAST_DAY: '最終出社日',                  // Q列：完了日(14981)/duedate（シリアル値変換）
    DEVICE: 'ﾃﾞﾊﾞｲｽ'                         // W列：値あり→デバイスチケット×1（種別算出）
  }
};

// =============================================================================
// システム変数 - 通常は変更不要
// =============================================================================

// JIRA認証情報（PropertiesServiceから取得）
var id = PropertiesService.getScriptProperties().getProperty('id');
var jiraTokenId = PropertiesService.getScriptProperties().getProperty('jiraTokenId');

// 認証情報の存在チェック
Logger.log('=== JIRA認証情報チェック ===');
Logger.log('ID取得結果: ' + (id ? '[設定済み]' : '[未設定]'));
Logger.log('Token ID取得結果: ' + (jiraTokenId ? '[設定済み]' : '[未設定]'));

if (!id) {
    throw new Error('JIRA認証用のIDが設定されていません。PropertiesServiceで "id" を設定してください。');
}

if (!jiraTokenId) {
    throw new Error('JIRA認証用のTokenが設定されていません。PropertiesServiceで "jiraTokenId" を設定してください。');
}

var token = Utilities.base64Encode(id + ":" + jiraTokenId);
Logger.log('認証トークン生成完了');

// グローバル変数
var count = 0;
var e;
var memberAccountMap = {};      // メンバーリストとアカウントIDのマッピング
var companyAssigneeMap = {};    // 企業と担当者のマッピング

// =============================================================================
// 動的ヘッダー検出ライブラリ
// =============================================================================

/**
 * ヘッダー行を特定し、列のマッピング情報を取得する
 */
function getHeaderMapping(sheet, keyColumn = HEADER_CONFIG.KEY_COLUMN, keyValue = HEADER_CONFIG.KEY_VALUE) {
  try {
    const headerRowIndex = findHeaderRow(sheet, keyColumn, keyValue);

    if (headerRowIndex === -1) {
      throw new Error(`"${keyValue}" が ${keyColumn} 列で見つかりませんでした`);
    }

    const headerData = getHeaderRowData(sheet, headerRowIndex);
    const mapping = createHeaderMapping(headerData, headerRowIndex);

    return mapping;

  } catch (error) {
    console.error('ヘッダー取得エラー:', error);
    throw error;
  }
}

/**
 * 指定された列で指定された値を検索し、行番号を返す
 */
function findHeaderRow(sheet, column, value) {
  const columnIndex = columnLetterToIndex(column);
  const columnData = sheet.getRange(1, columnIndex, sheet.getLastRow(), 1).getValues();

  for (let i = 0; i < columnData.length; i++) {
    if (columnData[i][0] === value) {
      return i + 1; // 1ベースの行番号を返す
    }
  }

  return -1; // 見つからない場合
}

/**
 * 指定された行のヘッダーデータを取得（値が入力されている最終列まで）
 */
function getHeaderRowData(sheet, rowIndex) {
  const maxColumns = sheet.getLastColumn();
  const headerRow = sheet.getRange(rowIndex, 1, 1, maxColumns).getValues()[0];

  // 最後の有効な値の位置を見つける
  let lastDataColumn = 0;
  for (let i = headerRow.length - 1; i >= 0; i--) {
    if (headerRow[i] !== null && headerRow[i] !== undefined && headerRow[i] !== '') {
      lastDataColumn = i + 1;
      break;
    }
  }

  return headerRow.slice(0, lastDataColumn);
}

/**
 * ヘッダーマッピング情報を作成
 */
function createHeaderMapping(headerData, rowIndex) {
  const mapping = {
    headerRow: rowIndex,
    columnCount: headerData.length,
    headers: {},
    headerArray: headerData,
    columnLetters: {}
  };

  // 各ヘッダーに対して列番号と列文字を設定
  for (let i = 0; i < headerData.length; i++) {
    const header = headerData[i];
    const columnIndex = i + 1; // 1ベースの列番号
    const columnLetter = indexToColumnLetter(columnIndex);

    if (header !== null && header !== undefined && header !== '') {
      mapping.headers[header] = {
        columnIndex: columnIndex,
        columnLetter: columnLetter,
        value: header
      };
      mapping.columnLetters[columnLetter] = header;
    }
  }

  return mapping;
}

/**
 * 列文字を列番号に変換（A=1, B=2, ...）
 */
function columnLetterToIndex(letter) {
  let result = 0;
  for (let i = 0; i < letter.length; i++) {
    result = result * 26 + (letter.charCodeAt(i) - 'A'.charCodeAt(0) + 1);
  }
  return result;
}

/**
 * 列番号を列文字に変換（1=A, 2=B, ...）
 */
function indexToColumnLetter(index) {
  let result = '';
  while (index > 0) {
    index--;
    result = String.fromCharCode('A'.charCodeAt(0) + (index % 26)) + result;
    index = Math.floor(index / 26);
  }
  return result;
}

/**
 * ヘッダーマッピングから指定されたカラム名の列番号を取得する（部分一致対応）
 * ※既存踏襲。厳密な文字列一致が必要な場合に使用。
 */
function findColumnIndex(headerMapping, targetColumnName, partialMatch = false) {
  for (let i = 0; i < headerMapping.columnCount; i++) {
    const headerName = headerMapping.headerArray[i];

    if (headerName && typeof headerName === 'string') {
      if (partialMatch) {
        if (headerName.includes(targetColumnName)) {
          return i;
        }
      } else {
        if (headerName === targetColumnName) {
          return i;
        }
      }
    }
  }

  return -1;
}

/**
 * ヘッダー名照合（正規化版）
 * セル内改行・空白（半角/全角/タブ）を無視して照合する。
 * 例: ヘッダーセルが「Jiraチケット\n管理番号」でも「Jiraチケット管理番号」で一致する。
 */
function findColumnIndexNormalized(headerMapping, targetColumnName, partialMatch = false) {
  const normalize = (s) => s.toString().replace(/[\s　]/g, '');
  const target = normalize(targetColumnName);

  for (let i = 0; i < headerMapping.columnCount; i++) {
    const headerName = headerMapping.headerArray[i];

    if (headerName && typeof headerName === 'string') {
      const h = normalize(headerName);
      if (partialMatch ? h.indexOf(target) !== -1 : h === target) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * 設定されたカラムマッピングに基づいて列インデックスを取得する
 * （すべて正規化マッチ：セル内改行/空白に耐性）
 */
function getColumnIndexes(headerMapping) {
  const columnIndexes = {};

  // Jiraチケット管理番号（完全一致・正規化）
  columnIndexes.TICKET_NUMBER = findColumnIndexNormalized(headerMapping, HEADER_CONFIG.COLUMN_MAPPING.TICKET_NUMBER, false);

  // 送り状（部分一致・正規化）＝起票トリガー
  columnIndexes.SHIPPING = findColumnIndexNormalized(headerMapping, HEADER_CONFIG.COLUMN_MAPPING.SHIPPING, true);

  // 新端末の発送日（完全一致・正規化）
  columnIndexes.SHIPPING_DATE = findColumnIndexNormalized(headerMapping, HEADER_CONFIG.COLUMN_MAPPING.SHIPPING_DATE, false);

  Logger.log('列インデックス検出: TICKET_NUMBER=' + columnIndexes.TICKET_NUMBER +
             ', SHIPPING=' + columnIndexes.SHIPPING +
             ', SHIPPING_DATE=' + columnIndexes.SHIPPING_DATE);

  return columnIndexes;
}

/**
 * 特定のヘッダーの列情報を取得
 */
function getColumnInfo(mapping, headerName) {
  return mapping.headers[headerName] || null;
}

// =============================================================================
// メンバー・担当者管理
// =============================================================================

function loadMemberAccountMap() {
    var spreadsheet = SpreadsheetApp.openById(SHEET_CONFIG.MEMBER_LIST_SHEET_ID);
    var memberSheet = spreadsheet.getSheetByName(SHEET_CONFIG.MEMBERLIST_SHEET_NAME);

    if (!memberSheet) {
        console.log('メンバーリストシートが見つかりません');
        return;
    }

    var lastRow = memberSheet.getLastRow();
    if (lastRow < 2) { // ヘッダー行 + データ行が最低限必要
        console.log('メンバーリストにデータがありません');
        return;
    }

    // ヘッダー行（1行目）を取得してカラムの位置を特定
    var lastColumn = memberSheet.getLastColumn();
    var headers = memberSheet.getRange(1, 1, 1, lastColumn).getValues()[0];

    // "Members"と"id"のカラム位置を検索
    var memberColumnIndex = -1;
    var idColumnIndex = -1;

    for (var i = 0; i < headers.length; i++) {
        var header = headers[i].toString().trim().toLowerCase();

        // メンバー名のカラムを検索（複数の候補に対応）
        if (MEMBER_CONFIG.MEMBER_HEADER_CANDIDATES.includes(header)) {
            memberColumnIndex = i;
            Logger.log('メンバー名カラムを発見: ' + (i + 1) + '列目 (' + headers[i] + ')');
        }

        // IDのカラムを検索（複数の候補に対応）
        if (MEMBER_CONFIG.ID_HEADER_CANDIDATES.includes(header)) {
            idColumnIndex = i;
            Logger.log('IDカラムを発見: ' + (i + 1) + '列目 (' + headers[i] + ')');
        }
    }

    // 必要なカラムが見つからない場合のエラーハンドリング
    if (memberColumnIndex === -1) {
        console.log('エラー: メンバー名のカラムが見つかりません。ヘッダーに "' + MEMBER_CONFIG.MEMBER_HEADER_CANDIDATES.join('", "') + '" のいずれかを設定してください。');
        Logger.log('現在のヘッダー: ' + JSON.stringify(headers));
        return;
    }

    if (idColumnIndex === -1) {
        console.log('エラー: IDのカラムが見つかりません。ヘッダーに "' + MEMBER_CONFIG.ID_HEADER_CANDIDATES.join('", "') + '" のいずれかを設定してください。');
        Logger.log('現在のヘッダー: ' + JSON.stringify(headers));
        return;
    }

    // データ行（2行目以降）を取得
    var memberData = memberSheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();

    // マッピングを構築
    var mappingCount = 0;
    for (var i = 0; i < memberData.length; i++) {
        var memberName = memberData[i][memberColumnIndex];
        var memberId = memberData[i][idColumnIndex];

        // 両方の値が存在する場合のみマッピングに追加
        if (memberName && memberId) {
            memberAccountMap[memberName] = memberId;
            mappingCount++;
            Logger.log('マッピング追加: "' + memberName + '" -> "' + memberId + '"');
        } else {
            Logger.log('スキップ: ' + (i + 2) + '行目 - メンバー名: "' + memberName + '", ID: "' + memberId + '"');
        }
    }

    Logger.log("メンバーアカウントマップをロードしました (" + mappingCount + "件): " + JSON.stringify(memberAccountMap));
    console.log("メンバーアカウントマップを" + mappingCount + "件ロードしました");
}

/**
 * 動的列数対応版 - 企業担当者マッピング読み込み機能
 * AssignedMembersシートの全列を動的に処理
 */
function loadCompanyAssigneeMap() {
    var spreadsheet = SpreadsheetApp.openById(SHEET_CONFIG.ASSIGNED_MEMBERS_SHEET_ID);
    var memberlistSheet = spreadsheet.getSheetByName(SHEET_CONFIG.ASSIGNED_MEMBERS_SHEET_NAME);

    if (!memberlistSheet) {
        console.log('AssignedMembersシートが見つかりません');
        return;
    }

    // シートの最後の列を取得（動的に列数を決定）
    var lastColumn = memberlistSheet.getLastColumn();
    Logger.log('AssignedMembersシートの最後の列: ' + lastColumn);

    if (lastColumn < 1) {
        console.log('AssignedMembersシートにデータがありません');
        return;
    }

    // 1行目: チーム名（全列を取得）
    var teamNames = memberlistSheet.getRange(1, 1, 1, lastColumn).getValues()[0];

    // 2行目: 担当者名（全列を取得）
    var assigneeNames = memberlistSheet.getRange(2, 1, 1, lastColumn).getValues()[0];

    // チーム/担当者マッピングをログ出力
    var mappingLog = [];
    for (var col = 0; col < lastColumn; col++) {
        if (teamNames[col] && assigneeNames[col]) {
            mappingLog.push(teamNames[col] + "/" + assigneeNames[col]);
        }
    }
    Logger.log("チーム/担当者マッピング (" + mappingLog.length + "組): " + mappingLog.join(", "));

    // 3行目以降: 企業名リスト
    var lastRow = memberlistSheet.getLastRow();
    if (lastRow < 3) {
        console.log('AssignedMembersシートに企業データがありません');
        return;
    }

    // 各列の担当者情報を動的に処理
    var totalCompanies = 0;

    for (var col = 1; col <= lastColumn; col++) {
        var colLetter = indexToColumnLetter(col); // 1→A, 2→B, 3→C, ...
        var assignee = assigneeNames[col - 1]; // 配列は0ベースなので-1
        var teamName = teamNames[col - 1];

        // 担当者名が設定されていない列はスキップ
        if (!assignee || assignee.toString().trim() === "") {
            Logger.log(colLetter + '列: 担当者が設定されていないためスキップ');
            continue;
        }

        Logger.log('=== ' + colLetter + '列の処理開始 ===');
        Logger.log('チーム名: ' + (teamName || '(未設定)'));
        Logger.log('担当者: ' + assignee);

        // 3行目以降の企業名を取得
        var companies = memberlistSheet.getRange(3, col, lastRow - 2, 1).getValues();
        var columnCompanyCount = 0;

        for (var i = 0; i < companies.length; i++) {
            var company = companies[i][0];

            if (company && company.toString().trim() !== "") {
                // 既存の企業が他の列で設定されている場合は警告
                if (companyAssigneeMap[company]) {
                    Logger.log('警告: 企業 "' + company + '" は既に "' + companyAssigneeMap[company] + '" に割り当てられています。上書きします。');
                }

                companyAssigneeMap[company] = assignee;
                columnCompanyCount++;
                totalCompanies++;

                Logger.log('企業 "' + company + '" → 担当者 "' + assignee + '"');
            }
        }

        Logger.log(colLetter + '列の企業登録数: ' + columnCompanyCount + '社');
    }

    Logger.log('=== 企業担当者マッピング読み込み完了 ===');
    Logger.log('総処理列数: ' + lastColumn);
    Logger.log('総企業登録数: ' + totalCompanies + '社');
    Logger.log('最終マップ: ' + JSON.stringify(companyAssigneeMap));
    console.log("企業担当者マップを" + totalCompanies + "社ロードしました（" + lastColumn + "列処理）");
}

/**
 * デバッグ用：現在の企業担当者マッピングを表示
 */
function debugCompanyAssigneeMap() {
    loadMemberAccountMap();
    loadCompanyAssigneeMap();

    console.log('=== 企業担当者マッピング一覧 ===');
    var companies = Object.keys(companyAssigneeMap);

    if (companies.length === 0) {
        console.log('マッピングデータがありません');
        return;
    }

    // 担当者別に企業をグループ化
    var assigneeGroups = {};
    for (var company of companies) {
        var assignee = companyAssigneeMap[company];
        if (!assigneeGroups[assignee]) {
            assigneeGroups[assignee] = [];
        }
        assigneeGroups[assignee].push(company);
    }

    // 担当者別に表示
    for (var assignee in assigneeGroups) {
        console.log('担当者: ' + assignee + ' (' + assigneeGroups[assignee].length + '社)');
        for (var company of assigneeGroups[assignee]) {
            console.log('  - ' + company);
        }
    }

    console.log('合計: ' + companies.length + '社が登録されています');
}

/**
 * 特定の企業の担当者を確認する関数
 */
function checkCompanyAssignee(companyName) {
    loadMemberAccountMap();
    loadCompanyAssigneeMap();

    var assignee = companyAssigneeMap[companyName];
    if (assignee) {
        var accountId = memberAccountMap[assignee];
        console.log('企業: ' + companyName);
        console.log('担当者: ' + assignee);
        console.log('アカウントID: ' + (accountId || '見つかりません'));
        return {
            company: companyName,
            assignee: assignee,
            accountId: accountId
        };
    } else {
        console.log('企業 "' + companyName + '" は登録されていません');
        console.log('デフォルト担当者 "' + MEMBER_CONFIG.DEFAULT_ASSIGNEE + '" が使用されます');
        return {
            company: companyName,
            assignee: MEMBER_CONFIG.DEFAULT_ASSIGNEE,
            accountId: memberAccountMap[MEMBER_CONFIG.DEFAULT_ASSIGNEE]
        };
    }
}

function getAssigneeAccountId(opskey) {
    if (!opskey) {
        Logger.log("opskeyが指定されていないため、デフォルト担当者を設定します: " + MEMBER_CONFIG.DEFAULT_ASSIGNEE);
        var accountId = memberAccountMap[MEMBER_CONFIG.DEFAULT_ASSIGNEE];
        return accountId || null;
    }

    // opskeyに対応する担当者を取得
    var assigneeName = companyAssigneeMap[opskey];

    // 担当者が見つからない場合はデフォルト担当者を設定
    if (!assigneeName) {
        Logger.log("opskey '" + opskey + "' の担当者が見つからないため、デフォルト担当者を設定します: " + MEMBER_CONFIG.DEFAULT_ASSIGNEE);
        assigneeName = MEMBER_CONFIG.DEFAULT_ASSIGNEE;
    } else {
        Logger.log("opskey '" + opskey + "' の担当者: " + assigneeName);
    }

    // 担当者のアカウントIDを取得
    var accountId = memberAccountMap[assigneeName];

    if (!accountId) {
        Logger.log("警告: " + assigneeName + "のアカウントIDが見つかりません。担当者は設定されません。");
        return null;
    }

    Logger.log("担当者 '" + assigneeName + "' のアカウントID: " + accountId);
    return accountId;
}

// =============================================================================
// メイン処理
// =============================================================================

function kittingRequest(sheetId, sheetURL, targetSheetName) {
   targetSheetName = targetSheetName || SHEET_CONFIG.REQUEST_SHEET_NAME;  // 既定は「リプレイス用」
   try {
       loadMemberAccountMap();
       loadCompanyAssigneeMap();

       var spreadsheet = SpreadsheetApp.openById(sheetId);
       const storySheet = spreadsheet.getSheetByName(targetSheetName)
       createStory(storySheet, sheetURL)
       data = storySheet.getRange(1, 1).getValues();
       var clientName = data[0][0]  // A1: クライアント名
       if (count > 0) {
           console.log(clientName + count + "件の依頼を送信しました。")
           storySheet.getRange(1, 2).setValue(new Date)  // B1: 送信日時
       } else {
           console.log(clientName + "依頼送信条件に当てはまる行がありません。")
       }
   } catch (e) {
       console.log('システムエラーを検知しました。');
       console.log('エラー内容：' + e.message);
   }
}

function createStory(storySheet, sheetURL) {
    // 動的ヘッダーマッピングを取得（ヘッダー行検出は既存踏襲）
    var headerMapping = getHeaderMapping(storySheet, HEADER_CONFIG.KEY_COLUMN, HEADER_CONFIG.KEY_VALUE);
    Logger.log('ヘッダーマッピング取得成功 - ヘッダー行: ' + headerMapping.headerRow);

    // カラムインデックスを動的に取得
    var columnIndexes = getColumnIndexes(headerMapping);

    lastColumn = storySheet.getLastColumn()
    Logger.log(lastColumn)
    data = storySheet.getRange(1, 1, storySheet.getLastRow(), lastColumn).getValues();

    var clientName = data[0][0]      // A1: クライアント名
    var opskey = data[0][2]          // C1: opskey
    Logger.log("依頼管理簿シートのC1に格納されているopskey: " + opskey)

    // opskeyから担当者のアカウントIDを先に取得
    var assigneeAccountId = getAssigneeAccountId(opskey);
    Logger.log("チケットの担当者アカウントID: " + assigneeAccountId)

    var customFieldValue = data[0][2] // C1: opskey

    // "No."カラムでの値"1"を検索して処理開始行を決定（既存踏襲）
    var noColumnIndex = findColumnIndex(headerMapping, 'No.', false);
    var dataStartRow = headerMapping.headerRow + 1; // デフォルトはヘッダーの次の行

    if (noColumnIndex >= 0) {
        Logger.log('"No."カラムが見つかりました (列' + (noColumnIndex + 1) + ')');

        // "No."カラムで値"1"を検索
        for (var searchIndex = headerMapping.headerRow; searchIndex < data.length; searchIndex++) {
            var noValue = data[searchIndex][noColumnIndex];
            if (noValue && noValue.toString() === "1") {
                dataStartRow = searchIndex + 1; // スプレッドシートの行番号（1ベース）
                Logger.log('"No."カラムで値"1"を発見: ' + (searchIndex + 1) + '行目');
                Logger.log('処理開始行を' + dataStartRow + '行目に設定');
                break;
            }
        }

        if (dataStartRow === headerMapping.headerRow + 1) {
            Logger.log('警告: "No."カラムで値"1"が見つかりませんでした。ヘッダーの次の行から処理を開始します');
        }
    } else {
        Logger.log('警告: "No."カラムが見つかりませんでした。ヘッダーの次の行から処理を開始します');
    }

    Logger.log('最終的な処理開始行: ' + dataStartRow + '行目 (配列インデックス: ' + (dataStartRow - 1) + ')');

    // 一括ハイパーリンク設定用の配列
    var hyperlinkUpdates = [];

    // データの処理を "1" が見つかった行以降から開始
    for (var i = dataStartRow - 1; i < data.length; i++) { // 配列インデックス用に-1

        // 起票条件① 「Jiraチケット管理番号」が空
        var ticketNumberEmpty = columnIndexes.TICKET_NUMBER >= 0 &&
                                (data[i][columnIndexes.TICKET_NUMBER] === null ||
                                 data[i][columnIndexes.TICKET_NUMBER] === undefined ||
                                 data[i][columnIndexes.TICKET_NUMBER].toString().length === 0);

        // 起票条件② 「送り状」に値がある
        var hasShipping = columnIndexes.SHIPPING >= 0 &&
                          data[i][columnIndexes.SHIPPING] !== null &&
                          data[i][columnIndexes.SHIPPING] !== undefined &&
                          data[i][columnIndexes.SHIPPING].toString().trim().length > 0;

        // 起票条件③ 「新端末の発送日」に値がある
        var hasShippingDate = columnIndexes.SHIPPING_DATE >= 0 &&
                              data[i][columnIndexes.SHIPPING_DATE] !== null &&
                              data[i][columnIndexes.SHIPPING_DATE] !== undefined &&
                              data[i][columnIndexes.SHIPPING_DATE].toString().trim().length > 0;

        // チケット番号が空 かつ 送り状に値あり かつ 新端末の発送日に値あり の場合のみ起票
        if (ticketNumberEmpty && hasShipping && hasShippingDate) {

            // チケットタイトルは固定
            summary = REPLACE_CONFIG.TICKET_TITLE

            // 「新端末の発送日」→ customfield_10038 と duedate に使用
            var shippingDateValue = columnIndexes.SHIPPING_DATE >= 0 ? data[i][columnIndexes.SHIPPING_DATE] : null;
            var shippingDate;
            if (shippingDateValue && isDate(shippingDateValue)) {
                shippingDate = Utilities.formatDate(shippingDateValue, `JST`, `yyyy-MM-dd`)
            } else {
                shippingDate = Utilities.formatDate(new Date(), `JST`, `yyyy-MM-dd`)
                // 発送日が日付として入力されていない場合はシステム日付を設定
            }
            dueDate = shippingDate  // duedate は発送日を使用

            description = createDescription(i, data, sheetURL, headerMapping)

            var createdTickets = []; // この行で作成された全チケットを記録

            try {
                // チケットを1件作成
                json = getStoryIssueJson(summary, description, dueDate, clientName, customFieldValue, shippingDate, assigneeAccountId)
                ret = postStoryIssue(json)

                Logger.log('=== チケット作成成功 ===');
                Logger.log('作成されたチケットキー: ' + ret['key']);

                createdTickets.push({
                    key: ret['key'],
                    url: JIRA_CONFIG.BASE_URL + '/browse/' + ret['key']
                });

                // 新端末の発送日が実行日より前の日付なら、起票直後に「完了」へ遷移
                //   shippingDate は 'yyyy-MM-dd'（発送日未入力時は当日）→ 当日==当日は遷移しない
                var todayStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');
                if (shippingDate < todayStr) {
                    try {
                        transitionIssue(ret['key'], JIRA_CONFIG.DONE_TRANSITION_ID);
                        Logger.log('発送日(' + shippingDate + ')が実行日(' + todayStr + ')より前のため「完了」へ遷移しました: ' + ret['key']);
                    } catch (transitionError) {
                        Logger.log('完了遷移エラー (' + ret['key'] + '): ' + transitionError.message);
                        // 遷移に失敗してもチケット自体は作成済みなので処理は続行
                    }
                }

                // 作成したチケット番号を「即座に」シートへ書き戻す
                //   ※ ループ末尾での一括書き戻しだと、途中でキャンセル/エラーになった場合に
                //     Jiraにはチケットが作られたのにシートは空のまま残り、再実行で重複起票になる。
                //     それを防ぐため 1件作成するたびに書き込み＆flushして確定させる。
                if (columnIndexes.TICKET_NUMBER >= 0 && createdTickets.length > 0) {
                    var ticket = createdTickets[0];
                    var cell = storySheet.getRange(i + 1, columnIndexes.TICKET_NUMBER + 1);
                    cell.setFormula('=HYPERLINK("' + ticket.url + '","' + ticket.key + '")');
                    SpreadsheetApp.flush(); // この行の記録を即時確定（重複防止の要）
                    Logger.log('行' + (i + 1) + ' にチケット番号を書き戻し: ' + ticket.key);
                }

                count++

            } catch (error) {
                Logger.log('チケット作成エラー (行' + (i + 1) + '): ' + error.message)
                // エラーが発生しても処理を続行
            }
        }
    }

    // 一括ハイパーリンク設定処理（既存踏襲）
    if (hyperlinkUpdates.length > 0) {
        Logger.log('=== 一括ハイパーリンク設定開始 ===');
        Logger.log('更新対象: ' + hyperlinkUpdates.length + '件');

        try {
            for (var j = 0; j < hyperlinkUpdates.length; j++) {
                var update = hyperlinkUpdates[j];
                var cell = storySheet.getRange(update.row, update.column);

                if (update.isMultiple) {
                    // 複数チケットの場合: リッチテキスト形式で設定
                    var richTextValue = SpreadsheetApp.newRichTextValue();
                    var fullText = '';
                    var textParts = [];

                    for (var k = 0; k < update.tickets.length; k++) {
                        var ticket = update.tickets[k];

                        if (k > 0) {
                            fullText += '\n';
                        }

                        var startIndex = fullText.length;
                        fullText += ticket.key;
                        var endIndex = fullText.length;

                        textParts.push({
                            start: startIndex,
                            end: endIndex,
                            url: ticket.url
                        });
                    }

                    richTextValue.setText(fullText);

                    for (var k = 0; k < textParts.length; k++) {
                        var part = textParts[k];
                        richTextValue.setLinkUrl(part.start, part.end, part.url);
                    }

                    cell.setRichTextValue(richTextValue.build());
                    cell.setWrap(true);

                } else {
                    // 単一チケットの場合: HYPERLINK関数
                    cell.setFormula(update.formula);
                }
            }

            Logger.log('=== 一括ハイパーリンク設定完了 ===');
            console.log(hyperlinkUpdates.length + '件のチケット番号にハイパーリンクを設定しました');

        } catch (error) {
            Logger.log('一括ハイパーリンク設定エラー: ' + error.message);
            console.log('ハイパーリンク設定でエラーが発生しました: ' + error.message);
        }
    }

    return count
}

function isDate(d) {
  if ( Object.prototype.toString.call(d) == "[object Date]" ){
    return true;
  }
  return false;
}

/**
 * 動的ヘッダーマッピングを使用した説明文作成
 * 「Jiraチケット管理番号」の次の列から開始（既存踏襲・正規化マッチ対応）
 */
function createDescription(i, data, sheetURL, headerMapping) {
    var description = ""

    // ヘッダー行のデータを取得
    var headerRow = headerMapping.headerRow - 1; // 配列インデックス用に-1

    // 開始カラム「Jiraチケット管理番号」の列番号を動的に取得（正規化マッチ）
    var ticketColumnIndex = findColumnIndexNormalized(headerMapping, HEADER_CONFIG.DATA_START_COLUMN_NAME, false);

    var startColumnIndex;
    if (ticketColumnIndex === -1) {
        startColumnIndex = 0; // 見つからない場合は最初から
    } else {
        startColumnIndex = ticketColumnIndex + 1; // 基準カラムの次の列から開始
    }

    // 指定された開始列から最後まで処理
    for (var n = startColumnIndex; n < headerMapping.columnCount; n++) {
        var headerName = data[headerRow][n];
        var cellValue = data[i][n];

        if (headerName && headerName.toString().trim() !== '') {
            description += headerName + "：" + (cellValue || '') + "\r\n";
        }
    }

    description = description + sheetURL
    return description
}

// =============================================================================
// JIRA API処理
// =============================================================================

function postStoryIssue(json) {
    var requestUrl = JIRA_CONFIG.BASE_URL + '/rest/api/2/issue';
    Logger.log(requestUrl)
    var options = {
        method: 'post',
        payload: json,
        contentType: 'application/json',
        headers: { 'Authorization': ' Basic ' + token },
        muteHttpExceptions: true
    }
    response = UrlFetchApp.fetch(requestUrl, options)
    const responseCode = response.getResponseCode();
    const responseBody = response.getContentText();
    if (responseCode != 201) {
        // issueをPOSTで叩いた場合201以外はエラー扱いとする
        throw new Error('エラーが発生しました(code:' + responseCode + ' responseBody:' + responseBody + ')');
    }
    result = JSON.parse(responseBody);
    return result
}

/**
 * 指定チケットを指定transitionIdで遷移させる（例: 「完了」へ遷移）
 * transitions API は成功時 204 No Content を返す。
 */
function transitionIssue(issueKey, transitionId) {
    var requestUrl = JIRA_CONFIG.BASE_URL + '/rest/api/2/issue/' + issueKey + '/transitions';
    var payload = JSON.stringify({ "transition": { "id": String(transitionId) } });
    var options = {
        method: 'post',
        payload: payload,
        contentType: 'application/json',
        headers: { 'Authorization': ' Basic ' + token },
        muteHttpExceptions: true
    };
    var response = UrlFetchApp.fetch(requestUrl, options);
    var responseCode = response.getResponseCode();
    if (responseCode != 204) {
        throw new Error('遷移エラーが発生しました(code:' + responseCode + ' responseBody:' + response.getContentText() + ')');
    }
    return true;
}

// =============================================================================
// リースアップ返却 起票処理
//   対象シート「リースアップ用」（列: A=Jiraチケット管理番号 / B=josys取得 / C=date）
//   ・起票条件 : A列（Jiraチケット管理番号）が空の行（空白行の誤起票防止のため
//               josys取得 または date に値がある行のみ）
//   ・送信値   : タスク種別(15004)=受領/初期化/発送のみ（固定）、完了日(14981)=C列 date
//   ・タイトル : 「株式会社GA technologies:リースアップ返却依頼」
//   ・作成後   : A列にHYPERLINKを即時書き戻し → 無条件で「完了」へ遷移(id 51)
// =============================================================================

/**
 * リースアップ返却 起票エントリポイント
 * @param {string} sheetId          対象スプレッドシートID
 * @param {string} sheetURL         スプレッドシートURL（現状未使用・将来用）
 * @param {string} targetSheetName  対象シート名（省略時は「リースアップ用」）
 */
function leaseUpRequest(sheetId, sheetURL, targetSheetName) {
    targetSheetName = targetSheetName || LEASEUP_CONFIG.REQUEST_SHEET_NAME;
    try {
        var spreadsheet = SpreadsheetApp.openById(sheetId);
        var sheet = spreadsheet.getSheetByName(targetSheetName);
        if (!sheet) {
            console.log('対象シートが見つかりません: ' + targetSheetName);
            return;
        }
        var created = createLeaseUpStory(sheet);
        if (created > 0) {
            console.log('リースアップ返却: ' + created + '件の依頼を送信しました。');
        } else {
            console.log('リースアップ返却: 送信条件に当てはまる行がありません。');
        }
    } catch (e) {
        console.log('システムエラーを検知しました。');
        console.log('エラー内容：' + e.message);
    }
}

function createLeaseUpStory(sheet) {
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) {
        Logger.log('リースアップ: シートにデータがありません');
        return 0;
    }
    var data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();

    var normalize = function (s) { return s == null ? '' : s.toString().replace(/[\s　]/g, ''); };
    var targetTicket = normalize(LEASEUP_CONFIG.COLUMN_MAPPING.TICKET_NUMBER);
    var targetAsset  = normalize(LEASEUP_CONFIG.COLUMN_MAPPING.ASSET);
    var targetDate   = normalize(LEASEUP_CONFIG.COLUMN_MAPPING.DATE);

    // ヘッダー行と各列を検出（「Jiraチケット管理番号」を含む行をヘッダーとみなす）
    var headerRow = -1, ticketCol = -1, assetCol = -1, dateCol = -1;
    for (var r = 0; r < data.length && headerRow === -1; r++) {
        for (var c = 0; c < data[r].length; c++) {
            if (normalize(data[r][c]) === targetTicket) { headerRow = r; ticketCol = c; break; }
        }
    }
    if (headerRow === -1) {
        throw new Error('「Jiraチケット管理番号」ヘッダーが見つかりませんでした');
    }
    for (var c2 = 0; c2 < data[headerRow].length; c2++) {
        var hv = normalize(data[headerRow][c2]);
        if (hv === targetAsset) assetCol = c2;
        if (hv === targetDate)  dateCol = c2;
    }
    Logger.log('リースアップ ヘッダー行=' + (headerRow + 1) +
               ' / TICKET列=' + (ticketCol + 1) +
               ' / ASSET列=' + (assetCol + 1) +
               ' / DATE列=' + (dateCol + 1));

    var summary = LEASEUP_CONFIG.TICKET_TITLE;
    var createdCount = 0;

    for (var i = headerRow + 1; i < data.length; i++) {
        // 起票条件：Jiraチケット管理番号が空
        var ticketEmpty = data[i][ticketCol] === null ||
                          data[i][ticketCol] === undefined ||
                          data[i][ticketCol].toString().trim().length === 0;

        // 空白行の誤起票防止：josys取得 または date に値がある行のみ対象
        var hasAsset = assetCol >= 0 && data[i][assetCol] != null && data[i][assetCol].toString().trim().length > 0;
        var hasDate  = dateCol  >= 0 && data[i][dateCol]  != null && data[i][dateCol].toString().trim().length > 0;

        if (ticketEmpty && (hasAsset || hasDate)) {
            var completionDate = dateCol >= 0 ? formatDateOrNull(data[i][dateCol]) : null;

            try {
                var ret = postStoryIssue(getLeaseUpIssueJson(summary, completionDate));
                Logger.log('リースアップ起票成功: ' + ret['key']);

                // チケット番号を即時書き戻し（重複防止の要）
                var url = JIRA_CONFIG.BASE_URL + '/browse/' + ret['key'];
                sheet.getRange(i + 1, ticketCol + 1).setFormula('=HYPERLINK("' + url + '","' + ret['key'] + '")');
                SpreadsheetApp.flush();
                Logger.log('行' + (i + 1) + ' にチケット番号を書き戻し: ' + ret['key']);

                // 起票 → 完了 へ無条件で自動遷移
                try {
                    transitionIssue(ret['key'], JIRA_CONFIG.DONE_TRANSITION_ID);
                    Logger.log('「完了」へ遷移しました: ' + ret['key']);
                } catch (transitionError) {
                    Logger.log('完了遷移エラー (' + ret['key'] + '): ' + transitionError.message);
                }

                createdCount++;
            } catch (error) {
                Logger.log('リースアップ起票エラー (行' + (i + 1) + '): ' + error.message);
            }
        }
    }
    return createdCount;
}

/**
 * リースアップ返却用 起票JSON生成
 *   summary / project / issuetype（必須）＋ タスク種別(15004) ＋ 完了日(14981)
 */
function getLeaseUpIssueJson(summary, completionDate) {
    var fields = {
        "summary": summary,
        "project":   { "key": JIRA_CONFIG.PROJECT_NAME },
        "issuetype": { "id": JIRA_CONFIG.ISSUE_TYPE_STORY },
        // 企業名(14986)/Opskey(14987)：固定値
        [CUSTOM_FIELDS.CLIENT_NAME]: LEASEUP_CONFIG.CLIENT_NAME,
        [CUSTOM_FIELDS.OPSKEY]:      LEASEUP_CONFIG.OPSKEY,
        // タスク種別（Checkboxes）：受領・初期化・発送のみ（固定）
        [CUSTOM_FIELDS.TASK_TYPE]: LEASEUP_CONFIG.TASK_TYPE_VALUES.map(function (v) {
            return { "value": v };
        })
    };
    // 完了日（customfield_14981・日付）と duedate に date の値を出力。
    // date列が空/解釈不能なら両方とも送らない。
    if (completionDate) {
        fields[CUSTOM_FIELDS.COMPLETION_DATE] = completionDate;
        fields["duedate"] = completionDate;
    }
    return JSON.stringify({ "update": {}, "fields": fields });
}

/**
 * 日付値を 'yyyy-MM-dd'（JST）へ整形。Date型・文字列に対応。
 * 空/解釈不能なら null を返す（デフォルト当日にはフォールバックしない）。
 */
function formatDateOrNull(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue.toString().trim() === '') return null;
    if (isDate(rawValue)) return Utilities.formatDate(rawValue, 'JST', 'yyyy-MM-dd');
    var str = String(rawValue).trim();
    var m = str.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (m) {
        var dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        if (!isNaN(dt.getTime())) return Utilities.formatDate(dt, 'JST', 'yyyy-MM-dd');
    }
    Logger.log('警告: date「' + str + '」を日付として解釈できませんでした（完了日は送信しません）');
    return null;
}

// =============================================================================
// 退職休職リスト 起票処理
//   対象シート「退職休職リスト」
//   ・起票条件 : Jiraチケット管理番号(A列)が空 かつ 依頼種別(F列)に値がある行
//   ・1行あたり最大3チケット:
//       - ﾒｰﾙｱﾄﾞﾚｽ(J列)に値 → SaaS削除チケットを2枚
//       - ﾃﾞﾊﾞｲｽ(W列)に値   → デバイスチケットを1枚（タスク種別を算出）
//   ・完了日(14981)/duedate = 最終出社日(Q列)。45322 のようなシリアル値は日付へ変換
//   ・企業名(14986)/opskey(14987) = シート上部の会社行から取得
//   ・タイトル = 会社名 + 「：退職休職対応」
//   ・作成後 : A列に全チケットのリンクを書き戻し → 各チケットを「完了」へ遷移(id 51)
// =============================================================================

/**
 * 退職休職リスト 起票エントリポイント
 */
function offboardRequest(sheetId, sheetURL, targetSheetName) {
    targetSheetName = targetSheetName || OFFBOARD_CONFIG.REQUEST_SHEET_NAME;
    try {
        var spreadsheet = SpreadsheetApp.openById(sheetId);
        var sheet = spreadsheet.getSheetByName(targetSheetName);
        if (!sheet) {
            console.log('対象シートが見つかりません: ' + targetSheetName);
            return;
        }
        var created = createOffboardStories(sheet);
        if (created > 0) {
            console.log('退職休職: ' + created + '件のチケットを作成しました。');
        } else {
            console.log('退職休職: 送信条件に当てはまる行がありません。');
        }
    } catch (e) {
        console.log('システムエラーを検知しました。');
        console.log('エラー内容：' + e.message);
    }
}

function createOffboardStories(sheet) {
    var lastRow = sheet.getLastRow();
    var lastColumn = sheet.getLastColumn();
    if (lastRow < 1 || lastColumn < 1) { Logger.log('退職休職: データがありません'); return 0; }
    var data = sheet.getRange(1, 1, lastRow, lastColumn).getValues();

    var normalize = function (s) { return s == null ? '' : s.toString().replace(/[\s　]/g, ''); };
    var CM = OFFBOARD_CONFIG.COLUMN_MAPPING;

    // ヘッダー行検出（「Jiraチケット管理番号」を含む行）
    var headerRow = -1;
    var col = { TICKET_NUMBER: -1, REQUEST_TYPE: -1, EMAIL: -1, LAST_DAY: -1, DEVICE: -1 };
    for (var r = 0; r < data.length && headerRow === -1; r++) {
        for (var c = 0; c < data[r].length; c++) {
            if (normalize(data[r][c]) === normalize(CM.TICKET_NUMBER)) { headerRow = r; break; }
        }
    }
    if (headerRow === -1) throw new Error('「Jiraチケット管理番号」ヘッダーが見つかりませんでした');
    for (var c2 = 0; c2 < data[headerRow].length; c2++) {
        var hv = normalize(data[headerRow][c2]);
        if (hv === normalize(CM.TICKET_NUMBER)) col.TICKET_NUMBER = c2;
        else if (hv === normalize(CM.REQUEST_TYPE)) col.REQUEST_TYPE = c2;
        else if (hv === normalize(CM.EMAIL)) col.EMAIL = c2;
        else if (hv === normalize(CM.LAST_DAY)) col.LAST_DAY = c2;
        else if (hv === normalize(CM.DEVICE)) col.DEVICE = c2;
    }
    Logger.log('退職休職 ヘッダー行=' + (headerRow + 1) + ' 列: ' + JSON.stringify(col));
    if (col.TICKET_NUMBER < 0 || col.REQUEST_TYPE < 0) {
        throw new Error('必要な列（Jiraチケット管理番号／依頼種別）が見つかりません');
    }

    // 会社名/opskey は会社行（col C に値がある最初の行）から取得
    var clientName = data[0][0];
    var opskey = data[0].length > 2 ? data[0][2] : '';
    Logger.log('退職休職 会社名=' + clientName + ' / opskey=' + opskey);

    var titleBase = (clientName ? clientName.toString() : '') + OFFBOARD_CONFIG.TITLE_SUFFIX;
    var createdCount = 0;

    for (var i = headerRow + 1; i < data.length; i++) {
        var ticketEmpty = data[i][col.TICKET_NUMBER] === null ||
                          data[i][col.TICKET_NUMBER] === undefined ||
                          data[i][col.TICKET_NUMBER].toString().trim().length === 0;
        var hasRequestType = col.REQUEST_TYPE >= 0 &&
                             data[i][col.REQUEST_TYPE] != null &&
                             data[i][col.REQUEST_TYPE].toString().trim().length > 0;
        if (!(ticketEmpty && hasRequestType)) continue;

        var completionDate = col.LAST_DAY >= 0 ? offboardCompletionDate(data[i][col.LAST_DAY]) : null;

        // この行で作成するチケット定義を組み立てる
        var ticketSpecs = [];

        // ① メールアドレスに値 → SaaS削除チケット × EMAIL_TICKET_COUNT
        var emailVal = col.EMAIL >= 0 ? data[i][col.EMAIL] : '';
        if (emailVal != null && emailVal.toString().trim().length > 0) {
            for (var e2 = 0; e2 < OFFBOARD_CONFIG.EMAIL_TICKET_COUNT; e2++) {
                ticketSpecs.push([OFFBOARD_CONFIG.EMAIL_TASK_TYPE]);
            }
        }

        // ② デバイスに値 → デバイスチケット × 1（タスク種別を算出）
        var deviceVal = col.DEVICE >= 0 ? data[i][col.DEVICE] : '';
        if (deviceVal != null && deviceVal.toString().trim().length > 0) {
            var deviceTaskTypes = computeDeviceTaskTypes(deviceVal);
            ticketSpecs.push(deviceTaskTypes);
        }

        if (ticketSpecs.length === 0) continue; // メール・デバイスとも無ければ作成しない

        var createdTickets = [];
        try {
            for (var t = 0; t < ticketSpecs.length; t++) {
                var json = getOffboardIssueJson(titleBase, clientName, opskey, completionDate, ticketSpecs[t]);
                var ret = postStoryIssue(json);
                Logger.log('退職休職起票成功: ' + ret['key'] + ' 種別=' + JSON.stringify(ticketSpecs[t]));
                var url = JIRA_CONFIG.BASE_URL + '/browse/' + ret['key'];
                createdTickets.push({ key: ret['key'], url: url });

                // 作成後すぐ「完了」へ遷移
                try {
                    transitionIssue(ret['key'], JIRA_CONFIG.DONE_TRANSITION_ID);
                    Logger.log('「完了」へ遷移しました: ' + ret['key']);
                } catch (te) {
                    Logger.log('完了遷移エラー (' + ret['key'] + '): ' + te.message);
                }
                createdCount++;
            }

            // 全チケットのリンクをA列に即時書き戻し（重複防止）
            writeTicketLinks(sheet, i + 1, col.TICKET_NUMBER + 1, createdTickets);
            SpreadsheetApp.flush();
            Logger.log('行' + (i + 1) + ' に ' + createdTickets.length + '件のチケットリンクを書き戻し');
        } catch (error) {
            Logger.log('退職休職起票エラー (行' + (i + 1) + '): ' + error.message);
            // 途中まで作成できていればA列に記録して重複を防ぐ
            if (createdTickets.length > 0) {
                try { writeTicketLinks(sheet, i + 1, col.TICKET_NUMBER + 1, createdTickets); SpreadsheetApp.flush(); } catch (e3) {}
            }
        }
    }
    return createdCount;
}

/**
 * デバイス欄の文字列からタスク種別（複数可）を算出。
 *   各行の先頭トークンを見て:
 *     「1x-…」形式（先頭数字が1）→ キッティング（PC）
 *     「2x-…」形式（先頭数字が2）→ キッティング（Phone）
 *     それ以外（数字-数字形式でない、または先頭数字が3以上等）→ キッティング（その他）
 *   同じ種別は1つにまとめる。
 */
function computeDeviceTaskTypes(deviceCell) {
    var text = deviceCell == null ? '' : deviceCell.toString();
    if (text.trim() === '') return [];
    var lines = text.split(/[\r\n]+/);
    var set = {};
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        var token = line.split(/[\s　]+/)[0];        // 行の先頭トークン（資産コード）
        var m = token.match(/^(\d)\d*-\d+/);         // 数字-数字 の形
        if (m && m[1] === '1') set['キッティング（PC）'] = true;
        else if (m && m[1] === '2') set['キッティング（Phone）'] = true;
        else set['キッティング（その他）'] = true;
    }
    var order = ['キッティング（PC）', 'キッティング（Phone）', 'キッティング（その他）'];
    var result = [];
    for (var k = 0; k < order.length; k++) if (set[order[k]]) result.push(order[k]);
    return result;
}

/**
 * 最終出社日の値を 'yyyy-MM-dd' へ。
 *   ・Date型 → 整形
 *   ・数値（Google Sheetsシリアル値・例 45322）→ 1899-12-30基準で日付へ変換
 *   ・日付文字列 → パース
 *   ・「未定」「確認中」「#VALUE!」等・空 → null（完了日を送らない）
 */
function offboardCompletionDate(rawValue) {
    if (rawValue == null) return null;
    if (isDate(rawValue)) return Utilities.formatDate(rawValue, 'JST', 'yyyy-MM-dd');
    var s = rawValue.toString().trim();
    if (s === '') return null;
    if (/^\d+(\.\d+)?$/.test(s)) {                       // シリアル値
        var serial = parseFloat(s);
        var ms = Math.round((serial - 25569) * 86400 * 1000); // 25569 = 1899-12-30→1970-01-01
        var d = new Date(ms);
        if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
        return null;
    }
    var m = s.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (m) {
        var dt = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        if (!isNaN(dt.getTime())) return Utilities.formatDate(dt, 'JST', 'yyyy-MM-dd');
    }
    Logger.log('最終出社日「' + s + '」は日付として扱えないため完了日を送信しません');
    return null;
}

/**
 * 退職休職リスト用 起票JSON生成
 *   summary / project / issuetype ＋ 企業名 ＋ opskey ＋ タスク種別 ＋ 完了日/duedate
 */
function getOffboardIssueJson(summary, clientName, opskey, completionDate, taskTypeValues) {
    var fields = {
        "summary": summary,
        "project":   { "key": JIRA_CONFIG.PROJECT_NAME },
        "issuetype": { "id": JIRA_CONFIG.ISSUE_TYPE_STORY }
    };
    if (clientName) fields[CUSTOM_FIELDS.CLIENT_NAME] = clientName.toString();
    if (opskey)     fields[CUSTOM_FIELDS.OPSKEY] = opskey.toString();
    if (taskTypeValues && taskTypeValues.length > 0) {
        fields[CUSTOM_FIELDS.TASK_TYPE] = taskTypeValues.map(function (v) { return { "value": v }; });
    }
    if (completionDate) {
        fields[CUSTOM_FIELDS.COMPLETION_DATE] = completionDate;
        fields["duedate"] = completionDate;
    }
    return JSON.stringify({ "update": {}, "fields": fields });
}

/**
 * 作成した1〜複数チケットのリンクをセルへ書き戻す。
 *   1件 → HYPERLINK関数 / 複数 → リッチテキスト（改行区切りで各キーにリンク）
 */
function writeTicketLinks(sheet, row, column, tickets) {
    if (!tickets || tickets.length === 0) return;
    var cell = sheet.getRange(row, column);
    if (tickets.length === 1) {
        cell.setFormula('=HYPERLINK("' + tickets[0].url + '","' + tickets[0].key + '")');
        return;
    }
    var richText = SpreadsheetApp.newRichTextValue();
    var fullText = '', parts = [];
    for (var k = 0; k < tickets.length; k++) {
        if (k > 0) fullText += '\n';
        var start = fullText.length;
        fullText += tickets[k].key;
        parts.push({ start: start, end: fullText.length, url: tickets[k].url });
    }
    richText.setText(fullText);
    for (var p = 0; p < parts.length; p++) richText.setLinkUrl(parts[p].start, parts[p].end, parts[p].url);
    cell.setRichTextValue(richText.build());
    cell.setWrap(true);
}

/**
 * リプレイス依頼用 Story起票JSON生成
 * 依頼種別/PC種別は送信しない。
 * 企業名(14986)/Opskey(14987)/新端末の発送日(14981・duedateにも同値)を設定。
 */
function getStoryIssueJson(summary, description, dueDate, clientName, customFieldValue, shippingDate, assigneeAccountId) {
    Logger.log("設定するクライアントネームは" + clientName)

    json = {
        "update": {},
        "fields": {
            "summary": summary,
            "description": description,
            "project": {
                "key": JIRA_CONFIG.PROJECT_NAME
            },
            "issuetype": {
                "id": JIRA_CONFIG.ISSUE_TYPE_STORY
            },
            "duedate": dueDate,
            [CUSTOM_FIELDS.CLIENT_NAME]: clientName,          // クライアント名
            [CUSTOM_FIELDS.OPSKEY]: customFieldValue,         // opskey（C1の値）
            [CUSTOM_FIELDS.SHIPPING_DATE]: shippingDate,      // 新端末の発送日
            // タスク種別（Checkboxes型）：リプレイス依頼は固定で「キッティング（PC）」
            [CUSTOM_FIELDS.TASK_TYPE]: [{ "value": REPLACE_CONFIG.TASK_TYPE_VALUE }]
        }
    }

    // 担当者が指定されている場合のみ設定
    if (assigneeAccountId) {
        json.fields.assignee = {
            "accountId": assigneeAccountId
        };
    }

    return JSON.stringify(json);
}

// =============================================================================
// ユーティリティ関数
// =============================================================================

function getCompanyAssigneeMap() {
  return companyAssigneeMap;
}

function getDefaultAssignee() {
  return MEMBER_CONFIG.DEFAULT_ASSIGNEE;
}

function checkOpskey(opskey) {
  // メンバーリストと担当者マッピングを読み込む
  loadMemberAccountMap();
  loadCompanyAssigneeMap();

  // opskeyに対応する担当者を取得
  var assigneeName = companyAssigneeMap[opskey] || MEMBER_CONFIG.DEFAULT_ASSIGNEE;
  var assigneeId = memberAccountMap[assigneeName];

  return {
    opskey: opskey,
    assigneeName: assigneeName,
    assigneeId: assigneeId || "見つかりません"
  };
}

// =============================================================================
// テスト用ラッパー（GASエディタの「実行」ボタンから引数なしで実行）
// =============================================================================

/**
 * リプレイス起票テスト
 * 使い方:
 *  1) 下の TEST_SHEET_ID / TEST_SHEET_URL に対象スプレッドシートの値を入力
 *  2) エディタ上部の関数プルダウンで「testReplaceIssue」を選び「実行」
 *  3) 実行ログ（表示 → ログ）で結果を確認
 *
 * ⚠️ 実際にJiraチケットが作成されます。
 *    「リプレイス用」シートで【送り状に値あり かつ Jiraチケット管理番号が空】の行が
 *    起票対象です。テストでは該当行を1行だけにしておくと1件だけ発行されます。
 */
function testReplaceIssue() {
  // ↓↓↓ ここに入力してください ↓↓↓
  var TEST_SHEET_ID  = '';  // スプレッドシートのID（URLの /d/【ここ】/edit 部分）
  var TEST_SHEET_URL = '';  // スプレッドシートのURL（description末尾に付与されます）
  // ↑↑↑ ここに入力してください ↑↑↑

  if (!TEST_SHEET_ID || !TEST_SHEET_URL) {
    Logger.log('【設定待ち】TEST_SHEET_ID と TEST_SHEET_URL を入力してから実行してください。');
    return;
  }

  count = 0;  // 念のため作成件数カウンタを初期化
  Logger.log('=== リプレイス起票テスト開始 ===');
  Logger.log('対象シート名: ' + SHEET_CONFIG.REQUEST_SHEET_NAME);
  Logger.log('対象スプレッドシートID: ' + TEST_SHEET_ID);

  // targetSheetName を省略 → 既定の「リプレイス用」が使われる
  kittingRequest(TEST_SHEET_ID, TEST_SHEET_URL);

  Logger.log('=== リプレイス起票テスト終了 === 作成件数 count=' + count);
}

/**
 * リースアップ返却テスト
 * 使い方:
 *  1) 下の TEST_SHEET_ID に対象スプレッドシートのIDを入力
 *  2) 関数プルダウンで「testLeaseUpIssue」を選び「実行」
 *  3) 実行ログで結果を確認
 *
 * ⚠️ 実際にJiraチケットが作成され、作成後すぐ「完了」へ遷移します。
 *    「リースアップ用」シートで Jiraチケット管理番号(A列)が空 かつ
 *    josys取得 または date に値がある行が起票対象です（テストは1行だけに絞ると安全）。
 */
function testLeaseUpIssue() {
  // ↓↓↓ ここに入力してください ↓↓↓
  var TEST_SHEET_ID = '';  // スプレッドシートのID（URLの /d/【ここ】/edit 部分）
  // ↑↑↑ ここに入力してください ↑↑↑

  if (!TEST_SHEET_ID) {
    Logger.log('【設定待ち】TEST_SHEET_ID を入力してから実行してください。');
    return;
  }

  Logger.log('=== リースアップ返却テスト開始 ===');
  Logger.log('対象シート名: ' + LEASEUP_CONFIG.REQUEST_SHEET_NAME);
  Logger.log('対象スプレッドシートID: ' + TEST_SHEET_ID);

  // targetSheetName を省略 → 既定の「リースアップ用」が使われる
  leaseUpRequest(TEST_SHEET_ID, '');

  Logger.log('=== リースアップ返却テスト終了 ===');
}

/**
 * 退職休職リスト テスト
 * 使い方:
 *  1) 下の TEST_SHEET_ID に対象スプレッドシートのIDを入力
 *  2) 関数プルダウンで「testOffboardIssue」を選び「実行」
 *  3) 実行ログで結果を確認
 *
 * ⚠️ 1行につき最大3チケット作成され、各チケットは作成後すぐ「完了」へ遷移します。
 *    Jiraチケット管理番号(A列)が空 かつ 依頼種別(F列)に値がある行が対象です
 *    （テストは対象を1行だけに絞ると安全）。
 */
function testOffboardIssue() {
  // ↓↓↓ ここに入力してください ↓↓↓
  var TEST_SHEET_ID = '';  // スプレッドシートのID（URLの /d/【ここ】/edit 部分）
  // ↑↑↑ ここに入力してください ↑↑↑

  if (!TEST_SHEET_ID) {
    Logger.log('【設定待ち】TEST_SHEET_ID を入力してから実行してください。');
    return;
  }

  Logger.log('=== 退職休職リスト テスト開始 ===');
  Logger.log('対象シート名: ' + OFFBOARD_CONFIG.REQUEST_SHEET_NAME);
  Logger.log('対象スプレッドシートID: ' + TEST_SHEET_ID);

  // targetSheetName を省略 → 既定の「退職休職リスト」が使われる
  offboardRequest(TEST_SHEET_ID, '');

  Logger.log('=== 退職休職リスト テスト終了 ===');
}
