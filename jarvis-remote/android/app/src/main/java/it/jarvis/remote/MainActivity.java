package it.jarvis.remote;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Jarvis per Android: una finestra a schermo intero sulla web app di Jarvis Remote
 * (il server gira sul PC) con la dettatura del riconoscimento vocale di sistema.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "jarvis";
    private static final String KEY_SERVER = "server";
    private static final int REQ_MIC = 1;
    private static final int BG = 0xFFEDF1F6;
    private static final int INK = 0xFF132033;
    private static final int ACCENT = 0xFF2F5BFF;

    private WebView web;
    private ScrollView setup;
    private EditText urlInput;
    private TextView errorText;

    private String activeBase;      // origine del server in uso (es. https://pc.tail1234.ts.net)
    private boolean pageFailed;

    // riconoscimento vocale
    private SpeechRecognizer recognizer;
    private int speechId = 0;
    private boolean speechOpen = false;
    private boolean hasPending = false;
    private int pendingId;
    private String pendingLang;
    private boolean pendingInterim;

    // ───────────────────────── ciclo di vita ─────────────────────────

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(BG);
        int flags = 0;
        if (Build.VERSION.SDK_INT >= 23) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= 26) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            getWindow().setNavigationBarColor(BG);
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = buildWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setup = buildSetup();
        root.addView(setup, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        String saved = prefs().getString(KEY_SERVER, null);
        if (saved != null && !saved.isEmpty()) {
            openServer(saved, saved);
        } else {
            showSetup(null, "");
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (speechOpen) finishSpeech(speechId);
        destroySpeech();
        CookieManager.getInstance().flush();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        destroySpeech();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web.getVisibility() == View.VISIBLE && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ───────────────────────── schermate ─────────────────────────

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView buildWebView() {
        WebView w = new WebView(this);
        w.setBackgroundColor(BG);
        WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " JarvisAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);
        w.addJavascriptInterface(new Bridge(), "JarvisNative");
        w.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (activeBase != null && activeBase.equals(origin(u.toString()))) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u)); // i link esterni si aprono nel browser
                } catch (Exception ignored) {
                    // nessuna app può aprirlo
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                pageFailed = false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                pageFailed = true;
                showSetup("Non riesco a raggiungere il server (" + error.getDescription()
                        + "). Controlla che Jarvis sia acceso sul PC e che il link sia giusto.", activeBase);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                // Il server è raggiungibile: lo ricordiamo (solo l'indirizzo, il codice resta nel cookie).
                if (!pageFailed && activeBase != null && activeBase.equals(origin(url))) {
                    prefs().edit().putString(KEY_SERVER, activeBase).apply();
                }
            }
        });
        return w;
    }

    private ScrollView buildSetup() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_VERTICAL);
        col.setPadding(dp(24), dp(24), dp(24), dp(24));

        TextView title = new TextView(this);
        title.setText("Jarvis");
        title.setTextSize(30);
        title.setTextColor(INK);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        col.addView(title);

        TextView hint = new TextView(this);
        hint.setText("Incolla il link di accesso che Jarvis mostra sul computer (quello con ?t=…). "
                + "Sul PC lo trovi anche in Impostazioni › «Collega il telefono».");
        hint.setTextSize(15);
        hint.setTextColor(INK);
        hint.setPadding(0, dp(8), 0, dp(20));
        col.addView(hint);

        urlInput = new EditText(this);
        urlInput.setHint("https://nome-pc.tailnet.ts.net/?t=…");
        urlInput.setHintTextColor(0xFF7A8794);
        urlInput.setTextColor(INK);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_GO);
        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            connect();
            return true;
        });
        col.addView(urlInput);

        errorText = new TextView(this);
        errorText.setTextColor(0xFFC62828);
        errorText.setTextSize(14);
        errorText.setPadding(0, dp(12), 0, 0);
        errorText.setVisibility(View.GONE);
        col.addView(errorText);

        Button go = new Button(this);
        go.setText("Connetti");
        go.setTextColor(0xFFFFFFFF);
        go.setBackgroundColor(ACCENT);
        go.setOnClickListener(v -> connect());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(20);
        col.addView(go, lp);

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setBackgroundColor(BG);
        sv.addView(col, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return sv;
    }

    private void showSetup(String error, String prefill) {
        web.setVisibility(View.GONE);
        setup.setVisibility(View.VISIBLE);
        if (prefill != null) urlInput.setText(prefill);
        errorText.setText(error == null ? "" : error);
        errorText.setVisibility(error == null || error.isEmpty() ? View.GONE : View.VISIBLE);
    }

    private void openServer(String base, String url) {
        activeBase = base;
        pageFailed = false;
        setup.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(url);
    }

    private void connect() {
        String full = normalize(urlInput.getText().toString());
        if (full == null) {
            showSetup("Incolla il link di accesso.", null);
            return;
        }
        Uri u = Uri.parse(full);
        if (u.getHost() == null || u.getHost().isEmpty()) {
            showSetup("Il link non sembra valido.", null);
            return;
        }
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlInput.getWindowToken(), 0);
        openServer(origin(full), full);
    }

    /** Aggiunge https:// (o http:// per gli indirizzi di casa) se manca. */
    private static String normalize(String raw) {
        String t = raw == null ? "" : raw.trim();
        if (t.isEmpty()) return null;
        if (!t.toLowerCase().startsWith("http://") && !t.toLowerCase().startsWith("https://")) {
            String host = t.split("[/?#]")[0];
            boolean local = host.matches("(?i)(localhost|127\\.\\d+\\.\\d+\\.\\d+|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+)(:\\d+)?");
            t = (local ? "http://" : "https://") + t;
        }
        return t;
    }

    private static String origin(String url) {
        try {
            Uri u = Uri.parse(url);
            if (u.getScheme() == null || u.getAuthority() == null) return "";
            return u.getScheme().toLowerCase() + "://" + u.getAuthority().toLowerCase();
        } catch (Exception e) {
            return "";
        }
    }

    // ───────────────────────── ponte con la web app ─────────────────────────

    private class Bridge {
        @JavascriptInterface
        public boolean speechAvailable() {
            return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        @JavascriptInterface
        public void startListening(final int id, final String lang, final boolean interim) {
            runOnUiThread(() -> startSpeech(id, lang, interim));
        }

        @JavascriptInterface
        public void stopListening(final int id) {
            runOnUiThread(() -> {
                if (recognizer != null && speechOpen && id == speechId) recognizer.stopListening();
            });
        }

        @JavascriptInterface
        public void cancelListening(final int id) {
            runOnUiThread(() -> {
                if (hasPending && pendingId == id) hasPending = false; // annullata mentre si attendeva il permesso
                if (id == speechId) {
                    speechOpen = false;
                    destroySpeech();
                }
            });
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showSetup(null, activeBase));
        }
    }

    // ───────────────────────── riconoscimento vocale ─────────────────────────

    private void startSpeech(final int id, String lang, boolean interim) {
        destroySpeech();
        speechId = id;
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            hasPending = true;
            pendingId = id;
            pendingLang = lang;
            pendingInterim = interim;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
            return;
        }
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
        } catch (Exception e) {
            callJs("onError(" + id + ",\"service-not-allowed\")");
            callJs("onEnd(" + id + ")");
            return;
        }
        speechOpen = true;
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int eventType, Bundle params) { }

            @Override
            public void onPartialResults(Bundle partialResults) {
                String text = first(partialResults);
                if (text != null && speechOpen && id == speechId) {
                    callJs("onResult(" + id + "," + JSONObject.quote(text) + ",false)");
                }
            }

            @Override
            public void onResults(Bundle results) {
                String text = first(results);
                if (text != null && speechOpen && id == speechId) {
                    callJs("onResult(" + id + "," + JSONObject.quote(text) + ",true)");
                }
                finishSpeech(id);
            }

            @Override
            public void onError(int error) {
                if (!speechOpen || id != speechId) return;
                callJs("onError(" + id + ",\"" + errorCode(error) + "\")");
                finishSpeech(id);
            }
        });
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang == null || lang.isEmpty() ? "it-IT" : lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, interim);
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        recognizer.startListening(i);
    }

    private static String first(Bundle b) {
        if (b == null) return null;
        ArrayList<String> list = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (list == null || list.isEmpty()) return null;
        return list.get(0);
    }

    private static String errorCode(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
                return "network";
            case SpeechRecognizer.ERROR_CLIENT:
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                return "aborted";
            default:
                return "audio-capture";
        }
    }

    /** Dice alla pagina che la sessione di ascolto è finita (una sola volta) e libera il riconoscitore. */
    private void finishSpeech(final int id) {
        if (!speechOpen || id != speechId) return;
        speechOpen = false;
        callJs("onEnd(" + id + ")");
        web.post(() -> {
            if (!speechOpen) destroySpeech();
        });
    }

    private void destroySpeech() {
        if (recognizer != null) {
            try {
                recognizer.cancel();
                recognizer.destroy();
            } catch (Exception ignored) {
                // già chiuso
            }
            recognizer = null;
        }
    }

    private void callJs(String call) {
        if (web != null) web.evaluateJavascript("window.__jarvisSpeech&&window.__jarvisSpeech." + call, null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MIC || !hasPending) return;
        hasPending = false;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startSpeech(pendingId, pendingLang, pendingInterim);
        } else {
            callJs("onError(" + pendingId + ",\"not-allowed\")");
            callJs("onEnd(" + pendingId + ")");
        }
    }
}
