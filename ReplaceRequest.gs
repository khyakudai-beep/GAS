// =============================================================================
// リプレイス依頼 Jira起票 Google Apps Script（アレンジ版）
// ver1.1 改訂0007ベース / 株式会社GA technologies リプレイス依頼対応
//
// 変更点（元スクリプトからの差分）:
//  - 対象シート        : 「リプレイス用」
//  - 起票条件          : 「Jiraチケット管理番号」が空 かつ 「送り状」に値あり
//  - チケットタイトル  : 固定「株式会社GA technologies:リプレイス依頼」
//  - 「新端末の発送日」→ customfield_10038（および duedate に同値を設定）
//  - 依頼種別(10301)/PC種別(10268) は送信しない
//  - クライアント名(10036)/opskey(10202)/担当者自動割当 は維持
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
  PROJECT_NAME: 'ITO',
  ISSUE_TYPE_STORY: '10007',
  ISSUE_TYPE_STORY_CHILD: '10013'
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
  TICKET_TITLE: '株式会社GA technologies:リプレイス依頼'  // チケットタイトル（固定）
};

// ヘッダー検出設定
const HEADER_CONFIG = {
  KEY_COLUMN: 'B',                              // ヘッダー検索の基準列
  KEY_VALUE: 'No.',                             // 検索するキー値
  DATA_START_COLUMN_NAME: 'Jiraチケット管理番号',  // description生成の開始基準カラム名
  // 動的カラム検索設定（照合は正規化マッチ：改行/空白を無視）
  COLUMN_MAPPING: {
    TICKET_NUMBER: 'Jiraチケット管理番号',  // 完全一致（正規化後）：起票済み判定＆リンク出力先
    SHIPPING: '送り状',                     // 部分一致（正規化後）：起票トリガー
    SHIPPING_DATE: '新端末の発送日'          // 完全一致（正規化後）：customfield_10038 / duedate
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
  CLIENT_NAME: 'customfield_10036',    // クライアント名（A1）
  OPSKEY: 'customfield_10202',         // opskey（C1の値）
  SHIPPING_DATE: 'customfield_10038'   // 新端末の発送日
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

        // チケット番号が空 & 送り状に値がある場合
        if (ticketNumberEmpty && hasShipping) {

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

                // 作成されたチケットのハイパーリンクを設定（既存踏襲）
                if (columnIndexes.TICKET_NUMBER >= 0 && createdTickets.length > 0) {
                    var ticketRowNumber = i + 1;
                    var ticketColumnNumber = columnIndexes.TICKET_NUMBER + 1;

                    if (createdTickets.length === 1) {
                        // 単一チケットの場合: 通常のHYPERLINK関数
                        var ticket = createdTickets[0];
                        var hyperLinkFormula = '=HYPERLINK("' + ticket.url + '","' + ticket.key + '")';

                        hyperlinkUpdates.push({
                            row: ticketRowNumber,
                            column: ticketColumnNumber,
                            formula: hyperLinkFormula,
                            ticketKeys: [ticket.key]
                        });
                    } else {
                        // 複数チケットの場合: リッチテキスト形式で各行にリンクを設定
                        hyperlinkUpdates.push({
                            row: ticketRowNumber,
                            column: ticketColumnNumber,
                            tickets: createdTickets,
                            isMultiple: true
                        });
                    }
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
 * リプレイス依頼用 Story起票JSON生成
 * 依頼種別(10301)/PC種別(10268)は送信しない。
 * クライアント名(10036)/opskey(10202)/新端末の発送日(10038)を設定。
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
            [CUSTOM_FIELDS.SHIPPING_DATE]: shippingDate       // 新端末の発送日
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
