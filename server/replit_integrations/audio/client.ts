import OpenAI, { toFile } from "openai";
import { Buffer } from "node:buffer";
import { spawn } from "child_process";

export const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

/**
 * Convert WebM audio buffer to WAV format using ffmpeg.
 * Browser MediaRecorder outputs WebM/opus which must be converted to WAV for audio APIs.
 * Note: Requires ffmpeg (available by default on Replit).
 *
 * @example
 * // In your route handler:
 * const webmBuffer = Buffer.from(req.body.audio, "base64");
 * const wavBuffer = await convertWebmToWav(webmBuffer);
 * const transcript = await speechToText(wavBuffer, "wav");
 */
export function convertWebmToWav(webmBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",      // Read from stdin
      "-f", "wav",         // Output format
      "-ar", "16000",      // Sample rate (16kHz is good for speech)
      "-ac", "1",          // Mono audio
      "-acodec", "pcm_s16le", // PCM 16-bit encoding
      "pipe:1"             // Write to stdout
    ]);

    const chunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", () => {}); // Suppress ffmpeg logs
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
    ffmpeg.on("error", reject);

    ffmpeg.stdin.write(webmBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Voice Chat: User speaks, LLM responds with audio (audio-in, audio-out).
 * Uses gpt-audio-mini model via Replit AI Integrations.
 *
 * @example
 * // Converting browser WebM to WAV before calling:
 * const webmBuffer = Buffer.from(req.body.audio, "base64");
 * const wavBuffer = await convertWebmToWav(webmBuffer);
 * const result = await voiceChat(wavBuffer, "alloy", "wav", "mp3");
 */
export async function voiceChat(
  audioBuffer: Buffer,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  inputFormat: "wav" | "mp3" = "wav",
  outputFormat: "wav" | "mp3" = "mp3"
): Promise<{ transcript: string; audioResponse: Buffer }> {
  const audioBase64 = audioBuffer.toString("base64");
  const response = await openai.chat.completions.create({
    model: "gpt-audio-mini",
    modalities: ["text", "audio"],
    audio: { voice, format: outputFormat },
    messages: [{
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: audioBase64, format: inputFormat } },
      ],
    }],
  });
  const message = response.choices[0]?.message as any;
  const transcript = message?.audio?.transcript || message?.content || "";
  const audioData = message?.audio?.data ?? "";
  return {
    transcript,
    audioResponse: Buffer.from(audioData, "base64"),
  };
}

/**
 * Streaming Voice Chat: For real-time audio responses.
 * Note: Streaming only supports pcm16 output format.
 *
 * @example
 * // Converting browser WebM to WAV before calling:
 * const webmBuffer = Buffer.from(req.body.audio, "base64");
 * const wavBuffer = await convertWebmToWav(webmBuffer);
 * for await (const chunk of voiceChatStream(wavBuffer)) { ... }
 */
export async function voiceChatStream(
  audioBuffer: Buffer,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  inputFormat: "wav" | "mp3" = "wav"
): Promise<AsyncIterable<{ type: "transcript" | "audio"; data: string }>> {
  const audioBase64 = audioBuffer.toString("base64");
  const stream = await openai.chat.completions.create({
    model: "gpt-audio-mini",
    modalities: ["text", "audio"],
    audio: { voice, format: "pcm16" },
    messages: [{
      role: "user",
      content: [
        { type: "input_audio", input_audio: { data: audioBase64, format: inputFormat } },
      ],
    }],
    stream: true,
  });

  return (async function* () {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta as any;
      if (!delta) continue;
      if (delta?.audio?.transcript) {
        yield { type: "transcript", data: delta.audio.transcript };
      }
      if (delta?.audio?.data) {
        yield { type: "audio", data: delta.audio.data };
      }
    }
  })();
}

/**
 * Text-to-Speech: Converts text to speech verbatim.
 * Uses gpt-audio-mini model via Replit AI Integrations.
 */
export async function textToSpeech(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy",
  format: "wav" | "mp3" | "flac" | "opus" | "pcm16" = "wav"
): Promise<Buffer> {
  const response = await openai.chat.completions.create({
    model: "gpt-audio-mini",
    modalities: ["text", "audio"],
    audio: { voice, format },
    messages: [
      { role: "system", content: "You are an assistant that performs text-to-speech." },
      { role: "user", content: `Repeat the following text verbatim: ${text}` },
    ],
  });
  const audioData = (response.choices[0]?.message as any)?.audio?.data ?? "";
  return Buffer.from(audioData, "base64");
}

