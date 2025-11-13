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

// Импорт Password (может быть в разных местах в зависимости от версии)
let computeCheck;
try {
  computeCheck = require('telegram/Password').computeCheck;
} catch (e) {
  try {
    const { Password } = require('telegram');
    computeCheck = Password.computeCheck;
  } catch (e2) {
    console.warn('Could not import computeCheck, password verification will not work');
    computeCheck = null;
  }
}

const app = express();
app.use(express.json());

const YANDEX_API_KEY = process.env.YANDEX_API_KEY;
const WORKERS_WEBHOOK_URL = process.env.WORKERS_WEBHOOK_URL;
const WORKERS_WEBHOOK_KEY = process.env.WORKERS_WEBHOOK_KEY;

// Хранилище клиентов (в реальности используйте базу данных)
const clients = new Map();

// Хранилище сессий (в реальности используйте базу данных)
const sessions = new Map();

// Хранилище phoneCodeHash для каждого пользователя
const phoneCodeHashes = new Map();

// Получить сохраненную сессию
function getSavedSession(userId) {
  return sessions.get(userId) || null;
}

// Сохранить сессию
function saveSession(userId, sessionString) {
  if (sessionString) {
    sessions.set(userId, sessionString);
  }
}

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
    console.log('[/api/connect] Request received:', { 
      userId: req.body.userId, 
      phone: req.body.phone,
      apiId: req.body.apiId,
      hasApiHash: !!req.body.apiHash
    });
    
    const { userId, phone, apiId, apiHash } = req.body;
    
    // Валидация входных данных
    if (!phone || !apiId || !apiHash) {
      console.error('[/api/connect] Missing required fields');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: phone, apiId, apiHash' 
      });
    }
    
    // Создаем сессию
    // StringSession требует либо валидную строку сессии, либо null/undefined для новой сессии
    // Используем null для новой сессии
    const session = new StringSession(null);
    
    // Создаем клиент
    const client = new TelegramClient(session, parseInt(apiId), apiHash, {
      connectionRetries: 5,
    });
    
    console.log('[/api/connect] Connecting to Telegram...');
    await client.connect();
    console.log('[/api/connect] Client connected');
    
    // Отправляем код (если нужно)
    const isAuthorized = await client.checkAuthorization();
    console.log('[/api/connect] Authorization status:', isAuthorized);
    
    if (!isAuthorized) {
      // Проверяем, не отправляли ли мы уже код (чтобы не отправлять повторно)
      const existingHash = phoneCodeHashes.get(userId);
      if (existingHash && clients.get(userId)) {
        console.log('[/api/connect] Code already sent, returning existing phoneCodeHash');
        return res.json({ 
          success: true, 
          phoneCodeHash: existingHash,
          requiresCode: true 
        });
      }
      
      console.log('[/api/connect] Not authorized, sending code to:', phone);
      try {
        const result = await client.sendCode({ apiId, apiHash }, phone);
        console.log('[/api/connect] Code sent successfully, phoneCodeHash:', result.phoneCodeHash);
        
        // Сохраняем клиент и phoneCodeHash для последующего использования
        clients.set(userId, client);
        phoneCodeHashes.set(userId, result.phoneCodeHash);
        
        return res.json({ 
          success: true, 
          phoneCodeHash: result.phoneCodeHash,
          requiresCode: true 
        });
      } catch (sendCodeError) {
        console.error('[/api/connect] Error sending code:', sendCodeError.message);
        console.error('[/api/connect] Error stack:', sendCodeError.stack);
        return res.status(500).json({
          success: false,
          error: `Failed to send code: ${sendCodeError.message}`
        });
      }
    }
    
    console.log('[/api/connect] Already authorized');
    
    // Сохраняем сессию
    const sessionString = client.session.save();
    saveSession(userId, sessionString);
    
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
    console.log('[/api/verify-code] Request received:', { 
      userId: req.body.userId, 
      phone: req.body.phone,
      hasPhoneCodeHash: !!req.body.phoneCodeHash,
      code: req.body.code
    });
    
    const { userId, phone, apiId, apiHash, phoneCodeHash, code } = req.body;
    
    // ВАЖНО: Используем тот же клиент, который отправил код
    // Если клиента нет, значит сервер перезапустился - нужно начать заново
    let client = clients.get(userId);
    if (!client) {
      console.error('[/api/verify-code] Client not found for userId:', userId);
      return res.status(400).json({
        success: false,
        error: 'Клиент не найден. Начните подключение заново: /connect_bot'
      });
    }
    
    // Используем сохраненный phoneCodeHash, если переданный не совпадает
    const savedHash = phoneCodeHashes.get(userId);
    const hashToUse = savedHash || phoneCodeHash;
    
    if (savedHash && savedHash !== phoneCodeHash) {
      console.log('[/api/verify-code] Using saved phoneCodeHash instead of provided one');
    }
    
    console.log('[/api/verify-code] Using existing client, verifying code with hash:', hashToUse);
    
    // Проверяем код
    console.log('[/api/verify-code] Attempting SignIn with:', {
      phone: phone,
      phoneCodeHash: hashToUse,
      codeLength: code.length,
      code: code
    });
    
    try {
      const result = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: hashToUse,
        phoneCode: code
      }));
      
      console.log('[/api/verify-code] SignIn successful, result type:', result.constructor.name);
      
      // Если SignIn успешен, проверяем тип результата
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        // Нужна регистрация (не должно быть для существующих аккаунтов)
        return res.json({
          success: false,
          error: 'Аккаунт не найден'
        });
      }
      
      // Авторизация успешна, пароль не требуется
      // Сохраняем сессию
      const sessionString = client.session.save();
      saveSession(userId, sessionString);
      
      // Удаляем phoneCodeHash, так как он больше не нужен
      phoneCodeHashes.delete(userId);
      
      clients.set(userId, client);
      
      // Настраиваем обработчик сообщений
      client.addEventHandler(async (event) => {
        await handleNewMessage(event, userId);
      }, new Api.NewMessage({}));
      
      console.log('[/api/verify-code] Authorization successful');
      return res.json({
        success: true,
        connected: true,
        requiresPassword: false
      });
    } catch (error) {
      // Детальная информация об ошибке
      const errorMessage = error.message || '';
      const errorCode = error.code || '';
      const errorClassName = error.constructor.name;
      
      console.error('[/api/verify-code] SignIn error:', {
        message: errorMessage,
        code: errorCode,
        type: errorClassName,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });
      
      // Проверяем, требуется ли пароль (2FA)
      // Ошибка PASSWORD_REQUIRED означает, что код верный, но нужен пароль
      if (errorMessage.includes('PASSWORD_REQUIRED') || 
          errorMessage.includes('PASSWORD_HASH_INVALID') ||
          errorCode === 401 ||
          errorClassName.includes('Password')) {
        console.log('[/api/verify-code] Password required (code was correct)');
        // НЕ удаляем phoneCodeHash, он еще нужен для проверки пароля
        clients.set(userId, client);
        return res.json({
          success: true,
          requiresPassword: true
        });
      }
      
      // Проверяем ошибки кода
      // Эти ошибки означают, что код неверный или истек
      const isCodeError = 
        errorMessage.includes('PHONE_CODE_INVALID') || 
        errorMessage.includes('PHONE_CODE_EXPIRED') || 
        errorMessage.includes('PHONE_CODE_EMPTY') ||
        errorMessage.includes('CODE_INVALID') ||
        errorMessage.includes('CODE_EXPIRED') ||
        errorCode === 400 ||
        errorCode === 'PHONE_CODE_INVALID' ||
        errorCode === 'PHONE_CODE_EXPIRED' ||
        errorClassName.includes('PhoneCode');
      
      if (isCodeError) {
        console.error('[/api/verify-code] Invalid or expired code. Clearing state.');
        
        // Очищаем старый phoneCodeHash и клиент, чтобы можно было запросить новый код
        phoneCodeHashes.delete(userId);
        clients.delete(userId);
        
        return res.json({
          success: false,
          error: 'Неверный или истекший код. Коды Telegram действительны ограниченное время. Начните подключение заново: /connect_bot'
        });
      }
      
      // Другие ошибки
      console.error('[/api/verify-code] Unexpected error:', error);
      return res.status(500).json({
        success: false,
        error: `Ошибка при проверке кода: ${errorMessage || 'Неизвестная ошибка'}`
      });
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
      const session = new StringSession(null); // null для новой сессии
      client = new TelegramClient(session, parseInt(apiId), apiHash, {
        connectionRetries: 5,
      });
      await client.connect();
    }
    
    // Получаем информацию о пароле
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    
    // Вычисляем хеш пароля
    if (!computeCheck) {
      return res.json({
        success: false,
        error: 'Password verification not available'
      });
    }
    
    const check = await computeCheck(passwordInfo, password);
    
    // Проверяем пароль
    try {
      const result = await client.invoke(new Api.auth.CheckPassword({
        password: check
      }));
      
      // Пароль верный, авторизация завершена
      // Сохраняем сессию
      const sessionString = client.session.save();
      saveSession(userId, sessionString);
      
      // Удаляем phoneCodeHash, так как он больше не нужен
      phoneCodeHashes.delete(userId);
      
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
      // Используем сохраненную сессию, если есть, иначе null для новой
      const savedSession = await getSavedSession(userId);
      const session = new StringSession(savedSession || null);
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

// Обработка ошибок при старте
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`User Bot server running on port ${PORT}`);
  console.log('Environment check:');
  console.log('- WORKERS_WEBHOOK_KEY:', WORKERS_WEBHOOK_KEY ? 'SET' : 'NOT SET');
  console.log('- YANDEX_API_KEY:', YANDEX_API_KEY ? 'SET' : 'NOT SET');
  console.log('- WORKERS_WEBHOOK_URL:', WORKERS_WEBHOOK_URL || 'NOT SET');
});


