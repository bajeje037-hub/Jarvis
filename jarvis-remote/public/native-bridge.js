// Ponte con l'app Android (WebView). Nel browser normale non fa nulla.
// Il WebView di Android non ha la dettatura del browser (Web Speech API): qui la sostituiamo con
// il riconoscimento vocale di sistema, esposto dall'app come window.JarvisNative.
(function () {
  const N = window.JarvisNative;
  if (!N) return;
  document.documentElement.classList.add('native-app');

  let seq = 0;
  let active = null; // { id, inst }

  window.__jarvisSpeech = {
    onResult(id, text, isFinal) { if (active && active.id === id) active.inst._result(text, isFinal); },
    onError(id, code) { if (active && active.id === id) active.inst._error(code); },
    onEnd(id) { if (active && active.id === id) { const inst = active.inst; active = null; inst._end(); } },
  };

  if (N.speechAvailable()) {
    class NativeRecognition {
      constructor() {
        this.lang = 'it-IT';
        this.interimResults = false;
        this.continuous = false;
        this.onresult = null; this.onerror = null; this.onend = null;
      }
      start() {
        if (active) throw new Error('già avviato');
        seq += 1;
        active = { id: seq, inst: this };
        N.startListening(seq, this.lang, !!this.interimResults);
      }
      stop() { if (active && active.inst === this) N.stopListening(active.id); }
      abort() {
        if (active && active.inst === this) { const id = active.id; active = null; N.cancelListening(id); }
      }
      _result(text, isFinal) {
        if (!this.onresult) return;
        const alt = { transcript: text, confidence: 0.9 };
        const res = [alt];
        res.isFinal = !!isFinal;
        this.onresult({ resultIndex: 0, results: [res] });
      }
      _error(code) { if (this.onerror) this.onerror({ error: code }); }
      _end() { if (this.onend) this.onend(); }
    }
    window.SpeechRecognition = NativeRecognition;
    window.webkitSpeechRecognition = NativeRecognition;
  }

  // Impostazioni: «Cambia server» solo nell'app Android.
  const logout = document.getElementById('logout');
  if (logout && logout.parentNode) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = 'Cambia server';
    b.addEventListener('click', () => N.changeServer());
    logout.parentNode.insertBefore(b, logout);
  }
})();
