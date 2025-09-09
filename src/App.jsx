import React, { useState, useRef } from "react";

export default function MozartChat() {
  const [mode, setMode] = useState("voice"); // "voice" | "text"
  const [messages, setMessages] = useState([]);
  const [partial, setPartial] = useState("");
  const [prompt, setPrompt] = useState(""); // para modo texto
  const wsRef = useRef(null);
  const mediaRef = useRef({ stream: null, processor: null, audioContext: null });

  // === INICIO GRABACIÓN VOZ ===
  const startRecording = async () => {
    if (wsRef.current) return;

    const ws = new WebSocket("ws://localhost:4000");
    wsRef.current = ws;

    ws.onopen = () => console.log("✅ Conectado al servidor");

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.transcript) {
        if (data.isPartial) {
          setPartial(data.transcript);
        } else {
          setMessages((prev) => [...prev, { role: "user", text: data.transcript }]);
          setPartial("");
        }
      }

      if (data.bedrockReply) {
        setMessages((prev) => [...prev, { role: "assistant", text: data.bedrockReply }]);
      }
    };

    ws.onclose = () => {
      console.log("❌ WebSocket cerrado");
      wsRef.current = null;
    };

    // Captura de audio en PCM
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext({ sampleRate: 44100 });
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
    setPrompt("");

    try {
      const res = await fetch("http://localhost:4000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const data = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", text: data.reply }]);
    } catch (err) {
      console.error(err);
      setMessages((prev) => [...prev, { role: "assistant", text: "❌ Error al conectar con el servidor" }]);
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
          <div className="flex space-x-2">
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
          </div>
        ) : (
          <div className="flex space-x-2">
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
          </div>
        )}
      </div>
    </div>
  );
}
