import SwiftUI
import UIKit

/// Restores UIKit's edge-back gesture while the app keeps its custom visual
/// navigation bar. The bridge has no drag handling of its own, so there is
/// only one source of truth for the interactive transition.
struct InteractivePopGestureEnabler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }

    func updateUIViewController(_ controller: Controller, context: Context) {
        controller.enableIfPossible()
    }

    final class Controller: UIViewController {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            enableIfPossible()
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            enableIfPossible()
        }

        func enableIfPossible() {
            guard let navigationController else { return }
            navigationController.interactivePopGestureRecognizer?.delegate = nil
            navigationController.interactivePopGestureRecognizer?.isEnabled = navigationController.viewControllers.count > 1
        }
    }
}
