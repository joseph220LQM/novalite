import React, { useEffect, useRef, useState } from "react";

export default function FloatingAgendaWidget({
  apiBase,
  title = "AGENDA TU CITA",
  subtitleReady = "Ready to assist",
  greeting = "¡Hola! Aquí podrás agendar tus citas en Cemdi para Famisanar. ¿En qué puedo ayudarte?",
  position = "bottom-right", // futuro: bottom-left, etc.
  zIndex = 50,
}) {
  // ---------------- State ----------------
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", text: greeting },
  ]);
  const [partial, setPartial] = useState("");
  const [prompt, setPrompt] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  // ---------------- Backend base ----------------
  const API_BASE = apiBase ?? (import.meta.env?.VITE_API_BASE ?? "http://localhost:4000");
  const WS_URL = API_BASE.replace(/^http/i, "ws");

  // ---------------- Refs ----------------
  const wsRef = useRef(null);
  const mediaRef = useRef({ stream: null, processor: null, audioContext: null });
  const audioRef = useRef(null);
  const clientIdRef = useRef(
    (crypto?.randomUUID && crypto.randomUUID()) ||
      `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  // ---------------- Helpers: Barge-in ----------------
  const stopSpeak = async () => {
    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const a = audioRef.current;
      if (a._mozartAbort) {
        try { a._mozartAbort.abort(); } catch {}
        a._mozartAbort = null;
      }
      try { a.pause(); } catch {}
      try {
        if (a.src && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
        a.src = "";
      } catch {}
      fetch(`${API_BASE}/speak/stop?clientId=${clientIdRef.current}`, { method: "POST" }).catch(() => {});
    } catch {}
  };

  const speak = async (text) => {
    if (!text?.trim()) return;
    await stopSpeak();
    if (!audioRef.current) audioRef.current = new Audio();
    const a = audioRef.current;

    // Usa MediaSource si está disponible, si no, fallback a blob
    if (window.MediaSource && MediaSource.isTypeSupported?.("audio/mpeg")) {
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      a.src = objectUrl;

      const ctrl = new AbortController();
      a._mozartAbort = ctrl;

      mediaSource.addEventListener("sourceopen", async () => {
        const sb = mediaSource.addSourceBuffer("audio/mpeg");
        sb.mode = "sequence";
        try {
          const res = await fetch(`${API_BASE}/speak?clientId=${clientIdRef.current}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text }),
            signal: ctrl.signal,
          });
          if (!res.ok || !res.body) {
            try { mediaSource.endOfStream(); } catch {}
            return;
          }
          const reader = res.body.getReader();
          let queue = [];
          let appending = false;
          const pump = () => {
            if (appending || queue.length === 0) return;
            appending = true;
            const chunk = queue.shift();
            const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteLength + chunk.byteOffset);
            sb.appendBuffer(buf);
            sb.onupdateend = () => { appending = false; pump(); };
          };
          (async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) { try { mediaSource.endOfStream(); } catch {} break; }
              queue.push(value);
              pump();
            }
          })();
          a.play().catch(() => {});
        } catch (e) {
          if (ctrl.signal.aborted) return;
          try { mediaSource.endOfStream(); } catch {}
        }
      });
      a.onended = () => { try { URL.revokeObjectURL(objectUrl); } catch {} };
      return;
    }

    // Fallback: descarga completa (menos óptimo, pero compatible)
    try {
      const res = await fetch(`${API_BASE}/speak?clientId=${clientIdRef.current}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try { if (a.src?.startsWith("blob:")) URL.revokeObjectURL(a.src); } catch {}
      a.src = url;
      a.onended = () => { try { URL.revokeObjectURL(url); } catch {} };
      await a.play();
    } catch {}
  };

  // ---------------- STT por WebSocket ----------------
  const startRecording = async () => {
    if (wsRef.current) return;
    await stopSpeak();

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsRecording(true);
      // baja latencia en TCP
      try { ws._socket?.setNoDelay?.(true); } catch {}
    };

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);
      if (data.transcript !== undefined) {
        if (data.isPartial) {
          setPartial(data.transcript);
          if (data.transcript && data.transcript.length > 2) await stopSpeak();
        } else {
          if (data.transcript.trim()) setMessages((p) => [...p, { role: "user", text: data.transcript }]);
          setPartial("");
        }
      }
      if (data.bedrockReply) {
        setMessages((p) => [...p, { role: "assistant", text: data.bedrockReply }]);
        await speak(data.bedrockReply);
      }
    };

    ws.onclose = () => { setIsRecording(false); wsRef.current = null; };

    // captura audio
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioContext = new AudioCtx({ sampleRate: 44100 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(1024, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const buffer = new ArrayBuffer(inputData.length * 2);
      const view = new DataView(buffer);
      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);
    mediaRef.current = { stream, processor, audioContext };
  };

  const stopRecording = () => {
    setIsRecording(false);
    if (mediaRef.current.stream) mediaRef.current.stream.getTracks().forEach((t) => t.stop());
    if (mediaRef.current.processor) mediaRef.current.processor.disconnect();
    if (mediaRef.current.audioContext) mediaRef.current.audioContext.close();
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    setPartial("");
  };

  const toggleMic = () => (isRecording ? stopRecording() : startRecording());

  // ---------------- Texto -> Agente ----------------
  const sendPrompt = async () => {
    if (!prompt.trim()) return;
    const userText = prompt; setPrompt("");
    setMessages((p) => [...p, { role: "user", text: userText }]);
    await stopSpeak();
    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userText }),
      });
      const data = await res.json();
      const reply = data.reply || "❌ Lo siento, no hubo respuesta del servidor.";
      setMessages((p) => [...p, { role: "assistant", text: reply }]);
      if (!reply.startsWith("❌")) await speak(reply);
    } catch (e) {
      setMessages((p) => [...p, { role: "assistant", text: "❌ Error al conectar con el servidor" }]);
    }
  };

  const resetChat = () => { setMessages([{ role: "assistant", text: greeting }]); setPartial(""); };

  // ---------------- Cleanup al desmontar o cerrar widget ----------------
  useEffect(() => {
    return () => { stopRecording(); stopSpeak(); };
  }, []);

  useEffect(() => {
    if (!open) { stopRecording(); stopSpeak(); }
  }, [open]);

  // ---------------- UI Helpers ----------------
  const posClass = position === "bottom-left"
    ? `left-6 bottom-6`
    : position === "top-right"
      ? `right-6 top-6`
      : position === "top-left"
        ? `left-6 top-6`
        : `right-6 bottom-6`; // bottom-right

  return (
    <div className={`fixed ${posClass} z-[${zIndex}]`}>
      {/* Launcher button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="group h-14 w-14 rounded-full shadow-2xl bg-gradient-to-br from-cyan-600 to-blue-600 text-white grid place-items-center hover:from-cyan-500 hover:to-blue-500 focus:outline-none"
          title="Abrir asistente"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M21 12a9 9 0 1 1-3.94-7.44L21 5l-1.44 3.94A8.96 8.96 0 0 1 21 12Z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="8" cy="12" r="1.5" fill="white"/>
            <circle cx="12" cy="12" r="1.5" fill="white"/>
            <circle cx="16" cy="12" r="1.5" fill="white"/>
          </svg>
        </button>
      )}

      {/* Widget panel */}
      {open && (
        <div className="w-[380px] max-w-[92vw] rounded-2xl shadow-2xl border border-gray-200 bg-white overflow-hidden animate-in fade-in zoom-in-95 duration-150">
          {/* Header */}
          <div className="relative bg-gradient-to-r from-cyan-600 to-blue-600 text-white px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-5 w-5 relative">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping bg-white/50"></span>
                <span className="relative inline-flex rounded-full h-5 w-5 bg-white/90"></span>
              </span>
              <div className="leading-tight">
                <div className="font-semibold text-sm tracking-wide">{title}</div>
                <div className="text-xs text-white/90">{isRecording ? "Escuchando…" : subtitleReady}</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={resetChat}
                className="p-2 rounded-lg hover:bg-white/15 transition"
                title="Reiniciar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M20 7v6h-6" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M20 13a8 8 0 1 1-2.34-5.66L20 7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-2 rounded-lg hover:bg-white/15 transition"
                title="Cerrar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M6 6l12 12M18 6L6 18" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="h-[420px] bg-white overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[78%] px-4 py-2 rounded-2xl shadow-sm ${m.role === "user" ? "bg-blue-600 text-white rounded-br-none" : "bg-gray-100 text-gray-800 rounded-bl-none"}`}>
                  {m.text}
                </div>
              </div>
            ))}
            {partial && (
              <div className="flex justify-end">
                <div className="max-w-[78%] px-4 py-2 rounded-2xl bg-gray-200 text-gray-800 italic">{partial}</div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="border-t bg-gray-50 p-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendPrompt(); }}
                placeholder="Escribe tu consulta para agendar"
                className="flex-1 px-3 py-2 rounded-xl border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={sendPrompt}
                className="inline-flex items-center justify-center h-10 w-10 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition"
                title="Enviar"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M22 2L11 13" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M22 2L15 22l-4-9-9-4L22 2z" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                onClick={toggleMic}
                className={`inline-flex items-center justify-center h-10 w-10 rounded-xl text-white transition ${isRecording ? "bg-red-600 hover:bg-red-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
                title={isRecording ? "Detener" : "Hablar"}
              >
                {isRecording ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                    <path d="M12 14a4 4 0 0 0 4-4V7a4 4 0 0 0-8 0v3a4 4 0 0 0 4 4z"></path>
                    <path d="M19 11a7 7 0 0 1-14 0"></path>
                    <path d="M12 18v4"></path>
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}







