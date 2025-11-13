/**
 * User Bot Server для Telegram с интеграцией Яндекс SpeechKit
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

// Middleware для проверки авторизации
function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${WORKERS_WEBHOOK_KEY}`;
  
  if (!authHeader || authHeader !== expectedAuth) {
    console.error('Unauthorized request:', {
      received: authHeader,
      expected: expectedAuth.substring(0, 10) + '...',
      hasKey: !!WORKERS_WEBHOOK_KEY
    });
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized. Check WORKERS_WEBHOOK_KEY in Railway environment variables.' 
    });
  }
  
  next();
}

// Применяем проверку авторизации ко всем API эндпоинтам
app.use('/api', checkAuth);

// Эндпоинт для проверки здоровья сервера (без авторизации)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasWebhookKey: !!WORKERS_WEBHOOK_KEY,
    hasYandexKey: !!YANDEX_API_KEY
  });
});

/**
 * Подключение User Bot
 */
app.post('/api/connect', async (req, res) => {
  try {
    console.log('[/api/connect] Request received:', { userId: req.body.userId, phone: req.body.phone });
    const { userId, phone, apiId, apiHash } = req.body;
    
    // Создаем сессию
    const sessionString = `userbot_${userId}`;
    const session = new StringSession(sessionString);
    
    // Создаем клиент
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
      connectionRetries: 5,
    });
    
    await client.connect();
    console.log('[/api/connect] Client connected');
    
    // Отправляем код (если нужно)
    if (!await client.checkAuthorization()) {
      console.log('[/api/connect] Not authorized, sending code...');
      const result = await client.sendCode({ apiId, apiHash }, phone);
      console.log('[/api/connect] Code sent, phoneCodeHash:', result.phoneCodeHash);
      return res.json({ 
        success: true, 
        phoneCodeHash: result.phoneCodeHash,
        requiresCode: true 
      });
    }
    
    console.log('[/api/connect] Already authorized');
    
    // Сохраняем клиент
    clients.set(userId, client);
    
    // Настраиваем обработчик сообщений
    client.addEventHandler(async (event) => {
      await handleNewMessage(event, userId);
    }, new Api.NewMessage({}));
    
    res.json({ success: true, connected: true });
  } catch (error) {
    console.error('[/api/connect] Error:', error.message);
    console.error('[/api/connect] Stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

/**
 * Проверка кода подтверждения
 */
app.post('/api/verify-code', async (req, res) => {
  try {
    const { userId, phone, apiId, apiHash, phoneCodeHash, code } = req.body;
    
    // Получаем или создаем клиент
    let client = clients.get(userId);
    if (!client) {
      const session = new StringSession(`userbot_${userId}`);
      client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
    }
    
    // Проверяем код
    try {
      const result = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: phoneCodeHash,
        phoneCode: code
      }));
      
      // Если SignIn успешен, проверяем тип результата
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        // Нужна регистрация (не должно быть для существующих аккаунтов)
        return res.json({
          success: false,
          error: 'Аккаунт не найден'
        });
      }
      
      // Авторизация успешна, пароль не требуется
      clients.set(userId, client);
      
      // Настраиваем обработчик сообщений
      client.addEventHandler(async (event) => {
        await handleNewMessage(event, userId);
      }, new Api.NewMessage({}));
      
      return res.json({
        success: true,
        connected: true,
        requiresPassword: false
      });
    } catch (error) {
      // Проверяем, требуется ли пароль
      if (error.message && (error.message.includes('PASSWORD_HASH_INVALID') || error.message.includes('PASSWORD_REQUIRED'))) {
        // Нужен пароль 2FA
        clients.set(userId, client);
        return res.json({
          success: true,
          requiresPassword: true
        });
      }
      
      if (error.message && (error.message.includes('PHONE_CODE_INVALID') || error.message.includes('PHONE_CODE_EXPIRED'))) {
        return res.json({
          success: false,
          error: 'Неверный или истекший код'
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Verify code error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Проверка пароля 2FA
 */
app.post('/api/verify-password', async (req, res) => {
  try {
    const { userId, phone, apiId, apiHash, password } = req.body;
    
    // Получаем клиент
    let client = clients.get(userId);
    if (!client) {
      const session = new StringSession(`userbot_${userId}`);
      client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
    }
    
    // Получаем информацию о пароле
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    
    // Вычисляем хеш пароля
    const { computeCheck } = require('telegram/Password');
    const check = await computeCheck(passwordInfo, password);
    
    // Проверяем пароль
    try {
      const result = await client.invoke(new Api.auth.CheckPassword({
        password: check
      }));
      
      // Пароль верный, авторизация завершена
      clients.set(userId, client);
      
      // Настраиваем обработчик сообщений
      client.addEventHandler(async (event) => {
        await handleNewMessage(event, userId);
      }, new Api.NewMessage({}));
      
      return res.json({
        success: true,
        connected: true
      });
    } catch (error) {
      if (error.message && error.message.includes('PASSWORD_HASH_INVALID')) {
        return res.json({
          success: false,
          error: 'Неверный пароль'
        });
      }
      throw error;
    }
  } catch (error) {
    console.error('Verify password error:', error);
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


