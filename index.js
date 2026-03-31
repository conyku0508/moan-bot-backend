const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

if (!admin.apps.length) {
    admin.initializeApp({ projectId: "moan-adtech-bot" });
}
const db = admin.firestore();

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || '';
const client = new line.Client(config);
const app = express();

let systemEnabled = true;
let BOT_USER_ID_CACHE = process.env.BOT_USER_ID || '';

app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(r => res.json(r))
        .catch(e => { console.error("Webhook Error:", e); res.status(500).end(); });
});

// ============================================
// 權限常數
// ============================================
const ROLES = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    MEMBER: 'member'
};

// ============================================
// 使用說明（根據角色顯示）
// ============================================
function getHelpText(role) {
    let text = `【團隊業務助理 使用說明】

所有人可用的功能：

  綁定信箱：
  輸入「綁定 你的email」
  範例：「綁定 mary@gmail.com」

  新增待辦：
  直接輸入工作內容
  範例：「天狐宴告知客戶修改頁面 3/31」
  系統提議後回覆「確認」即寫入後台+行事曆

  查看自己的待辦：
  「待辦有哪些」

  完成待辦：
  「XX已經完成」

  刪除待辦：
  「刪除XX」

  取消操作：
  「取消」「不用」`;

    if (role === ROLES.MANAGER || role === ROLES.ADMIN) {
        text += `

主管可用的功能：

  查看某人待辦：
  「查看 XXX 的待辦」

  查看全部人待辦：
  「查看所有人待辦」

  查看成員列表：
  「查看成員列表」`;
    }

    if (role === ROLES.ADMIN) {
        text += `

管理員專屬功能：

  停用 / 啟用系統：
  「停用系統」/「啟用系統」

  設定主管權限：
  「設定主管 XXX」

  移除主管權限：
  「移除主管 XXX」`;
    }

    return text;
}

// ============================================
// 工具函數
// ============================================
function containsDate(text) {
    const patterns = [
        /\d{1,2}\/\d{1,2}/,
        /\d{1,2}月\d{1,2}[日號]/,
        /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/,
        /明天|後天|大後天|下週|下禮拜|下星期|今天|今晚|明早|週[一二三四五六日]/,
    ];
    return patterns.some(p => p.test(text));
}

function isAdmin(userId) {
    return userId === ADMIN_USER_ID;
}

async function getOrCreateUser(userId, displayName) {
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    if (userDoc.exists) {
        if (displayName && displayName !== userDoc.data().displayName) {
            await userRef.update({ displayName });
        }
        return userDoc.data();
    }
    const newUser = {
        userId,
        displayName: displayName || '未知',
        email: null,
        role: isAdmin(userId) ? ROLES.ADMIN : ROLES.MEMBER,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        active: true
    };
    await userRef.set(newUser);
    return newUser;
}

async function getDisplayName(event) {
    try {
        if (event.source.type === 'group') {
            const p = await client.getGroupMemberProfile(event.source.groupId, event.source.userId);
            return p.displayName;
        }
        const p = await client.getProfile(event.source.userId);
        return p.displayName;
    } catch (e) { return '未知'; }
}

async function findUserByName(name) {
    const snapshot = await db.collection("users").get();
    let bestMatch = null;
    snapshot.forEach(doc => {
        const d = doc.data();
        if (d.displayName && d.displayName.toLowerCase().includes(name.toLowerCase())) {
            bestMatch = d;
        }
    });
    return bestMatch;
}

function canViewOthers(role) {
    return role === ROLES.ADMIN || role === ROLES.MANAGER;
}

// ============================================
// 主流程
// ============================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const rawText = event.message.text.trim();
    const userId = event.source.userId;
    const isGroup = event.source.type === 'group' || event.source.type === 'room';
    const groupId = event.source.groupId || event.source.roomId || null;

    if (!systemEnabled && !isAdmin(userId)) {
        if (isGroup) return null;
        return reply(event, '系統維護中，請稍後再試。');
    }

    if (isGroup) {
        return await handleGroupMessage(event, rawText, groupId, userId);
    }
    return await handleDirectMessage(event, rawText, userId);
}

