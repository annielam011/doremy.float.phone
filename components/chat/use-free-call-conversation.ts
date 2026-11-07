"use client";

/** 可选自由对话：持续监听，静音 3 秒后转写；用户开口时尝试打断当前语音播放。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveCloudSttConfig, transcribeAudioBlob } from "@/lib/stt-cloud";

const SILENCE_MS = 3000;
const MIN_SPEECH_MS = 350;
const MAX_TURN_MS = 20000;
const THRESHOLD = 0.035;

type Options = {
  characterId?: string;
  enabled: boolean;
  speaking: boolean;
  onTranscript: (text: string) => void;
  onInterrupt: () => void;
  onError?: (message: string) => void;
};

export function useFreeCallConversation({ characterId, enabled, speaking, onTranscript, onInterrupt, onError }: Options) {
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const callbacks = useRef({ onTranscript, onInterrupt, onError });
  callbacks.current = { onTranscript, onInterrupt, onError };
  const active = useRef(false);

  const stop = useCallback(() => {
    active.current = false;
    setListening(false);
    setBusy(false);
  }, []);

  useEffect(() => {
    if (!enabled) { stop(); return; }
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let frame = 0;
    let silenceTimer = 0;
    let turnTimer = 0;
    let speechAt = 0;
    let voiced = false;
    let interrupted = false;
    let stopping = false;
    let cancelled = false;

    const fail = (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      callbacks.current.onError?.(message);
      active.current = false;
      setListening(false);
    };
    const disposeRecorder = () => {
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); } catch { /* already stopped */ }
      }
      recorder = null;
      chunks = [];
      voiced = false;
      speechAt = 0;
      window.clearTimeout(silenceTimer);
      window.clearTimeout(turnTimer);
    };
    const beginSegment = () => {
      if (!stream || !active.current || recorder) return;
      chunks = [];
      try {
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type));
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream);
        recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          const current = recorder;
          recorder = null;
          window.clearTimeout(silenceTimer);
          window.clearTimeout(turnTimer);
          if (cancelled || !active.current) { chunks = []; return; }
          const duration = speechAt ? Date.now() - speechAt : 0;
          const blob = new Blob(chunks, { type: current?.mimeType || "audio/webm" });
          chunks = [];
          if (!voiced || duration < MIN_SPEECH_MS || blob.size < 1500) return;
          setBusy(true);
          try {
            const config = resolveCloudSttConfig(characterId);
            if (!config) throw new Error("自由对话需要配置 OpenAI 兼容语音识别（STT）");
            const text = (await transcribeAudioBlob(blob, config)).trim();
            if (text && active.current) callbacks.current.onTranscript(text);
          } catch (error) { fail(error); }
          finally { setBusy(false); voiced = false; speechAt = 0; }
        };
        recorder.start(200);
        turnTimer = window.setTimeout(() => {
          if (recorder && recorder.state !== "inactive") recorder.stop();
        }, MAX_TURN_MS);
      } catch (error) { fail(error); }
    };

    const sample = () => {
      if (!active.current || !analyser) return;
      const values = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(values);
      let sum = 0;
      for (const value of values) { const n = (value - 128) / 128; sum += n * n; }
      const rms = Math.sqrt(sum / values.length);
      const now = Date.now();
      // 开始录制时开启 AEC/NS；通话语音期间也监听，用户发声即停掉当前播放。
      if (rms > THRESHOLD) {
        if (!voiced) {
          voiced = true;
          speechAt = now;
          beginSegment();
          if (speaking && !interrupted) { interrupted = true; callbacks.current.onInterrupt(); }
        }
        window.clearTimeout(silenceTimer);
        silenceTimer = window.setTimeout(() => {
          if (recorder && recorder.state !== "inactive") recorder.stop();
        }, SILENCE_MS);
      }
      if (!speaking) interrupted = false;
      frame = window.requestAnimationFrame(sample);
    };

    active.current = true;
    setError("");
    setListening(true);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("当前环境不支持自由对话录音");
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!active.current) { stream.getTracks().forEach(track => track.stop()); return; }
        context = new AudioContext();
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        sample();
      } catch (error) { fail(error); }
    })();

    return () => {
      cancelled = true;
      active.current = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(silenceTimer);
      window.clearTimeout(turnTimer);
      if (recorder && recorder.state !== "inactive") { recorder.onstop = null; try { recorder.stop(); } catch {} }
      stream?.getTracks().forEach(track => track.stop());
      source?.disconnect();
      void context?.close().catch(() => {});
    };
  }, [enabled, characterId, speaking, stop]);

  return { listening, busy, error, stop };
}
