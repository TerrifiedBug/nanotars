import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const configPath = path.join(__dirname, '..', '..', '.transcription.config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { provider: 'openai', enabled: false, fallbackMessage: '[Voice Message - transcription unavailable]' };
  }
}

async function transcribeWithOpenAI(audioPath, config) {
  if (!config.openai?.apiKey || config.openai.apiKey === '') return null;

  const openaiModule = await import('openai');
  const OpenAI = openaiModule.default;
  const { toFile } = openaiModule;

  const openai = new OpenAI({ apiKey: config.openai.apiKey });
  const buffer = fs.readFileSync(audioPath);
  const file = await toFile(buffer, 'voice.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: config.openai.model || 'whisper-1',
    response_format: 'text',
  });

  return /** @type {string} */ (transcription);
}

/**
 * onInboundMessage hook — transcribe voice notes.
 * The WhatsApp channel sets mediaType='audio' and mediaHostPath for audio messages.
 */
export async function onInboundMessage(msg, channel) {
  if (msg.mediaType !== 'audio' || !msg.mediaHostPath) return msg;
  if (!fs.existsSync(msg.mediaHostPath)) return msg;

  const config = loadConfig();
  if (!config.enabled) {
    msg.content = msg.content
      ? `${msg.content}\n${config.fallbackMessage}`
      : config.fallbackMessage;
    return msg;
  }

  try {
    let transcript = null;
    if (config.provider === 'openai') {
      transcript = await transcribeWithOpenAI(msg.mediaHostPath, config);
    }

    if (transcript) {
      const trimmed = transcript.trim();
      // Replace the [audio: path] annotation with the transcription
      msg.content = msg.content.replace(/\[audio: [^\]]+\]/, `[Voice: ${trimmed}]`);
    } else {
      msg.content = msg.content
        ? `${msg.content}\n${config.fallbackMessage}`
        : config.fallbackMessage;
    }
  } catch (err) {
    console.error('Transcription plugin error:', err);
    msg.content = msg.content
      ? `${msg.content}\n[Voice Message - transcription failed]`
      : '[Voice Message - transcription failed]';
  }

  return msg;
}
