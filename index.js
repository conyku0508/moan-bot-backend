const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

// ========== Firebase 初始化 ==========
admin.initializeApp({ projectId: 'moan-adtech-bot' });
const db = admin.firestore();

// ========== 環境變數 ==========
const LINE_CONFIG = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(LINE_CONFIG);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const BOT_USER_ID = process.env.BOT_USER_ID || '';
const PORT = process.env.PORT || 8080;

// ========== Gemini 模型 ==========
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ========== 角色常數 ==========
const ROLE_ADMIN = 'admin';
const ROLE_MANAGER = 'manager';
const ROLE_MEMBER = 'member';

// ========== 系統狀態 ==========
let systemEnabled = true;
let BOT_USER_ID_CACHE = BOT_USER_ID;

// ========== 使用者上下文快取 ==========
const userContext = {};
function setContext(userId, taskId, taskText) {
    userContext[userId] = { taskId, taskText, timestamp: Date.now() };
}
function getContext(userId) {
    const ctx = userContext[userId];
    if (!ctx) return null;
    if (Date.now() - ctx.timestamp > 5 * 60 * 1000) {
        delete userContext[userId];
        return null;
    }
    return ctx;
}

// ========== 說明文字 ==========
function getHelpText(role) {
    let text = '【業務助理使用說明】\n\n';
    text += '📋 待辦管理：\n';
    text += '• 新增：直接輸入任務，例如「荷卡META預算確認 4/5」\n';
    text += '• 查詢：「待辦有哪些」「我的任務」\n';
    text += '• 修改時間：「荷卡那個改到下午3點」\n';
    text += '• 完成：「完成 荷卡META預算確認」\n';
    text += '• 刪除：「刪除 荷卡META預算確認」\n\n';
    text += '📁 檔案查詢：\n';
    text += '• 「找檔案 荷卡」「查報告 META」\n\n';
    text += '📧 綁定信箱：\n';
    text += '• 「綁定 你的email」\n\n';
    text += '💬 閒聊：直接跟我聊天也可以喔！\n\n';
    text += '【群組使用】\n';
    text += '在群組中說「助理 + 指令」即可\n';
    text += '例：助理 待辦有哪些\n';
    text += '例：助理 整理一下剛剛的討論\n';
    if (role === ROLE_ADMIN) {
        text += '\n【管理員指令】\n';
        text += '• 「系統停用」/「系統啟用」\n';
        text += '• 「成員列表」\n';
        text += '• 「設定主管 @名字」/「取消主管 @名字」\n';
        text += '• 「查看 @名字 的待辦」\n';
    } else if (role === ROLE_MANAGER) {
        text += '\n【主管指令】\n';
        text += '• 「成員列表」\n';
        text += '• 「查看 @名字 的待辦」\n';
    }
    return text;
}

// ========== 日期時間偵測 ==========
function detectDateTime(msg) {
    const hasDate = /\d{1,4}[\/\-\.]\d{1,2}([\/\-\.]\d{1,4})?/.test(msg) ||
        /今天|明天|後天|大後天|下週|下周|週[一二三四五六日]|星期[一二三四五六日]/.test(msg);
    const hasTime = /\d{1,2}\s*[:.：]\s*\d{0,2}/.test(msg) ||
        /\d{1,2}\s*點/.test(msg) ||
        /上午|下午|早上|中午|晚上/.test(msg);
    return { hasDate, hasTime };
}

// ========== 使用者管理 ==========
async function getOrCreateUser(userId, displayName) {
    let docRef = db.collection('users').doc(userId);
    let doc = await docRef.get();
    if (doc.exists) {
        const data = doc.data();
        await docRef.update({ lastActive: admin.firestore.FieldValue.serverTimestamp() });
        return { id: doc.id, ...data };
    }
    let snap = await db.collection('users').where('userId', '==', userId).get();
    if (!snap.empty) {
        const d = snap.docs[0];
        await d.ref.update({ lastActive: admin.firestore.FieldValue.serverTimestamp() });
        return { id: d.id, ...d.data() };
    }
    snap = await db.collection('users').where('odId', '==', userId).get();
    if (!snap.empty) {
        const d = snap.docs[0];
        await d.ref.update({ lastActive: admin.firestore.FieldValue.serverTimestamp() });
        return { id: d.id, ...d.data() };
    }
    const newUser = {
        userId: userId,
        odId: userId,
        displayName: displayName || '未知',
        name: displayName || '未知',
        role: ROLE_MEMBER,
        approved: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp()
    };
    if (userId === ADMIN_USER_ID) {
        newUser.role = ROLE_ADMIN;
        newUser.approved = true;
    }
    await docRef.set(newUser);
    return { id: userId, ...newUser };
}

// ========== 權限檢查 ==========
function isAdmin(user) { return user.role === ROLE_ADMIN; }
function isManager(user) { return user.role === ROLE_MANAGER; }
function isPrivileged(user) { return user.role === ROLE_ADMIN || user.role === ROLE_MANAGER; }

// ========== 使用者搜尋 ==========
async function findUserByName(name) {
    const clean = name.replace(/^@/, '').trim();
    let snap = await db.collection('users').where('name', '==', clean).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    snap = await db.collection('users').where('displayName', '==', clean).get();
    if (!snap.empty) return { id: snap.docs[0].id, ...snap.docs[0].data() };
    return null;
}

