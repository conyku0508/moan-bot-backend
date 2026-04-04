// ===== MoAn AdTech Bot v4.6 =====
// 改動：說明依角色顯示、「怎麼用」觸發、檔案搜尋含tags/category、查共享檔案列出全部

const express = require('express');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');

// ===== 環境變數 =====
const LINE_CONFIG = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const BOT_USER_ID = process.env.BOT_USER_ID;
const PORT = process.env.PORT || 8080;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// ===== 角色常數 =====
const ROLE_ADMIN = 'admin';
const ROLE_MANAGER = 'manager';
const ROLE_MEMBER = 'member';

// ===== Firebase 初始化 =====
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
}
const db = admin.firestore();

// ===== LINE SDK =====
const lineClient = new line.Client(LINE_CONFIG);

// ===== 全域變數 =====
let systemEnabled = true;
let BOT_USER_ID_CACHE = BOT_USER_ID || null;
const userContext = {};

// ===== 時間格式化工具 =====
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function formatDateTimeFriendly(isoStr) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        const tw = new Date(d.getTime() + (8 * 60 * 60 * 1000) + (d.getTimezoneOffset() * 60 * 1000));
        const month = tw.getMonth() + 1;
        const day = tw.getDate();
        const weekday = WEEKDAYS[tw.getDay()];
        const hour = String(tw.getHours()).padStart(2, '0');
        const minute = String(tw.getMinutes()).padStart(2, '0');
        return `${month}/${day}（${weekday}）${hour}:${minute}`;
    } catch (e) {
        return isoStr;
    }
}

// ===== 說明文字（依角色）=====
function getHelpText(role) {
    let text = '📋 MoAn AdTech Bot 使用說明\n';
    text += '━━━━━━━━━━━━━━\n\n';

    text += '【新增待辦】\n';
    text += '• 助理 提醒我明天下午3點開會\n';
    text += '• 助理 4/5要交報告\n';
    text += '• 助理 下週一拜訪客戶\n\n';

    text += '【查詢待辦】\n';
    text += '• 助理 待辦有哪些\n';
    text += '• 助理 看一下[任務名稱]的內容\n\n';

    text += '【管理待辦】\n';
    text += '• 助理 完成[任務名稱]\n';
    text += '• 助理 刪除[任務名稱]\n';
    text += '• 助理 修改[任務名稱]改成[新內容]\n\n';

    text += '【查詢檔案】\n';
    text += '• 助理 找[關鍵字]的檔案\n';
    text += '• 助理 查共享檔案（列出全部）\n\n';

    text += '【其他】\n';
    text += '• 助理 綁定[email]\n';
    text += '• 助理 怎麼用\n';

    // 管理員 & 主管才看得到
    if (role === ROLE_ADMIN || role === ROLE_MANAGER) {
        text += '\n━━━━━━━━━━━━━━\n';
        text += '🔒 以下為管理功能\n\n';
        text += '【成員管理】\n';
        text += '• 助理 成員列表\n';
        text += '• 助理 查看[名字]的待辦\n';
        if (role === ROLE_ADMIN) {
            text += '• 助理 設定[名字]為主管\n';
            text += '• 助理 取消[名字]的主管\n';
        }
    }

    if (role === ROLE_ADMIN) {
        text += '\n【系統管理】\n';
        text += '• 助理 開啟系統\n';
        text += '• 助理 關閉系統\n';
    }

    return text;
}

// ===== 使用者管理 =====
async function getOrCreateUser(userId, displayName) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    if (doc.exists) {
        const data = doc.data();
        if (displayName && data.displayName !== displayName) {
            await userRef.update({ displayName, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }
        return data;
    }
    const isAdminUser = userId === ADMIN_USER_ID;
    const newUser = {
        userId,
        displayName: displayName || 'Unknown',
        role: isAdminUser ? ROLE_ADMIN : ROLE_MEMBER,
        approved: isAdminUser,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await userRef.set(newUser);
    return newUser;
}

// ===== 權限檢查 =====
function isAdmin(user) { return user.role === ROLE_ADMIN; }
function isManager(user) { return user.role === ROLE_MANAGER; }
function isPrivileged(user) { return user.role === ROLE_ADMIN || user.role === ROLE_MANAGER; }

// ===== Gemini 呼叫（含 timeout）=====
async function callGemini(prompt, timeoutMs = 15000) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const resp = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: timeoutMs });
    return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ===== Express 伺服器 =====
