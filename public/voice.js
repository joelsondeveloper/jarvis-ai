const ENABLED_KEY = "jarvis.voice.enabled";
const VOICE_KEY = "jarvis.voice.name";
const RATE_KEY = "jarvis.voice.rate";
const PITCH_KEY = "jarvis.voice.pitch";

export class VoiceService {
  constructor(options = {}) {
    const browser = options.window ?? (typeof window !== "undefined" ? window : undefined);
    this.synthesis = options.synthesis ?? browser?.speechSynthesis ?? null;
    this.Utterance = options.Utterance ?? browser?.SpeechSynthesisUtterance ?? null;
    try { this.storage = options.storage ?? browser?.localStorage ?? null; } catch { this.storage = null; }
    this.enabled = this.read(ENABLED_KEY) === "true";
    this.voiceName = this.read(VOICE_KEY) || "";
    const rate = Number(this.read(RATE_KEY));
    const pitch = Number(this.read(PITCH_KEY));
    this.rate = Number.isFinite(rate) ? this.clamp(rate, 0.5, 2) : 1;
    this.pitch = Number.isFinite(pitch) ? this.clamp(pitch, 0, 2) : 1;
    this.voices = [];
    this.listeners = new Set();
    this.refreshVoices();
    if (this.synthesis?.addEventListener) this.synthesis.addEventListener("voiceschanged", () => this.refreshVoices());
    else if (this.synthesis) this.synthesis.onvoiceschanged = () => this.refreshVoices();
  }

  listVoices() { return [...this.voices]; }

  onVoicesChanged(listener) {
    this.listeners.add(listener);
    listener(this.listVoices());
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.write(ENABLED_KEY, String(this.enabled));
    if (!this.enabled) this.stop();
  }

  setVoice(name) {
    this.voiceName = typeof name === "string" ? name : "";
    this.write(VOICE_KEY, this.voiceName);
  }

  setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value)) return;
    this.rate = this.clamp(value, 0.5, 2);
    this.write(RATE_KEY, String(this.rate));
  }

  setPitch(pitch) {
    const value = Number(pitch);
    if (!Number.isFinite(value)) return;
    this.pitch = this.clamp(value, 0, 2);
    this.write(PITCH_KEY, String(this.pitch));
  }

  speak(text) {
    if (!this.enabled || !this.synthesis || !this.Utterance || typeof text !== "string" || !text.trim()) return false;
    this.stop();
    const utterance = new this.Utterance(text.trim());
    const voice = this.chooseVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    this.synthesis.speak(utterance);
    return true;
  }

  stop() {
    this.synthesis?.cancel?.();
  }

  refreshVoices() {
    const voices = this.synthesis?.getVoices?.();
    this.voices = Array.isArray(voices) ? [...voices] : [];
    for (const listener of this.listeners) listener(this.listVoices());
    return this.listVoices();
  }

  chooseVoice() {
    if (this.voiceName) {
      const selected = this.voices.find(voice => voice.name === this.voiceName);
      if (selected) return selected;
    }
    const portugueseBrazil = this.voices.find(voice => String(voice.lang).toLowerCase() === "pt-br");
    return portugueseBrazil ?? this.voices.find(voice => String(voice.lang).toLowerCase().startsWith("pt")) ?? this.voices[0] ?? null;
  }

  read(key) {
    try { return this.storage?.getItem?.(key) ?? ""; } catch { return ""; }
  }

  write(key, value) {
    try { this.storage?.setItem?.(key, value); } catch { /* Storage can be disabled by the browser. */ }
  }

  clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
}
