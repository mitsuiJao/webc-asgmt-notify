import fs from 'fs/promises';
import crypto from 'crypto';

const STATE_FILE_PATH = './notification_state.json';

// 状態ファイルを読み込むヘルパー関数
async function readNotificationState() {
    try {
        const data = await fs.readFile(STATE_FILE_PATH, 'utf8');
        return { state: JSON.parse(data), isFirstRun: false };
    } catch (error) {
        if (error.code === 'ENOENT') {
            // ファイルが存在しない場合は初回実行
            return { state: {}, isFirstRun: true };
        }
        throw error;
    }
}

// 状態ファイルを書き込むヘルパー関数
async function writeNotificationState(state) {
    await fs.writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2));
}

// 課題のユニークIDを生成する関数
function getAssignmentId(assignment) {
    const identifier = `${assignment.course}-${assignment.title}`;
    return crypto.createHash('sha1').update(identifier).digest('hex');
}

/**
 * スクレイピングされた課題を処理し、送信すべき通知内容を生成して返します。
 * @param {Array} scrapedAssignments - スクレイパーから取得した課題の配列。
 * @returns {Array} 送信すべき通知オブジェクト（{subject, body}）の配列。
 */
export async function processNotifications(scrapedAssignments) {
    if (!scrapedAssignments) {
        console.log("No assignments found to process.");
        return [];
    }

    const { state: notificationState, isFirstRun } = await readNotificationState();
    const now = new Date();

    // --- 初回実行の特別ロジック ---
    if (isFirstRun) {
        console.log("First run detected. Initializing notification state.");
        for (const assignment of scrapedAssignments) {
            const assignmentId = getAssignmentId(assignment);
            const deadline = new Date(assignment.deadline);
            const isExpired = deadline < now;
            
            notificationState[assignmentId] = {
                notifiedNew: true,
                notified24h: isExpired // 期限切れなら24hも通知済みに
            };
        }
        await writeNotificationState(notificationState);
        console.log("Initial notification state has been created.");

        // 初回実行完了を知らせる特別な通知を生成
        return [{
            subject: "【WebClass通知】 初期設定が完了しました",
            body: `<h1>初期設定完了</h1><p>WebClass課題通知ボットの初期設定が完了しました。現在登録されているすべての課題が記録されました。次回実行時から、新しい課題や期限が近い課題について通知が送信されます。</p>`
        }];
    }

    // --- 通常実行のロジック ---
    console.log("Checking for notifications...");
    const newAssignments = [];
    const dueSoonAssignments = [];
    const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    for (const assignment of scrapedAssignments) {
        const assignmentId = getAssignmentId(assignment);
        const deadline = new Date(assignment.deadline);

        // 実行時点ですでに期限切れの課題は無視
        if (deadline < now) {
            if (!notificationState[assignmentId]) {
                notificationState[assignmentId] = { notifiedNew: true, notified24h: true };
            }
            continue;
        }

        // ケースA: 新規課題
        if (!notificationState[assignmentId]) {
            console.log(`New assignment found: ${assignment.title}`);
            newAssignments.push(assignment);
            notificationState[assignmentId] = { notifiedNew: true, notified24h: false };
        }
        // ケースB: 期限が24時間以内で、まだ通知していない課題
        else if (deadline <= twentyFourHoursFromNow && !notificationState[assignmentId].notified24h) {
            console.log(`Assignment due soon: ${assignment.title}`);
            dueSoonAssignments.push(assignment);
            notificationState[assignmentId].notified24h = true;
        }
    }

    const notificationsToSend = [];

    if (newAssignments.length > 0) {
        const subject = `【新規課題】${newAssignments.length}件の新しい課題が追加されました`;
        const body = `
            <h1>新規課題</h1>
            <p>以下の新しい課題が追加されました。</p>
            <ul>
                ${newAssignments.map(a => `<li><strong>${a.course}</strong>: ${a.title} (期限: ${a.deadline}) <a href="${a.url}">課題へ</a></li>`).join('')}
            </ul>
        `;
        notificationsToSend.push({ subject, body });
        console.log(`Prepared notification for ${newAssignments.length} new assignments.`);
    }
    if (dueSoonAssignments.length > 0) {
        const subject = `【期限間近】${dueSoonAssignments.length}件の課題が24時間以内に期限を迎えます`;
        const body = `
            <h1>期限間近の課題</h1>
            <p>以下の課題が24時間以内に期限を迎えます。</p>
            <ul>
                ${dueSoonAssignments.map(a => `<li><strong>${a.course}</strong>: ${a.title} (期限: ${a.deadline}) <a href="${a.url}">課題へ</a></li>`).join('')}
            </ul>
        `;
        notificationsToSend.push({ subject, body });
        console.log(`Prepared notification for ${dueSoonAssignments.length} assignments due soon.`);
    }

    if (notificationsToSend.length === 0) {
        console.log("No new notifications to send.");
    }

    await writeNotificationState(notificationState);
    console.log("Notification state saved.");

    return notificationsToSend;
}