// ============================================
// 群組訊息
// ============================================
async function handleGroupMessage(event, rawText, groupId, userId) {
    const botUserId = BOT_USER_ID_CACHE || process.env.BOT_USER_ID || '';
    const mention = event.message.mention;
    const isMentioned = mention && mention.mentionees &&
        mention.mentionees.some(m => m.type === 'user' && m.userId === botUserId);

    // 沒被 @ => 靜默記錄
    if (!isMentioned) {
        try {
            let senderName = '未知';
            try {
                const p = await client.getGroupMemberProfile(groupId, userId);
                senderName = p.displayName;
            } catch (e) { }
            await db.collection("group_logs").add({
                groupId, userId, senderName, text: rawText,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (e) { console.error("群組記錄失敗:", e.message); }
        return null;
    }

    // 被 @ => 處理指令
    let command = rawText.replace(/@\S+/g, '').trim();

    const summarizeKeywords = ["整理", "摘要", "總結", "討論了什麼", "剛剛聊什麼"];
    if (summarizeKeywords.some(kw => command.includes(kw))) {
        return await handleGroupSummary(event, groupId);
    }

    return await handleDirectMessage(event, command, userId);
}

// ============================================
// 群組討論整理
// ============================================
async function handleGroupSummary(event, groupId) {
    try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const snapshot = await db.collection("group_logs")
            .where("groupId", "==", groupId)
            .where("timestamp", ">=", twoHoursAgo)
            .orderBy("timestamp", "asc")
            .limit(100)
            .get();

        if (snapshot.empty) return reply(event, '最近 2 小時沒有討論記錄。');

        let conversation = '';
        snapshot.forEach(doc => {
            const d = doc.data();
            conversation += `${d.senderName}：${d.text}\n`;
        });

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
        const prompt = `你是會議記錄助理。嚴禁 Markdown 符號。整理以下討論的重點、待辦、需跟進事項。用數字編號。\n\n${conversation}`;

        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        return reply(event, `【討論整理】\n\n${res.data.candidates[0].content.parts[0].text.trim()}`);
    } catch (e) {
        return reply(event, '整理時出了問題。');
    }
}

// ============================================
// 一對一 / 指令處理
// ============================================
async function handleDirectMessage(event, userMessage, userId) {
    const displayName = await getDisplayName(event);
    const userData = await getOrCreateUser(userId, displayName);
    const userRole = userData.role;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // --- 確認 / 取消 ---
    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行", "對", "好的"];
    const cancelWords = ["不要", "取消", "算了", "不用", "不行"];

    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        return await executeConfirmedTasks(event, pendingRef, pending.data(), userId, userData);
    }
    if (pending.exists && cancelWords.includes(userMessage.toLowerCase())) {
        await pendingRef.delete();
        return reply(event, '好，已取消。');
    }

    // --- 管理員指令 ---
    if (isAdmin(userId)) {
        const adminResult = await handleAdminCommands(event, userMessage);
        if (adminResult) return adminResult;
    }

    // --- 綁定 Email ---
    const bindMatch = userMessage.match(/^綁定\s+(\S+@\S+\.\S+)$/);
    if (bindMatch) {
        await db.collection("users").doc(userId).update({ email: bindMatch[1] });
        return reply(event, `綁定成功！行事曆信箱：${bindMatch[1]}`);
    }

    // --- 使用說明 ---
    const helpKeywords = ["怎麼用", "怎麼使用", "要怎麼用", "使用說明", "help", "功能", "你會什麼"];
    if (helpKeywords.some(kw => userMessage.includes(kw))) {
        return reply(event, getHelpText(userRole));
    }

    // --- 查看別人的待辦（主管/管理員）---
    const viewOtherMatch = userMessage.match(/查看\s*(.+?)\s*的?\s*待辦/);
    if (viewOtherMatch) {
        const targetName = viewOtherMatch[1].trim();

        if (targetName === '所有人' || targetName === '全部' || targetName === '大家') {
            if (!canViewOthers(userRole)) {
                return reply(event, '只有主管和管理員可以查看其他人的待辦喔。');
            }
            return await handleViewAllTasks(event);
        }

        if (!canViewOthers(userRole)) {
            return reply(event, '只有主管和管理員可以查看其他人的待辦喔。');
        }
        return await handleViewOtherTasks(event, targetName);
    }

    // --- 查詢自己的待辦 ---
    const queryKeywords = ["待辦", "有哪些", "什麼事", "todo", "任務清單", "還有什麼", "目前有什麼", "列出"];
    if (queryKeywords.some(kw => userMessage.includes(kw))) {
        return await handleQueryTasks(event, userId, displayName);
    }

    // --- 完成任務 ---
    const completeKeywords = ["完成", "做完", "做好了", "搞定", "結束了", "已完成", "處理好"];
    if (completeKeywords.some(kw => userMessage.includes(kw))) {
        return await handleCompleteTask(event, userMessage, userId);
    }

    // --- 刪除任務 ---
    const deleteKeywords = ["刪除", "刪掉", "移除", "拿掉"];
    if (deleteKeywords.some(kw => userMessage.includes(kw))) {
        return await handleDeleteTask(event, userMessage, userId);
    }

    // --- 日期偵測 ---
    if (containsDate(userMessage) && userMessage.length > 5) {
        return await handleAddTask(event, userId, userMessage, pendingRef, pending, userData);
    }

    // --- AI 分類 ---
    const intent = await classifyIntent(userMessage);
    console.log(`[AI] "${userMessage}" => ${intent}`);

    switch (intent) {
        case "QUERY_TASKS": return await handleQueryTasks(event, userId, displayName);
        case "ADD_TASK": return await handleAddTask(event, userId, userMessage, pendingRef, pending, userData);
        case "COMPLETE_TASK": return await handleCompleteTask(event, userMessage, userId);
        case "DELETE_TASK": return await handleDeleteTask(event, userMessage, userId);
        default: return await handleChitchat(event, userMessage);
    }
}

// ============================================
// 管理員指令
// ============================================
async function handleAdminCommands(event, message) {
    if (message === '停用系統') {
        systemEnabled = false;
        await db.collection("system").doc("config").set({ enabled: false }, { merge: true });
        return reply(event, '系統已停用。輸入「啟用系統」恢復。');
    }
    if (message === '啟用系統') {
        systemEnabled = true;
        await db.collection("system").doc("config").set({ enabled: true }, { merge: true });
        return reply(event, '系統已啟用！');
    }
    if (message === '查看成員列表') {
        const snapshot = await db.collection("users").get();
        if (snapshot.empty) return reply(event, '目前沒有成員。');
        let msg = '【成員列表】\n';
        snapshot.forEach(doc => {
            const d = doc.data();
            const roleName = d.role === ROLES.ADMIN ? ' [管理員]' :
                             d.role === ROLES.MANAGER ? ' [主管]' : '';
            msg += `\n${d.displayName}${roleName}\n  信箱：${d.email || '未綁定'}\n`;
        });
        return reply(event, msg);
    }

    const setManagerMatch = message.match(/^設定主管\s+(.+)$/);
    if (setManagerMatch) {
        const targetName = setManagerMatch[1].trim();
        const targetUser = await findUserByName(targetName);
        if (!targetUser) return reply(event, `找不到「${targetName}」這位成員。`);
        await db.collection("users").doc(targetUser.userId).update({ role: ROLES.MANAGER });
        return reply(event, `已將「${targetUser.displayName}」設定為主管。`);
    }

    const removeManagerMatch = message.match(/^移除主管\s+(.+)$/);
    if (removeManagerMatch) {
        const targetName = removeManagerMatch[1].trim();
        const targetUser = await findUserByName(targetName);
        if (!targetUser) return reply(event, `找不到「${targetName}」。`);
        if (targetUser.role === ROLES.ADMIN) return reply(event, '不能移除管理員的權限。');
        await db.collection("users").doc(targetUser.userId).update({ role: ROLES.MEMBER });
        return reply(event, `已將「${targetUser.displayName}」改回一般成員。`);
    }

    return null;
}

// ============================================
// 查看特定人的待辦
// ============================================
async function handleViewOtherTasks(event, targetName) {
    const targetUser = await findUserByName(targetName);
    if (!targetUser) return reply(event, `找不到「${targetName}」這位成員。`);

    try {
        const snapshot = await db.collection("chat_logs")
            .where("status", "==", "active")
            .where("ownerId", "==", targetUser.userId)
            .get();

        if (snapshot.empty) return reply(event, `${targetUser.displayName} 目前沒有待辦事項。`);

        let msg = `【${targetUser.displayName} 的待辦】\n`;
        let i = 1;
        snapshot.forEach(doc => {
            const d = doc.data();
            const dateStr = d.timestamp
                ? new Date(d.timestamp.seconds * 1000).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                }) : '';
            msg += `\n${i}. ${d.text}\n   建立：${dateStr}\n`;
            i++;
        });
        msg += `\n共 ${i - 1} 項。`;
        return reply(event, msg);
    } catch (e) {
        return reply(event, '查詢時出了問題。');
    }
}

