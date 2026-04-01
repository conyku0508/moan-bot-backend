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
const PORT = process.env.PORT || 8080;

// ========== Gemini 模型（統一使用） ==========
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ========== 系統狀態 ==========
let systemEnabled = true;
let BOT_USER_ID_CACHE = process.env.BOT_USER_ID || '';

// ========== 角色定義 ==========
const ROLES = { ADMIN: 'admin', MANAGER: 'manager', MEMBER: 'member' };

// ========== 使用說明 ==========
function getHelpText(role) {
    let text = '【業務助理使用說明】\n\n';
    text += '1. 綁定信箱：輸入「綁定 你的email」\n';
    text += '   例：綁定 cony@js-adways.com.tw\n\n';
    text += '2. 新增待辦：直接輸入任務內容+日期\n';
    text += '   例：荷卡META貼文預算確認 4/5\n';
    text += '   → 機器人會產生任務，回覆「確認」即寫入\n\n';
    text += '3. 查詢待辦：說「待辦有哪些」「目前任務」\n\n';
    text += '4. 完成任務：說「荷卡那個完成了」\n\n';
    text += '5. 刪除任務：說「刪除荷卡那筆」\n\n';
    text += '6. 取消暫存：說「取消」「不要」「算了」\n\n';
    text += '7. 閒聊：任何不像任務的話，機器人會陪你聊\n';

    if (role === ROLES.MANAGER || role === ROLES.ADMIN) {
        text += '\n【主管功能】\n';
        text += '8. 查看別人待辦：「查看 XXX 的待辦」\n';
        text += '9. 查看全部待辦：「查看所有人的待辦」\n';
    }

    if (role === ROLES.ADMIN) {
        text += '\n【管理員功能】\n';
        text += '10. 停用系統：「停用系統」\n';
        text += '11. 啟用系統：「啟用系統」\n';
        text += '12. 設定主管：「設定主管 XXX」\n';
        text += '13. 移除主管：「移除主管 XXX」\n';
        text += '14. 成員列表：「成員列表」\n';
    }

    text += '\n【群組使用】\n';
    text += '在群組中 @機器人 + 指令即可\n';
    text += '例：@業務助理 整理一下剛剛的討論';

    return text;
}

// ========== 工具函式 ==========
function containsDate(text) {
    const patterns = [
        /\d{1,2}\/\d{1,2}/,
        /\d{1,2}月\d{1,2}[日號]/,
        /\d{4}-\d{2}-\d{2}/,
        /明天|後天|大後天|下週|下周|週一|週二|週三|週四|週五|週六|週日|星期一|星期二|星期三|星期四|星期五|星期六|星期日|今天|本週/
    ];
    return patterns.some(p => p.test(text));
}

async function getOrCreateUser(userId, displayName) {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (userDoc.exists) {
        if (displayName && userDoc.data().displayName !== displayName) {
            await userRef.update({ displayName: displayName, lastActive: admin.firestore.FieldValue.serverTimestamp() });
        }
        return userDoc.data();
    }

    const isAdmin = userId === ADMIN_USER_ID;
    const newUser = {
        userId: userId,
        displayName: displayName || '未知',
        role: isAdmin ? ROLES.ADMIN : ROLES.MEMBER,
        email: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastActive: admin.firestore.FieldValue.serverTimestamp()
    };
    await userRef.set(newUser);
    return newUser;
}

function canViewOthers(role) {
    return role === ROLES.ADMIN || role === ROLES.MANAGER;
}

async function findUserByName(name) {
    const snap = await db.collection('users').where('displayName', '==', name).limit(1).get();
    if (!snap.empty) return snap.docs[0].data();
    const allUsers = await db.collection('users').get();
    let found = null;
    allUsers.forEach(doc => {
        const d = doc.data();
        if (d.displayName && d.displayName.includes(name)) found = d;
    });
    return found;
}

// ========== Express 設定 ==========
const app = express();
app.post('/callback', line.middleware(LINE_CONFIG), async (req, res) => {
    try {
        await Promise.all(req.body.events.map(handleEvent));
        res.json({ success: true });
    } catch (err) {
        console.error('Webhook Error:', err);
        res.status(500).end();
    }
});

// ========== 主事件處理 ==========
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;

    if (!systemEnabled && event.source.userId !== ADMIN_USER_ID) {
        return reply(event, '系統目前維護中，請稍後再試。');
    }

    const source = event.source;
    if (source.type === 'group') {
        return await handleGroupMessage(event, source.groupId, source.userId);
    }
    return await handleDirectMessage(event, source.userId);
}

