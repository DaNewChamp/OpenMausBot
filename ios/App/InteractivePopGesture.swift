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
            guard let navigationController = enclosingNavigationController else { return }
            let pop = navigationController.interactivePopGestureRecognizer
            pop?.delegate = nil
            pop?.isEnabled = navigationController.viewControllers.count > 1
        }

        private var enclosingNavigationController: UINavigationController? {
            if let navigationController { return navigationController }
            var current: UIViewController? = parent
            while let candidate = current {
                if let navigation = candidate as? UINavigationController {
                    return navigation
                }
                current = candidate.parent
            }
            return view.window?.rootViewController as? UINavigationController
        }
    }
}
