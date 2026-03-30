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
const client = new line.Client(config);
const app = express();

app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then(r => res.json(r))
        .catch(e => { console.error("Webhook Error:", e); res.status(500).end(); });
});

// ============================================
// 主流程
// ============================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // --- 快速指令攔截（不經過 AI）---
    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行", "對", "好的"];
    const cancelWords = ["不要", "取消", "算了", "不用", "不行"];

    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        return await executeConfirmedTasks(event, pendingRef, pending.data());
    }
    if (pending.exists && cancelWords.includes(userMessage.toLowerCase())) {
        await pendingRef.delete();
        return reply(event, '好，已經取消了。有需要再說！');
    }

    // --- 第一層：關鍵字快速分流（不花 AI 額度）---
    const queryKeywords = ["待辦", "有哪些", "什麼事", "to do", "todo", "任務清單", "還有什麼", "目前有什麼", "看一下任務", "列出"];
    const isQueryIntent = queryKeywords.some(kw => userMessage.includes(kw));

    if (isQueryIntent) {
        console.log(`[快速分流] "${userMessage}" => QUERY_TASKS`);
        return await handleQueryTasks(event);
    }

    // --- 第二層：AI 意圖分類（處理模糊指令）---
    const intent = await classifyIntent(userMessage);
    console.log(`[AI 分流] "${userMessage}" => ${intent}`);

    switch (intent) {
        case "QUERY_TASKS":
            return await handleQueryTasks(event);
        case "ADD_TASK":
            return await handleAddTask(event, userId, userMessage, pendingRef, pending);
        case "COMPLETE_TASK":
            return await handleCompleteTask(event, userMessage);
        case "DELETE_TASK":
            return await handleDeleteTask(event, userMessage);
        case "CHITCHAT":
        default:
            return await handleChitchat(event, userMessage);
    }
}

// ============================================
// 意圖分類器
// ============================================
async function classifyIntent(message) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是意圖分類器。只回覆一個分類代碼，不要回覆任何其他文字。

分類：
- QUERY_TASKS：查詢、列出、詢問待辦事項或任務
- ADD_TASK：新增任務、安排行程、排時間、提醒
- COMPLETE_TASK：標記完成、做完了
- DELETE_TASK：刪除、移除任務
- CHITCHAT：閒聊、其他

訊息：「${message}」
代碼：`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 20 }
        });
        const result = res.data.candidates[0].content.parts[0].text.trim();
        const valid = ["QUERY_TASKS", "ADD_TASK", "COMPLETE_TASK", "DELETE_TASK", "CHITCHAT"];
        return valid.includes(result) ? result : "CHITCHAT";
    } catch (e) {
        console.error("分類失敗:", e.message);
        return "CHITCHAT";
    }
}

// ============================================
// 查詢待辦 — 100% 基於真實資料，禁止 AI 幻覺
// ============================================
async function handleQueryTasks(event) {
    try {
        const snapshot = await db.collection("chat_logs")
            .where("status", "==", "active")
            .orderBy("timestamp", "desc")
            .limit(20)
            .get();

        if (snapshot.empty) {
            return reply(event, 'Cony，妳目前沒有任何待辦事項，清單是空的！想新增的話直接告訴我就好。');
        }

        // 純粹用資料庫的真實資料組成回覆，完全不經過 AI
        let msg = 'Cony，以下是妳目前的待辦事項：\n';
        let index = 1;
        snapshot.forEach(doc => {
            const d = doc.data();
            const dateStr = d.timestamp
                ? new Date(d.timestamp.seconds * 1000).toLocaleString('zh-TW', {
                    timeZone: 'Asia/Taipei',
                    month: 'numeric', day: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                })
                : '時間未記錄';
            msg += `\n${index}. ${d.text}\n   建立時間：${dateStr}\n`;
            index++;
        });
        msg += `\n共 ${index - 1} 項。要完成或刪除哪項的話，直接跟我說。`;

        return reply(event, msg);
    } catch (e) {
        console.error("查詢錯誤:", e);
        // 如果是索引問題，嘗試不排序的備用查詢
        try {
            const fallback = await db.collection("chat_logs")
                .where("status", "==", "active")
                .get();

            if (fallback.empty) {
                return reply(event, 'Cony，目前沒有待辦事項。');
            }

            let msg = 'Cony，以下是目前的待辦：\n';
            let i = 1;
            fallback.forEach(doc => {
                msg += `\n${i}. ${doc.data().text}`;
                i++;
            });
            return reply(event, msg);
        } catch (e2) {
            console.error("備用查詢也失敗:", e2);
            return reply(event, '查詢待辦時遇到問題，請稍後再試。');
        }
    }
}

// ============================================
// 新增任務
// ============================================
async function handleAddTask(event, userId, userMessage, pendingRef, pending) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const now = new Date();
    const todayStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    const context = pending.exists && pending.data().tasks?.length > 0
        ? `【背景】Cony 正在修改先前的任務「${pending.data().tasks[0].title}」，請根據新指令更新。`
        : "";

    const prompt = `你是 Cony 的特助，說話精簡自然。嚴禁使用 Markdown 符號。
現在台灣時間：${todayStr}。

Cony 說：「${userMessage}」
${context}

