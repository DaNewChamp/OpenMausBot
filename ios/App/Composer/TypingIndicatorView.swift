import SwiftUI

public struct TypingIndicatorView: View {
    public let tintColor: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    
    public init(tintColor: Color = .purple) {
        self.tintColor = tintColor
    }
    
    public var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
            HStack(spacing: 4) {
                ForEach(0..<3) { index in
                    Circle()
                        .fill(tintColor.opacity(0.85))
                        .frame(width: 5, height: 5)
                        .scaleEffect(reduceMotion ? 1 : dotScale(index, at: context.date))
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .accessibilityHidden(true)
    }

    private func dotScale(_ index: Int, at date: Date) -> CGFloat {
        let elapsed = date.timeIntervalSinceReferenceDate - Double(index) * 0.16
        let wave = (sin(elapsed * .pi * 2) + 1) / 2
        return 0.35 + CGFloat(wave) * 0.65
    }
}