// ========== Express 伺服器 ==========
const app = express();
app.post('/webhook', line.middleware(LINE_CONFIG), async (req, res) => {
    res.status(200).send('OK');
    const events = req.body.events || [];
    for (const event of events) {
        try {
            if (event.type !== 'message' || event.message.type !== 'text') continue;
            const userId = event.source.userId;
            const groupId = event.source.groupId;
            if (groupId) {
                await handleGroupMessage(event, groupId, userId);
            } else {
                await handlePrivateMessage(event, userId);
            }
        } catch (err) {
            console.error('事件處理錯誤:', err.message, err.stack);
        }
    }
});

app.get('/', (req, res) => {
    res.send('MoAn Bot is running! v3.9');
});

// ========== 私訊處理（加入白名單檢查）==========
async function handlePrivateMessage(event, userId) {
    const msg = event.message.text.trim();
    let displayName = '未知';
    try {
        const profile = await client.getProfile(userId);
        displayName = profile.displayName;
    } catch (e) {}
    const user = await getOrCreateUser(userId, displayName);
    if (!user.approved && user.role !== ROLE_ADMIN) {
        return reply(event, '⚠️ 你尚未被授權使用本系統。\n請聯繫管理員開通權限。');
    }
    if (!systemEnabled && !isAdmin(user)) {
        return reply(event, '系統目前已停用，請稍後再試。');
    }
    await handleDirectMessage(event, userId, msg, user);
}

// ========== 群組訊息（不擋人）==========
async function handleGroupMessage(event, groupId, userId) {
    const rawText = event.message.text.trim();
    const botId = BOT_USER_ID_CACHE;
    let isMentioned = false;
    let commandText = rawText;

    if (event.message.mention) {
        const mentionees = event.message.mention.mentionees || [];
        for (const m of mentionees) {
            if (m.userId === botId) {
                isMentioned = true;
                commandText = rawText.replace(/@\S+/g, '').trim();
                break;
            }
        }
    }

    const triggerKeywords = ['業務助理', '小助理', '助理'];
    let keywordTriggered = false;
    if (!isMentioned) {
        for (const kw of triggerKeywords) {
            if (rawText.startsWith(kw)) {
                keywordTriggered = true;
                commandText = rawText.replace(new RegExp(`^${kw}[，,\\s]*`), '').trim();
                console.log(`群組關鍵字觸發: "${kw}" → 指令: "${commandText}"`);
                break;
            }
        }
    }

    if (!isMentioned && !keywordTriggered) {
        let senderName = '未知';
        try {
            const profile = await client.getGroupMemberProfile(groupId, userId);
            senderName = profile.displayName;
        } catch (e) {}
        await db.collection('group_logs').add({
            groupId, userId, senderName, text: rawText,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        return null;
    }

    let senderName = '未知';
    try {
        const profile = await client.getGroupMemberProfile(groupId, userId);
        senderName = profile.displayName;
    } catch (e) {}

    const user = await getOrCreateUser(userId, senderName);

    if (!commandText) {
        return reply(event, '我在！請問需要什麼協助？\n輸入「助理 怎麼用」查看使用說明。');
    }

    const helpKeywords = ['怎麼用', '使用說明', '你會什麼', 'help', '功能', '指令'];
    if (helpKeywords.some(k => commandText.includes(k))) {
        return reply(event, getHelpText(user.role));
    }

    const summaryKeywords = ['整理', '摘要', '總結', '剛剛說了什麼', '討論了什麼'];
    if (summaryKeywords.some(k => commandText.includes(k))) {
        return await handleGroupSummary(event, groupId);
    }

    event._isGroup = true;
    return await handleDirectMessage(event, userId, commandText, user);
}

// ========== 群組摘要 ==========
async function handleGroupSummary(event, groupId) {
    try {
        const snap = await db.collection('group_logs')
            .where('groupId', '==', groupId)
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
        if (snap.empty) return reply(event, '目前沒有群組對話記錄可以整理。');
        let logs = [];
        snap.forEach(d => {
            const data = d.data();
            logs.push(`${data.senderName}: ${data.text}`);
        });
        logs.reverse();
        const prompt = `以下是一個工作群組最近的對話記錄，請用繁體中文做一個簡潔的摘要，列出重點討論事項和待辦：\n\n${logs.join('\n')}`;
        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });
        const summary = response.data.candidates[0].content.parts[0].text.trim();
        return reply(event, `📋 群組討論摘要：\n\n${summary}`);
    } catch (err) {
        console.error('摘要錯誤:', err.message);
        return reply(event, '整理摘要時遇到問題，請稍後再試。');
    }
}

