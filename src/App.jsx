import React, { useState, useRef } from "react";

export default function MozartChat() {
  const [mode, setMode] = useState("voice"); // "voice" | "text"
  const [messages, setMessages] = useState([]);
  const [partial, setPartial] = useState("");
  const [prompt, setPrompt] = useState("");

  const wsRef = useRef(null);
  const mediaRef = useRef({ stream: null, processor: null, audioContext: null });

  // 🔐 Identificador estable por pestaña/llamada para barge-in en el backend
  const clientIdRef = useRef(
    (window.crypto?.randomUUID && window.crypto.randomUUID()) ||
      `client-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  // 🎧 Un solo reproductor para evitar superposición de audios
  const audioRef = useRef(null);

  const API = "http://localhost:4000";

  // 🛑 Corta audio local y avisa al backend (barge-in)
  const stopSpeak = async () => {
    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const a = audioRef.current;
      // corta de inmediato en el cliente
      try { a.pause(); } catch {}
      try { a.src = ""; } catch {}
      // avisa al backend que aborte el stream actual
      fetch(`${API}/speak/stop?clientId=${clientIdRef.current}`, { method: "POST" }).catch(() => {});
    } catch {}
  };

  // 🔊 TTS con barge-in: corta lo anterior y reproduce lo nuevo
  const speak = async (text) => {
    if (!text || !text.trim()) return;

    // corta cualquier reproducción actual y aborta en backend
    stopSpeak();

    try {
      if (!audioRef.current) audioRef.current = new Audio();
      const res = await fetch(`${API}/speak?clientId=${clientIdRef.current}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        console.error("❌ Error al generar voz:", await res.text());
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = audioRef.current;

      // libera el URL anterior si existía
      try {
        if (a.src && a.src.startsWith("blob:")) URL.revokeObjectURL(a.src);
      } catch {}

      a.src = url;
      a.onended = () => {
        try { URL.revokeObjectURL(url); } catch {}
      };

      await a.play();
    } catch (err) {
      console.error("❌ Error TTS en frontend:", err);
    }
  };

  // === INICIO GRABACIÓN VOZ ===
  const startRecording = async () => {
    if (wsRef.current) return;

    // Si hay voz sonando, la cortamos (barge-in al empezar a hablar)
    stopSpeak();

    const ws = new WebSocket("ws://localhost:4000");
    wsRef.current = ws;

    ws.onopen = () => console.log("✅ Conectado al servidor");

    ws.onmessage = async (event) => {
      const data = JSON.parse(event.data);

      if (data.transcript) {
        if (data.isPartial) {
          setPartial(data.transcript);
          // (Opcional) si quieres barge-in inmediato al detectar voz del usuario:
          // stopSpeak();
        } else {
          setMessages((prev) => [...prev, { role: "user", text: data.transcript }]);
          setPartial("");
        }
      }

      if (data.bedrockReply) {
        setMessages((prev) => [...prev, { role: "assistant", text: data.bedrockReply }]);
        // Barge-in: corta audio previo y habla la nueva respuesta
        await speak(data.bedrockReply);
      }
    };

    ws.onclose = () => {
      console.log("❌ WebSocket cerrado");
      wsRef.current = null;
    };

    // Captura de audio en PCM 16-bit 44.1kHz
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      const inputData = e.inputBuffer.getChannelData(0);
      const buffer = new ArrayBuffer(inputData.length * 2);
      const view = new DataView(buffer);

      for (let i = 0; i < inputData.length; i++) {
        let s = Math.max(-1, Math.min(1, inputData[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer);
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    mediaRef.current = { stream, processor, audioContext };
  };

  // === DETENER GRABACIÓN VOZ ===
  const stopRecording = () => {
    if (mediaRef.current.stream) {
      mediaRef.current.stream.getTracks().forEach((t) => t.stop());
    }
    if (mediaRef.current.processor) mediaRef.current.processor.disconnect();
    if (mediaRef.current.audioContext) mediaRef.current.audioContext.close();

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setPartial("");
  };

  // === MODO TEXTO ===
  const sendPrompt = async () => {
    if (!prompt.trim()) return;

    const userMsg = { role: "user", text: prompt };
    setMessages((prev) => [...prev, userMsg]);
    const userInput = prompt;
    setPrompt("");

    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: userInput }),
      });

      const data = await res.json();
      const reply = data.reply || "❌ Lo siento, no hubo respuesta del servidor.";

      setMessages((prev) => [...prev, { role: "assistant", text: reply }]);

      if (reply && !reply.startsWith("❌")) {
        await speak(reply); // barge-in integrado
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "❌ Error al conectar con el servidor" },
      ]);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100">
      {/* Tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setMode("voice")}
          className={`flex-1 py-2 ${mode === "voice" ? "bg-blue-600 text-white" : "bg-white text-black"}`}
        >
          🎤 Voz
        </button>
        <button
          onClick={() => setMode("text")}
          className={`flex-1 py-2 ${mode === "text" ? "bg-blue-600 text-white" : "bg-white text-black"}`}
        >
          ⌨️ Texto
        </button>
      </div>

      {/* Chat */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-white">
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`px-4 py-2 rounded-2xl max-w-xs ${
                msg.role === "user"
                  ? "bg-blue-500 text-white rounded-br-none"
                  : "bg-green-500 text-white rounded-bl-none"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {partial && (
          <div className="flex justify-end">
            <div className="px-4 py-2 rounded-2xl max-w-xs bg-gray-300 text-gray-800 italic">
              {partial}
            </div>
          </div>
        )}
      </div>

      {/* Controles */}
      <div className="p-3 border-t bg-gray-50">
        {mode === "voice" ? (
          <div className="flex gap-2">
            <button
              onClick={startRecording}
              className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              🎤 Comenzar
            </button>
            <button
              onClick={stopRecording}
              className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
            >
              🛑 Detener
            </button>
            <button
              onClick={stopSpeak}
              className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-800"
              title="Corta cualquier audio en curso"
            >
              🔇 Silenciar voz
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="flex-1 border rounded-lg px-3 py-2 text-black"
              placeholder="Escribe tu mensaje..."
            />
            <button
              onClick={sendPrompt}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              ➤
            </button>
            <button
              onClick={stopSpeak}
              className="px-4 py-2 bg-gray-700 text-white rounded-lg hover:bg-gray-800"
              title="Corta cualquier audio en curso"
            >
              🔇
            </button>
          </div>
        )}
      </div>
    </div>
  );
}