// ============================================
// 查看所有人待辦
// ============================================
async function handleViewAllTasks(event) {
    try {
        const snapshot = await db.collection("chat_logs")
            .where("status", "==", "active")
            .get();

        if (snapshot.empty) return reply(event, '目前所有人都沒有待辦。');

        const grouped = {};
        snapshot.forEach(doc => {
            const d = doc.data();
            const name = d.ownerName || '未知';
            if (!grouped[name]) grouped[name] = [];
            grouped[name].push(d.text);
        });

        let msg = '【全團隊待辦總覽】\n';
        for (const [name, tasks] of Object.entries(grouped)) {
            msg += `\n${name}（${tasks.length} 項）：\n`;
            tasks.forEach((t, i) => { msg += `  ${i + 1}. ${t}\n`; });
        }
        return reply(event, msg);
    } catch (e) {
        return reply(event, '查詢時出了問題。');
    }
}

// ============================================
// 查詢自己的待辦
// ============================================
async function handleQueryTasks(event, userId, displayName) {
    try {
        const snapshot = await db.collection("chat_logs")
            .where("status", "==", "active")
            .where("ownerId", "==", userId)
            .orderBy("timestamp", "desc")
            .limit(20)
            .get();

        if (snapshot.empty) return reply(event, `${displayName}，目前沒有待辦！`);

        let msg = `${displayName}，妳的待辦：\n`;
        let index = 1;
        snapshot.forEach(doc => {
            const d = doc.data();
            const dateStr = d.timestamp
                ? new Date(d.timestamp.seconds * 1000).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                }) : '';
            msg += `\n${index}. ${d.text}\n   建立：${dateStr}\n`;
            index++;
        });
        msg += `\n共 ${index - 1} 項。`;
        return reply(event, msg);
    } catch (e) {
        console.error("查詢錯誤:", e);
        try {
            const fb = await db.collection("chat_logs")
                .where("status", "==", "active")
                .where("ownerId", "==", userId).get();
            if (fb.empty) return reply(event, '目前沒有待辦。');
            let msg = '待辦：\n';
            let i = 1;
            fb.forEach(doc => { msg += `${i}. ${doc.data().text}\n`; i++; });
            return reply(event, msg);
        } catch (e2) { return reply(event, '查詢出了問題。'); }
    }
}