// ========== 核心訊息處理 ==========
async function handleDirectMessage(event, userId, msg, user) {
    const intent = await classifyIntent(msg);
    console.log(`使用者: ${userId}, 訊息: "${msg}", 意圖: ${intent}`);

    if (isAdmin(user)) {
        if (msg === '系統停用') { systemEnabled = false; await db.collection('system').doc('config').set({ enabled: false }); return reply(event, '系統已停用。'); }
        if (msg === '系統啟用') { systemEnabled = true; await db.collection('system').doc('config').set({ enabled: true }); return reply(event, '系統已啟用。'); }
        if (msg === '成員列表') return await handleMemberList(event);
        if (msg.startsWith('設定主管')) return await handleSetManager(event, msg);
        if (msg.startsWith('取消主管')) return await handleRemoveManager(event, msg);
    }
    if (isManager(user)) {
        if (msg === '成員列表') return await handleMemberList(event);
    }

    if (msg.startsWith('查看') && msg.includes('的待辦') && isPrivileged(user)) {
        return await handleViewOtherTasks(event, msg);
    }

    if (msg.startsWith('綁定')) {
        const email = msg.replace('綁定', '').trim();
        if (email && email.includes('@')) {
            await db.collection('users').doc(userId).update({ email: email }).catch(async () => {
                const snap = await db.collection('users').where('userId', '==', userId).get();
                if (!snap.empty) await snap.docs[0].ref.update({ email: email });
            });
            return reply(event, `已綁定信箱：${email}`);
        }
        return reply(event, '請輸入「綁定 你的email」，例如：綁定 cony@js-adways.com.tw');
    }

    if (msg === '確認' || msg === '取消') {
        return await handleConfirmOrCancel(event, userId, msg);
    }

    switch (intent) {
        case 'QUERY_TASKS':
            return await handleQueryTasks(event, userId);
        case 'ADD_TASK':
            return await handleAddTask(event, msg, userId, user);
        case 'MODIFY_TASK':
            return await handleModifyTask(event, msg, userId, user.email);
        case 'COMPLETE_TASK':
            return await handleCompleteTask(event, msg, userId);
        case 'DELETE_TASK':
            return await handleDeleteTask(event, msg, userId);
        case 'QUERY_FILE':
            return await handleFileQuery(event, msg);
        case 'HELP':
            return reply(event, getHelpText(user.role));
        case 'CHITCHAT':
        default:
            return await handleChitchat(event, msg);
    }
}

// ========== 意圖分類 ==========
async function classifyIntent(msg) {
    if (/待辦|任務|事項|有哪些|列表|清單/.test(msg) && !/新增|加入|幫我|交辦/.test(msg)) return 'QUERY_TASKS';
    if (/完成了?|做完了?|結案/.test(msg) && msg.length < 50) return 'COMPLETE_TASK';
    if (/刪除|移除|取消任務/.test(msg)) return 'DELETE_TASK';
    if (/改到|改成|延後|提前|改時間|換到|調整到|移到|時間改/.test(msg)) return 'MODIFY_TASK';
    if (/找檔案|查檔案|共享檔案|查報告|找報告/.test(msg)) return 'QUERY_FILE';
    if (/怎麼用|使用說明|你會什麼|help|功能|指令/.test(msg)) return 'HELP';

    const dt = detectDateTime(msg);
    if (dt.hasDate || dt.hasTime) return 'ADD_TASK';

    try {
        const prompt = `你是一個意圖分類器。根據以下使用者訊息，判斷意圖類別。只回覆類別名稱，不要其他文字。

類別：
- QUERY_TASKS：查詢待辦事項
- ADD_TASK：新增待辦事項、交辦任務、安排工作
- MODIFY_TASK：修改任務時間
- COMPLETE_TASK：完成任務
- DELETE_TASK：刪除任務
- QUERY_FILE：查詢共享檔案
- CHITCHAT：閒聊、打招呼、其他

使用者訊息：「${msg}」`;

        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });

        const result = response.data.candidates[0].content.parts[0].text.trim();
        const validIntents = ['QUERY_TASKS', 'ADD_TASK', 'MODIFY_TASK', 'COMPLETE_TASK', 'DELETE_TASK', 'QUERY_FILE', 'HELP', 'CHITCHAT'];
        return validIntents.includes(result) ? result : 'CHITCHAT';
    } catch (err) {
        console.error('Gemini 分類錯誤:', err.message);
        return 'CHITCHAT';
    }
}

