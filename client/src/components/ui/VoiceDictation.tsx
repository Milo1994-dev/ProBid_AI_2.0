import React, { useState, useRef, useCallback, useEffect } from "react";
import { api } from "../../api/client";

interface VoiceDictationProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
}

export function VoiceDictation({ onTranscript, disabled }: VoiceDictationProps) {
  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 1000) {
          setError("Recording too short. Hold longer to dictate.");
          setRecording(false);
          return;
        }

        setProcessing(true);
        try {
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const result = reader.result as string;
              resolve(result.split(",")[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const res = await api.transcribe(base64, "webm");
          if (res.transcript) {
            onTranscript(res.transcript);
          } else {
            setError("Couldn't understand the audio. Try again.");
          }
        } catch (err: any) {
          setError(err.message || "Transcription failed. Try again.");
        } finally {
          setProcessing(false);
          setRecording(false);
          setElapsed(0);
        }
      };

      recorder.start(250);
      setRecording(true);
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } catch (err: any) {
      if (err.name === "NotAllowedError") {
        setError("Microphone access denied. Please allow microphone in your browser settings.");
      } else {
        setError("Could not access microphone.");
      }
    }
  }, [onTranscript]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const isDisabled = disabled || processing;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {recording ? (
          <button
            type="button"
            onClick={stopRecording}
            className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 transition-colors text-sm font-medium"
          >
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
            </span>
            <span>Recording {formatTime(elapsed)}</span>
            <span className="text-red-400/70 text-xs">(tap to stop)</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            disabled={isDisabled}
            className="group flex items-center gap-2 px-3 py-2 rounded-lg bg-brand-card border border-brand-border text-brand-textMuted hover:text-brand-green hover:border-brand-green/40 hover:bg-brand-green/10 transition-colors text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            title="Dictate job description"
          >
            {processing ? (
              <>
                <span className="w-4 h-4 border-2 border-brand-green border-t-transparent rounded-full animate-spin" />
                <span>Transcribing...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-14 0m14 0a7 7 0 00-14 0m14 0v1a7 7 0 01-14 0v-1m14 0H5m7 8v4m-4 0h8" />
                  <rect x="9" y="2" width="6" height="11" rx="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Dictate</span>
              </>
            )}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
