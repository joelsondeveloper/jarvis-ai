import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceService } from "../public/voice.js";

function fakeBrowser(voices = []) {
  const listeners = new Map();
  const spoken = [];
  const synthesis = {
    cancelCount: 0,
    getVoices: () => voices,
    speak: utterance => spoken.push(utterance),
    cancel: () => { synthesis.cancelCount++; },
    addEventListener: (name, listener) => listeners.set(name, listener),
    triggerVoicesChanged: () => listeners.get("voiceschanged")?.(),
  };
  class Utterance { constructor(text) { this.text = text; } }
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), get: key => values.get(key) };
  return { synthesis, Utterance, storage, spoken };
}

test("voz desligada por padrão não chama speechSynthesis", () => {
  const browser = fakeBrowser();
  const voice = new VoiceService(browser);
  assert.equal(voice.enabled, false);
  assert.equal(voice.speak("JARVIS online."), false);
  assert.equal(browser.spoken.length, 0);
});

test("voz fala somente o buffer final e persiste a preferência", () => {
  const browser = fakeBrowser();
  const voice = new VoiceService(browser);
  voice.setEnabled(true);
  assert.equal(voice.speak("Olá Joelson."), true);
  assert.equal(browser.spoken[0].text, "Olá Joelson.");
  assert.equal(browser.storage.get("jarvis.voice.enabled"), "true");
});

test("pt-BR é preferido, voiceschanged atualiza e nova fala cancela a anterior", () => {
  const browser = fakeBrowser([]);
  const voice = new VoiceService(browser);
  voice.setEnabled(true);
  browser.synthesis.getVoices = () => [{ name: "English", lang: "en-US" }, { name: "Brasil", lang: "pt-BR" }];
  browser.synthesis.triggerVoicesChanged();
  voice.speak("Primeira resposta.");
  voice.speak("Segunda resposta.");
  assert.equal(browser.synthesis.cancelCount, 2); // each new speech cancels the previous one first
  assert.equal(browser.spoken.at(-1).text, "Segunda resposta.");
  assert.equal(browser.spoken.at(-1).voice.name, "Brasil");
});

test("stop cancela a fala atual e voz pt genérica é fallback seguro", () => {
  const browser = fakeBrowser([{ name: "Português", lang: "pt-PT" }]);
  const voice = new VoiceService(browser);
  voice.setEnabled(true);
  voice.speak("Resposta.");
  voice.stop();
  assert.equal(browser.synthesis.cancelCount, 2);
  assert.equal(browser.spoken[0].voice.name, "Português");
});