// ========== 查詢待辦 ==========
async function handleQueryTasks(event, userId) {
    try {
        let snap;
        try {
            snap = await db.collection('chat_logs')
                .where('ownerId', '==', userId)
                .where('status', '==', 'active')
                .orderBy('timestamp', 'desc')
                .get();
        } catch (indexErr) {
            console.log('索引錯誤，使用備用查詢');
            snap = await db.collection('chat_logs')
                .where('ownerId', '==', userId)
                .where('status', '==', 'active')
                .get();
        }
        if (snap.empty) return reply(event, '你目前沒有待辦事項！🎉');
        let tasks = [];
        snap.forEach(d => tasks.push({ id: d.id, ...d.data() }));
        tasks.sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

        let text = `📋 你的待辦事項（共 ${tasks.length} 筆）：\n\n`;
        tasks.forEach((t, i) => {
            const ts = t.timestamp ? new Date(t.timestamp.seconds * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '';
            const scheduled = t.scheduledStart ? new Date(t.scheduledStart).toLocaleString('zh-TW', {
                timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : '';
            text += `${i + 1}. ${t.text}`;
            if (scheduled) text += `\n   📅 ${scheduled}`;
            text += `\n   🕐 建立：${ts}\n\n`;
        });
        return reply(event, text.trim());
    } catch (err) {
        console.error('查詢待辦錯誤:', err.message);
        return reply(event, '查詢待辦時遇到問題，請稍後再試。');
    }
}

// ========== 新增待辦（加入完整 debug log）==========
async function handleAddTask(event, msg, userId, user) {
    try {
        const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const prompt = `現在台灣時間是 ${now}。

使用者說：「${msg}」

請從中提取待辦事項。回傳 JSON 陣列格式：
[{"title":"任務標題","start":"ISO 8601 時間或 null","end":"ISO 8601 時間或 null"}]

注意：
- 如果使用者一次提到多個任務，分別列出
- 時間請轉換為完整的 ISO 8601 格式（含時區 +08:00）
- 如果只有日期沒有時間，預設用當天 09:00
- end 預設為 start 的一小時後
- 如果完全沒有提到時間或日期，start 和 end 設為 null
- 只回傳 JSON，不要其他文字`;

        console.log('[ADD_TASK] 呼叫 Gemini 解析任務...');
        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });

        const aiText = response.data.candidates[0].content.parts[0].text.trim();
        console.log('[ADD_TASK] Gemini 原始回傳:', aiText);

        const jsonMatch = aiText.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            console.error('[ADD_TASK] 無法從 Gemini 回傳中提取 JSON');
            return reply(event, '我無法理解這個任務，請再說一次？');
        }

        const tasks = JSON.parse(jsonMatch[0]);
        console.log('[ADD_TASK] 解析後的任務:', JSON.stringify(tasks));

        if (!tasks || tasks.length === 0) return reply(event, '我無法理解這個任務，請再說一次？');

        // ===== 群組：直接建立 =====
        if (event._isGroup) {
            let results = [];
            for (const task of tasks) {
                console.log(`[ADD_TASK][群組] 處理任務: "${task.title}", start: ${task.start}, end: ${task.end}`);

                const taskData = {
                    text: task.title,
                    ownerId: userId,
                    ownerName: user.name || user.displayName || '未知',
                    status: 'active',
                    source: 'line-group',
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                };
                if (task.start) taskData.scheduledStart = task.start;
                if (task.end) taskData.scheduledEnd = task.end;

                const docRef = await db.collection('chat_logs').add(taskData);
                console.log(`[ADD_TASK][群組] 任務已寫入 Firestore, docId: ${docRef.id}`);

                // ===== 行事曆同步 =====
                let calendarSynced = false;
                if (task.start) {
                    console.log(`[ADD_TASK][群組] 開始同步行事曆, start: ${task.start}, end: ${task.end || task.start}`);
                    try {
                        const calId = await createCalendarEvent({
                            title: task.title,
                            start: task.start,
                            end: task.end || task.start
                        });
                        if (calId) {
                            await docRef.update({ calendarEventId: calId });
                            calendarSynced = true;
                            console.log(`[ADD_TASK][群組] 行事曆同步成功, calendarEventId: ${calId}`);
                        } else {
                            console.warn('[ADD_TASK][群組] createCalendarEvent 回傳 null');
                        }
                    } catch (calErr) {
                        console.error('[ADD_TASK][群組] 行事曆同步失敗:', calErr.message, calErr.stack);
                    }
                } else {
                    console.log('[ADD_TASK][群組] 沒有 start 時間，跳過行事曆同步');
                }

                setContext(userId, docRef.id, task.title);
                const timeStr = task.start ? new Date(task.start).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                }) : '';

                let resultMsg = `「${task.title}」已加入待辦`;
                if (timeStr) resultMsg += `，排程 ${timeStr}`;
                if (calendarSynced) resultMsg += '，📅 行事曆已同步！';
                else if (task.start) resultMsg += '（⚠️ 行事曆同步失敗）';
                else resultMsg += '！';

                results.push(resultMsg);
            }
            return reply(event, results.join('\n'));
        }

        // ===== 私聊：需確認 =====
        const pendingRef = db.collection('pending_proposals').doc(userId);
        await pendingRef.set({
            tasks: tasks,
            originalMsg: msg,
            userId: userId,
            userName: user.name || user.displayName || '未知',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        let confirmText = '我幫你整理了以下待辦：\n\n';
        tasks.forEach((t, i) => {
            confirmText += `${i + 1}. ${t.title}`;
            if (t.start) {
                const timeStr = new Date(t.start).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
                });
                confirmText += `（${timeStr}）`;
            }
            confirmText += '\n';
        });
        confirmText += '\n請回覆「確認」建立，或「取消」放棄。';

        return reply(event, confirmText);
    } catch (err) {
        console.error('[ADD_TASK] 新增待辦錯誤:', err.message, err.stack);
        return reply(event, '新增待辦時遇到問題，請稍後再試。');
    }
}

// ========== 確認/取消待辦 ==========
async function handleConfirmOrCancel(event, userId, msg) {
    const pendingRef = db.collection('pending_proposals').doc(userId);
    const pendingDoc = await pendingRef.get();
    if (!pendingDoc.exists) {
        return reply(event, '目前沒有待確認的待辦事項。');
    }
    if (msg === '取消') {
        await pendingRef.delete();
        return reply(event, '已取消，待辦未建立。');
    }
    const pending = pendingDoc.data();
    return await executeConfirmedTasks(event, userId, pending);
}

