import React, { useState, useEffect, useRef, useCallback } from "react";
import { Layout } from "../components/layout/Layout";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";

let messageLoadSeq = 0;

interface Conversation {
  id: number;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ChatMessage {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [error, setError] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/conversations", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
        // Use functional setState so we never overwrite an activeId set during the fetch.
        if (data.length > 0) {
          setActiveId((current) => (current == null ? data[0].id : current));
        }
      } else if (res.status === 401) {
        setError("Please log in to use chat.");
      }
    } catch {
      setError("Could not load conversations.");
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: number) => {
    const seq = ++messageLoadSeq;
    try {
      const res = await fetch(`/api/conversations/${id}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        // Drop the response if a newer load has been issued in the meantime.
        if (seq !== messageLoadSeq) return;
        setMessages(data.messages || []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (activeId != null) loadMessages(activeId);
  }, [activeId, loadMessages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamBuffer]);

  const newChat = async () => {
    setError("");
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Chat" }),
      });
      if (res.ok) {
        const conv = await res.json();
        setConversations((prev) => [conv, ...prev]);
        setActiveId(conv.id);
        setMessages([]);
      }
    } catch {
      setError("Could not start new chat.");
    }
  };

  const deleteChat = async (id: number) => {
    if (!confirm("Delete this conversation?")) return;
    try {
      await fetch(`/api/conversations/${id}`, { method: "DELETE", credentials: "include" });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    } catch {
      /* ignore */
    }
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    let convId = activeId;
    if (convId == null) {
      // Auto-create a conversation
      try {
        const res = await fetch("/api/conversations", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: text.slice(0, 60) }),
        });
        if (!res.ok) throw new Error("create failed");
        const conv = await res.json();
        setConversations((prev) => [conv, ...prev]);
        setActiveId(conv.id);
        convId = conv.id;
      } catch {
        setError("Could not start chat.");
        return;
      }
    }

    setError("");
    setInput("");
    const optimistic: ChatMessage = {
      id: Date.now(),
      conversationId: convId!,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setStreaming(true);
    setStreamBuffer("");

    try {
      const res = await fetch(`/api/conversations/${convId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok || !res.body) {
        throw new Error("stream failed");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assembled = "";

      const handleLine = (line: string) => {
        if (!line.startsWith("data: ")) return;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.content) {
            assembled += payload.content;
            setStreamBuffer(assembled);
          }
          if (payload.error) {
            setError(payload.error);
          }
        } catch {
          /* ignore parse errors */
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) handleLine(line);
      }
      // Flush any final multi-byte remainder + trailing line that wasn't terminated by \n.
      buffer += decoder.decode();
      if (buffer.length > 0) {
        for (const line of buffer.split("\n")) handleLine(line);
      }
      // Flush completed assistant reply into the message list, then reload to get persisted ids
      if (assembled) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            conversationId: convId!,
            role: "assistant",
            content: assembled,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      setStreamBuffer("");
      // Refresh conversation list (titles/updated time may change server-side later)
      loadConversations();
    } catch {
      setError("Sorry — something went wrong while sending. Please try again.");
    } finally {
      setStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="mb-4">
          <h1 className="text-2xl font-bold text-brand-textPrimary">AI Chat</h1>
          <p className="text-sm text-brand-textMuted">
            Ask ProBid AI anything — estimating tips, scope of work questions, follow-up message drafts.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 h-[calc(100vh-220px)] min-h-[500px]">
          {/* Conversation list */}
          <Card className="flex flex-col p-3 overflow-hidden">
            <Button onClick={newChat} className="mb-3 w-full">+ New Chat</Button>
            <div className="flex-1 overflow-y-auto space-y-1">
              {loadingList ? (
                <div className="text-xs text-brand-textMuted">Loading…</div>
              ) : conversations.length === 0 ? (
                <div className="text-xs text-brand-textMuted">No chats yet.</div>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex items-center justify-between rounded-lg px-2 py-2 cursor-pointer text-sm ${
                      activeId === c.id ? "bg-brand-green/15 text-brand-green" : "hover:bg-brand-card text-brand-textPrimary"
                    }`}
                    onClick={() => setActiveId(c.id)}
                  >
                    <span className="truncate flex-1">{c.title || "Untitled"}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(c.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-xs text-brand-textMuted hover:text-red-400 ml-2"
                      aria-label="Delete chat"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          </Card>

          {/* Message thread */}
          <Card className="flex flex-col overflow-hidden">
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && !streaming && (
                <div className="text-center text-sm text-brand-textMuted mt-12">
                  Start a conversation. Try: <em>"Help me write a follow-up to a homeowner who hasn't replied in a week."</em>
                </div>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-brand-green text-white ml-auto"
                      : "bg-brand-card text-brand-textPrimary mr-auto border border-brand-border"
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {streaming && streamBuffer && (
                <div className="max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap bg-brand-card text-brand-textPrimary mr-auto border border-brand-border">
                  {streamBuffer}
                  <span className="inline-block w-1 h-4 bg-brand-green ml-1 animate-pulse align-middle" />
                </div>
              )}
              {streaming && !streamBuffer && (
                <div className="text-xs text-brand-textMuted">Thinking…</div>
              )}
            </div>

            {error && (
              <div className="px-4 py-2 text-sm text-red-400 bg-red-500/10 border-t border-red-500/20">{error}</div>
            )}

            <div className="border-t border-brand-border p-3">
              <div className="flex gap-2 items-end">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
                  rows={2}
                  className="flex-1 resize-none bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-sm text-brand-textPrimary focus:outline-none focus:ring-1 focus:ring-brand-green"
                />
                <Button onClick={sendMessage} disabled={streaming || !input.trim()}>
                  {streaming ? "…" : "Send"}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
