import SwiftUI
import WebKit
import CompanionCore

/// Live noVNC viewer for a proxied Local VM desktop URL.
struct VMViewerWebView: UIViewRepresentable {
    let url: URL
    var pointerMode: VmPointerMode
    /// Bumps when the parent mints a fresh one-time ticket. Stable URL keys
    /// ignore `omb_viewer`, so generation is what forces a reload.
    var generation: Int
    var onLoadSucceeded: (() -> Void)?
    var onLoadFailed: ((String, LocalVmDesktopPolicy.ViewerFailure) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onLoadSucceeded: onLoadSucceeded, onLoadFailed: onLoadFailed)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(VBotSurface.background)
        webView.scrollView.backgroundColor = UIColor(VBotSurface.background)
        webView.scrollView.delegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView
        context.coordinator.applyScrollZoom(for: pointerMode, on: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        context.coordinator.onLoadSucceeded = onLoadSucceeded
        context.coordinator.onLoadFailed = onLoadFailed
        if context.coordinator.pointerMode != pointerMode {
            context.coordinator.applyPointerMode(pointerMode, on: webView)
        }
        context.coordinator.applyScrollZoom(for: pointerMode, on: webView)

        let target = LocalVmDesktopPolicy.stableViewerKey(for: url)
        let stableChanged = context.coordinator.loadedURL != target
        let generationChanged = context.coordinator.loadedGeneration != generation
        if LocalVmDesktopPolicy.shouldReloadViewer(stableKeyChanged: stableChanged, generationChanged: generationChanged) {
            context.coordinator.loadedURL = target
            context.coordinator.loadedGeneration = generation
            context.coordinator.beginNewLoad()
            webView.load(URLRequest(url: url, timeoutInterval: 15))
        }
    }

