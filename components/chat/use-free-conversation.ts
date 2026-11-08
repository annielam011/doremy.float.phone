"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { resolveCloudSttConfig, transcribeAudioBlob } from "@/lib/stt-cloud";

const POLL_MS = 120;
const SILENCE_MS = 1600;
const NO_SPEECH_RESTART_MS = 60000;
const USER_RMS_THRESHOLD = 520;
const BARGE_IN_RMS_THRESHOLD = 1100;
const BARGE_IN_GRACE_MS = 300;

type ShellRecorder = {
    startNativeFreeRecord?: () => boolean;
    stopNativeFreeRecord?: () => string;
    cancelNativeFreeRecord?: () => void;
    getNativeFreeRecordRms?: () => number;
};

type Params = {
    enabled: boolean;
    muted: boolean;
    callStateRef: MutableRefObject<string>;
    characterId: string;
    onSpeechStart: (interruptingAssistant: boolean) => void;
    onTranscribeStart: () => void;
    onTranscript: (text: string) => void;
    onError: (message: string) => void;
};

function shellRecorder(): ShellRecorder | null {
    if (typeof window === "undefined") return null;
    return ((window as unknown as { AndroidShell?: ShellRecorder }).AndroidShell) ?? null;
}

function base64Wav(base64: string): Blob | null {
    if (!base64) return null;
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: "audio/wav" });
    } catch {
        return null;
    }
}

/**
 * Android 壳专用的免按键对话循环。
 *
 * 它与按住说话完全分开：关闭 enabled 后立即释放原生录音器，原来的
 * useHoldToTalk 可照常使用。状态轮询只在 IDLE / AI_SPEAKING /
 * USER_SPEAKING 运行；PROCESSING 时不会占用麦克风。
 */
