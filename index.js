const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

// --- 1. 初始化 Firebase ---
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
    Promise.all(req.body.events.map(handleEvent)).then(r => res.json(r)).catch(e => console.error("Webhook Error:", e));
});

// --- 2. 核心大腦邏輯 ---
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // 🎯 邏輯 A：確認與執行 (存入資料庫與行事曆)
    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行"];
    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        const data = pending.data();
        
        try {
            const batch = db.batch();
            data.tasks.forEach(t => {
                const ref = db.collection("chat_logs").doc();
                batch.set(ref, { text: t.title, timestamp: admin.firestore.FieldValue.serverTimestamp(), status: "active" });
            });
            await batch.commit();
        } catch (e) { console.error("DB Error", e); }

        let calendarFeedback = "";
        for (const t of data.tasks) {
            if (t.start) {
                try {
                    await createCalendarEvent(t);
                    calendarFeedback = "\n📅 行事曆預約成功囉！";
                } catch (e) {
                    calendarFeedback = `\n❌ 行事曆失敗：${e.message}`;
                }
            }
        }
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, { type: 'text', text: `✨ 任務已同步到系統。${calendarFeedback}` });
    }

    // 🎯 邏輯 B：AI 讀心術與意圖判斷
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const now = new Date();
    const todayStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    const context = pending.exists && pending.data().tasks && pending.data().tasks.length > 0 
        ? `【背景】：Cony 正在修改先前的任務「${pending.data().tasks[0].title}」。` : "";

    // 🧠 給 AI 的最新指令：教它判斷意圖
    const prompt = `你是一位精明俐落的 Cony 專屬特助。嚴禁使用 Markdown 符號。現在時間是：${todayStr}。
    分析 Cony 的最新訊息：『${userMessage}』 ${context}

    【意圖判斷與行動準則】：
    1. 【查詢模式】：若她問「待辦有哪些、查清單」，請回覆『正在為您連線儀表板...』。並在 JSON 的 title 填寫 "QUERY_TASKS"。
    2. 【問答模式】：若她問「怎麼用」或閒聊，請直接用特助語氣回答問題。並在 JSON 的 title 填寫 "NORMAL_CHAT"。
    3. 【排程模式】：若她要求「新增/修改任務」，請擷取任務名稱與時間。回覆：『Cony，沒問題，幫妳把[任務]排在[時間]了，這樣可以嗎？』

    【系統要求 - 必填】：
    不論哪種模式，都必須在最下方附上 JSON 格式：
    [{"title": "任務名稱 或 QUERY_TASKS 或 NORMAL_CHAT", "start": "2026-MM-DDTHH:mm:00", "end": "2026-MM-DDTHH:mm:00"}]`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;
        
        // 抓出 JSON 內容
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        const cleanMessage = aiResponseText.replace(/\[\s*\{[\s\S]*\}\s*\]/g, '').trim();

        if (jsonMatch) {
            const tasksToSave = JSON.parse(jsonMatch[0]);
            const intent = tasksToSave[0].title;

            // 🌟 攔截器 1：如果意圖是「查詢待辦」
            if (intent === "QUERY_TASKS") {
                const snapshot = await db.collection("chat_logs").where("status", "==", "active").get();
                if (snapshot.empty) {
                    await pendingRef.delete();
                    return client.replyMessage(event.replyToken, { type: 'text', text: "Cony，目前系統儀表板裡沒有未完成的待辦事項喔！✨" });
                }
                
                let listMsg = "📋 【Cony 的專屬待辦清單】：\n\n";
                snapshot.forEach(doc => {
                    listMsg += `🔸 ${doc.data().text}\n`;
                });
                await pendingRef.delete(); // 清除暫存以免卡住
                return client.replyMessage(event.replyToken, { type: 'text', text: listMsg.trim() });
            } 
            // 🌟 攔截器 2：如果意圖是「閒聊或發問」
            else if (intent === "NORMAL_CHAT") {
                await pendingRef.delete();
                return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
            } 
            // 🌟 攔截器 3：正常的「排程任務」
            else {
                await pendingRef.set({ tasks: tasksToSave, timestamp: admin.firestore.FieldValue.serverTimestamp() });
                return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
            }
        }
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
    } catch (e) {
        return client.replyMessage(event.replyToken, { type: 'text', text: "特助大腦短暫當機，請稍後再試。" });
    }
}

// --- 3. Google Calendar 寫入 ---
async function createCalendarEvent(taskData) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const rawCalId = process.env.MY_CALENDAR_ID || "";

    const cleanKey = rawKey.trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
    const cleanEmail = rawEmail.trim().replace(/^["']|["']$/g, '');
    const cleanCalId = rawCalId.trim().replace(/^["']|["']$/g, '');

    const auth = new google.auth.JWT({
        email: cleanEmail,
        key: cleanKey,
        scopes: ['https://www.googleapis.com/auth/calendar']
    });

    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.insert({
        calendarId: cleanCalId,
        resource: {
            summary: taskData.title,
            start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
            end: { dateTime: taskData.end, timeZone: 'Asia/Taipei' },
        }
    });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`伺服器在 ${PORT} 啟動...`));