/**
 * React hook for handling SSE voice streaming responses.
 * Supports both simple streaming and sequenced audio (text model pipeline).
 */
import { useCallback } from "react";
import { useAudioPlayback } from "./useAudioPlayback";

interface StreamCallbacks {
  onUserTranscript?: (text: string) => void;
  onSentence?: (seq: number, text: string) => void;
  onTranscript?: (text: string, full: string) => void;
  onComplete?: (transcript: string) => void;
  onError?: (error: Error) => void;
}

export function useVoiceStream(callbacks: StreamCallbacks = {}) {
  const playback = useAudioPlayback();

  const streamVoiceResponse = useCallback(
    async (url: string, audioBlob: Blob) => {
      await playback.init();
      playback.clear();

      const reader = new FileReader();
      const base64Audio = await new Promise<string>((resolve) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1]); // Remove data URL prefix
        };
        reader.readAsDataURL(audioBlob);
      });

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64Audio }),
      });

      if (!response.ok) throw new Error("Voice request failed");

      const streamReader = response.body?.getReader();
      if (!streamReader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let fullTranscript = "";

      while (true) {
        const { done, value } = await streamReader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          try {
            const event = JSON.parse(line.slice(6));

            switch (event.type) {
              case "user_transcript":
                callbacks.onUserTranscript?.(event.data);
                break;

              case "sentence":
                callbacks.onSentence?.(event.seq, event.text);
                break;

              case "transcript":
                // Legacy: simple transcript delta (no seq)
                if (event.seq === undefined && event.data) {
                  fullTranscript += event.data;
                  callbacks.onTranscript?.(event.data, fullTranscript);
                } else if (event.data) {
                  // New: full transcript at end
                  fullTranscript = event.data;
                }
                break;

              case "audio":
                if (event.seq !== undefined) {
                  // Sequenced audio (text model pipeline)
                  playback.pushSequencedAudio(event.seq, event.data);
                } else {
                  // Simple audio (legacy gpt-audio-mini)
                  playback.pushAudio(event.data);
                }
                break;

              case "done":
                playback.signalComplete();
                callbacks.onComplete?.(fullTranscript);
                break;

              case "error":
                throw new Error(event.error);
            }
          } catch (e) {
            if (!(e instanceof SyntaxError)) {
              callbacks.onError?.(e as Error);
            }
          }
        }
      }
    },
    [playback, callbacks]
  );

  return { streamVoiceResponse, playbackState: playback.state };
}
