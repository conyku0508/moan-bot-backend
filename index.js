const express = require('express');
const line = require('@line/bot-sdk');
const admin = require('firebase-admin');
const axios = require('axios');
const { google } = require('googleapis');

// --- 1. 初始化 Firebase ---
if (!admin.apps.length) {
    admin.initializeApp({
        projectId: "moan-adtech-bot" // 妳的專案 ID
    });
}
const db = admin.firestore();

// --- 2. 基本設定 ---
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const client = new line.Client(config);
const app = express();

// --- 3. Webhook 入口 ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error("Webhook 錯誤:", err);
            res.status(500).end();
        });
});

// --- 4. 核心邏輯 ---
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    // --- 🎯 邏輯 A：處理「確認」或「接受提案」 ---
    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行"];
    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        const data = pending.data();
        const batch = db.batch();
        
        // 1. 同步到系統儀表板 (chat_logs)
        data.tasks.forEach(t => {
            const ref = db.collection("chat_logs").doc();
            batch.set(ref, { 
                text: t.title, 
                timestamp: admin.firestore.FieldValue.serverTimestamp(), 
                status: "active" 
            });
        });
        await batch.commit();

        // 2. 嘗試同步到 Google 行事曆，並捕捉診斷訊息
        let calendarStatus = "";
        for (const t of data.tasks) {
            if (t.start) {
                try { 
                    await createCalendarEvent(t); 
                    calendarStatus = "\n📅 行事曆也幫妳排好囉，記得去檢查一下！";
                } catch (e) { 
                    console.error("行事曆同步報錯:", e);
                    calendarStatus = `\n❌ 行事曆同步失敗，原因：${e.message}`; 
                }
            }
        }

        // 3. 刪除暫存，結束這次對話
        await pendingRef.delete();
        
        return client.replyMessage(event.replyToken, { 
            type: 'text', 
            text: `✨ 沒問題 Cony，已經幫妳把任務同步到系統了。${calendarStatus}` 
        });
    }

    // --- 🎯 邏輯 B：AI 幕僚分析與提案 (極簡人類口氣) ---
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // 如果有舊的 pending，AI 會知道是要修改時間
    const context = pending.exists ? `（背景：使用者之前有待確認的任務：${pending.data().tasks[0].title}，現在可能是要調整時間或內容）` : "";

    const prompt = `你是一位 Cony 的資深特助。目前的年份是 2026 年。
    
    任務指令：
    1. 分析訊息：『${userMessage}』 ${context}
    2. 嚴禁使用 Markdown 符號（如 ###, **）。
    3. 用自然、親切、俐落的人類口氣說話，不要寫報告書。
    4. 針對提到的日期，預設提議在該日期的「早上 10 點」預約。
    5. 回覆參考：『Cony，關於[任務]，我預計幫妳排在[日期]的早上 10 點，並設定提醒，這樣可以嗎？如果不滿意時間，請直接告訴我妳要改幾點。』
    
    ⚠️ 必須在回覆的最末端附上此 JSON 格式（這段會被程式隱藏處理）：
    [{"title": "任務名稱", "start": "2026-MM-DDT10:00:00", "end": "2026-MM-DDT11:00:00"}]`;

    try {
        const response = await axios.post(geminiUrl, { contents: [{ parts: [{ text: prompt }] }] });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;

        // 提取 JSON 資料
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
            try {
                const tasksToSave = JSON.parse(jsonMatch[0]);
                await pendingRef.set({ 
                    tasks: tasksToSave,
                    timestamp: admin.firestore.FieldValue.serverTimestamp() 
                });
            } catch (e) { console.log("JSON 解析失敗"); }
        }

        // 隱藏 JSON，只回覆乾淨的人話給 Cony
        const cleanMessage = aiResponseText.replace(/\[\s*\{[\s\S]*\}\s*\]/g, '').trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });

    } catch (error) {
        console.error("AI 分析報錯:", error);
        return client.replyMessage(event.replyToken, { type: 'text', text: "Cony 抱歉，我現在腦袋有點卡住，可以再說一次嗎？" });
    }
}

// --- 5. Google Calendar API 寫入函數 ---
async function createCalendarEvent(taskData) {
    const auth = new google.auth.JWT(
        process.env.CALENDAR_EMAIL,
        null,
        process.env.CALENDAR_PRIVATE_KEY.replace(/\\n/g, '\n'),
        ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
        summary: taskData.title,
        description: '由墨案 AI 特助自動建立',
        start: { dateTime: taskData.start, timeZone: 'Asia/Taipei' },
        end: { dateTime: taskData.end || taskData.start, timeZone: 'Asia/Taipei' },
        reminders: {
            useDefault: false,
            overrides: [
                { method: 'popup', minutes: 60 },   // 1小時前
                { method: 'popup', minutes: 1440 }, // 1天前
            ],
        },
    };

    await calendar.events.insert({
        calendarId: process.env.MY_CALENDAR_ID,
        resource: event,
    });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`特助系統在 ${PORT} 端口執勤中...`));