規則：
1. 擷取真正的任務名稱。
2. 有指定時間就遵照，只說日期就預設 10:00，都沒說就排今天 10:00。
3. end = start + 1小時。
4. 用一句話自然回覆，最後問「確認嗎？」

最後一行附上 JSON（不要用 code block）：
[{"title": "任務名稱", "start": "YYYY-MM-DDTHH:mm:00", "end": "YYYY-MM-DDTHH:mm:00"}]`;

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
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (pe) {
                console.error("JSON parse 失敗:", pe.message);
            }
        }

        const clean = aiText
            .replace(/```json\s*/g, '').replace(/```\s*/g, '')
            .replace(/\[\s*\{[\s\S]*?\}\s*\]/g, '').trim();
        return reply(event, clean);
    } catch (e) {
        console.error("新增任務失敗:", e.message);
        return reply(event, '特助大腦當機了，請再說一次。');
    }
}

// ============================================
// 標記完成
// ============================================
async function handleCompleteTask(event, userMessage) {
    const snapshot = await db.collection("chat_logs").where("status", "==", "active").get();
    if (snapshot.empty) return reply(event, 'Cony，目前沒有待辦可以完成。');

    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, text: doc.data().text }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `待辦清單：
${tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」
判斷想完成哪項，只回覆 ID。無法判斷回覆 NONE。`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const id = res.data.candidates[0].content.parts[0].text.trim();
        if (id === "NONE") return reply(event, '不太確定是哪一項，可以說更明確嗎？');

        const name = tasks.find(t => t.id === id)?.text || "該任務";
        await db.collection("chat_logs").doc(id).update({
            status: "archived",
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return reply(event, `「${name}」已標記完成！`);
    } catch (e) {
        console.error("完成任務失敗:", e);
        return reply(event, '處理時出了問題，請稍後再試。');
    }
}

// ============================================
// 刪除任務
// ============================================
async function handleDeleteTask(event, userMessage) {
    const snapshot = await db.collection("chat_logs").where("status", "==", "active").get();
    if (snapshot.empty) return reply(event, 'Cony，目前沒有待辦可以刪除。');

    const tasks = [];
    snapshot.forEach(doc => tasks.push({ id: doc.id, text: doc.data().text }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `待辦清單：
${tasks.map((t, i) => `${i + 1}. [${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」
判斷想刪除哪項，只回覆 ID。無法判斷回覆 NONE。`;

    try {
        const res = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const id = res.data.candidates[0].content.parts[0].text.trim();
        if (id === "NONE") return reply(event, '不太確定要刪哪項，可以說清楚一點嗎？');

        const name = tasks.find(t => t.id === id)?.text || "該任務";
        await db.collection("chat_logs").doc(id).delete();
        return reply(event, `「${name}」已刪除。`);
    } catch (e) {
        console.error("刪除失敗:", e);
        return reply(event, '刪除時出了問題，請稍後再試。');
    }
}

// ============================================
// 閒聊
// ============================================
async function handleChitchat(event, userMessage) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const prompt = `你是 Cony 的業務特助，精明溫暖。嚴禁 Markdown 符號。
Cony 是數位廣告行銷副理。
簡短自然地回應，不要每次都問「需要幫忙嗎」。
重要：你不知道 Cony 的待辦事項內容，如果她問待辦相關問題，告訴她說「讓我幫妳查一下」然後請她再輸入一次「待辦有哪些」。
絕對不要自己編造任何任務內容。

Cony 說：「${userMessage}」`;

    try {
        const res = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
        return reply(event, res.data.candidates[0].content.parts[0].text.trim());
    } catch (e) {
        return reply(event, '我剛恍神了，再說一次？');
    }
}

// ============================================
// 確認執行
// ============================================
async function executeConfirmedTasks(event, pendingRef, data) {
    try {
        const batch = db.batch();
        data.tasks.forEach(t => {
            batch.set(db.collection("chat_logs").doc(), {
                text: t.title,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: "active"
            });
        });
        await batch.commit();
    } catch (e) { console.error("DB Error:", e); }

    let calMsg = "";
    for (const t of data.tasks) {
        if (t.start) {
            try {
                await createCalendarEvent(t);
                calMsg = "\n行事曆也同步好了！";
            } catch (e) {
                console.error("行事曆失敗:", e.message);
                calMsg = `\n行事曆同步失敗：${e.message}`;
            }
        }
    }

    await pendingRef.delete();
    return reply(event, `搞定！任務已加入系統。${calMsg}`);
}

// ============================================
// Google Calendar
// ============================================
async function createCalendarEvent(taskData) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const rawCalId = process.env.MY_CALENDAR_ID || "";

    if (!rawKey || rawKey.length < 10) throw new Error("私鑰為空");
    if (!rawEmail) throw new Error("Email 為空");

    const auth = new google.auth.JWT({
        email: rawEmail.trim().replace(/^["']|["']$/g, ''),
        key: rawKey.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/calendar']
    });

    await google.calendar({ version: 'v3', auth }).events.insert({
        calendarId: rawCalId.trim().replace(/^["']|["']$/g, ''),
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
        }
    });
}

// 工具函數
function reply(event, text) {
    return client.replyMessage(event.replyToken, { type: 'text', text });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`伺服器在 ${PORT} 啟動`));