// ========== 執行已確認的待辦 ==========
async function executeConfirmedTasks(event, userId, pending) {
    try {
        const tasks = pending.tasks;
        let results = [];
        for (const task of tasks) {
            console.log(`[CONFIRM] 處理任務: "${task.title}", start: ${task.start}, end: ${task.end}`);

            const taskData = {
                text: task.title,
                ownerId: userId,
                ownerName: pending.userName || '未知',
                status: 'active',
                source: 'line',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            };
            if (task.start) taskData.scheduledStart = task.start;
            if (task.end) taskData.scheduledEnd = task.end;

            const docRef = await db.collection('chat_logs').add(taskData);
            console.log(`[CONFIRM] 任務已寫入 Firestore, docId: ${docRef.id}`);

            let calendarSynced = false;
            if (task.start) {
                console.log(`[CONFIRM] 開始同步行事曆, start: ${task.start}`);
                try {
                    const calId = await createCalendarEvent({
                        title: task.title,
                        start: task.start,
                        end: task.end || task.start
                    });
                    if (calId) {
                        await docRef.update({ calendarEventId: calId });
                        calendarSynced = true;
                        console.log(`[CONFIRM] 行事曆同步成功, calendarEventId: ${calId}`);
                    } else {
                        console.warn('[CONFIRM] createCalendarEvent 回傳 null');
                    }
                } catch (calErr) {
                    console.error('[CONFIRM] 行事曆同步失敗:', calErr.message, calErr.stack);
                }
            } else {
                console.log('[CONFIRM] 沒有 start 時間，跳過行事曆同步');
            }

            setContext(userId, docRef.id, task.title);
            const timeStr = task.start ? new Date(task.start).toLocaleString('zh-TW', {
                timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
            }) : '';

            let resultMsg = `「${task.title}」已加入待辦`;
            if (calendarSynced) resultMsg += '，📅 行事曆已同步！';
            else if (task.start) resultMsg += `，排程 ${timeStr}（⚠️ 行事曆同步失敗）`;
            else resultMsg += '！';

            results.push(resultMsg);
        }
        await db.collection('pending_proposals').doc(userId).delete();
        return reply(event, results.join('\n'));
    } catch (err) {
        console.error('[CONFIRM] 執行待辦錯誤:', err.message);
        return reply(event, '建立待辦時遇到問題，請稍後再試。');
    }
}

// ========== 修改任務 ==========
async function handleModifyTask(event, msg, userId, userEmail) {
    try {
        console.log('=== 修改任務開始 ===');
        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active').get();
        if (snap.empty) return reply(event, '你目前沒有任何待辦事項可以修改。');

        const msgClean = msg
            .replace(/改到|改成|延後|提前|改時間|換到|調整到|移到|移至|搬到|時間改|修改|變更/g, '')
            .replace(/上午|下午|早上|中午|晚上|今天|明天|後天|大後天/g, '')
            .replace(/下週|下周|週[一二三四五六日]/g, '')
            .replace(/星期[一二三四五六日]/g, '')
            .replace(/\d{1,2}\s*[:.：]\s*\d{0,2}/g, '')
            .replace(/\d{1,2}\s*點\s*(\d{1,2}\s*分)?/g, '')
            .replace(/\d{1,4}\s*[\/\-\.]\s*\d{1,2}(\s*[\/\-\.]\s*\d{1,4})?/g, '')
            .replace(/的|把|將|幫我|請|那個|這個|那筆|那件|這筆|這件|時間/g, '')
            .replace(/\s+/g, ' ').trim();

        console.log(`清理後關鍵字: "${msgClean}"`);

        const taskList = [];
        snap.forEach(doc => taskList.push({ id: doc.id, doc, text: doc.data().text || '' }));

        let targetDoc = null, targetData = null;

        if (msgClean.length >= 2) {
            const exact = taskList.find(t => t.text.includes(msgClean) || msgClean.includes(t.text));
            if (exact) {
                targetDoc = exact.doc;
                targetData = exact.doc.data();
                console.log(`完全匹配: ${exact.text}`);
            }

            if (!targetDoc) {
                const listStr = taskList.map((t, i) => `${i + 1}. ID:${t.id} 標題:${t.text}`).join('\n');
                const prompt = `使用者說：「${msg}」\n以下是他的待辦清單：\n${listStr}\n使用者想修改哪個任務的時間？只回覆該任務的 ID，如果無法判斷回覆 UNCLEAR。`;
                try {
                    const r = await axios.post(GEMINI_URL, {
                        contents: [{ parts: [{ text: prompt }] }]
                    }, { headers: { 'Content-Type': 'application/json' } });
                    const aiResult = r.data.candidates[0].content.parts[0].text.trim();
                    console.log(`AI 匹配結果: ${aiResult}`);
                    const matched = taskList.find(t => t.id === aiResult);
                    if (aiResult !== 'UNCLEAR' && matched) {
                        targetDoc = matched.doc;
                        targetData = matched.doc.data();
                    }
                } catch (e) {
                    console.error('AI 匹配失敗:', e.message);
                }
            }

            if (!targetDoc) {
                let bestScore = 0, best = null;
                taskList.forEach(t => {
                    let score = 0;
                    for (let len = msgClean.length; len >= 2; len--) {
                        for (let start = 0; start <= msgClean.length - len; start++) {
                            const sub = msgClean.substring(start, start + len);
                            if (t.text.includes(sub)) score = Math.max(score, len * 15);
                        }
                    }
                    if (score > bestScore) { bestScore = score; best = t; }
                });
                if (best && bestScore >= 30) {
                    targetDoc = best.doc;
                    targetData = best.doc.data();
                    console.log(`子字串匹配: ${best.text}, 分數: ${bestScore}`);
                }
            }
        }

        if (!targetDoc && msgClean.length < 2) {
            const ctx = getContext(userId);
            if (ctx) {
                const docSnap = await db.collection('chat_logs').doc(ctx.taskId).get();
                if (docSnap.exists && docSnap.data().status === 'active') {
                    targetDoc = docSnap;
                    targetData = docSnap.data();
                }
            }
        }

        if (!targetDoc && snap.size === 1) {
            targetDoc = snap.docs[0];
            targetData = targetDoc.data();
        }

        if (!targetDoc) {
            let list = '你有多個待辦，請說清楚要改哪一個：\n';
            snap.forEach((d, i) => { list += `${i + 1}. ${d.data().text}\n`; });
            return reply(event, list + '\n例如：「交辦JJ製作荷卡素材 改到下午3點」');
        }

        const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        const timePrompt = `現在台灣時間是 ${now}。使用者想修改任務「${targetData.text}」的時間。原本排程：${targetData.scheduledStart || '無'}。使用者說：「${msg}」\n請回傳 JSON {"start":"ISO 8601","end":"ISO 8601"}，時區用 +08:00。只回傳 JSON。`;
        const rTime = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: timePrompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });
        const aiTxt = rTime.data.candidates[0].content.parts[0].text.trim();
        const jsonMatch = aiTxt.match(/\{.*\}/s);
        const newTime = JSON.parse(jsonMatch[0]);

        await db.collection('chat_logs').doc(targetDoc.id).update({
            scheduledStart: newTime.start,
            scheduledEnd: newTime.end,
            lastModified: admin.firestore.FieldValue.serverTimestamp()
        });

        if (targetData.calendarEventId) {
            try {
                await updateCalendarEvent(targetData.calendarEventId, {
                    title: targetData.text,
                    start: newTime.start,
                    end: newTime.end
                });
            } catch (e) {
                console.error('行事曆更新失敗:', e.message);
            }
        }

        setContext(userId, targetDoc.id, targetData.text);

        const st = new Date(newTime.start);
        const timeStr = st.toLocaleString('zh-TW', {
            timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        return reply(event, `「${targetData.text}」已改到 ${timeStr}，行事曆也同步更新了！`);
    } catch (e) {
        console.error('修改任務錯誤:', e.message, e.stack);
        return reply(event, '修改任務時遇到問題，請稍後再試。');
    }
}

