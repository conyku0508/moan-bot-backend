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

// --- 2. 基本設定 ---
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
// 核心：意圖判斷 + 分流處理
// ============================================
async function handleEvent(event) {
    if (event.type !== 'message' || event.message.type !== 'text') return null;
    const userMessage = event.message.text.trim();
    const userId = event.source.userId;

    // --- Step 0: 檢查是否有待確認的任務 ---
    const pendingRef = db.collection("pending_proposals").doc(userId);
    const pending = await pendingRef.get();

    const confirmWords = ["好", "確認", "ok", "yes", "可以", "加進去", "執行", "對"];
    const cancelWords = ["不要", "取消", "算了", "不用"];

    // 確認執行
    if (pending.exists && confirmWords.includes(userMessage.toLowerCase())) {
        return await executeConfirmedTasks(event, pendingRef, pending.data());
    }

    // 取消
    if (pending.exists && cancelWords.includes(userMessage.toLowerCase())) {
        await pendingRef.delete();
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '沒問題，已經幫妳取消了。有需要再跟我說！'
        });
    }

    // --- Step 1: 讓 AI 判斷意圖 ---
    const intent = await classifyIntent(userMessage);
    console.log(`[意圖判斷] "${userMessage}" => ${intent}`);

    // --- Step 2: 根據意圖分流 ---
    switch (intent) {
        case "QUERY_TASKS":
            return await handleQueryTasks(event, userId);
        case "ADD_TASK":
            return await handleAddTask(event, userId, userMessage, pendingRef, pending);
        case "COMPLETE_TASK":
            return await handleCompleteTask(event, userId, userMessage);
        case "DELETE_TASK":
            return await handleDeleteTask(event, userId, userMessage);
        case "CHITCHAT":
        default:
            return await handleChitchat(event, userMessage);
    }
}

// ============================================
// 意圖分類器 (用 Gemini 快速判斷)
// ============================================
async function classifyIntent(message) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `你是一個意圖分類器。請判斷以下使用者訊息屬於哪一種意圖，只回覆分類代碼，不要回覆任何其他文字。

分類選項：
- QUERY_TASKS：查詢待辦事項、問有哪些任務、查看進度（例如：「待辦有哪些」「我還有什麼事」「今天有什麼要做的」）
- ADD_TASK：新增任務、安排行程、排定時間（例如：「幫我安排明天開會」「下午三點提醒我打電話」）
- COMPLETE_TASK：標記任務完成（例如：「XX任務做完了」「完成了」）
- DELETE_TASK：刪除任務（例如：「把XX刪掉」「移除那個任務」）
- CHITCHAT：閒聊、打招呼、問問題、抱怨、其他所有不屬於以上的訊息

使用者訊息：「${message}」

分類代碼：`;

    try {
        const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 20 }
        });
        const result = response.data.candidates[0].content.parts[0].text.trim();
        // 防呆：確保回傳的是有效分類
        const validIntents = ["QUERY_TASKS", "ADD_TASK", "COMPLETE_TASK", "DELETE_TASK", "CHITCHAT"];
        return validIntents.includes(result) ? result : "CHITCHAT";
    } catch (e) {
        console.error("意圖分類失敗:", e.message);
        return "CHITCHAT";
    }
}

// ============================================
// 功能一：查詢待辦事項
// ============================================
async function handleQueryTasks(event, userId) {
    try {
        const snapshot = await db.collection("chat_logs")
            .where("status", "==", "active")
            .orderBy("timestamp", "desc")
            .limit(20)
            .get();

        if (snapshot.empty) {
            return client.replyMessage(event.replyToken, {
                type: 'text', text: 'Cony，妳目前沒有任何待辦事項，太棒了，全部清空！'
            });
        }

        let taskList = 'Cony，以下是妳目前的待辦事項：\n\n';
        let index = 1;
        snapshot.forEach(doc => {
            const data = doc.data();
            const dateStr = data.timestamp
                ? new Date(data.timestamp.seconds * 1000).toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' })
                : '未知日期';
            taskList += `${index}. ${data.text}（${dateStr}）\n`;
            index++;
        });
        taskList += `\n共 ${index - 1} 項待處理。需要我幫妳完成或刪除哪一項嗎？`;

        return client.replyMessage(event.replyToken, { type: 'text', text: taskList });
    } catch (e) {
        console.error("查詢失敗:", e);
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '抱歉，查詢待辦時出了點問題，請稍後再試。'
        });
    }
}

