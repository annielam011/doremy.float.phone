"use client";

// 通话层：由 desktop-shell 常驻渲染，不再挂在聊天室内部。
//
// 原实现把通话界面 portal 进聊天室的父容器，于是通话只活在聊天室里——
// 返回会话列表就被隐藏，回手机桌面直接随聊天 App 一起卸载。
// 移到这里之后，切会话、回桌面、开别的 App 都不影响：通话全程由本组件持有，
// 缩成悬浮窗时也留在手机界面上。
//
// 会话与角色按 id 现取：避免全局状态里再存一份会话对象，改名或换头像后
// 悬浮窗显示旧值。

import { useSyncExternalStore } from "react";

import { loadCharacters } from "@/lib/character-storage";
import { loadChatSessions } from "@/lib/chat-storage";
import {
    endCall,
    getActiveCall,
    getActiveCallServerSnapshot,
    minimizeCall,
    restoreCall,
    subscribeActiveCall,
} from "@/lib/call-session-store";
import { GroupCallScreen } from "./group-call-screen";
import { VoiceCallScreen } from "./voice-call-screen";
import { VideoCallScreen } from "./video-call-screen";

/**
 * 全局通话层。没有通话时渲染 null，对桌面零影响。
 *
 * 本步只负责「渲染」：来电触发（ai-call-trigger）暂仍由聊天室处理，
 * 让这一步的行为与改动前完全一致，便于单独验证本层挂载不会出问题。
 */
export function CallLayer() {
    const call = useSyncExternalStore(
        subscribeActiveCall,
        getActiveCall,
        getActiveCallServerSnapshot,
    );

    if (!call) return null;

    // 会话被删除时通话无从继续，直接收起。
    const session = loadChatSessions().find(item => item.id === call.sessionId);
    if (!session) return null;

    // 群聊通话没有单一角色，按会话里当前成员渲染（被踢出/退群的成员实时少一个）。
    if (session.isGroup) {
        const participants = session.participantIds || [];
        const allCharacters = loadCharacters();
        const members = participants
            .map(id => allCharacters.find(item => item.id === id))
            .filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (members.length === 0) return null;
        const groupProps = {
            key: call.callId,
            type: call.kind,
            session,
            characters: members,
            initiator: call.initiator,
            initiatorName: call.initiatorName,
            minimized: call.minimized,
            onMinimize: minimizeCall,
            onRestore: restoreCall,
            onEnd: endCall,
        };
        // 全屏与小窗必须保持同一棵 React 结构。之前缩小时直接返回 GroupCallScreen、
        // 恢复时又在外面套 div，父节点类型变化会让 React 卸载并重建整个群通话组件：
        // 初始化 effect 再跑一次，于是缩小一次重拨一次、点浮窗恢复又重拨一次。
        // 小窗本体会 portal 到 body；缩小时只把稳定外壳收成 0 尺寸，避免挡住桌面。
        return (
            <div
                className={call.minimized ? "fixed left-0 top-0 h-0 w-0 pointer-events-none" : "absolute inset-0 z-[100]"}
            >
                <GroupCallScreen {...groupProps} />
            </div>
        );
    }

    // 单聊：角色找不到就没法渲染通话界面，收起。
    const character = loadCharacters().find(item => item.id === call.characterId);
    if (!character) return null;

    const sharedProps = {
        key: call.callId,
        session,
        character,
        initiator: call.initiator,
        minimized: call.minimized,
        onMinimize: minimizeCall,
        onRestore: restoreCall,
        onEnd: endCall,
    };

    return call.kind === "voice"
        ? <VoiceCallScreen {...sharedProps} />
        : <VideoCallScreen {...sharedProps} />;
}