// ========== 完成任務 ==========
async function handleCompleteTask(event, msg, userId) {
    try {
        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active').get();
        if (snap.empty) return reply(event, '你目前沒有待辦事項可以完成。');

        const cleanMsg = msg.replace(/完成了?|做完了?|結案/g, '').trim();
        let targetDoc = null;

        if (cleanMsg.length >= 2) {
            snap.forEach(doc => {
                const text = doc.data().text || '';
                if (text.includes(cleanMsg) || cleanMsg.includes(text)) targetDoc = doc;
            });

            if (!targetDoc) {
                const taskList = [];
                snap.forEach(doc => taskList.push({ id: doc.id, text: doc.data().text || '' }));
                const listStr = taskList.map((t, i) => `${i + 1}. ID:${t.id} 標題:${t.text}`).join('\n');
                const prompt = `使用者說：「${msg}」\n以下是他的待辦清單：\n${listStr}\n使用者想完成哪個任務？只回覆 ID 或 UNCLEAR。`;
                try {
                    const r = await axios.post(GEMINI_URL, {
                        contents: [{ parts: [{ text: prompt }] }]
                    }, { headers: { 'Content-Type': 'application/json' } });
                    const aiResult = r.data.candidates[0].content.parts[0].text.trim();
                    const matched = taskList.find(t => t.id === aiResult);
                    if (aiResult !== 'UNCLEAR' && matched) {
                        targetDoc = snap.docs.find(d => d.id === matched.id);
                    }
                } catch (e) {}
            }
        }

        if (!targetDoc) {
            const ctx = getContext(userId);
            if (ctx) {
                const docSnap = await db.collection('chat_logs').doc(ctx.taskId).get();
                if (docSnap.exists && docSnap.data().status === 'active') targetDoc = docSnap;
            }
        }

        if (!targetDoc && snap.size === 1) targetDoc = snap.docs[0];

        if (!targetDoc) {
            let list = '你有多個待辦，請說清楚要完成哪一個：\n';
            snap.forEach((d, i) => { list += `${i + 1}. ${d.data().text}\n`; });
            return reply(event, list);
        }

        const taskData = targetDoc.data();
        await db.collection('chat_logs').doc(targetDoc.id).update({
            status: 'archived',
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return reply(event, `✅「${taskData.text}」已完成！做得好！`);
    } catch (err) {
        console.error('完成任務錯誤:', err.message);
        return reply(event, '完成任務時遇到問題，請稍後再試。');
    }
}

// ========== 刪除任務 ==========
async function handleDeleteTask(event, msg, userId) {
    try {
        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active').get();
        if (snap.empty) return reply(event, '你目前沒有待辦事項可以刪除。');

        const cleanMsg = msg.replace(/刪除|移除|取消任務/g, '').trim();
        let targetDoc = null;

        if (cleanMsg.length >= 2) {
            snap.forEach(doc => {
                const text = doc.data().text || '';
                if (text.includes(cleanMsg) || cleanMsg.includes(text)) targetDoc = doc;
            });

            if (!targetDoc) {
                const taskList = [];
                snap.forEach(doc => taskList.push({ id: doc.id, text: doc.data().text || '' }));
                const listStr = taskList.map((t, i) => `${i + 1}. ID:${t.id} 標題:${t.text}`).join('\n');
                const prompt = `使用者說：「${msg}」\n以下是他的待辦清單：\n${listStr}\n使用者想刪除哪個任務？只回覆 ID 或 UNCLEAR。`;
                try {
                    const r = await axios.post(GEMINI_URL, {
                        contents: [{ parts: [{ text: prompt }] }]
                    }, { headers: { 'Content-Type': 'application/json' } });
                    const aiResult = r.data.candidates[0].content.parts[0].text.trim();
                    const matched = taskList.find(t => t.id === aiResult);
                    if (aiResult !== 'UNCLEAR' && matched) {
                        targetDoc = snap.docs.find(d => d.id === matched.id);
                    }
                } catch (e) {}
            }
        }

        if (!targetDoc) {
            const ctx = getContext(userId);
            if (ctx) {
                const docSnap = await db.collection('chat_logs').doc(ctx.taskId).get();
                if (docSnap.exists && docSnap.data().status === 'active') targetDoc = docSnap;
            }
        }

        if (!targetDoc && snap.size === 1) targetDoc = snap.docs[0];

        if (!targetDoc) {
            let list = '你有多個待辦，請說清楚要刪除哪一個：\n';
            snap.forEach((d, i) => { list += `${i + 1}. ${d.data().text}\n`; });
            return reply(event, list);
        }

        const taskData = targetDoc.data();
        await db.collection('chat_logs').doc(targetDoc.id).delete();

        return reply(event, `🗑️「${taskData.text}」已刪除。`);
    } catch (err) {
        console.error('刪除任務錯誤:', err.message);
        return reply(event, '刪除任務時遇到問題，請稍後再試。');
    }
}

// ========== 共享檔案查詢 ==========
async function handleFileQuery(event, msg) {
    try {
        const keyword = msg.replace(/找檔案|查檔案|共享檔案|查報告|找報告/g, '').trim();
        const snap = await db.collection('shared_files').get();
        if (snap.empty) return reply(event, '目前沒有共享檔案。');

        let files = [];
        snap.forEach(d => files.push({ id: d.id, ...d.data() }));

        if (keyword) {
            files = files.filter(f => {
                const tags = Array.isArray(f.tags) ? f.tags.join(' ') : (f.tags || '');
                const haystack = ((f.name || '') + (f.category || '') + (f.description || '') + tags).toLowerCase();
                return haystack.includes(keyword.toLowerCase());
            });
        }

        if (files.length === 0) return reply(event, `找不到包含「${keyword}」的檔案。`);

        let text = `📁 共享檔案（${files.length} 筆）：\n\n`;
        files.slice(0, 10).forEach((f, i) => {
            text += `${i + 1}. ${f.name || '(無名稱)'}`;
            if (f.category) text += `【${f.category}】`;
            text += '\n';
            if (f.description) text += `   ${f.description}\n`;
            if (f.url) text += `   🔗 ${f.url}\n`;
            text += '\n';
        });

        if (files.length > 10) text += `...還有 ${files.length - 10} 筆，請到後台查看完整清單。`;

        return reply(event, text.trim());
    } catch (err) {
        console.error('檔案查詢錯誤:', err.message);
        return reply(event, '查詢檔案時遇到問題，請稍後再試。');
    }
}

// ========== 閒聊 ==========
async function handleChitchat(event, msg) {
    try {
        const prompt = `你是一個名叫「業務助理」的 AI 助手，個性友善、專業、有效率。你主要幫助使用者管理待辦事項和工作任務。請用繁體中文回覆。

使用者說：「${msg}」

請自然地回覆，如果使用者似乎想新增任務，引導他說出任務內容和時間。回覆要簡短，不超過 100 字。`;

        const response = await axios.post(GEMINI_URL, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { headers: { 'Content-Type': 'application/json' } });

        const aiReply = response.data.candidates[0].content.parts[0].text.trim();
        return reply(event, aiReply);
    } catch (err) {
        console.error('閒聊錯誤:', err.message);
        return reply(event, '嗨！有什麼我可以幫你的嗎？');
    }
}

// ========== 管理員功能 ==========
async function handleMemberList(event) {
    const snap = await db.collection('users').get();
    if (snap.empty) return reply(event, '目前沒有成員。');
    let text = '👥 成員列表：\n\n';
    snap.forEach(d => {
        const data = d.data();
        const role = data.role === 'admin' ? '👑' : data.role === 'manager' ? '⭐' : '👤';
        const approved = data.approved ? '✅' : '⛔';
        text += `${role} ${data.name || data.displayName || '未知'} ${approved}\n`;
    });
    return reply(event, text.trim());
}

async function handleSetManager(event, msg) {
    const name = msg.replace('設定主管', '').trim();
    const user = await findUserByName(name);
    if (!user) return reply(event, `找不到「${name}」這個成員。`);
    const snap = await db.collection('users').where('userId', '==', user.userId || user.odId).get();
    if (!snap.empty) {
        await snap.docs[0].ref.update({ role: ROLE_MANAGER });
    }
    return reply(event, `已將「${name}」設定為主管。`);
}

async function handleRemoveManager(event, msg) {
    const name = msg.replace('取消主管', '').trim();
    const user = await findUserByName(name);
    if (!user) return reply(event, `找不到「${name}」這個成員。`);
    const snap = await db.collection('users').where('userId', '==', user.userId || user.odId).get();
    if (!snap.empty) {
        await snap.docs[0].ref.update({ role: ROLE_MEMBER });
    }
    return reply(event, `已將「${name}」的主管權限移除。`);
}

async function handleViewOtherTasks(event, msg) {
    const nameMatch = msg.match(/查看\s*(.+?)\s*的待辦/);
    if (!nameMatch) return reply(event, '格式：查看 @名字 的待辦');
    const targetUser = await findUserByName(nameMatch[1]);
    if (!targetUser) return reply(event, `找不到「${nameMatch[1]}」這個成員。`);
    const targetId = targetUser.userId || targetUser.odId;
    const snap = await db.collection('chat_logs')
        .where('ownerId', '==', targetId)
        .where('status', '==', 'active').get();
    if (snap.empty) return reply(event, `${nameMatch[1]} 目前沒有待辦事項。`);
    let tasks = [];
    snap.forEach(d => tasks.push(d.data()));
    let text = `📋 ${nameMatch[1]} 的待辦事項（${tasks.length} 筆）：\n\n`;
    tasks.forEach((t, i) => {
        text += `${i + 1}. ${t.text}\n`;
    });
    return reply(event, text.trim());
}

// ========== Google Calendar（使用 CALENDAR_EMAIL + CALENDAR_PRIVATE_KEY）==========
async function createCalendarEvent(eventData) {
    try {
        console.log('[CALENDAR] createCalendarEvent 被呼叫, eventData:', JSON.stringify(eventData));
        const calendarId = process.env.MY_CALENDAR_ID;
        const clientEmail = process.env.CALENDAR_EMAIL;
        const privateKey = (process.env.CALENDAR_PRIVATE_KEY || '').replace(/\\n/g, '\n');

        console.log(`[CALENDAR] calendarId: ${calendarId || '(未設定)'}`);
        console.log(`[CALENDAR] clientEmail: ${clientEmail || '(未設定)'}`);
        console.log(`[CALENDAR] privateKey 長度: ${privateKey.length}`);

        if (!calendarId) {
            console.error('[CALENDAR] MY_CALENDAR_ID 未設定！');
            return null;
        }
        if (!clientEmail) {
            console.error('[CALENDAR] CALENDAR_EMAIL 未設定！');
            return null;
        }
        if (!privateKey || privateKey.length < 100) {
            console.error('[CALENDAR] CALENDAR_PRIVATE_KEY 未設定或不完整！');
            return null;
        }

        const auth = new google.auth.JWT(clientEmail, null, privateKey, ['https://www.googleapis.com/auth/calendar']);
        const calendar = google.calendar({ version: 'v3', auth });

        const res = await calendar.events.insert({
            calendarId: calendarId,
            requestBody: {
                summary: eventData.title,
                start: { dateTime: eventData.start, timeZone: 'Asia/Taipei' },
                end: { dateTime: eventData.end, timeZone: 'Asia/Taipei' }
            }
        });
        console.log('[CALENDAR] 行事曆事件已建立:', res.data.id);
        return res.data.id;
    } catch (err) {
        console.error('[CALENDAR] 建立行事曆事件失敗:', err.message);
        if (err.response) {
            console.error('[CALENDAR] API 回應:', JSON.stringify(err.response.data));
        }
        return null;
    }
}

async function updateCalendarEvent(eventId, eventData) {
    try {
        const calendarId = process.env.MY_CALENDAR_ID;
        const clientEmail = process.env.CALENDAR_EMAIL;
        const privateKey = (process.env.CALENDAR_PRIVATE_KEY || '').replace(/\\n/g, '\n');

        if (!calendarId || !clientEmail || !privateKey) {
            console.error('[CALENDAR] 更新失敗：缺少必要設定');
            return;
        }

        const auth = new google.auth.JWT(clientEmail, null, privateKey, ['https://www.googleapis.com/auth/calendar']);
        const calendar = google.calendar({ version: 'v3', auth });
        await calendar.events.update({
            calendarId: calendarId,
            eventId: eventId,
            requestBody: {
                summary: eventData.title,
                start: { dateTime: eventData.start, timeZone: 'Asia/Taipei' },
                end: { dateTime: eventData.end, timeZone: 'Asia/Taipei' }
            }
        });
        console.log('[CALENDAR] 行事曆事件已更新:', eventId);
    } catch (err) {
        console.error('[CALENDAR] 更新行事曆事件失敗:', err.message);
    }
}

// ========== 回覆函式 ==========
function reply(event, text) {
    return client.replyMessage(event.replyToken, { type: 'text', text: text });
}

// ========== 系統初始化 ==========
async function init() {
    if (!BOT_USER_ID_CACHE) {
        try {
            const res = await client.getBotInfo();
            BOT_USER_ID_CACHE = res.userId;
            console.log('Bot User ID:', BOT_USER_ID_CACHE);
        } catch (e) {
            console.error('取得 Bot 資訊失敗（不影響啟動）:', e.message);
        }
    }
    try {
        const doc = await db.collection('system').doc('config').get();
        if (doc.exists && doc.data().enabled !== undefined) {
            systemEnabled = doc.data().enabled;
        }
    } catch (e) {
        console.error('讀取系統狀態失敗（不影響啟動）:', e.message);
    }

    // 啟動時檢查行事曆設定
    console.log('[INIT] MY_CALENDAR_ID:', process.env.MY_CALENDAR_ID ? '已設定' : '❌ 未設定');
    console.log('[INIT] CALENDAR_EMAIL:', process.env.CALENDAR_EMAIL ? '已設定' : '❌ 未設定');
    console.log('[INIT] CALENDAR_PRIVATE_KEY:', process.env.CALENDAR_PRIVATE_KEY ? `已設定 (${process.env.CALENDAR_PRIVATE_KEY.length} chars)` : '❌ 未設定');
}

// ========== 啟動伺服器（即使 init 失敗也能啟動）==========
init().catch(err => {
    console.error('初始化錯誤（不影響啟動）:', err.message);
}).then(() => {
    app.listen(PORT, () => {
        console.log(`伺服器已啟動，port: ${PORT}`);
        console.log(`Admin User ID: ${ADMIN_USER_ID}`);
        console.log(`Bot User ID: ${BOT_USER_ID_CACHE || '(自動取得)'}`);
        console.log(`Gemini Model: ${GEMINI_MODEL}`);
        console.log(`系統狀態: ${systemEnabled ? '啟用中' : '已停用'}`);
    });
});
