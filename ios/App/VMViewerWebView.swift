import SwiftUI
import WebKit

/// Live noVNC viewer for a proxied Local VM desktop URL.
struct VMViewerWebView: UIViewRepresentable {
    let url: URL
    var keyboardTrigger: Int
    var onLoadFailed: ((String) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoadFailed: onLoadFailed)
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
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onLoadFailed = onLoadFailed
        if webView.url?.absoluteString != url.absoluteString {
            webView.load(URLRequest(url: url))
        }
        if context.coordinator.lastKeyboardTrigger != keyboardTrigger {
            context.coordinator.lastKeyboardTrigger = keyboardTrigger
            context.coordinator.showKeyboard()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var lastKeyboardTrigger = 0
        var onLoadFailed: ((String) -> Void)?

        init(onLoadFailed: ((String) -> Void)?) {
            self.onLoadFailed = onLoadFailed
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.body && document.body.innerText") { value, _ in
                guard let text = value as? String else { return }
                if text.contains("pair this device from Phone settings") {
                    self.onLoadFailed?("This phone is no longer paired with the computer.")
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onLoadFailed?(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onLoadFailed?(error.localizedDescription)
        }

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