/**
 * Streaming Text-to-Speech: Converts text to speech with real-time streaming.
 * Uses gpt-audio-mini model via Replit AI Integrations.
 * Note: Streaming only supports pcm16 output format.
 */
export async function textToSpeechStream(
  text: string,
  voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" = "alloy"
): Promise<AsyncIterable<string>> {
  const stream = await openai.chat.completions.create({
    model: "gpt-audio-mini",
    modalities: ["text", "audio"],
    audio: { voice, format: "pcm16" },
    messages: [
      { role: "system", content: "You are an assistant that performs text-to-speech." },
      { role: "user", content: `Repeat the following text verbatim: ${text}` },
    ],
    stream: true,
  });

  return (async function* () {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta as any;
      if (!delta) continue;
      if (delta?.audio?.data) {
        yield delta.audio.data;
      }
    }
  })();
}

/**
 * Speech-to-Text: Transcribes audio using dedicated transcription model.
 * Uses gpt-4o-mini-transcribe for accurate transcription.
 */
export async function speechToText(
  audioBuffer: Buffer,
  format: "wav" | "mp3" | "webm" = "wav"
): Promise<string> {
  const file = await toFile(audioBuffer, `audio.${format}`);
  const response = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
  });
  return response.text;
}

/**
 * Streaming Speech-to-Text: Transcribes audio with real-time streaming.
 * Uses gpt-4o-mini-transcribe for accurate transcription.
 */
export async function speechToTextStream(
  audioBuffer: Buffer,
  format: "wav" | "mp3" | "webm" = "wav"
): Promise<AsyncIterable<string>> {
  const file = await toFile(audioBuffer, `audio.${format}`);
  const stream = await openai.audio.transcriptions.create({
    file,
    model: "gpt-4o-mini-transcribe",
    stream: true,
  });

  return (async function* () {
    for await (const event of stream) {
      if (event.type === "transcript.text.delta") {
        yield event.delta;
      }
    }
  })();
}

// ============================================================
// Sentence Parser - Multilingual using Intl.Segmenter
// ============================================================

/**
 * Extracts complete sentences from streaming text using Intl.Segmenter.
 * Supports multilingual text (handles CJK, Arabic, etc. properly).
 */
export class SentenceParser {
  private buffer = "";
  private seq = 0;
  private segmenter: Intl.Segmenter;

  constructor(locale = "en") {
    // Intl.Segmenter handles sentence boundaries for all Unicode languages
    // Falls back gracefully if locale not supported
    this.segmenter = new Intl.Segmenter(locale, { granularity: "sentence" });
  }

  /**
   * Feed tokens from LLM stream.
   * Returns complete sentences with sequence numbers.
   */
  feed(token: string): Array<{ seq: number; text: string }> {
    this.buffer += token;
    const sentences: Array<{ seq: number; text: string }> = [];

    // Segment current buffer
    const segments = [...this.segmenter.segment(this.buffer)];

    // All segments except the last are complete sentences
    // (last segment might be incomplete, still accumulating tokens)
    for (let i = 0; i < segments.length - 1; i++) {
      const text = segments[i].segment.trim();
      if (text) {
        sentences.push({ seq: this.seq++, text });
      }
    }

    // Keep only the last (potentially incomplete) segment in buffer
    if (segments.length > 0) {
      this.buffer = segments[segments.length - 1].segment;
    }

    return sentences;
  }

  /** Flush any remaining text as final sentence */
  flush(): { seq: number; text: string } | null {
    const text = this.buffer.trim();
    this.buffer = "";
    return text ? { seq: this.seq++, text } : null;
  }

  reset() {
    this.buffer = "";
    this.seq = 0;
  }
}

// ============================================================
// Cascading Voice Chat - STT → Text Model → TTS Pipeline
// ============================================================

export interface VoiceChatStreamEvent {
  type: "user_transcript" | "sentence" | "audio" | "transcript" | "done" | "error";
  seq?: number;
  data?: string;
  text?: string;
  error?: string;
}

/** Internal type for tracking active TTS streams */
interface TTSStream {
  seq: number;
  iterator: AsyncIterator<string>;
  done: boolean;
}

