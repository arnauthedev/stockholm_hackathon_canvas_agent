/**
 * Realtime fallback (gpt-realtime-2.1) — implement only if GPT-Live is unavailable on the account (B9).
 * Shape when needed (same VoiceSession interface):
 * - POST /v1/realtime/client_secrets {session:{type:"realtime", model, audio:{output:{voice}}, tools, instructions}} → ephemeral `value`
 * - phone: POST SDP to https://api.openai.com/v1/realtime/calls (Content-Type: application/sdp, Bearer ephemeral); Location → call_id
 * - runner sideband: wss://api.openai.com/v1/realtime?call_id=… ; tools via response.function_call_arguments.done →
 *   conversation.item.create {type:"function_call_output"} + response.create ; inject via conversation.item.create message;
 *   interrupt via response.cancel + output_audio_buffer.clear.
 */
export {};
