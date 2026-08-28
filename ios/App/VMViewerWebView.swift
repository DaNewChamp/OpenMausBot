import SwiftUI
import WebKit

/// Live noVNC viewer for a proxied Local VM desktop URL.
struct VMViewerWebView: UIViewRepresentable {
    let url: URL
    var keyboardTrigger: Int

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url))
        }
        if context.coordinator.lastKeyboardTrigger != keyboardTrigger {
            context.coordinator.lastKeyboardTrigger = keyboardTrigger
            context.coordinator.showKeyboard()
        }
    }

    final class Coordinator {
        weak var webView: WKWebView?
        var lastKeyboardTrigger = 0

        func showKeyboard() {
            guard let webView else { return }
            let script = """
            (function() {
              var button = document.getElementById('noVNC_keyboard_button')
                || document.querySelector('[id*="keyboard"]');
              if (button) { button.click(); return true; }
              var input = document.getElementById('noVNC_keyboardinput')
                || document.getElementById('keyboardinput');
              if (input) { input.focus(); return true; }
              return false;
            })();
            """
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }
}