// ============================================
// 意圖分類器
// ============================================
async function classifyIntent(message) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `意圖分類，只回覆代碼：
ADD_TASK/QUERY_TASKS/COMPLETE_TASK/DELETE_TASK/CHITCHAT

ADD_TASK：工作事項、備忘錄、客戶回報、會議、提醒、任何需要記住追蹤的事
QUERY_TASKS：查詢待辦
COMPLETE_TASK：標記完成
DELETE_TASK：刪除任務
CHITCHAT：閒聊

「荷卡完成了」=> COMPLETE_TASK
「A客戶的案子做完了」=> COMPLETE_TASK
「客戶修改頁面3/31」=> ADD_TASK
「A客戶素材上線了記得追蹤」=> ADD_TASK
「待辦有哪些」=> QUERY_TASKS
「好累」=> CHITCHAT

訊息：「${message}」
代碼：`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 20 }
        });
        const r = res.data.candidates[0].content.parts[0].text.trim();
        const v = ["QUERY_TASKS", "ADD_TASK", "COMPLETE_TASK", "DELETE_TASK", "CHITCHAT"];
        return v.includes(r) ? r : "CHITCHAT";
    } catch (e) { return "CHITCHAT"; }
}

// ============================================
// 新增任務
// ============================================
async function handleAddTask(event, userId, userMessage, pendingRef, pending, userData) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const now = new Date();
    const todayStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const year = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric' }).replace(/[^0-9]/g, '');

    const context = pending.exists && pending.data().tasks?.length > 0
        ? `【背景】正在修改「${pending.data().tasks[0].title}」。` : "";

    const prompt = `你是團隊業務特助，說話精簡。嚴禁 Markdown 符號。
現在台灣時間：${todayStr}，年份 ${year}。

${userData.displayName} 說：「${userMessage}」
${context}

1. 整理成清楚的待辦標題，保留關鍵資訊
2. 有指定時間遵照，只說日期預設 10:00，沒說就排今天 10:00
3. end = start + 1小時
4. 一句話回覆確認

最後一行附 JSON（不要用 code block）：
[{"title": "待辦標題", "start": "${year}-MM-DDTHH:mm:00", "end": "${year}-MM-DDTHH:mm:00"}]`;

    try {
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        const aiText = res.data.candidates[0].content.parts[0].text;

        const jsonMatch = aiText.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (jsonMatch) {
            try {
                const tasks = JSON.parse(jsonMatch[0]);
                tasks.forEach(t => {
                    if (!t.end || t.end === t.start) {
                        const d = new Date(t.start);
                        d.setHours(d.getHours() + 1);
                        t.end = d.toISOString().slice(0, 16) + ':00';
                    }
                });
                await pendingRef.set({
                    tasks,
                    ownerId: userId,
                    ownerName: userData.displayName,
                    ownerEmail: userData.email,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (pe) { console.error("JSON parse 失敗:", pe.message); }
        }

        const clean = aiText.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/\[\s*\{[\s\S]*?\}\s*\]/g, '').trim();
        let hint = '';
        if (!userData.email) hint = '\n\n（提醒：未綁定信箱，不會同步行事曆。輸入「綁定 email」開啟。）';
        return reply(event, clean + hint);
    } catch (e) {
        console.error("新增失敗:", e.message);
        return reply(event, '特助當機了，再說一次。');
    }
}

// ============================================
// 確認執行
// ============================================
async function executeConfirmedTasks(event, pendingRef, data, userId, userData) {
    try {
        const batch = db.batch();
        data.tasks.forEach(t => {
            batch.set(db.collection("chat_logs").doc(), {
                text: t.title,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: "active",
                ownerId: data.ownerId || userId,
                ownerName: data.ownerName || userData.displayName,
                ownerEmail: data.ownerEmail || userData.email
            });
        });
        await batch.commit();
    } catch (e) { console.error("DB Error:", e); }

    let calMsg = "";
    const ownerEmail = data.ownerEmail || userData.email;

    for (const t of data.tasks) {
        if (t.start) {
            try {
                await createCalendarEvent(t, ownerEmail);
                calMsg = "\n行事曆已同步！";
            } catch (e) {
                console.error("行事曆失敗:", e.message);
                if (!ownerEmail) {
                    calMsg = "\n（未綁定信箱，行事曆未同步。輸入「綁定 email」開啟。）";
                } else {
                    calMsg = `\n行事曆同步失敗：${e.message}`;
                }
            }
        }
    }

    await pendingRef.delete();
    return reply(event, `搞定！任務已加入。${calMsg}`);
}

// ============================================
// 標記完成
// ============================================
async function handleCompleteTask(event, userMessage, userId) {
    const snapshot = await db.collection("chat_logs")
        .where("status", "==", "active")
        .where("ownerId", "==", userId)
        .get();
    if (snapshot.empty) return reply(event, '沒有待辦可完成。');

    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, text: doc.data().text }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是任務匹配助手。以下是待辦清單：
${tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」
她想標記某項任務為完成。請根據語意判斷最可能是哪一項。

規則：
- 使用者可能只提到部分關鍵字
- 如果有多項可能匹配，選最相關的
- 只回覆該任務的 ID（方括號裡的那串）
- 真的無法判斷才回覆 NONE`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const id = res.data.candidates[0].content.parts[0].text.trim().replace(/[[\]]/g, '');

        if (id === "NONE" || !id) {
            let msg = '不確定是哪項：\n';
            tasks.forEach((t, i) => { msg += `${i + 1}. ${t.text}\n`; });
            msg += '\n說「完成 + 關鍵字」更明確一點。';
            return reply(event, msg);
        }

        const matched = tasks.find(t => t.id === id);
        if (!matched) return reply(event, '找不到對應任務。');

        await db.collection("chat_logs").doc(id).update({
            status: "archived",
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return reply(event, `「${matched.text}」已完成！`);
    } catch (e) {
        console.error("完成失敗:", e);
        return reply(event, '處理時出了問題。');
    }
}

// ============================================
// 刪除任務
// ============================================
async function handleDeleteTask(event, userMessage, userId) {
    const snapshot = await db.collection("chat_logs")
        .where("status", "==", "active")
        .where("ownerId", "==", userId)
        .get();
    if (snapshot.empty) return reply(event, '沒有待辦可刪除。');

    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, text: doc.data().text }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `待辦清單：
${tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」
判斷想刪哪項，只回覆 ID。無法判斷回覆 NONE。`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const id = res.data.candidates[0].content.parts[0].text.trim().replace(/[[\]]/g, '');
        if (id === "NONE" || !id) return reply(event, '不確定要刪哪項，說清楚一點？');

        const matched = tasks.find(t => t.id === id);
        if (!matched) return reply(event, '找不到對應任務。');

        await db.collection("chat_logs").doc(id).delete();
        return reply(event, `「${matched.text}」已刪除。`);
    } catch (e) {
        return reply(event, '刪除出了問題。');
    }
}

// ============================================
// 閒聊
// ============================================
async function handleChitchat(event, userMessage) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是團隊業務特助，精明溫暖。嚴禁 Markdown 符號。
簡短自然回應。不要編造任何任務內容。
如果訊息像工作事項，回覆「這看起來像待辦，要記下來嗎？加日期就能排進行事曆。」
使用者說：「${userMessage}」`;

    try {
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        return reply(event, res.data.candidates[0].content.parts[0].text.trim());
    } catch (e) { return reply(event, '恍神了，再說一次？'); }
}

// ============================================
// Google Calendar
// ============================================
async function createCalendarEvent(taskData, userEmail) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const defaultCalId = process.env.MY_CALENDAR_ID || "";

    if (!rawKey || rawKey.length < 10) throw new Error("私鑰為空");
    if (!rawEmail) throw new Error("Service Account Email 為空");

    const cleanKey = rawKey.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const cleanEmail = rawEmail.trim().replace(/^["']|["']$/g, '');
    const targetCalId = defaultCalId.trim().replace(/^["']|["']$/g, '');

    const auth = new google.auth.JWT({
        email: cleanEmail,
        key: cleanKey,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });

    const eventResource = {
        summary: taskData.title,
        start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
        end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
    };

    if (userEmail && userEmail !== targetCalId) {
        eventResource.attendees = [{ email: userEmail }];
    }

    await google.calendar({ version: 'v3', auth }).events.insert({
        calendarId: targetCalId,
        sendUpdates: userEmail ? 'all' : 'none',
        resource: eventResource
    });
}

function reply(event, text) {
    return client.replyMessage(event.replyToken, { type: 'text', text });
}

// ============================================
// 初始化
// ============================================
async function init() {
    // 讀取系統狀態
    try {
        const c = await db.collection("system").doc("config").get();
        if (c.exists && c.data().enabled === false) {
            systemEnabled = false;
            console.log("系統處於停用狀態");
        }
    } catch (e) { }

    // 自動取得 Bot User ID
    if (!BOT_USER_ID_CACHE) {
        try {
            const botInfo = await client.getBotInfo();
            BOT_USER_ID_CACHE = botInfo.userId;
            console.log("Bot User ID:", BOT_USER_ID_CACHE);
        } catch (e) {
            console.log("無法自動取得 Bot ID，群組 @ 功能可能受限:", e.message);
        }
    }
}

const PORT = process.env.PORT || 8080;
init().then(() => {
    app.listen(PORT, () => console.log(`伺服器在 ${PORT} 啟動`));
});