// ========== 群組訊息處理 ==========
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

    if (!isMentioned) {
        let senderName = '未知';
        try {
            const profile = await client.getGroupMemberProfile(groupId, userId);
            senderName = profile.displayName;
        } catch (e) { }
        await db.collection('group_logs').add({
            groupId: groupId,
            userId: userId,
            senderName: senderName,
            text: rawText,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        return null;
    }

    let senderName = '未知';
    try {
        const profile = await client.getGroupMemberProfile(groupId, userId);
        senderName = profile.displayName;
    } catch (e) { }
    await getOrCreateUser(userId, senderName);

    const helpKeywords = ['怎麼用', '使用說明', '你會什麼', 'help', '功能', '指令'];
    if (helpKeywords.some(k => commandText.includes(k))) {
        const user = await getOrCreateUser(userId, senderName);
        return reply(event, getHelpText(user.role));
    }

    const summaryKeywords = ['整理', '摘要', '總結', '剛剛說了什麼', '討論了什麼'];
    if (summaryKeywords.some(k => commandText.includes(k))) {
        return await handleGroupSummary(event, groupId);
    }

    return await handleDirectMessage(event, userId, commandText);
}

async function handleGroupSummary(event, groupId) {
    try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const snap = await db.collection('group_logs')
            .where('groupId', '==', groupId)
            .orderBy('timestamp', 'asc')
            .where('timestamp', '>=', twoHoursAgo)
            .limit(100)
            .get();

        if (snap.empty) return reply(event, '最近兩小時沒有聊天記錄可以整理。');

        let chatHistory = '';
        snap.forEach(doc => {
            const d = doc.data();
            chatHistory += `${d.senderName}：${d.text}\n`;
        });

        const prompt = `你是一位專業的會議記錄助理。請根據以下群組聊天記錄，整理出重點摘要。
嚴禁使用 Markdown 符號（不要用 #、*、- 等）。
用自然段落和換行排版。
重點標註：誰說了什麼重要的事、有哪些待辦或決議。

聊天記錄：
${chatHistory}

請整理摘要：`;

        const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
        const summary = r.data.candidates[0].content.parts[0].text.trim();
        return reply(event, `【討論摘要】\n\n${summary}`);
    } catch (e) {
        console.error('群組整理錯誤:', e.message);
        return reply(event, '整理討論時遇到問題，請稍後再試。');
    }
}