// ============================================
// 功能二：新增任務 + 行事曆排程
// ============================================
async function handleAddTask(event, userId, userMessage, pendingRef, pending) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const now = new Date();
    const todayStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    const isoDate = now.toISOString().split('T')[0]; // 2026-03-30

    // 如果有 pending 資料，提供上下文讓 AI 知道是在修改
    const context = pending.exists && pending.data().tasks && pending.data().tasks.length > 0
        ? `【重要背景】Cony 正在修改先前的任務「${pending.data().tasks[0].title}」，請根據她的新指令更新時間或內容。`
        : "";

    const prompt = `你是 Cony 的專屬特助，說話精簡俐落。嚴禁使用任何 Markdown 符號（不能用 # * \` 等）。
現在的真實台灣時間是：${todayStr}（${isoDate}）。

Cony 說：「${userMessage}」
${context}

請做以下事情：
1. 擷取真正的任務名稱，用自然的方式回覆。
2. 如果 Cony 有指定時間，絕對遵照。如果只說日期沒說時間，預設早上 10:00。如果連日期都沒說，預設排在今天。
3. end 時間預設為 start 之後 1 小時。
4. 用一句話自然回覆，例如：「Cony，已經幫妳把 XXX 排在 X月X日 X點了，確認嗎？」

最後一行請附上純 JSON（不要加 \`\`\`），格式如下：
[{"title": "任務名稱", "start": "YYYY-MM-DDTHH:mm:00", "end": "YYYY-MM-DDTHH:mm:00"}]`;

    try {
        const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        const aiResponseText = response.data.candidates[0].content.parts[0].text;

        // 抓 JSON
        const jsonMatch = aiResponseText.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (jsonMatch) {
            try {
                const tasks = JSON.parse(jsonMatch[0]);
                // 防呆：確保 end 存在且不等於 start
                tasks.forEach(t => {
                    if (!t.end || t.end === t.start) {
                        const startDate = new Date(t.start);
                        startDate.setHours(startDate.getHours() + 1);
                        t.end = startDate.toISOString().replace(/:\d{2}\.\d{3}Z$/, ':00');
                    }
                });
                await pendingRef.set({
                    tasks: tasks,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (parseErr) {
                console.error("JSON 解析失敗:", parseErr.message, "原始:", jsonMatch[0]);
                // 解析失敗還是回覆人話，只是不存暫存
            }
        }

        const cleanMessage = aiResponseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').replace(/\[\s*\{[\s\S]*?\}\s*\]/g, '').trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: cleanMessage });
    } catch (e) {
        console.error("Gemini Error:", e.message);
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '特助大腦短暫當機，請稍後再試。'
        });
    }
}