    static func stableViewerKey(for url: URL) -> String {
        LocalVmDesktopPolicy.stableViewerKey(for: url)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, UIScrollViewDelegate {
        weak var webView: WKWebView?
        var loadedURL: String?
        var loadedGeneration: Int = -1
        var onLoadSucceeded: (() -> Void)?
        var onLoadFailed: ((String, LocalVmDesktopPolicy.ViewerFailure) -> Void)?
        private var healthCheckTask: Task<Void, Never>?
        var pointerMode: VmPointerMode = .trackpad
        private var pointerModeInjected: VmPointerMode?
        private var pointerModeToken: UInt = 0
        private var reportedFailure = false
        private var reportedSuccess = false

        init(
            onLoadSucceeded: (() -> Void)?,
            onLoadFailed: ((String, LocalVmDesktopPolicy.ViewerFailure) -> Void)?
        ) {
            self.onLoadSucceeded = onLoadSucceeded
            self.onLoadFailed = onLoadFailed
        }

        deinit {
            healthCheckTask?.cancel()
        }

        func resetHealthCheck() {
            healthCheckTask?.cancel()
            healthCheckTask = nil
        }

        func beginNewLoad() {
            resetHealthCheck()
            reportedFailure = false
            reportedSuccess = false
            pointerModeInjected = nil
        }

        func applyScrollZoom(for mode: VmPointerMode, on webView: WKWebView) {
            let scrollView = webView.scrollView
            switch mode {
            case .touch:
                scrollView.minimumZoomScale = 1
                scrollView.maximumZoomScale = 4
                scrollView.isScrollEnabled = true
                scrollView.bouncesZoom = true
            case .trackpad:
                scrollView.setZoomScale(1, animated: false)
                scrollView.minimumZoomScale = 1
                scrollView.maximumZoomScale = 1
                scrollView.isScrollEnabled = false
                scrollView.bouncesZoom = false
            }
        }

        func applyPointerMode(_ mode: VmPointerMode, on webView: WKWebView) {
            guard mode != pointerModeInjected else { return }
            pointerMode = mode
            pointerModeInjected = mode
            pointerModeToken &+= 1
            let token = pointerModeToken
            let trackpad = mode == .trackpad
            webView.evaluateJavaScript(Self.pointerModeScript(trackpad: trackpad, token: token), completionHandler: nil)
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            webView
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            scheduleHealthCheck(on: webView)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationResponse: WKNavigationResponse,
            decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
        ) {
            if let http = navigationResponse.response as? HTTPURLResponse,
               http.statusCode == 401 || http.statusCode == 403 {
                decisionHandler(.cancel)
                fail(.staleTicket)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript(Self.chromeScript, completionHandler: nil)
            applyPointerMode(pointerMode, on: webView)
            webView.evaluateJavaScript("document.body && document.body.innerText") { value, _ in
                guard let text = value as? String else { return }
                if text.contains("pair this device from Phone settings") {
                    self.fail(.staleTicket)
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !Self.isCancelledNavigationError(error) else { return }
            fail(.navigationError)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard !Self.isCancelledNavigationError(error) else { return }
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorUserCancelledAuthentication {
                fail(.staleTicket)
                return
            }
            fail(.navigationError)
        }

        private static func isCancelledNavigationError(_ error: Error) -> Bool {
            let nsError = error as NSError
            return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
        }

        private func fail(_ reason: LocalVmDesktopPolicy.ViewerFailure) {
            Task { @MainActor in
                guard !self.reportedFailure else { return }
                self.reportedFailure = true
                self.healthCheckTask?.cancel()
                self.healthCheckTask = nil
                self.onLoadFailed?(LocalVmDesktopPolicy.message(for: reason), reason)
            }
        }

        private func succeed() {
            Task { @MainActor in
                guard !self.reportedSuccess, !self.reportedFailure else { return }
                self.reportedSuccess = true
                self.onLoadSucceeded?()
            }
        }

        private func scheduleHealthCheck(on webView: WKWebView) {
            healthCheckTask?.cancel()
            healthCheckTask = Task { @MainActor in
                let deadline = ContinuousClock.now.advanced(by: LocalVmDesktopPolicy.viewerBlankTimeout)
                while !Task.isCancelled {
                    if ContinuousClock.now >= deadline {
                        self.fail(.blankTimeout)
                        return
                    }
                    do {
                        let value = try await webView.evaluateJavaScript(Self.healthScript)
                        if Task.isCancelled { return }
                        if let result = value as? String {
                            if result == LocalVmDesktopPolicy.ViewerHealthSignal.ok.rawValue {
                                self.succeed()
                                return
                            }
                            if result == LocalVmDesktopPolicy.ViewerHealthSignal.auth.rawValue {
                                self.fail(.staleTicket)
                                return
                            }
                        }
                    } catch {
                        if Task.isCancelled { return }
                    }
                    try? await Task.sleep(for: .milliseconds(400))
                }
            }
        }

        private static func pointerModeScript(trackpad: Bool, token: UInt) -> String {
            let mode = trackpad ? "true" : "false"
            return """
            (function(enableTrackpad, token) {
              window.__ombPointerModeToken = token;
              function findRfb() {
                if (window.rfb) return window.rfb;
                if (window.UI && window.UI.rfb) return window.UI.rfb;
                return null;
              }
              function apply() {
                var rfb = findRfb();
                if (!rfb) return false;
                if (typeof rfb.trackpadMode === 'boolean') {
                  rfb.trackpadMode = enableTrackpad;
                  return true;
                }
                return false;
              }
              var tries = 0;
              (function poll() {
                if (window.__ombPointerModeToken !== token) return;
                if (apply() || ++tries > 80) return;
                setTimeout(poll, 200);
              })();
            })(\(mode), \(token));
            """
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
          var body = document.body ? document.body.innerText : '';
          if (body.indexOf('pair this device') >= 0) return 'auth';
          var rfb = window.rfb || (window.UI && window.UI.rfb);
          if (rfb) {
            var state = rfb._rfb_connection_state || rfb._rfbConnectionState;
            if (state === 'connected') return 'ok';
            return 'waiting';
          }
          var canvas = document.getElementById('noVNC_canvas') || document.querySelector('#noVNC_container canvas') || document.querySelector('canvas');
          if (canvas && canvas.width > 8 && canvas.height > 8) return 'ok';
          return 'waiting';
        })();
        """
    }
}