// ========== 私聊訊息處理 ==========
async function handleDirectMessage(event, userId, overrideText) {
    const msg = (overrideText || event.message.text).trim();
    const lowerMsg = msg.toLowerCase();

    let displayName = '使用者';
    try {
        const profile = await client.getProfile(userId);
        displayName = profile.displayName;
    } catch (e) { }
    const user = await getOrCreateUser(userId, displayName);

    console.log('=== 收到訊息 ===');
    console.log('使用者:', displayName, 'ID:', userId);
    console.log('訊息:', msg);

    // ===== 綁定信箱 =====
    if (msg.startsWith('綁定 ') || msg.startsWith('綁定')) {
        const email = msg.replace('綁定', '').trim();
        if (!email || !email.includes('@')) return reply(event, '格式：綁定 你的email\n例：綁定 cony@js-adways.com.tw');
        await db.collection('users').doc(userId).update({ email: email });
        return reply(event, `綁定成功！你的信箱：${email}\n之後新增的待辦會同步到你的行事曆。`);
    }

    // ===== 使用說明 =====
    const helpKeywords = ['怎麼用', '使用說明', '你會什麼', 'help', '功能', '指令', '教學'];
    if (helpKeywords.some(k => lowerMsg.includes(k))) {
        return reply(event, getHelpText(user.role));
    }

    // ===== 管理員指令 =====
    if (userId === ADMIN_USER_ID) {
        const adminResult = await handleAdminCommands(event, msg);
        if (adminResult) return adminResult;
    }

    // ===== 查看別人的待辦 =====
    const viewOtherMatch = msg.match(/查看(.+?)的待辦/);
    if (viewOtherMatch && canViewOthers(user.role)) {
        const targetName = viewOtherMatch[1].trim();
        if (targetName === '所有人') {
            return await handleQueryAllTasks(event);
        }
        const targetUser = await findUserByName(targetName);
        if (!targetUser) return reply(event, `找不到「${targetName}」這位成員。`);
        return await handleQueryTasks(event, targetUser.userId, targetUser.displayName);
    }

    // ===== 確認/取消待辦 =====
    const pendingRef = db.collection('pending_proposals').doc(userId);
    const pending = await pendingRef.get();
    const confirmWords = ['好', '確認', 'ok', 'yes', '可以', '加進去', '執行', '對', '好的', '確定'];
    const cancelWords = ['不要', '取消', '算了', '不用', '不行'];

    if (pending.exists && confirmWords.includes(lowerMsg)) {
        return await executeConfirmedTasks(event, pendingRef, pending.data(), userId, displayName, user.email);
    }
    if (pending.exists && cancelWords.includes(lowerMsg)) {
        await pendingRef.delete();
        return reply(event, '好，已經取消了。有需要再說！');
    }

    // ===== 關鍵字分流 =====
    const hasDate = containsDate(msg);
    const queryKeywords = ['待辦有哪些', '有哪些待辦', '待辦清單', '任務清單', '目前任務', '還有什麼', '目前有什麼', '看一下任務', '列出待辦', '查看待辦'];
    const isQuery = queryKeywords.some(k => msg.includes(k));
    const completeKeywords = ['完成', '做完', '搞定', '已完成', '處理好', '結案'];
    const isComplete = completeKeywords.some(k => msg.includes(k));
    const deleteKeywords = ['刪除', '移除', '拿掉', '去掉'];
    const isDelete = deleteKeywords.some(k => msg.includes(k));

    // 日期 + 長度 > 5 → 新增任務
    if (hasDate && msg.length > 5 && !isComplete && !isDelete && !isQuery) {
        return await handleAddTask(event, userId, msg, pendingRef);
    }

    if (isQuery) return await handleQueryTasks(event, userId, displayName);
    if (msg.includes('待辦') && !hasDate) return await handleQueryTasks(event, userId, displayName);
    if (isComplete) return await handleCompleteTask(event, msg, userId);
    if (isDelete) return await handleDeleteTask(event, msg, userId);

    // ===== AI 意圖分類 =====
    const intent = await classifyIntent(msg);
    console.log('AI 意圖分類結果:', intent);
    switch (intent) {
        case 'QUERY_TASKS': return await handleQueryTasks(event, userId, displayName);
        case 'ADD_TASK': return await handleAddTask(event, userId, msg, pendingRef);
        case 'COMPLETE_TASK': return await handleCompleteTask(event, msg, userId);
        case 'DELETE_TASK': return await handleDeleteTask(event, msg, userId);
        default: return await handleChitchat(event, msg);
    }
}

// ========== 管理員指令 ==========
async function handleAdminCommands(event, msg) {
    if (msg === '停用系統') {
        systemEnabled = false;
        await db.collection('system').doc('config').set({ enabled: false }, { merge: true });
        return reply(event, '系統已停用。除了你以外，其他人無法使用機器人。\n輸入「啟用系統」可恢復。');
    }
    if (msg === '啟用系統') {
        systemEnabled = true;
        await db.collection('system').doc('config').set({ enabled: true }, { merge: true });
        return reply(event, '系統已啟用！所有人都可以正常使用了。');
    }
    if (msg === '成員列表') {
        const snap = await db.collection('users').get();
        if (snap.empty) return reply(event, '目前沒有任何成員。');
        let text = '【成員列表】\n\n';
        snap.forEach(doc => {
            const d = doc.data();
            const roleLabel = d.role === ROLES.ADMIN ? '管理員' : d.role === ROLES.MANAGER ? '主管' : '成員';
            text += `${d.displayName || '未知'} [${roleLabel}]\n`;
            if (d.email) text += `  信箱：${d.email}\n`;
        });
        return reply(event, text);
    }
    const setManagerMatch = msg.match(/設定主管\s*(.+)/);
    if (setManagerMatch) {
        const targetName = setManagerMatch[1].trim();
        const targetUser = await findUserByName(targetName);
        if (!targetUser) return reply(event, `找不到「${targetName}」。`);
        await db.collection('users').doc(targetUser.userId).update({ role: ROLES.MANAGER });
        return reply(event, `已將「${targetUser.displayName}」設為主管。`);
    }
    const removeManagerMatch = msg.match(/移除主管\s*(.+)/);
    if (removeManagerMatch) {
        const targetName = removeManagerMatch[1].trim();
        const targetUser = await findUserByName(targetName);
        if (!targetUser) return reply(event, `找不到「${targetName}」。`);
        await db.collection('users').doc(targetUser.userId).update({ role: ROLES.MEMBER });
        return reply(event, `已將「${targetUser.displayName}」改為一般成員。`);
    }
    return null;
}

