import React, { useEffect, useRef, useState } from "react";
import "./widget.css"; // estilos locales (Tailwind v4 sin preflight)

// App.jsx — FloatingAgendaWidget (Chat/Voz) con fixes de foco, autoscroll, ocultar texto en voz,
// barge‑in rápido y cursores tipo “manito”
export default function FloatingAgendaWidget({
  apiBase = import.meta?.env?.VITE_API_BASE ?? "http://localhost:4000",
  mode = "both", // "chat" | "voice" | "both"
  // etiquetas
  chatTitle = "AGENDA TU CITA POR CHAT",
  chatSubtitle = "Chat activo",
  voiceTitle = "AGENDA TU CITA POR VOZ",
  voiceSubtitle = "Pulsa el micrófono para iniciar",
  greeting = "¡Hola! Aquí podrás agendar tus citas en Cemdi para Famisanar. ¿Con quién estoy hablando?",
  // layout
  position = "bottom-right",
  zIndex = 50,
}) {
  // --- layout / abrir-cerrar
  const [open, setOpen] = useState(false);
  const pos =
    position === "bottom-left"
      ? "left-4 bottom-4"
      : position === "top-right"
      ? "right-4 top-4"
      : position === "top-left"
      ? "left-4 top-4"
      : "right-4 bottom-4";

  // --- modo activo
  const [activeTab, setActiveTab] = useState(mode === "voice" ? "voice" : "chat");

  // ---------------- CHAT ----------------
  const [messages, setMessages] = useState([{ role: "assistant", text: greeting }]);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  const chatBodyRef = useRef(null);

  const resetChat = () => {
    setMessages([{ role: "assistant", text: greeting }]);
    setPrompt("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const sendPrompt = async () => {
    if (!prompt.trim() || loading) return;
    const userText = prompt.trim();
    setMessages((p) => [...p, { role: "user", text: userText }]);
    setPrompt("");
    try {
      setLoading(true);
      const res = await fetch(`${apiBase}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userText }),
      });
      const data = await res.json();
      setMessages((p) => [
        ...p,
        { role: "assistant", text: data?.reply || "Lo siento, no hubo respuesta." },
      ]);
    } catch {
      setMessages((p) => [
        ...p,
        { role: "assistant", text: "❌ Error conectando con el servidor" },
      ]);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  };

  // foco estable al abrir/cambiar a Chat
  useEffect(() => {
    if (open && activeTab === "chat") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, activeTab]);

  // Auto-scroll al último mensaje
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---------------- VOZ ----------------
  const wsRef = useRef(null);
  const mediaRef = useRef({ stream: null, workletNode: null, audioContext: null });
  const [listening, setListening] = useState(false);

  const audioRef = useRef(null);
  const clientIdRef = useRef(
    (window.crypto?.randomUUID && window.crypto.randomUUID()) ||
      `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  const WS_URL = (apiBase || "").replace(/^http/i, "ws");

  const stopSpeak = async () => {
    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const a = audioRef.current;
      try { a.pause(); } catch {}
      try { a.src = ""; } catch {}
      fetch(`${apiBase}/speak/stop?clientId=${clientIdRef.current}`, { method: "POST" }).catch(
        () => {}
      );
    } catch {}
  };

  const speak = async (text) => {
    if (!text || !text.trim()) return;
    stopSpeak();
    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const res = await fetch(`${apiBase}/speak?clientId=${clientIdRef.current}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = audioRef.current;
      try {
        if (a.src && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
      } catch {}
      a.src = url;
      a.onended = () => {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      };
      await a.play();
    } catch {}
  };

  const startRecording = async () => {
    if (wsRef.current) return;
    stopSpeak();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen = () => setListening(true);
    ws.onclose = () => {
      setListening(false);
      wsRef.current = null;
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      // BARGE-IN ULTRA RÁPIDO: corta TTS apenas llega un parcial
      if (data.transcript && data.isPartial) {
        stopSpeak();
      }
      // Reproducir respuesta sin mostrar texto
      if (data.bedrockReply) {
        await speak(data.bedrockReply);
      }
    };

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AC = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AC({ sampleRate: 44100 });

    // AudioWorklet (latencia baja) con fallback ScriptProcessor
    try {
      await audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
      const source = audioContext.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      workletNode.port.onmessage = (e) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(e.data);
      };
      source.connect(workletNode);
      mediaRef.current = { stream, workletNode, audioContext };
    } catch {
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(2048, 1, 1); // < 4096 para menos latencia
      processor.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const ab = new ArrayBuffer(input.length * 2);
        const view = new DataView(ab);
        for (let i = 0; i < input.length; i++) {
          let s = Math.max(-1, Math.min(1, input[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(ab);
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      mediaRef.current = { stream, workletNode: processor, audioContext };
    }
  };

  const stopRecording = () => {
    if (mediaRef.current?.stream) mediaRef.current.stream.getTracks().forEach((t) => t.stop());
    if (mediaRef.current?.workletNode) {
      try {
        mediaRef.current.workletNode.disconnect();
      } catch {}
    }
    if (mediaRef.current?.audioContext) {
      try {
        mediaRef.current.audioContext.close();
      } catch {}
    }
    mediaRef.current = { stream: null, workletNode: null, audioContext: null };
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    setListening(false);
  };

  // cambio de modo: corta llamada/tts y enfoca input
  const switchMode = (next) => {
    if (next === activeTab) return;
    if (activeTab === "voice") {
      stopRecording();
      stopSpeak();
    }
    setActiveTab(next);
    if (next === "chat") requestAnimationFrame(() => inputRef.current?.focus());
  };

  // ----------- UI helpers -----------
  const FloatingToggle = () => (
    <div className="flex items-center gap-2 mt-2">
      <div className="relative w-20 h-9 bg-slate-300 rounded-full shadow-inner">
        <button
          className={`cursor-pointer absolute top-1 left-1 w-7 h-7 rounded-full shadow transition-all ${activeTab === "chat" ? "translate-x-0 bg-white" : "translate-x-11 bg-white"}`}
          onClick={() => switchMode(activeTab === "chat" ? "voice" : "chat")}
          aria-label="Cambiar Chat/Voz"
        />
      </div>
      <span className="text-xs text-slate-600">{activeTab === "chat" ? "Chat" : "Voz"}</span>
    </div>
  );

  const FloatingButton = ({ label }) => (
    <div className="flex flex-col items-end cursor-pointer">
      <button
        onClick={() => setOpen(true)}
        className="cursor-pointer flex items-center gap-3 bg-white/90 backdrop-blur shadow-xl rounded-full pl-3 pr-4 py-2 border border-slate-200 hover:shadow-2xl"
      >
        <span className="w-5 h-5 shrink-0 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
        <span className="text-sm font-semibold text-slate-900">{label}</span>
      </button>
      <FloatingToggle />
    </div>
  );

  const Header = ({ title, subtitle, rightExtra }) => (
    <div className="cursor-default px-4 py-3 border-b border-slate-200 flex items-center gap-3 bg-white">
      <span className="w-5 h-5 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
      <div className="flex-1">
        <div className="text-sm font-semibold text-slate-900 tracking-wide">{title}</div>
        <div className="text-[11px] text-slate-500 -mt-0.5">{subtitle}</div>
      </div>

      {/* pills Chat/Voz en header */}
      <div className="hidden sm:flex items-center bg-slate-100 rounded-full p-1">
        <button
          onClick={() => switchMode("chat")}
          className={`cursor-pointer text-xs px-3 py-1 rounded-full ${
            activeTab === "chat" ? "bg-slate-900 text-white" : "text-slate-700"
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => switchMode("voice")}
          className={`cursor-pointer text-xs px-3 py-1 rounded-full ${
            activeTab === "voice" ? "bg-slate-900 text-white" : "text-slate-700"
          }`}
        >
          Voz
        </button>
      </div>

      {/* espacio para extras (p.ej. Reiniciar) */}
      {rightExtra}

      <button
        onClick={() => setOpen(false)}
        className="cursor-pointer text-slate-500 hover:text-slate-800 text-lg"
      >
        ✕
      </button>
    </div>
  );

  const ChatView = () => (
    <>
      <Header
        title={chatTitle}
        subtitle={chatSubtitle}
        rightExtra={
          <button
            onClick={resetChat}
            className="cursor-pointer text-xs px-2 py-1 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 mr-2"
            title="Reiniciar chat"
          >
            ↻ Reiniciar
          </button>
        }
      />
      <div ref={chatBodyRef} className="flex-1 p-3 overflow-y-auto bg-slate-50/50">
        {messages.map((m, i) => (
          <div key={i} className={`mb-2 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`$${""}
                ${m.role === "user"
                  ? "bg-sky-600 text-white rounded-br-sm"
                  : "bg-slate-200 text-slate-900 rounded-bl-sm"
                } px-3 py-2 rounded-2xl max-w-[75%] whitespace-pre-wrap`}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>
      <div className="p-3 border-t border-slate-200 bg-white flex gap-2">
        <textarea
          ref={inputRef}
          autoFocus
          dir="ltr"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={(e) => {
            // barge-in por teclado: corta TTS si estaba sonando
            try { stopSpeak(); } catch {}
            const len = e.target.value.length;
            try { e.target.setSelectionRange(len, len); } catch {}
          }}
          onKeyDown={onKey}
          rows={1}
          placeholder="Escribe tu consulta para agendar citas..."
          className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-slate-900 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
        />
        <button
          onClick={sendPrompt}
          disabled={loading}
          className="cursor-pointer px-4 rounded-xl bg-emerald-500 text-white font-semibold hover:bg-emerald-600 disabled:opacity-50"
          title="Enviar"
        >
          ➤
        </button>
      </div>
    </>
  );

  const VoiceView = () => (
    <>
      <Header title={voiceTitle} subtitle={listening ? "Escuchando…" : voiceSubtitle} />
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-50/50 gap-3 p-4">
        {listening ? (
          <div className="w-28 h-16 rounded-xl bg-emerald-100 relative overflow-hidden flex items-center justify-center">
            <div className="w-2 h-8 bg-emerald-500 mx-1 animate-pulse" />
            <div className="w-2 h-12 bg-emerald-500 mx-1 animate-pulse" />
            <div className="w-2 h-16 bg-emerald-500 mx-1 animate-pulse" />
            <div className="w-2 h-12 bg-emerald-500 mx-1 animate-pulse" />
            <div className="w-2 h-8 bg-emerald-500 mx-1 animate-pulse" />
          </div>
        ) : (
          <div className="w-16 h-16 rounded-full border-2 border-slate-300 flex items-center justify-center text-slate-500">
            🎤
          </div>
        )}

        {/* 🔇 NO mostramos nada de texto en modo voz */}
      </div>

      <div className="p-3 border-t border-slate-200 bg-white flex items-center justify-center gap-3">
        {listening ? (
          <>
            <button
              onClick={stopSpeak}
              className="cursor-pointer px-3 py-2 rounded-full bg-slate-800 text-white text-sm"
              title="Silenciar TTS"
            >
              🔇
            </button>
            <button
              onClick={stopRecording}
              className="cursor-pointer flex-1 max-w-[240px] px-4 py-3 rounded-full bg-rose-500 text-white font-semibold"
            >
              ■ Finalizar Llamada
            </button>
          </>
        ) : (
          <button
            onClick={startRecording}
            className="cursor-pointer flex-1 max-w-[240px] px-4 py-3 rounded-full bg-emerald-600 text-white font-semibold"
          >
            🎙️ Iniciar Llamada
          </button>
        )}
      </div>
    </>
  );

  // ----------- render principal -----------
  const label = activeTab === "voice" ? voiceTitle : chatTitle;

  return (
    <div className={`fixed ${pos}`} style={{ zIndex }}>
      {/* cursores por si tu Tailwind no tiene utilidades cargadas */}
      <style>{`.cursor-pointer{cursor:pointer}.cursor-default{cursor:default}`}</style>

      {!open && <FloatingButton label={label} />}

      {open && (
        <div className="w-[380px] max-w-[94vw] h-[520px] bg-white rounded-2xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden">
          {activeTab === "voice" ? <VoiceView /> : <ChatView />}
        </div>
      )}
    </div>
  );
}