export function useFreeConversation({
    enabled,
    muted,
    callStateRef,
    characterId,
    onSpeechStart,
    onTranscribeStart,
    onTranscript,
    onError,
}: Params) {
    const [supported, setSupported] = useState(false);
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    const timerRef = useRef<ReturnType<typeof window.setInterval> | null>(null);
    const recordingRef = useRef(false);
    const transcribingRef = useRef(false);
    const generationRef = useRef(0);
    const errorNotifiedRef = useRef(false);
    const phaseRef = useRef<"user" | "assistant">("user");
    const startedAtRef = useRef(0);
    const lastVoiceAtRef = useRef(0);
    const heardVoiceRef = useRef(false);

    const callbacksRef = useRef({ onSpeechStart, onTranscribeStart, onTranscript, onError });
    callbacksRef.current = { onSpeechStart, onTranscribeStart, onTranscript, onError };

    const cancelRecording = useCallback(() => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        try { shellRecorder()?.cancelNativeFreeRecord?.(); } catch { /* ignore */ }
        heardVoiceRef.current = false;
        lastVoiceAtRef.current = 0;
    }, []);

    const startRecording = useCallback((phase: "user" | "assistant") => {
        const shell = shellRecorder();
        if (!shell?.startNativeFreeRecord || !shell.getNativeFreeRecordRms || !shell.stopNativeFreeRecord) return false;
        try {
            if (!shell.startNativeFreeRecord()) return false;
        } catch {
            return false;
        }
        recordingRef.current = true;
        phaseRef.current = phase;
        startedAtRef.current = Date.now();
        lastVoiceAtRef.current = 0;
        heardVoiceRef.current = false;
        return true;
    }, []);

    const stop = useCallback(() => {
        generationRef.current += 1;
        transcribingRef.current = false;
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        cancelRecording();
    }, [cancelRecording]);

    useEffect(() => {
        const shell = shellRecorder();
        setSupported(!!(
            shell?.startNativeFreeRecord
            && shell?.stopNativeFreeRecord
            && shell?.cancelNativeFreeRecord
            && shell?.getNativeFreeRecordRms
        ));
    }, []);

    useEffect(() => {
        stop();
        if (!enabled || muted || !supported) return;
        // 新一轮监听从新的世代开始，避免上一次已取消的转写回调串回来。
        generationRef.current += 1;

        const tick = () => {
            const shell = shellRecorder();
            if (!shell) return;
            const state = callStateRef.current;
            const eligible = state === "IDLE" || state === "AI_SPEAKING" || state === "USER_SPEAKING";
            if (!eligible || transcribingRef.current) {
                cancelRecording();
                return;
            }

            const desiredPhase = state === "AI_SPEAKING" ? "assistant" : "user";
            // 角色说完且用户没有插话时切新录音；打断触发后录音 phase 已切成 user。
            if (recordingRef.current && phaseRef.current !== desiredPhase && !heardVoiceRef.current) {
                cancelRecording();
            }
            if (!recordingRef.current && !startRecording(desiredPhase)) {
                if (!errorNotifiedRef.current) {
                    errorNotifiedRef.current = true;
                    callbacksRef.current.onError("无法开启自由对话麦克风，请检查录音权限或重新安装新版 App 壳。");
                }
                return;
            }
            errorNotifiedRef.current = false;

            const now = Date.now();
            let rms = 0;
            try { rms = Number(shell.getNativeFreeRecordRms?.()) || 0; } catch { return; }
            const threshold = phaseRef.current === "assistant" ? BARGE_IN_RMS_THRESHOLD : USER_RMS_THRESHOLD;
            const inGrace = phaseRef.current === "assistant" && now - startedAtRef.current < BARGE_IN_GRACE_MS;
            const voiced = !inGrace && rms >= threshold;

            if (voiced) {
                // 角色播报期的录音只用于判断“用户开口”，绝不送去转写：一旦触发，
                // 先停角色、丢掉含扬声器回声的缓冲，再立刻开一段纯用户录音。
                if (phaseRef.current === "assistant" && !heardVoiceRef.current) {
                    callbacksRef.current.onSpeechStart(true);
                    cancelRecording();
                    if (!startRecording("user")) {
                        callbacksRef.current.onError("打断后无法重新开启麦克风。");
                        return;
                    }
                    heardVoiceRef.current = true;
                    lastVoiceAtRef.current = now;
                    return;
                }
                lastVoiceAtRef.current = now;
                if (!heardVoiceRef.current) {
                    heardVoiceRef.current = true;
                    callbacksRef.current.onSpeechStart(false);
                }
                return;
            }

            if (heardVoiceRef.current && lastVoiceAtRef.current && now - lastVoiceAtRef.current >= SILENCE_MS) {
                recordingRef.current = false;
                let base64 = "";
                try { base64 = shell.stopNativeFreeRecord?.() || ""; } catch { /* handled below */ }
                heardVoiceRef.current = false;
                lastVoiceAtRef.current = 0;
                const blob = base64Wav(base64);
                const config = resolveCloudSttConfig(characterId);
                if (!blob || !config) {
                    callbacksRef.current.onError(!config ? "未找到可用的云端语音识别配置。" : "没有录到可识别的声音。");
                    return;
                }
                transcribingRef.current = true;
                const generation = ++generationRef.current;
                callbacksRef.current.onTranscribeStart();
                void transcribeAudioBlob(blob, config)
                    .then(text => {
                        if (generation !== generationRef.current || !enabledRef.current) return;
                        transcribingRef.current = false;
                        if (text.trim()) {
                            callbacksRef.current.onTranscript(text.trim());
                        } else {
                            callbacksRef.current.onError("没有识别到说话内容。");
                        }
                    })
                    .catch(error => {
                        if (generation === generationRef.current && enabledRef.current) {
                            transcribingRef.current = false;
                            callbacksRef.current.onError(error instanceof Error ? error.message : String(error));
                        }
                    })
                    .finally(() => {
                        if (generation === generationRef.current) transcribingRef.current = false;
                    });
                return;
            }

            // 长时间完全没人说话时轮换录音，避免 WAV 无限增长；不关闭自由模式。
            if (!heardVoiceRef.current && now - startedAtRef.current >= NO_SPEECH_RESTART_MS) {
                cancelRecording();
            }
        };

        tick();
        timerRef.current = window.setInterval(tick, POLL_MS);
        return stop;
    }, [enabled, muted, supported, characterId, callStateRef, cancelRecording, startRecording, stop]);

    return { supported, stop };
}
