/**
 * GeminiLiveSession — NOT BUILT (B9 "Later").
 * Notes for implementing behind the same VoiceSession interface:
 * - Transport: Gemini Live API over WebSocket (BidiGenerateContent); browser connects with an
 *   ephemeral token minted by the runner (auth_tokens.create), audio PCM16 16 kHz in / 24 kHz out.
 * - Tools: function declarations with `behavior: "NON_BLOCKING"` so long tool calls don't stall
 *   speech; reply with FunctionResponse `scheduling: "WHEN_IDLE" | "INTERRUPT" | "SILENT"`.
 * - Async injection: send clientContent turns (role user) with turnComplete=false for quiet context.
 * - Route: config/routes.ts `voice` → { provider: "google", model: "<gemini live model>" } once GOOGLE_API_KEY exists.
 */
export {};
