/**/
 * ПРИМЕР СЕРВЕРА USER BOT (Node.js)
 * 
 * Этот файл - пример того, как должен работать внешний сервер
 * Разместите его на бесплатном хостинге (Railway, Render, Fly.io)
 * 
 * УСТАНОВКА:
 * npm install telegram express axios
 * 
 * НАСТРОЙКА:
 * 1. Получите API ключ Яндекс SpeechKit: https://cloud.yandex.ru/services/speechkit
 * 2. Установите переменные окружения:
 *    - YANDEX_API_KEY - ключ Яндекс SpeechKit
 *    - WORKERS_WEBHOOK_URL - URL вашего Workers + /webhook/userbot
 *    - WORKERS_WEBHOOK_KEY - секретный ключ для webhook
 */

const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const WORKERS_WEBHOOK_URL = process.env.WORKERS_WEBHOOK_URL;
const WORKERS_WEBHOOK_KEY = process.env.WORKERS_WEBHOOK_KEY;

// Хранилище клиентов (в реальности используйте базу данных)
const clients = new Map();

/**
 * Подключение User Bot
 */
app.post('/api/connect', async (req, res) => {
  try {
    const { userId, phone, apiId, apiHash } = req.body;
    
    // Создаем сессию
    const sessionString = `userbot_${userId}`;
    const session = new StringSession(sessionString);
    
    // Создаем клиент
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();
    
    // Отправляем код (если нужно)
    if (!await client.checkAuthorization()) {
      const result = await client.sendCode({ apiId, apiHash }, phone);
      return res.json({ 
        success: true, 
        phoneCodeHash: result.phoneCodeHash,
        requiresCode: true 
      });
    }
    
    // Сохраняем клиент
    clients.set(userId, client);
    
    // Настраиваем обработчик сообщений
    client.addEventHandler(async (event) => {
      await handleNewMessage(event, userId);
    }, new Api.NewMessage({}));
    
    res.json({ success: true, connected: true });
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Обработка команды .гс (расшифровка голосового сообщения)
 * 
 * Пользователь отвечает на голосовое сообщение командой .гс
 * Бот расшифровывает голосовое и отправляет расшифровку как ответ
 */
app.post('/api/voice-reply', async (req, res) => {
  try {
    const { userId, phone, apiId, apiHash, chatId, messageId } = req.body;
    
    // Получаем клиент
    let client = clients.get(userId);
    if (!client) {
      // Переподключаемся если нужно
      const session = new StringSession(`userbot_${userId}`);
      client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
      clients.set(userId, client);
    }
    
    // Получаем конкретное сообщение, на которое отвечаем
    const voiceMessage = await client.getMessages(chatId, { ids: [messageId] });
    
    if (!voiceMessage || voiceMessage.length === 0) {
      return res.json({ success: false, error: 'Сообщение не найдено' });
    }
    
    const targetMessage = voiceMessage[0];
    
    // Проверяем, что это голосовое сообщение
    if (!targetMessage.voice) {
      return res.json({ success: false, error: 'Это не голосовое сообщение' });
    }
    
    // Скачиваем голосовое сообщение
    const buffer = await client.downloadMedia(targetMessage, {});
    const audioPath = path.join(__dirname, `temp_${userId}_${Date.now()}.ogg`);
    fs.writeFileSync(audioPath, buffer);
    
    // Отправляем на Яндекс SpeechKit для расшифровки
    const transcription = await transcribeAudio(audioPath);
    
    // Удаляем временный файл
    try {
      fs.unlinkSync(audioPath);
    } catch (e) {
      // Игнорируем ошибки удаления
    }
    
    // Отправляем расшифровку как ответ на голосовое сообщение
    await client.sendMessage(chatId, {
      message: `📝 Расшифровка:\n\n"${transcription}"`,
      replyTo: targetMessage.id
    });
    
    // Отправляем результат в Workers
    await sendToWorkers(userId, 'voice_transcribed', {
      text: transcription
    });
    
    res.json({ success: true, transcription });
  } catch (error) {
    console.error('Voice reply error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Расшифровка аудио через Яндекс SpeechKit
 */
async function transcribeAudio(audioPath) {
  try {
    // Читаем файл
    const audioData = fs.readFileSync(audioPath);
    const base64Audio = audioData.toString('base64');
    
    // Отправляем на Яндекс SpeechKit
    const response = await axios.post(
      'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize',
      {
        config: {
          specification: {
            languageCode: 'ru-RU',
            model: 'general',
            audioEncoding: 'OGG_OPUS',
            sampleRateHertz: 48000
          }
        },
        audio: {
          content: base64Audio
        }
      },
      {
        headers: {
          'Authorization': `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data.result.alternatives[0].text;
  } catch (error) {
    console.error('Transcription error:', error);
    throw new Error('Ошибка расшифровки аудио');
  }
}

/**
 * Отправка результата в Workers
 */
async function sendToWorkers(userId, type, result) {
  try {
    await axios.post(WORKERS_WEBHOOK_URL, {
      userId,
      type,
      result
    }, {
      headers: {
        'Authorization': `Bearer ${WORKERS_WEBHOOK_KEY}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending to workers:', error);
  }
}

/**
 * Обработка новых сообщений
 */
async function handleNewMessage(event, userId) {
  const message = event.message;
  
  // Отправляем в Workers через webhook
  await sendToWorkers(userId, 'message_received', {
    text: message.text || '[медиа сообщение]',
    chatId: message.chatId,
    messageId: message.id
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`User Bot server running on port ${PORT}`);
});