// ============================================
// 功能三：標記任務完成
// ============================================
async function handleCompleteTask(event, userId, userMessage) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    // 先撈出所有 active 任務
    const snapshot = await db.collection("chat_logs")
        .where("status", "==", "active")
        .get();

    if (snapshot.empty) {
        return client.replyMessage(event.replyToken, {
            type: 'text', text: 'Cony，目前沒有待辦事項可以完成喔。'
        });
    }

    const tasksList = [];
    snapshot.forEach(doc => {
        tasksList.push({ id: doc.id, text: doc.data().text });
    });

    const prompt = `以下是目前的待辦清單：
${tasksList.map((t, i) => `${i + 1}. [ID:${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」

請判斷使用者想完成哪一項任務，只回覆該任務的 ID。如果無法判斷，回覆 NONE。
只回覆 ID 或 NONE，不要回覆其他文字。`;

    try {
        const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const matchedId = response.data.candidates[0].content.parts[0].text.trim();

        if (matchedId === "NONE" || !matchedId) {
            return client.replyMessage(event.replyToken, {
                type: 'text', text: 'Cony，我不太確定妳想完成哪一項，可以說得更明確一點嗎？'
            });
        }

        await db.collection("chat_logs").doc(matchedId).update({
            status: "archived",
            completedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        const taskName = tasksList.find(t => t.id === matchedId)?.text || "該任務";
        return client.replyMessage(event.replyToken, {
            type: 'text', text: `漂亮！「${taskName}」已經標記完成了。繼續衝！`
        });
    } catch (e) {
        console.error("完成任務失敗:", e);
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '處理時出了點問題，請稍後再試。'
        });
    }
}

// ============================================
// 功能四：刪除任務
// ============================================
async function handleDeleteTask(event, userId, userMessage) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const snapshot = await db.collection("chat_logs")
        .where("status", "==", "active")
        .get();

    if (snapshot.empty) {
        return client.replyMessage(event.replyToken, {
            type: 'text', text: 'Cony，目前沒有任何待辦可以刪除。'
        });
    }

    const tasksList = [];
    snapshot.forEach(doc => {
        tasksList.push({ id: doc.id, text: doc.data().text });
    });

    const prompt = `以下是目前的待辦清單：
${tasksList.map((t, i) => `${i + 1}. [ID:${t.id}] ${t.text}`).join('\n')}

使用者說：「${userMessage}」

請判斷使用者想刪除哪一項任務，只回覆該任務的 ID。如果無法判斷，回覆 NONE。`;

    try {
        const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 100 }
        });
        const matchedId = response.data.candidates[0].content.parts[0].text.trim();

        if (matchedId === "NONE" || !matchedId) {
            return client.replyMessage(event.replyToken, {
                type: 'text', text: 'Cony，我不太確定妳想刪除哪一項，可以再說清楚一點嗎？'
            });
        }

        const taskName = tasksList.find(t => t.id === matchedId)?.text || "該任務";
        await db.collection("chat_logs").doc(matchedId).delete();

        return client.replyMessage(event.replyToken, {
            type: 'text', text: `已經把「${taskName}」從清單移除了。`
        });
    } catch (e) {
        console.error("刪除任務失敗:", e);
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '刪除時出了點問題，請稍後再試。'
        });
    }
}

// ============================================
// 功能五：閒聊 / 其他
// ============================================
async function handleChitchat(event, userMessage) {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `你是 Cony 的專屬業務特助，個性精明、溫暖、幽默。嚴禁使用 Markdown 符號。
Cony 是一位數位廣告行銷副理，工作很忙。
請用簡短、自然的方式回應她的訊息。如果她在抱怨或聊天，就陪她聊；如果她問的問題跟工作有關，給務實的建議。
不要動不動就問「需要我幫妳做什麼嗎」，自然就好。

Cony 說：「${userMessage}」`;

    try {
        const response = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
        });
        const reply = response.data.candidates[0].content.parts[0].text.trim();
        return client.replyMessage(event.replyToken, { type: 'text', text: reply });
    } catch (e) {
        console.error("閒聊失敗:", e.message);
        return client.replyMessage(event.replyToken, {
            type: 'text', text: '我剛剛恍神了，再說一次？'
        });
    }
}

// ============================================
// 執行已確認的任務
// ============================================
async function executeConfirmedTasks(event, pendingRef, data) {
    // 寫入資料庫
    try {
        const batch = db.batch();
        data.tasks.forEach(t => {
            const ref = db.collection("chat_logs").doc();
            batch.set(ref, {
                text: t.title,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: "active"
            });
        });
        await batch.commit();
    } catch (e) {
        console.error("DB Error:", e);
    }

    // 寫入行事曆
    let calendarFeedback = "";
    for (const t of data.tasks) {
        if (t.start) {
            try {
                await createCalendarEvent(t);
                calendarFeedback = "\n行事曆也同步好了！";
            } catch (e) {
                console.error("行事曆失敗:", e.message);
                calendarFeedback = `\n行事曆同步失敗：${e.message}`;
            }
        }
    }

    await pendingRef.delete();
    return client.replyMessage(event.replyToken, {
        type: 'text', text: `搞定！任務已加入系統。${calendarFeedback}`
    });
}

// ============================================
// Google Calendar 寫入
// ============================================
async function createCalendarEvent(taskData) {
    const rawKey = process.env.CALENDAR_PRIVATE_KEY || "";
    const rawEmail = process.env.CALENDAR_EMAIL || "";
    const rawCalId = process.env.MY_CALENDAR_ID || "";

    if (!rawKey || rawKey.length < 10) throw new Error("私鑰變數為空或太短");
    if (!rawEmail) throw new Error("Email 變數為空");

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