// ========== AI 意圖分類 ==========
async function classifyIntent(message) {
    const prompt = `你是意圖分類器。只能回覆一個分類代碼，不要回覆任何其他文字。

分類規則：
- ADD_TASK：使用者想記錄工作事項、備忘、排程、客戶回報、進度更新
- QUERY_TASKS：使用者想查看、瀏覽目前的待辦事項
- COMPLETE_TASK：使用者表示某個任務已經完成、搞定、結案
- DELETE_TASK：使用者想刪除、移除某個任務
- CHITCHAT：閒聊、打招呼、抱怨、情緒抒發、與任務無關的對話

使用者訊息：「${message}」
分類代碼：`;

    try {
        const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
        const txt = r.data.candidates[0].content.parts[0].text.trim();
        return ['QUERY_TASKS', 'ADD_TASK', 'COMPLETE_TASK', 'DELETE_TASK', 'CHITCHAT'].includes(txt) ? txt : 'CHITCHAT';
    } catch (e) {
        console.error('意圖分類失敗:', e.message);
        return 'CHITCHAT';
    }
}

// ========== 查詢待辦 ==========
async function handleQueryTasks(event, userId, displayName) {
    try {
        console.log('=== 查詢待辦開始 ===');
        console.log('查詢 ownerId:', userId);

        let snap;
        try {
            snap = await db.collection('chat_logs')
                .where('ownerId', '==', userId)
                .where('status', '==', 'active')
                .orderBy('timestamp', 'desc')
                .limit(20)
                .get();
            console.log('排序查詢成功，筆數:', snap.size);
        } catch (indexErr) {
            console.log('索引降級查詢:', indexErr.message);
            snap = await db.collection('chat_logs')
                .where('ownerId', '==', userId)
                .where('status', '==', 'active')
                .get();
            console.log('降級查詢筆數:', snap.size);
        }

        if (snap.empty) {
            console.log('查詢結果為空');
            return reply(event, `${displayName}，你目前沒有任何待辦事項，清單是空的！`);
        }

        let text = `${displayName}，以下是你目前的待辦事項：\n`;
        let i = 1;
        snap.forEach(doc => {
            const d = doc.data();
            let timeStr = '';
            if (d.timestamp) {
                const ts = d.timestamp.seconds ? new Date(d.timestamp.seconds * 1000) : new Date(d.timestamp);
                timeStr = ts.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            }
            text += `\n${i}. ${d.text}`;
            if (timeStr) text += `\n   建立：${timeStr}`;
            i++;
        });
        text += `\n\n共 ${i - 1} 項。完成或刪除直接跟我說。`;
        return reply(event, text);
    } catch (e) {
        console.error('查詢待辦錯誤:', e.message, e.stack);
        return reply(event, '查詢待辦時遇到問題，請稍後再試。');
    }
}

async function handleQueryAllTasks(event) {
    try {
        const snap = await db.collection('chat_logs').where('status', '==', 'active').get();
        if (snap.empty) return reply(event, '目前所有人都沒有待辦事項。');

        const grouped = {};
        snap.forEach(doc => {
            const d = doc.data();
            const name = d.ownerName || '未知';
            if (!grouped[name]) grouped[name] = [];
            grouped[name].push(d.text);
        });

        let text = '【所有人的待辦事項】\n';
        for (const [name, tasks] of Object.entries(grouped)) {
            text += `\n${name}（${tasks.length} 項）：\n`;
            tasks.forEach((t, i) => { text += `  ${i + 1}. ${t}\n`; });
        }
        return reply(event, text);
    } catch (e) {
        console.error('查詢全部待辦錯誤:', e.message);
        return reply(event, '查詢時遇到問題，請稍後再試。');
    }
}