/**
 * Voice chat using separate text model and TTS.
 *
 * Key behaviors:
 * - TTS starts immediately when a sentence completes (doesn't wait for previous TTS)
 * - Audio yields in sequence order (always yields seq 0 chunks before seq 1)
 * - Multiple TTS streams can run concurrently
 * - Low latency: streams chunks as they arrive from the current sentence's TTS
 */
export async function* voiceChatWithTextModel(
  audioBuffer: Buffer,
  options: {
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
    inputFormat?: "wav" | "mp3";
    systemPrompt?: string;
    chatHistory?: Array<{ role: "user" | "assistant"; content: string }>;
    textModel?: string;
    locale?: string; // For sentence segmentation (e.g., "en", "ja", "zh")
  } = {}
): AsyncGenerator<VoiceChatStreamEvent> {
  const {
    voice = "alloy",
    inputFormat = "wav",
    systemPrompt = "You are a helpful assistant.",
    chatHistory = [],
    textModel = "gpt-5", // the newest OpenAI model is "gpt-5" which was released August 7, 2025
    locale = "en",
  } = options;

  // 1. Transcribe user audio
  const userText = await speechToText(audioBuffer, inputFormat);
  yield { type: "user_transcript", data: userText };

  // 2. Build messages for text model
  const messages = [
    { role: "system" as const, content: systemPrompt },
    ...chatHistory,
    { role: "user" as const, content: userText },
  ];

  // 3. Stream text from LLM
  const textStream = await openai.chat.completions.create({
    model: textModel,
    messages,
    stream: true,
  });

  // 4. Parse sentences and dispatch TTS in parallel
  const parser = new SentenceParser(locale);
  const activeStreams: TTSStream[] = [];
  let nextSeqToYield = 0;
  let fullTranscript = "";

  /**
   * Start TTS for a sentence. Runs concurrently with other TTS streams.
   */
  const startTTS = async (sentence: { seq: number; text: string }) => {
    const stream = await textToSpeechStream(sentence.text, voice);
    activeStreams.push({
      seq: sentence.seq,
      iterator: stream[Symbol.asyncIterator](),
      done: false,
    });
  };

  /**
   * Yield audio chunks from active TTS streams in sequence order.
   * - Always yields from the current sequence (nextSeqToYield) first
   * - Buffers are not needed here because we yield directly from iterators
   * - When current sequence's TTS is done, moves to next
   */
  async function* drainAudioInOrder(): AsyncGenerator<VoiceChatStreamEvent> {
    while (activeStreams.length > 0) {
      // Find the stream for the current sequence we should yield
      const currentStream = activeStreams.find((s) => s.seq === nextSeqToYield);

      if (!currentStream) {
        // Next sequence hasn't started TTS yet, yield control back
        return;
      }

      if (currentStream.done) {
        // Current stream exhausted, move to next sequence
        activeStreams.splice(activeStreams.indexOf(currentStream), 1);
        nextSeqToYield++;
        continue;
      }

      // Pull next chunk from current stream
      const { value, done } = await currentStream.iterator.next();

      if (done) {
        currentStream.done = true;
        activeStreams.splice(activeStreams.indexOf(currentStream), 1);
        nextSeqToYield++;
      } else {
        yield { type: "audio", seq: currentStream.seq, data: value };
      }
    }
  }

  // 5. Process text stream: parse sentences, dispatch TTS, yield audio
  for await (const chunk of textStream) {
    const token = chunk.choices[0]?.delta?.content || "";
    if (!token) continue;

    fullTranscript += token;

    // Extract complete sentences
    const sentences = parser.feed(token);
    for (const sentence of sentences) {
      yield { type: "sentence", seq: sentence.seq, text: sentence.text };
      await startTTS(sentence);
    }

    // Yield any ready audio (non-blocking: only yields if current seq has data)
    for await (const event of drainAudioInOrder()) {
      yield event;
    }
  }

  // 6. Flush remaining sentence
  const finalSentence = parser.flush();
  if (finalSentence) {
    yield { type: "sentence", seq: finalSentence.seq, text: finalSentence.text };
    await startTTS(finalSentence);
  }

  // 7. Drain all remaining TTS audio (blocking: wait for all to complete)
  while (activeStreams.length > 0) {
    for await (const event of drainAudioInOrder()) {
      yield event;
    }
    // Small yield to prevent tight loop if waiting for TTS
    if (activeStreams.length > 0 && !activeStreams.find((s) => s.seq === nextSeqToYield)) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  yield { type: "transcript", data: fullTranscript };
  yield { type: "done" };
}
