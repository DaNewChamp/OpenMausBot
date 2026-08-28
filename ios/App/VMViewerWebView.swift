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
            context.coordinator.resetHealthCheck()
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
        private var healthCheckTask: Task<Void, Never>?

        init(onLoadFailed: ((String) -> Void)?) {
            self.onLoadFailed = onLoadFailed
        }

        func resetHealthCheck() {
            healthCheckTask?.cancel()
            healthCheckTask = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(Self.chromeScript, completionHandler: nil)
            webView.evaluateJavaScript("document.body && document.body.innerText") { value, _ in
                guard let text = value as? String else { return }
                if text.contains("pair this device from Phone settings") {
                    self.onLoadFailed?("This phone is no longer paired with the computer.")
                }
            }
            scheduleHealthCheck(on: webView)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            onLoadFailed?(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            onLoadFailed?(error.localizedDescription)
        }

        private func scheduleHealthCheck(on webView: WKWebView) {
            resetHealthCheck()
            healthCheckTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                webView.evaluateJavaScript(Self.healthScript) { value, _ in
                    guard let state = value as? String else { return }
                    if state == "broken" {
                        self.onLoadFailed?("The live Local VM viewer could not load. Showing the desktop preview instead.")
                    }
                }
            }
        }

        func showKeyboard() {
            guard let webView else { return }
            webView.evaluateJavaScript(Self.keyboardScript, completionHandler: nil)
        }

        private static let chromeScript = """
        (function() {
          var style = document.createElement('style');
          style.textContent = '#noVNC_control_bar_anchor,#noVNC_status_bar,.noVNC_center{display:none!important;}'
            + '#noVNC_container,#noVNC_canvas{position:absolute!important;top:0!important;left:0!important;'
            + 'width:100%!important;height:100%!important;}';
          document.head.appendChild(style);
        })();
        """

        private static let healthScript = """
        (function() {
          var canvas = document.getElementById('noVNC_canvas');
          if (canvas && canvas.width > 0 && canvas.height > 0) return 'ok';
          var body = document.body ? document.body.innerText : '';
          if (body.indexOf('pair this device') >= 0) return 'broken';
          var styles = document.styleSheets ? document.styleSheets.length : 0;
          var controls = document.querySelectorAll('.noVNC_button, #noVNC_control_bar_anchor').length;
          if (controls > 0 && styles === 0) return 'broken';
          return 'ok';
        })();
        """

        private static let keyboardScript = """
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
    }
}