// ========== 新增待辦 ==========
async function handleAddTask(event, userId, msg, pendingRef) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const prompt = `你是一位待辦事項助理。現在台灣時間是 ${now}。
使用者輸入了一段工作相關訊息，請你：
1. 整理成一個簡潔的待辦標題
2. 判斷日期和時間（如果只有日期沒有時間，預設早上10:00；如果有時間就用該時間）
3. 結束時間 = 開始時間 + 1小時

嚴禁使用 Markdown 符號（不要用 #、*、- 等任何符號）。
先用一句自然的話回覆使用者，告訴他你整理了什麼任務、排在什麼時間。
最後一行必須是 JSON 陣列（只有一行，不要換行），格式如下：
[{"title":"任務標題","start":"2026-04-02T10:00:00+08:00","end":"2026-04-02T11:00:00+08:00"}]

使用者訊息：「${msg}」`;

    try {
        const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
        const aiText = r.data.candidates[0].content.parts[0].text.trim();

        const jsonMatch = aiText.match(/\[.*\]/s);
        if (!jsonMatch) {
            return reply(event, aiText + '\n\n（系統提示：AI 回覆格式異常，請重新輸入）');
        }

        let tasks;
        try {
            tasks = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
            console.error('JSON 解析失敗:', parseErr.message, 'AI原文:', aiText);
            return reply(event, aiText + '\n\n（系統提示：解析失敗，請重新輸入）');
        }

        if (!Array.isArray(tasks) || tasks.length === 0) {
            return reply(event, aiText);
        }

        await pendingRef.set({
            tasks: tasks,
            originalMessage: msg,
            aiReply: aiText.replace(jsonMatch[0], '').trim(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const displayText = aiText.replace(jsonMatch[0], '').trim();
        return reply(event, displayText + '\n\n確認的話回覆「確認」，不要的話回覆「取消」。');

    } catch (e) {
        console.error('新增任務錯誤:', e.message);
        return reply(event, '處理任務時遇到問題，請稍後再試。');
    }
}

// ========== 執行已確認的任務 ==========
async function executeConfirmedTasks(event, pendingRef, pendingData, userId, displayName, userEmail) {
    try {
        const tasks = pendingData.tasks || [];
        let resultMsg = '';

        for (const task of tasks) {
            await db.collection('chat_logs').add({
                text: task.title,
                status: 'active',
                ownerId: userId,
                ownerName: displayName,
                ownerEmail: userEmail || null,
                originalMessage: pendingData.originalMessage,
                scheduledStart: task.start || null,
                scheduledEnd: task.end || null,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            try {
                await createCalendarEvent(task, userEmail);
                resultMsg += `「${task.title}」已加入待辦，行事曆也同步好了！\n`;
            } catch (calErr) {
                console.error('行事曆同步失敗:', calErr.message);
                resultMsg += `「${task.title}」已加入待辦，但行事曆同步失敗：${calErr.message}\n`;
            }
        }

        await pendingRef.delete();

        if (!userEmail) {
            resultMsg += '\n提醒：你還沒綁定信箱，輸入「綁定 你的email」可以同步行事曆。';
        }

        return reply(event, resultMsg.trim());
    } catch (e) {
        console.error('執行確認任務錯誤:', e.message);
        return reply(event, '執行任務時遇到問題，請稍後再試。');
    }
}

// ========== 完成任務 ==========
async function handleCompleteTask(event, msg, userId) {
    try {
        console.log('=== 完成任務開始 ===');
        console.log('使用者訊息:', msg);
        console.log('使用者ID:', userId);

        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active')
            .get();

        console.log('查詢到的任務數量:', snap.size);

        if (snap.empty) return reply(event, '你目前沒有任何待辦事項可以完成。');

        // 如果只有一筆，直接完成
        if (snap.size === 1) {
            const doc = snap.docs[0];
            const taskText = doc.data().text;
            await db.collection('chat_logs').doc(doc.id).update({
                status: 'archived',
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return reply(event, `「${taskText}」已標記為完成！`);
        }

        // 多筆任務，用關鍵字比對
        let bestMatch = null;
        let bestScore = 0;
        const msgClean = msg.replace(/完成|做完|搞定|已完成|處理好|結案|了|那個|的/g, '').trim();
        console.log('清理後的關鍵字:', msgClean);

        snap.forEach(doc => {
            const d = doc.data();
            const text = d.text || '';
            let score = 0;

            if (text.includes(msgClean) || msgClean.includes(text)) {
                score = 100;
            } else {
                for (const char of msgClean) {
                    if (text.includes(char)) score += 10;
                }
            }

            console.log(`任務「${text}」匹配分數: ${score}`);

            if (score > bestScore) {
                bestScore = score;
                bestMatch = { id: doc.id, text: text };
            }
        });

        if (bestMatch && bestScore >= 20) {
            console.log('關鍵字比對成功:', bestMatch.text, '分數:', bestScore);
            await db.collection('chat_logs').doc(bestMatch.id).update({
                status: 'archived',
                completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return reply(event, `「${bestMatch.text}」已標記為完成！`);
        }

        // 關鍵字比對不到，用 AI
        console.log('關鍵字比對失敗，嘗試 AI 判斷');
        let taskList = '';
        const taskMap = {};
        snap.forEach(doc => {
            const d = doc.data();
            taskMap[doc.id] = d.text;
            taskList += `ID:${doc.id} 標題:${d.text}\n`;
        });

        const prompt = `使用者說：「${msg}」

以下是他的待辦清單：
${taskList}

請判斷使用者要完成哪個任務，只回覆該任務的 ID（就是 ID: 後面的那串文字）。
如果無法判斷，回覆「UNCLEAR」。
只回覆 ID 或 UNCLEAR，不要回覆其他文字。`;

        try {
            const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
            const aiResult = r.data.candidates[0].content.parts[0].text.trim();
            console.log('AI 回傳:', aiResult);

            if (aiResult !== 'UNCLEAR' && taskMap[aiResult]) {
                await db.collection('chat_logs').doc(aiResult).update({
                    status: 'archived',
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                return reply(event, `「${taskMap[aiResult]}」已標記為完成！`);
            }
        } catch (aiErr) {
            console.error('AI 判斷失敗:', aiErr.message);
        }

        let listText = '我不確定你要完成哪一項，以下是你的待辦：\n';
        let i = 1;
        for (const [id, text] of Object.entries(taskMap)) {
            listText += `${i}. ${text}\n`;
            i++;
        }
        listText += '\n請說清楚一點，例如「荷卡那個完成了」';
        return reply(event, listText);

    } catch (e) {
        console.error('完成任務錯誤:', e.message, e.stack);
        return reply(event, '處理完成任務時遇到問題，請稍後再試。');
    }
}

// ========== 刪除任務 ==========
async function handleDeleteTask(event, msg, userId) {
    try {
        const snap = await db.collection('chat_logs')
            .where('ownerId', '==', userId)
            .where('status', '==', 'active')
            .get();

        if (snap.empty) return reply(event, '你目前沒有任何待辦事項可以刪除。');

        let bestMatch = null;
        let bestScore = 0;
        const msgClean = msg.replace(/刪除|移除|拿掉|去掉|那個|那筆|的/g, '').trim();
        const taskMap = {};

        snap.forEach(doc => {
            const d = doc.data();
            const text = d.text || '';
            taskMap[doc.id] = text;
            let score = 0;

            if (text.includes(msgClean) || msgClean.includes(text)) {
                score = 100;
            } else {
                for (const char of msgClean) {
                    if (text.includes(char)) score += 10;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = { id: doc.id, text: text };
            }
        });

        if (bestMatch && bestScore >= 20) {
            await db.collection('chat_logs').doc(bestMatch.id).delete();
            return reply(event, `「${bestMatch.text}」已刪除！`);
        }

        let taskList = '';
        snap.forEach(doc => {
            taskList += `ID:${doc.id} 標題:${doc.data().text}\n`;
        });

        const prompt = `使用者說：「${msg}」

以下是他的待辦清單：
${taskList}

請判斷使用者要刪除哪個任務，只回覆該任務的 ID。
如果無法判斷，回覆「UNCLEAR」。
只回覆 ID 或 UNCLEAR，不要回覆其他文字。`;

        try {
            const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
            const aiResult = r.data.candidates[0].content.parts[0].text.trim();

            if (aiResult !== 'UNCLEAR' && taskMap[aiResult]) {
                await db.collection('chat_logs').doc(aiResult).delete();
                return reply(event, `「${taskMap[aiResult]}」已刪除！`);
            }
        } catch (aiErr) {
            console.error('AI 判斷刪除失敗:', aiErr.message);
        }

        let listText = '我不確定你要刪除哪一項，以下是你的待辦：\n';
        let i = 1;
        for (const [id, text] of Object.entries(taskMap)) {
            listText += `${i}. ${text}\n`;
            i++;
        }
        listText += '\n請說清楚一點，例如「刪除荷卡那筆」';
        return reply(event, listText);

    } catch (e) {
        console.error('刪除任務錯誤:', e.message, e.stack);
        return reply(event, '處理刪除任務時遇到問題，請稍後再試。');
    }
}

// ========== 閒聊 ==========
async function handleChitchat(event, msg) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const prompt = `你是 Cony 的業務助理，個性親切、專業。現在台灣時間是 ${now}。
嚴禁使用 Markdown 符號（不要用 #、*、- 等）。
你不知道使用者的待辦事項內容，絕對不要自行編造任何任務清單。
如果使用者問待辦事項相關問題，請回覆「讓我幫你查一下，請輸入『待辦有哪些』」。
用自然、簡短、溫暖的方式回覆。

使用者說：「${msg}」`;

    try {
        const r = await axios.post(GEMINI_URL, { contents: [{ parts: [{ text: prompt }] }] }, { headers: { 'Content-Type': 'application/json' } });
        const aiText = r.data.candidates[0].content.parts[0].text.trim();
        return reply(event, aiText);
    } catch (e) {
        console.error('閒聊錯誤:', e.message);
        return reply(event, '我剛剛恍神了，再說一次？');
    }
}

// ========== Google Calendar ==========
async function createCalendarEvent(taskData, userEmail) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || '';
    const rawEmail = process.env.CALENDAR_EMAIL || '';
    const rawCalId = process.env.MY_CALENDAR_ID || '';

    console.log('===== Calendar Debug =====');
    console.log('Calendar ID:', rawCalId);
    console.log('Task:', JSON.stringify(taskData));
    console.log('==========================');

    if (!rawKey || rawKey.length < 100) throw new Error('CALENDAR_PRIVATE_KEY 未設定或長度不足');
    if (!rawEmail) throw new Error('CALENDAR_EMAIL 未設定');
    if (!rawCalId) throw new Error('MY_CALENDAR_ID 未設定');

    const cleanKey = rawKey.trim().replace(/^['"]|['"]$/g, '').replace(/\\n/g, '\n');
    const cleanEmail = rawEmail.trim().replace(/^['"]|['"]$/g, '');
    const targetCalId = rawCalId.trim().replace(/^['"]|['"]$/g, '');

    const auth = new google.auth.JWT({
        email: cleanEmail,
        key: cleanKey,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });

    const calendar = google.calendar({ version: 'v3', auth });

    let startTime = taskData.start;
    let endTime = taskData.end;

    if (!startTime) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(10, 0, 0, 0);
        startTime = tomorrow.toISOString();
    }

    if (!endTime || endTime === startTime) {
        const endDate = new Date(startTime);
        endDate.setHours(endDate.getHours() + 1);
        endTime = endDate.toISOString();
    }

    const result = await calendar.events.insert({
        calendarId: targetCalId,
        resource: {
            summary: taskData.title,
            start: { dateTime: startTime, timeZone: 'Asia/Taipei' },
            end: { dateTime: endTime, timeZone: 'Asia/Taipei' },
            reminders: { useDefault: true }
        }
    });

    console.log('Calendar Event Created! ID:', result.data.id);
    return result.data;
}

// ========== 回覆函式 ==========
function reply(event, text) {
    return client.replyMessage(event.replyToken, { type: 'text', text: text });
}

// ========== 初始化 ==========
async function init() {
    try {
        const configDoc = await db.collection('system').doc('config').get();
        if (configDoc.exists && configDoc.data().enabled === false) {
            systemEnabled = false;
            console.log('系統狀態：已停用');
        }
    } catch (e) {
        console.log('讀取系統狀態失敗:', e.message);
    }

    if (!BOT_USER_ID_CACHE) {
        try {
            const botInfo = await client.getBotInfo();
            BOT_USER_ID_CACHE = botInfo.userId;
            console.log('Bot User ID:', BOT_USER_ID_CACHE);
        } catch (e) {
            console.log('取得 Bot ID 失敗:', e.message);
        }
    }
}

// ========== 啟動 ==========
init().then(() => {
    app.listen(PORT, () => {
        console.log(`伺服器已啟動，port: ${PORT}`);
        console.log(`Admin User ID: ${ADMIN_USER_ID}`);
        console.log(`Bot User ID: ${BOT_USER_ID_CACHE || '(自動取得)'}`);
        console.log(`Gemini Model: ${GEMINI_MODEL}`);
        console.log(`系統狀態: ${systemEnabled ? '啟用中' : '已停用'}`);
    });
});