const app = express();
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.send('MoAn Bot is running! v4.6'));

app.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-line-signature'];
        const body = req.body;
        const hash = crypto.createHmac('SHA256', LINE_CONFIG.channelSecret).update(body).digest('base64');
        if (hash !== signature) {
            console.error('簽名驗證失敗');
            return res.status(403).send('Invalid signature');
        }
        const parsed = JSON.parse(body.toString());
        const events = parsed.events || [];
        console.log(`收到 ${events.length} 個事件`);

        for (const event of events) {
            if (event.type !== 'message' || event.message.type !== 'text') continue;
            const sourceType = event.source.type;
            if (sourceType === 'group') {
                await handleGroupMessage(event);
            } else if (sourceType === 'user') {
                await handlePrivateMessage(event);
            }
        }
        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('Webhook 處理錯誤:', err);
        res.status(200).json({ status: 'error' });
    }
});

// ===== 群組訊息處理 =====
async function handleGroupMessage(event) {
    const msg = event.message.text.trim();
    const userId = event.source.userId;
    const groupId = event.source.groupId;

    const triggerPatterns = [/^助理[\s,，]*/i, /^小助理[\s,，]*/i, /^業務助理[\s,，]*/i];
    let triggered = false;
    let command = msg;

    for (const pattern of triggerPatterns) {
        if (pattern.test(msg)) {
            triggered = true;
            command = msg.replace(pattern, '').trim();
            break;
        }
    }

    if (!triggered) {
        try {
            let profile;
            try { profile = await lineClient.getGroupMemberProfile(groupId, userId); } catch (e) { profile = { displayName: 'Unknown' }; }
            await db.collection('group_logs').add({
                groupId, userId,
                displayName: profile.displayName,
                message: msg,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) { /* ignore */ }
        return;
    }

    let profile;
    try { profile = await lineClient.getGroupMemberProfile(groupId, userId); } catch (e) { profile = { displayName: 'Unknown' }; }
    const user = await getOrCreateUser(userId, profile.displayName);

    console.log(`群組觸發：「${command}」`);
    await handleDirectMessage(event, user, command, true);
}

// ===== 私訊處理 =====
async function handlePrivateMessage(event) {
    const msg = event.message.text.trim();
    const userId = event.source.userId;

    let profile;
    try { profile = await lineClient.getProfile(userId); } catch (e) { profile = { displayName: 'Unknown' }; }
    const user = await getOrCreateUser(userId, profile.displayName);

    if (!user.approved && !isAdmin(user)) {
        await reply(event, '⚠️ 您尚未被核准使用此系統。\n請聯繫管理員開通權限。');
        return;
    }

    if (!systemEnabled && !isAdmin(user)) {
        await reply(event, '⚠️ 系統目前已暫停服務，請稍後再試。');
        return;
    }

    if (/^(確認|取消|是|否|yes|no)$/i.test(msg)) {
        await handleConfirmOrCancel(event, user, msg);
        return;
    }

    let command = msg;
    const triggerPatterns = [/^助理[\s,，]*/i, /^小助理[\s,，]*/i, /^業務助理[\s,，]*/i];
    for (const pattern of triggerPatterns) {
        if (pattern.test(msg)) {
            command = msg.replace(pattern, '').trim();
            break;
        }
    }

    await handleDirectMessage(event, user, command, false);
}

// ===== 意圖分類（增強版）=====
async function classifyIntent(msg) {
    // 正則快速匹配 — 順序很重要，越明確的放越前面
    if (/怎麼用|說明|help|指令|幫助|使用說明/.test(msg)) return 'HELP';
    if (/成員列表|所有成員|使用者列表/.test(msg)) return 'MEMBER_LIST';
    if (/設定.*主管|升級.*主管/.test(msg)) return 'SET_MANAGER';
    if (/取消.*主管|移除.*主管/.test(msg)) return 'REMOVE_MANAGER';
    if (/查看.*的待辦|查看.*的任務/.test(msg)) return 'VIEW_OTHER_TASKS';
    if (/開啟系統/.test(msg)) return 'ENABLE_SYSTEM';
    if (/關閉系統/.test(msg)) return 'DISABLE_SYSTEM';

    // 查看待辦詳情
    if (/看一下.*的?(內容|詳情|備註|完整|全部)|查看.*的?(內容|詳情|備註|完整|全部)|詳情.*任務/.test(msg)) return 'TASK_DETAIL';

    // 檔案查詢 — 有「檔案」或「共享檔案」關鍵字
    if (/找.*檔案|查.*檔案|檔案.*查詢|共享檔案|查檔案/.test(msg)) return 'FILE_QUERY';

    if (/完成.*任務|完成.*待辦|已完成/.test(msg)) return 'COMPLETE_TASK';
    if (/刪除.*任務|刪除.*待辦|移除.*任務/.test(msg)) return 'DELETE_TASK';
    if (/修改.*任務|更改.*任務|變更.*待辦/.test(msg)) return 'MODIFY_TASK';
    if (/待辦|任務.*有哪些|查詢.*任務|我的任務/.test(msg)) return 'QUERY_TASKS';
    if (/綁定.*信箱|綁定.*email|綁定.*mail/i.test(msg)) return 'BIND_EMAIL';
    if (/提醒|新增.*任務|新增.*待辦|加入.*待辦|記住|幫我記|建立.*任務/.test(msg)) return 'ADD_TASK';

    // 日期開頭 → 高機率是新增任務
    if (/^(\d{1,2}\/\d{1,2}|明天|後天|大後天|下週|下禮拜|今天|星期[一二三四五六日天]|周[一二三四五六日天])/.test(msg)) return 'ADD_TASK';
    if (/\d{1,2}月\d{1,2}[日號]|明天.*[要去到]|後天.*[要去到]/.test(msg)) return 'ADD_TASK';
    if (/[要去做到].*[開會|報告|提案|簡報|拜訪|出差|面試|聚餐|吃飯]/.test(msg)) return 'ADD_TASK';

    // Gemini 分類
    try {
        const result = await callGemini(`請分類以下使用者指令的意圖，只回覆以下其中一個分類代碼：
ADD_TASK（新增任務/提醒/行程）
QUERY_TASKS（查詢待辦）
TASK_DETAIL（查看單一任務的詳細內容或備註）
COMPLETE_TASK（完成任務）
DELETE_TASK（刪除任務）
MODIFY_TASK（修改任務）
FILE_QUERY（查詢檔案或共享檔案）
BIND_EMAIL（綁定信箱）
HELP（查看說明或怎麼用）
CHAT（一般閒聊）

使用者指令：「${msg}」

只回覆分類代碼，不要其他文字。`, 10000);
        if (result && /^[A-Z_]+$/.test(result)) return result;
    } catch (e) {
        console.error('Gemini 分類逾時或錯誤:', e.message);
    }
    return 'ADD_TASK';
}

// ===== 核心指令處理 =====
async function handleDirectMessage(event, user, command, isGroup) {
    const intent = await classifyIntent(command);
    console.log(`意圖分類: ${intent}`);

    switch (intent) {
        case 'HELP':
            await reply(event, getHelpText(user.role));
            break;
        case 'ADD_TASK':
            await handleAddTask(event, user, command, isGroup);
            break;
        case 'QUERY_TASKS':
            await handleQueryTasks(event, user);
            break;
        case 'TASK_DETAIL':
            await handleTaskDetail(event, user, command);
            break;
        case 'COMPLETE_TASK':
            await handleCompleteTask(event, user, command);
            break;
        case 'DELETE_TASK':
            await handleDeleteTask(event, user, command);
            break;
        case 'MODIFY_TASK':
            await handleModifyTask(event, user, command);
            break;
        case 'FILE_QUERY':
            await handleFileQuery(event, user, command);
            break;
        case 'BIND_EMAIL':
            await handleBindEmail(event, user, command);
            break;
        case 'MEMBER_LIST':
            if (isPrivileged(user)) await handleMemberList(event);
            else await reply(event, '⚠️ 您沒有權限執行此操作。');
            break;
        case 'SET_MANAGER':
            if (isAdmin(user)) await handleSetManager(event, command);
            else await reply(event, '⚠️ 只有管理員可以設定主管。');
            break;
        case 'REMOVE_MANAGER':
            if (isAdmin(user)) await handleRemoveManager(event, command);
            else await reply(event, '⚠️ 只有管理員可以移除主管。');
            break;
        case 'VIEW_OTHER_TASKS':
            if (isPrivileged(user)) await handleViewOtherTasks(event, command);
            else await reply(event, '⚠️ 您沒有權限查看他人任務。');
            break;
        case 'ENABLE_SYSTEM':
            if (isAdmin(user)) {
                systemEnabled = true;
                await db.collection('settings').doc('system').set({ enabled: true }, { merge: true });
                await reply(event, '✅ 系統已開啟！');
            } else await reply(event, '⚠️ 只有管理員可以開啟系統。');
            break;
        case 'DISABLE_SYSTEM':
            if (isAdmin(user)) {
                systemEnabled = false;
                await db.collection('settings').doc('system').set({ enabled: false }, { merge: true });
                await reply(event, '🔒 系統已關閉。');
            } else await reply(event, '⚠️ 只有管理員可以關閉系統。');
            break;
        case 'CHAT':
        default:
            await handleChat(event, user, command);
            break;
    }
}

// ===== 新增任務 =====
async function handleAddTask(event, user, command, isGroup) {
    try {
        console.log('[ADD_TASK] 呼叫 Gemini 解析任務...');
        const now = new Date();
        const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const todayStr = twNow.toISOString().split('T')[0];

        const geminiText = await callGemini(`你是一個任務解析助手。請從以下訊息中提取任務資訊。
今天日期是 ${todayStr}（台灣時間）。

規則：
1. 如果有提到日期但沒有時間，預設時間為 10:00（上午十點）
2. 如果有提到「明天」，日期為 ${todayStr} 的隔天
3. 如果有提到「後天」，日期為 ${todayStr} 的兩天後
4. end 預設為 start 的一小時後
5. 時間格式使用 ISO 8601，時區為 +08:00
6. title 請去掉「要去」「要」「去」等贅詞，保留核心事項名稱

請回傳 JSON 格式（不要加 markdown 標記）：
[{"title": "任務標題", "start": "2026-04-03T15:00:00+08:00", "end": "2026-04-03T16:00:00+08:00"}]

如果無法解析出時間，start 和 end 都設為 null。

使用者訊息：「${command}」`);

        console.log('[ADD_TASK] Gemini 回傳:', geminiText);

        let cleanJson = geminiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const tasks = JSON.parse(cleanJson);
        console.log('[ADD_TASK] 解析結果:', JSON.stringify(tasks));

        if (!tasks || tasks.length === 0) {
            await reply(event, '❌ 無法解析任務內容，請重新輸入。');
            return;
        }

        if (isGroup) {
            for (const task of tasks) {
                const taskData = {
                    userId: user.userId,
                    displayName: user.displayName,
                    title: task.title,
                    start: task.start || null,
                    end: task.end || null,
                    completed: false,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    source: 'group'
                };
                await db.collection('tasks').add(taskData);

                let replyText = `✅ 已新增任務：${task.title}`;
                if (task.start) replyText += `\n📅 ${formatDateTimeFriendly(task.start)}`;
                await reply(event, replyText);
            }
        } else {
            userContext[user.userId] = { tasks, command, timestamp: Date.now() };
            await db.collection('pending_proposals').doc(user.userId).set({
                tasks, command,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            let confirmText = '📝 確認要新增以下任務嗎？\n\n';
            tasks.forEach((t, i) => {
                confirmText += `${i + 1}. ${t.title}`;
                if (t.start) confirmText += `\n   📅 ${formatDateTimeFriendly(t.start)}`;
                confirmText += '\n';
            });
            confirmText += '\n請回覆「確認」或「取消」';
            await reply(event, confirmText);
        }
    } catch (err) {
        console.error('[ADD_TASK] 錯誤:', err);
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            await reply(event, '⏳ AI 處理中，請稍後再試一次。');
        } else {
            await reply(event, '❌ 新增任務時發生錯誤，請稍後再試。');
        }
    }
}

// ===== 確認/取消操作 =====
async function handleConfirmOrCancel(event, user, msg) {
    const isConfirm = /^(確認|是|yes)$/i.test(msg);
    const proposalDoc = await db.collection('pending_proposals').doc(user.userId).get();

    if (!proposalDoc.exists) {
        await reply(event, '目前沒有待確認的任務。');
        return;
    }

    if (isConfirm) {
        await executeConfirmedTasks(event, user, proposalDoc.data().tasks);
    } else {
        await reply(event, '❌ 已取消新增任務。');
    }
    await db.collection('pending_proposals').doc(user.userId).delete();
    delete userContext[user.userId];
}

// ===== 執行確認後的任務 =====
async function executeConfirmedTasks(event, user, tasks) {
    for (const task of tasks) {
        const taskData = {
            userId: user.userId,
            displayName: user.displayName,
            title: task.title,
            start: task.start || null,
            end: task.end || null,
            completed: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'private'
        };
        await db.collection('tasks').add(taskData);

        let replyText = `✅ 已新增任務：${task.title}`;
        if (task.start) replyText += `\n📅 ${formatDateTimeFriendly(task.start)}`;
        await reply(event, replyText);
    }
}

// ===== 查詢任務列表 =====
async function handleQueryTasks(event, user) {
    try {
        const snapshot = await db.collection('tasks')
            .where('userId', '==', user.userId)
            .where('completed', '==', false)
            .get();

        if (snapshot.empty) {
            await reply(event, '📋 目前沒有待辦任務！');
            return;
        }

        const docs = snapshot.docs.sort((a, b) => {
            const aTime = a.data().createdAt?.toMillis?.() || 0;
            const bTime = b.data().createdAt?.toMillis?.() || 0;
            return bTime - aTime;
        });

        let text = '📋 您的待辦任務：\n\n';
        docs.slice(0, 20).forEach((doc, i) => {
            const t = doc.data();
            text += `${i + 1}. ${t.title}`;
            if (t.start) text += `\n   📅 ${formatDateTimeFriendly(t.start)}`;
            text += '\n';
        });

        if (docs.length > 20) {
            text += `\n...還有 ${docs.length - 20} 筆，請到後台查看完整列表`;
        }

        text += '\n💡 輸入「助理 看一下[任務名稱]的內容」可查看詳情';

        userContext[user.userId] = {
            lastQueryTasks: docs.map(d => ({ id: d.id, ...d.data() })),
            timestamp: Date.now()
        };
        await reply(event, text);
    } catch (err) {
        console.error('查詢任務錯誤:', err);
        await reply(event, '❌ 查詢任務時發生錯誤。');
    }
}

// ===== 查看單一任務詳情 =====
async function handleTaskDetail(event, user, command) {
    try {
        const keyword = command
            .replace(/看一下|查看|的內容|的詳情|的備註|的完整|的全部|內容|詳情|備註|完整|全部/g, '')
            .trim();

        if (!keyword) {
            await reply(event, '❌ 請指定任務名稱。\n例：助理 看一下開會的內容');
            return;
        }

        const snapshot = await db.collection('tasks')
            .where('userId', '==', user.userId)
            .where('completed', '==', false)
            .get();

        let targetDoc = null;
        for (const doc of snapshot.docs) {
            if (doc.data().title && doc.data().title.includes(keyword)) {
                targetDoc = doc;
                break;
            }
        }

        if (!targetDoc) {
            const allSnapshot = await db.collection('tasks')
                .where('userId', '==', user.userId)
                .get();
            for (const doc of allSnapshot.docs) {
                if (doc.data().title && doc.data().title.includes(keyword)) {
                    targetDoc = doc;
                    break;
                }
            }
        }

        if (!targetDoc) {
            await reply(event, `❌ 找不到包含「${keyword}」的任務。`);
            return;
        }

        const t = targetDoc.data();
        let text = `📋 任務詳情：${t.title}\n`;
        text += `━━━━━━━━━━━━━━\n`;
        text += `📌 狀態：${t.completed ? '已完成' : '進行中'}\n`;
        if (t.start) text += `📅 時間：${formatDateTimeFriendly(t.start)}`;
        if (t.end) text += ` ~ ${formatDateTimeFriendly(t.end)}`;
        if (t.start) text += '\n';
        if (t.note) text += `📝 備註：${t.note}\n`;
        else text += `📝 備註：（無）\n`;
        if (t.source) {
            const sourceMap = { group: '👥 群組', private: '💬 私訊', web: '📋 後台' };
            text += `📎 來源：${sourceMap[t.source] || t.source}\n`;
        }
        if (t.createdAt) {
            const created = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt.seconds * 1000);
            text += `🕐 建立：${created.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n`;
        }
        if (t.completed && t.completedAt) {
            const completed = t.completedAt.toDate ? t.completedAt.toDate() : new Date(t.completedAt.seconds * 1000);
            text += `✅ 完成：${completed.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}\n`;
        }

        await reply(event, text);
    } catch (err) {
        console.error('查看詳情錯誤:', err);
        await reply(event, '❌ 查看任務詳情時發生錯誤。');
    }
}

// ===== 完成任務 =====
async function handleCompleteTask(event, user, command) {
    try {
        const taskName = command.replace(/完成|任務|待辦/g, '').trim();
        const snapshot = await db.collection('tasks')
            .where('userId', '==', user.userId)
            .where('completed', '==', false)
            .get();

        let targetDoc = null;
        for (const doc of snapshot.docs) {
            if (doc.data().title.includes(taskName)) {
                targetDoc = doc;
                break;
            }
        }

        if (!targetDoc) {
            await reply(event, `❌ 找不到包含「${taskName}」的待辦任務。`);
            return;
        }

        await targetDoc.ref.update({
            completed: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await reply(event, `✅ 已完成任務：${targetDoc.data().title}`);
    } catch (err) {
        console.error('完成任務錯誤:', err);
        await reply(event, '❌ 完成任務時發生錯誤。');
    }
}

// ===== 刪除任務 =====
async function handleDeleteTask(event, user, command) {
    try {
        const taskName = command.replace(/刪除|移除|任務|待辦/g, '').trim();
        const snapshot = await db.collection('tasks')
            .where('userId', '==', user.userId)
            .where('completed', '==', false)
            .get();

        let targetDoc = null;
        for (const doc of snapshot.docs) {
            if (doc.data().title.includes(taskName)) {
                targetDoc = doc;
                break;
            }
        }

        if (!targetDoc) {
            await reply(event, `❌ 找不到包含「${taskName}」的待辦任務。`);
            return;
        }

        await targetDoc.ref.delete();
        await reply(event, `🗑️ 已刪除任務：${targetDoc.data().title}`);
    } catch (err) {
        console.error('刪除任務錯誤:', err);
        await reply(event, '❌ 刪除任務時發生錯誤。');
    }
}

// ===== 修改任務 =====
async function handleModifyTask(event, user, command) {
    try {
        const now = new Date();
        const twNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const todayStr = twNow.toISOString().split('T')[0];

        const geminiText = await callGemini(`你是一個任務修改解析助手。今天日期是 ${todayStr}。
請從以下訊息中提取：原始任務關鍵字、新的任務標題、新的時間。
回傳 JSON：{"keyword": "原始關鍵字", "newTitle": "新標題或null", "newStart": "ISO時間或null", "newEnd": "ISO時間或null"}
不要加 markdown 標記。

使用者訊息：「${command}」`);

        let cleanJson = geminiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanJson);

        const snapshot = await db.collection('tasks')
            .where('userId', '==', user.userId)
            .where('completed', '==', false)
            .get();

        let targetDoc = null;
        for (const doc of snapshot.docs) {
            if (doc.data().title.includes(parsed.keyword)) {
                targetDoc = doc;
                break;
            }
        }

        if (!targetDoc) {
            await reply(event, `❌ 找不到包含「${parsed.keyword}」的任務。`);
            return;
        }

        const updates = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (parsed.newTitle) updates.title = parsed.newTitle;
        if (parsed.newStart) updates.start = parsed.newStart;
        if (parsed.newEnd) updates.end = parsed.newEnd;

        await targetDoc.ref.update(updates);

        const finalTitle = parsed.newTitle || targetDoc.data().title;
        const finalStart = parsed.newStart || targetDoc.data().start;
        let replyText = `✅ 已修改任務：${finalTitle}`;
        if (finalStart) replyText += `\n📅 ${formatDateTimeFriendly(finalStart)}`;
        await reply(event, replyText);
    } catch (err) {
        console.error('修改任務錯誤:', err);
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            await reply(event, '⏳ AI 處理中，請稍後再試一次。');
        } else {
            await reply(event, '❌ 修改任務時發生錯誤。');
        }
    }
}

// ===== 檔案查詢（含 tags、category 搜尋）=====
async function handleFileQuery(event, user, command) {
    try {
        // 提取關鍵字：移除觸發詞
        const keyword = command
            .replace(/找|查|檔案|查詢|共享|的|有沒有|有無/g, '')
            .trim();

        const snapshot = await db.collection('shared_files').get();

        if (snapshot.empty) {
            await reply(event, '📁 目前沒有共享檔案。');
            return;
        }

        let files = snapshot.docs.map(d => d.data());

        // 有關鍵字就過濾，沒有就列出全部
        if (keyword) {
            const kw = keyword.toLowerCase();
            files = files.filter(f => {
                const name = (f.name || f.fileName || '').toLowerCase();
                const desc = (f.description || '').toLowerCase();
                const cat = (f.category || '').toLowerCase();
                const tags = Array.isArray(f.tags) ? f.tags.join(' ').toLowerCase() : (f.tags || '').toLowerCase();
                return name.includes(kw) || desc.includes(kw) || cat.includes(kw) || tags.includes(kw);
            });
        }

        if (files.length === 0) {
            await reply(event, `📁 找不到包含「${keyword}」的檔案。`);
            return;
        }

        const totalCount = files.length;
        const showFiles = files.slice(0, 10);

        let text = keyword
            ? `📁 共享檔案（關鍵字：${keyword}）：\n\n`
            : `📁 全部共享檔案（共 ${totalCount} 筆）：\n\n`;

        showFiles.forEach((f, i) => {
            const displayName = f.name || f.fileName || '未命名';
            const cat = f.category ? `【${f.category}】` : '';
            text += `${i + 1}. ${cat}${displayName}`;
            if (f.description) text += `\n   📝 ${f.description}`;
            // 顯示標籤
            const tags = Array.isArray(f.tags) ? f.tags : [];
            if (tags.length > 0) text += `\n   🏷️ ${tags.map(t => '#' + t).join(' ')}`;
            if (f.url) text += `\n   🔗 ${f.url}`;
            text += '\n\n';
        });

        if (totalCount > 10) {
            text += `...還有 ${totalCount - 10} 筆，請到後台查看完整列表`;
        }

        await reply(event, text.trim());
    } catch (err) {
        console.error('檔案查詢錯誤:', err);
        await reply(event, '❌ 查詢檔案時發生錯誤。');
    }
}

// ===== 綁定信箱 =====
async function handleBindEmail(event, user, command) {
    const emailMatch = command.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (!emailMatch) {
        await reply(event, '❌ 請提供有效的 email 地址。\n範例：助理 綁定 example@gmail.com');
        return;
    }
    await db.collection('users').doc(user.userId).update({ email: emailMatch[0] });
    await reply(event, `✅ 已綁定信箱：${emailMatch[0]}`);
}

// ===== 成員列表 =====
async function handleMemberList(event) {
    const snapshot = await db.collection('users').get();
    let text = '👥 成員列表：\n\n';
    snapshot.docs.forEach((doc, i) => {
        const u = doc.data();
        const roleEmoji = u.role === ROLE_ADMIN ? '👑' : u.role === ROLE_MANAGER ? '⭐' : '👤';
        const status = u.approved ? '✅' : '❌';
        text += `${i + 1}. ${roleEmoji} ${u.displayName} ${status}\n`;
    });
    await reply(event, text);
}

// ===== 設定主管 =====
async function handleSetManager(event, command) {
    const name = command.replace(/設定|為|主管/g, '').trim();
    const snapshot = await db.collection('users').where('displayName', '==', name).get();
    if (snapshot.empty) {
        await reply(event, `❌ 找不到名為「${name}」的成員。`);
        return;
    }
    await snapshot.docs[0].ref.update({ role: ROLE_MANAGER });
    await reply(event, `✅ 已設定 ${name} 為主管。`);
}

// ===== 移除主管 =====
async function handleRemoveManager(event, command) {
    const name = command.replace(/取消|移除|的|主管/g, '').trim();
    const snapshot = await db.collection('users').where('displayName', '==', name).get();
    if (snapshot.empty) {
        await reply(event, `❌ 找不到名為「${name}」的成員。`);
        return;
    }
    await snapshot.docs[0].ref.update({ role: ROLE_MEMBER });
    await reply(event, `✅ 已取消 ${name} 的主管權限。`);
}

// ===== 查看他人任務 =====
async function handleViewOtherTasks(event, command) {
    const name = command.replace(/查看|的|待辦|任務/g, '').trim();
    const userSnapshot = await db.collection('users').where('displayName', '==', name).get();
    if (userSnapshot.empty) {
        await reply(event, `❌ 找不到名為「${name}」的成員。`);
        return;
    }
    const targetUserId = userSnapshot.docs[0].id;
    const taskSnapshot = await db.collection('tasks')
        .where('userId', '==', targetUserId)
        .where('completed', '==', false)
        .get();

    if (taskSnapshot.empty) {
        await reply(event, `📋 ${name} 目前沒有待辦任務。`);
        return;
    }

    let text = `📋 ${name} 的待辦任務：\n\n`;
    taskSnapshot.docs.forEach((doc, i) => {
        const t = doc.data();
        text += `${i + 1}. ${t.title}`;
        if (t.start) text += `\n   📅 ${formatDateTimeFriendly(t.start)}`;
        text += '\n';
    });
    await reply(event, text);
}

// ===== 一般聊天 =====
async function handleChat(event, user, command) {
    try {
        const answer = await callGemini(`你是 MoAn AdTech Bot，一個友善的業務助理。請用繁體中文回覆。\n\n使用者說：「${command}」`);
        await reply(event, answer || '抱歉，我目前無法回應。');
    } catch (err) {
        console.error('聊天錯誤:', err);
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
            await reply(event, '⏳ AI 正在思考中，請稍後再問一次。');
        } else {
            await reply(event, '抱歉，我目前無法回應，請稍後再試。');
        }
    }
}

// ===== 回覆訊息 =====
async function reply(event, text) {
    try {
        await lineClient.replyMessage(event.replyToken, { type: 'text', text });
    } catch (err) {
        console.error('回覆失敗:', err.message);
    }
}

// ===== 初始化 =====
async function init() {
    try {
        if (!BOT_USER_ID_CACHE) {
            try {
                const profile = await lineClient.getBotInfo();
                BOT_USER_ID_CACHE = profile.userId;
            } catch (e) {
                console.log('[INIT] 無法取得 Bot 資訊，使用環境變數');
            }
        }
        console.log('[INIT] Bot User ID:', BOT_USER_ID_CACHE);
        console.log('[INIT] Admin User ID:', ADMIN_USER_ID);
        console.log('[INIT] Gemini Model:', GEMINI_MODEL);

        const configDoc = await db.collection('settings').doc('system').get();
        if (configDoc.exists) {
            systemEnabled = configDoc.data().enabled !== false;
        }
        console.log('[INIT] 系統狀態:', systemEnabled ? '啟用中' : '已停用');
        console.log('[INIT] ✅ MoAn Bot v4.6 初始化完成');
    } catch (err) {
        console.error('[INIT] 初始化錯誤:', err.message);
    }
}

// ===== 啟動伺服器 =====
app.listen(PORT, async () => {
    console.log(`伺服器已啟動，port: ${PORT}`);
    await init();
});
