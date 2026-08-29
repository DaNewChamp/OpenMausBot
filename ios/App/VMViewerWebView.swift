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
        let target = Self.stableURLString(url)
        let current = webView.url.map(Self.stableURLString)
        // WKWebView.url drops the hash noVNC reads for autoconnect. Comparing
        // absoluteString therefore reloads on every SwiftUI pass and the viewer
        // never stays connected.
        if current != target, context.coordinator.loadedURL != target {
            context.coordinator.loadedURL = target
            context.coordinator.resetHealthCheck()
            webView.load(URLRequest(url: url))
        }
        if context.coordinator.lastKeyboardTrigger != keyboardTrigger {
            context.coordinator.lastKeyboardTrigger = keyboardTrigger
            context.coordinator.showKeyboard()
        }
    }

    private static func stableURLString(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        components.fragment = nil
        return components.string ?? url.absoluteString
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var lastKeyboardTrigger = 0
        var loadedURL: String?
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
          style.textContent = '#noVNC_control_bar_anchor,#noVNC_status_bar,.noVNC_center,#noVNC_clipboard_button,'
            + '#noVNC_keyboard_button,.noVNC_button{display:none!important;}'
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
          var input = document.getElementById('noVNC_keyboardinput')
            || document.getElementById('keyboardinput');
          if (input) {
            input.removeAttribute('readonly');
            input.style.opacity = '0.01';
            input.style.position = 'fixed';
            input.style.left = '0';
            input.style.bottom = '0';
            input.style.width = '1px';
            input.style.height = '1px';
            input.focus();
            return true;
          }
          var button = document.getElementById('noVNC_keyboard_button');
          if (button) { button.click(); return true; }
          return false;
        })();
        """
    }
}
