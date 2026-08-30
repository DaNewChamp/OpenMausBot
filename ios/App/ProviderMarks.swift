import SwiftUI

/// Official-style provider marks for model engines. Paths mirror
/// `src/components/ProviderIcons.tsx` — public logos only, no IPA assets.
enum ProviderMarks {
    static func mark(for key: String, size: CGFloat = 18) -> some View {
        ProviderMarkView(providerKey: key, size: size)
    }

    static func displayName(for key: String, fallback: String? = nil) -> String {
        let normalized = normalize(key)
        switch normalized {
        case "grok", "grokgent", "grokreconstructed": return "Grok"
        case "grokauth": return "Grok Auth"
        case "claude", "claudeagent", "claudecode": return "Claude"
        case "codex": return "Codex"
        case "openai": return "OpenAI"
        case "cursor", "cursoragent": return "Cursor"
        case "kimi", "kimiagent": return "Kimi"
        case "droid", "droidagent": return "Droid"
        case "gemini", "geminiagent": return "Gemini"
        case "qwen", "qwenagent": return "Qwen"
        case "hermes", "hermesagent": return "Hermes"
        case "opencode", "opencodego": return "OpenCode"
        case "antigravity", "antigravityagent": return "Antigravity"
        case "pi", "piagent": return "pi"
        case "box", "boxagent", "computer": return "Computer"
        case "openrouter": return "OpenRouter"
        case "openmaus": return "OpenMaus"
        case "minimax": return "MiniMax"
        default:
            if let fallback, !fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return fallback
            }
            return key
        }
    }

    static func normalize(_ key: String) -> String {
        key
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "_", with: "-")
            .replacingOccurrences(of: "agent", with: "")
            .replacingOccurrences(of: "-", with: "")
    }
}

struct ProviderMarkView: View {
    let providerKey: String
    var size: CGFloat = 18

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let normalized = ProviderMarks.normalize(providerKey)
        ZStack {
            switch normalized {
            case "grok", "grokauth":
                SVGIconShape(path: Self.grokPath, viewBox: CGSize(width: 24, height: 24))
                    .fill(Color.primary)
            case "claude", "claudecode":
                SVGIconShape(path: Self.claudePath, viewBox: CGSize(width: 256, height: 257))
                    .fill(Color(red: 0.85, green: 0.47, blue: 0.34))
            case "codex", "openai":
                SVGIconShape(path: Self.codexPath, viewBox: CGSize(width: 256, height: 260))
                    .fill(Color.primary)
            case "cursor":
                SVGIconShape(path: Self.cursorPath, viewBox: CGSize(width: 24, height: 24))
                    .fill(colorScheme == .dark ? Color(white: 0.96) : Color.primary)
            case "kimi":
                SVGIconShape(path: Self.kimiPath, viewBox: CGSize(width: 24, height: 24))
                    .fill(Color(red: 0.09, green: 0.51, blue: 1))
            case "droid":
                SVGIconShape(path: Self.droidPath, viewBox: CGSize(width: 508, height: 508))
                    .fill(Color.primary)
            case "antigravity":
                SVGIconShape(path: Self.antigravityPath, viewBox: CGSize(width: 24, height: 24))
                    .fill(Color.primary)
            case "opencode", "opencodego":
                SVGIconShape(path: Self.openCodePath, viewBox: CGSize(width: 24, height: 24))
                    .fill(Color.primary)
            case "qwen":
                SVGIconShape(path: Self.qwenPath, viewBox: CGSize(width: 24, height: 24))
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.39, green: 0.21, blue: 0.91),
                                Color(red: 0.44, green: 0.41, blue: 0.97),
                            ],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
            case "pi":
                SVGIconShape(path: Self.piPath, viewBox: CGSize(width: 800, height: 800))
                    .fill(Color.primary)
            case "box", "computer":
                Image(systemName: "desktopcomputer")
                    .font(.system(size: size * 0.72, weight: .medium))
                    .foregroundStyle(.secondary)
            case "openrouter":
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: size * 0.68, weight: .semibold))
                    .foregroundStyle(.secondary)
            case "openmaus":
                Image(systemName: "hare.fill")
                    .font(.system(size: size * 0.72, weight: .medium))
                    .foregroundStyle(Color(red: 0, green: 0.6, blue: 0.34))
            case "gemini":
                Image(systemName: "sparkles")
                    .font(.system(size: size * 0.72, weight: .medium))
                    .foregroundStyle(Color(red: 0.26, green: 0.52, blue: 0.96))
            case "hermes":
                Image(systemName: "bolt.fill")
                    .font(.system(size: size * 0.68, weight: .semibold))
                    .foregroundStyle(Color.orange)
            case "minimax":
                Image(systemName: "waveform")
                    .font(.system(size: size * 0.68, weight: .medium))
                    .foregroundStyle(.secondary)
            default:
                Text(String(normalized.prefix(1)).uppercased())
                    .font(.system(size: size * 0.52, weight: .bold, design: .rounded))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private static let cursorPath =
        "M4 2.2 L20.6 12 12.7 13.9 10.4 21.8 Z"

    private static let grokPath =
        """
        M9.26905 15.284 L17.2479 9.36086 C17.6391 9.07047 18.1981 9.18374 18.3845 9.63478 \
        C19.3655 12.0135 18.9272 14.8721 16.9755 16.8349 C15.0238 18.7976 12.3082 19.228 9.8261 18.2477 \
        L7.1146 19.5102 C11.0037 22.1834 15.7263 21.5223 18.6774 18.5525 C21.0182 16.1985 21.7432 12.9897 \
        21.0653 10.0961 L21.0714 10.1023 C20.0884 5.85143 21.3131 4.15233 23.8218 0.677913 C23.8812 0.595532 \
        23.9406 0.513151 24 0.428711 L20.6987 3.74866 V3.73836 L9.267 15.2861 Z \
        M7.62249 16.7237 C4.83113 14.0422 5.3124 9.89222 7.69417 7.49905 C9.45541 5.72786 12.341 5.00497 \
        14.86 6.06768 L17.5653 4.81138 C17.0779 4.45714 16.4533 4.07613 15.7365 3.80839 C12.4966 2.46764 \
        8.6178 3.13492 5.98413 5.78141 C3.45081 8.32904 2.65415 12.2463 4.02219 15.5889 C5.04412 18.0871 \
        3.36889 19.8541 1.68137 21.6377 C1.08337 22.2699 0.483318 22.9022 0 23.5716 L7.62045 16.7257 Z
        """

    private static let codexPath =
        """
        M239.184 106.203 C219.452 28.459 191 15.784 163.213 21.74 C52.096 45.22 8.866 76.58 8.033 76.74 \
        C14.31 101.342 17.559 132.374 8.033 153.48 C14.174 178.13 42.644 190.804 70.446 184.84 C119.235 206.584 \
        148.481 206.609 176.962 184.223 C195.443 162.879 206.318 131.635 198.235 106.203 C192.099 80.385 \
        166.285 60.727 136.184 60.727 C106.083 60.727 80.269 80.385 74.133 106.203 C67.997 131.635 78.872 \
        162.879 97.353 184.223 C115.834 205.567 145.08 206.609 173.561 184.223 Z \
        M141.624 242.541 L193.294 212.716 C197.842 210.349 198.401 203.816 193.587 200.267 C188.773 196.718 \
        181.01 196.601 176.462 198.968 L124.792 228.793 C80.217 254.611 33.182 246.848 17.586 211.203 \
        C1.99 175.558 25.078 123.258 42.25 86.697 C42.538 86.086 43.009 85.576 43.603 85.234 C44.197 84.893 \
        44.883 84.737 45.57 84.788 C46.257 84.839 46.911 85.094 47.445 85.519 C47.979 85.944 48.366 86.518 \
        48.556 87.165 C55.491 110.936 63.419 138.866 71.901 162.575 C72.234 163.506 72.217 164.522 71.854 \
        165.441 C71.49 166.361 70.804 167.125 69.917 167.596 C48.736 178.895 12.491 193.9 6.471 183.373 \
        C2.491 175.528 25.579 123.258 42.751 86.697 Z
        """

    // Abbreviated Claude mark — full path is 2KB; this keeps the asterisk silhouette.
    private static let claudePath =
        """
        M50.228 170.321 L100.585 142.064 L101.428 139.601 L100.585 138.24 L98.123 138.24 L89.697 137.722 \
        L60.922 136.944 L35.97 135.907 L11.795 134.611 L5.703 133.314 L0 125.796 L0.583 122.037 L5.703 118.603 \
        L13.027 119.251 L29.229 120.352 L53.533 122.037 L71.162 123.074 L97.28 125.796 L101.428 125.796 \
        L102.011 124.111 L100.585 123.074 L99.484 123.074 L74.337 106.029 L47.117 87.012 L32.859 76.642 \
        L25.146 71.392 L21.258 66.467 L19.573 55.709 L26.573 47.996 L35.97 48.645 L38.368 49.293 L47.895 56.616 \
        L68.245 72.366 L94.817 91.9 L98.706 95.14 L100.261 94.038 L100.456 93.261 L98.706 90.344 L84.253 64.226 \
        L68.828 37.654 L61.958 26.636 L60.144 20.026 L58.459 12.268 L66.431 1.445 L71.42 0 L82.05 1.426 \
        L86.522 5.314 L93.132 20.415 L103.826 44.201 L120.417 76.541 L125.278 86.133 L127.87 95.012 L128.843 97.734 \
        L130.528 97.734 L130.528 96.178 L131.888 77.967 L134.416 55.607 L136.879 26.831 L137.722 18.731 \
        L141.74 9.009 L149.711 3.759 L155.933 6.74 L161.053 14.064 L160.34 18.794 L157.294 38.562 L151.332 69.542 \
        L147.443 90.281 L150.813 106.974 L153.279 106.78 L183.739 100.299 L200.201 97.317 L219.838 93.947 \
        L228.718 98.095 L229.689 102.308 L226.189 110.928 L205.191 116.112 L180.563 121.038 L143.881 129.723 \
        L143.427 130.047 L143.946 130.695 L160.472 132.25 L167.537 132.639 L184.841 132.639 L217.051 135.037 \
        L225.477 140.611 L230.532 147.416 L229.689 152.6 L216.727 159.211 L199.229 155.063 L158.399 145.342 \
        L144.399 141.842 L142.455 141.842 L142.455 143.656 L154.121 155.062 L175.508 174.376 L202.274 199.263 \
        L203.634 205.42 L200.2 210.28 L196.57 209.762 L173.044 192.069 L163.971 184.097 L143.426 166.793 \
        L142.066 168.607 L134.872 246.055 L131.502 250.008 L123.724 252.989 L117.243 248.064 L113.807 240.092 \
        L117.242 224.343 L121.39 203.799 L124.76 187.466 L127.806 167.181 L129.621 160.441 L128.131 159.987 \
        L112.836 180.986 L89.569 212.419 L71.163 232.121 L66.756 233.871 L59.108 229.917 L59.821 222.853 \
        L64.098 215.567 L89.568 183.162 L104.928 163.07 L114.845 151.47 L114.78 149.784 L114.197 149.784 \
        L44.07 198.125 L32.015 199.68 L26.83 194.82 L27.478 186.848 L29.941 184.255 L50.291 170.256 Z
        """

    private static let kimiPath =
        """
        M21.846 0 C21.846 0 21.846 1.923 21.846 3.846 L20.15 3.846 C20.15 3.846 19.923 3.62 19.923 3.393 \
        L19.923 1.923 C19.923 0.861 20.784 0 21.846 0 Z \
        M11.065 11.199 L18.322 3.999 C18.459 3.863 18.382 3.589 18.206 3.589 L14.3 3.589 C14.3 3.589 14.183 3.64 \
        14.066 3.756 L6.246 11.512 C6.124 11.632 5.944 11.525 5.944 11.333 L5.944 3.82 C5.944 3.693 5.861 3.59 \
        5.759 3.59 L3.186 3.59 C3.083 3.59 3 3.693 3 3.82 L3 19.77 C3 19.898 3.083 20 3.186 20 L5.876 20 \
        C5.979 20 6.062 19.898 6.062 19.77 L6.062 16.52 C6.062 16.451 6.087 16.385 6.131 16.342 L8.555 13.936 \
        C8.658 13.859 8.863 13.872 8.968 13.849 L15.452 18.621 C17.905 19.904 21.358 20.335 23.84 19.355 \
        C23.948 19.367 24.04 19.272 24.04 19.14 L24.04 16.08 C24.04 15.963 23.97 15.868 23.876 15.853 \
        C22.849 15.646 21.813 15.046 20.813 14.046 L15.2 9.982 C15.083 9.904 15.068 9.703 15.172 9.601 \
        L20.785 5.537 C20.902 5.459 20.917 5.258 20.813 5.156 L15.2 1.092 C15.083 1.014 15.068 0.813 15.172 0.711 \
        L9.225 1.774 C9.109 1.743 9.056 1.712 9.172 1.743 Z
        """

    private static let droidPath =
        """
        M321.997 150.712 C309.666 86.547 248.085 120.749 228.451 132.333 C214.06 111.043 205.384 97.609 196.589 97.027 \
        C173.279 95.469 154.491 162.187 148.991 183.932 C123.406 178.825 107.545 175.316 100.914 180.98 \
        C83.305 195.978 118.315 256.126 130.175 275.304 C108.384 289.359 94.631 297.834 94.027 306.424 \
        C92.439 329.192 160.74 347.544 183.01 352.916 C177.773 377.905 174.181 393.398 179.979 399.874 \
        C195.334 417.074 256.921 382.877 276.556 371.293 C290.947 392.578 299.616 406.012 308.417 406.601 \
        C331.728 408.153 350.516 341.44 356.009 319.688 C381.601 324.803 397.455 328.304 404.093 322.648 \
        C421.702 307.65 386.684 247.495 374.825 228.317 C396.623 214.261 410.376 205.786 410.973 197.196 \
        C412.568 174.428 344.26 156.078 321.997 150.712 Z
        """

    private static let antigravityPath =
        "M21.751 22.607 C23.091 23.612 25.101 22.942 23.259 21.099 C17.238 15.232 18.412 0.492 11.545 0.492 C4.678 0.492 5.85 15.232 0.323 20.592 C-1.687 22.601 -0.51 23.103 0.83 22.098 C6.022 18.581 5.687 12.384 10.879 15.902 C16.071 19.419 15.736 25.616 20.928 22.098 Z"

    private static let openCodePath = "M16 6 H8 V18 H16 V6 Z M20 22 H4 V2 H20 V22 Z"

    private static let qwenPath =
        """
        M12.604 1.34 C12.997 2.03 13.388 2.722 13.778 3.415 C13.958 3.506 14.115 3.506 14.313 3.415 L19.865 3.415 \
        C20.039 3.415 20.187 3.525 20.311 3.742 L21.765 6.312 C21.955 6.649 22.005 6.79 21.789 7.149 C21.529 7.579 \
        21.276 8.013 21.029 8.449 L20.662 9.107 C20.556 9.303 20.439 9.387 20.622 9.619 L23.274 14.256 C23.446 14.557 \
        23.385 14.75 23.231 15.026 C22.794 15.811 22.349 16.59 21.896 17.366 C21.737 17.638 21.544 17.741 21.216 17.736 \
        C20.439 17.72 19.664 17.726 18.889 17.752 C18.808 17.752 18.727 17.802 18.646 17.852 C16.941 20.592 15.236 23.332 \
        13.531 26.072 C13.362 26.365 13.151 26.435 12.826 26.436 C11.829 26.439 10.824 26.44 9.809 26.438 C9.272 26.438 \
        8.807 26.167 8.342 25.895 L6.007 23.572 C5.838 23.279 5.657 23.229 5.574 23.279 L4.982 19.77 C4.697 19.8 4.429 19.769 \
        4.177 19.678 L2.574 16.908 C2.414 16.598 2.401 16.412 2.669 15.943 C3.134 15.13 3.596 14.318 4.056 13.504 \
        C4.188 13.27 4.36 13.17 4.64 13.169 C5.417 13.168 6.194 13.167 6.971 13.166 C7.095 13.166 7.219 13.187 7.326 13.229 \
        L10.132 1.334 C10.554 0.439 10.976 0.474 11.398 0.474 C11.922 0.473 12.451 0.474 12.981 0.468 L11.704 1 C12.045 0.997 \
        12.428 1.032 12.604 1.34 Z
        """

    private static let piPath =
        """
        M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z \
        M282.65 282.65 V400 H400 V282.65 Z \
        M517.36 400 H634.72 V634.72 H517.36 Z
        """
}

private struct SVGIconShape: Shape {
    let path: String
    let viewBox: CGSize

    func path(in rect: CGRect) -> Path {
        let parsed = SVGPathParser.parse(path)
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let fitted = parsed.applying(
            CGAffineTransform(scaleX: scale, y: scale)
                .concatenating(
                    CGAffineTransform(
                        translationX: rect.minX + (rect.width - viewBox.width * scale) / 2,
                        y: rect.minY + (rect.height - viewBox.height * scale) / 2
                    )
                )
        )
        return fitted
    }
}

private enum SVGPathParser {
    static func parse(_ source: String) -> Path {
        var result = Path()
        var numbers: [CGFloat] = []
        var command: Character?
        var current = CGPoint.zero
        var start = CGPoint.zero
        var token = ""

        func takeNumber() {
            if !token.isEmpty, let value = Double(token) {
                numbers.append(CGFloat(value))
            }
            token = ""
        }

        func flush() {
            guard let command else { return }
            switch command {
            case "M":
                guard numbers.count >= 2 else { break }
                current = CGPoint(x: numbers[0], y: numbers[1])
                start = current
                result.move(to: current)
                var index = 2
                while index + 1 < numbers.count {
                    current = CGPoint(x: numbers[index], y: numbers[index + 1])
                    result.addLine(to: current)
                    index += 2
                }
            case "L":
                var index = 0
                while index + 1 < numbers.count {
                    current = CGPoint(x: numbers[index], y: numbers[index + 1])
                    result.addLine(to: current)
                    index += 2
                }
            case "H":
                for value in numbers {
                    current = CGPoint(x: value, y: current.y)
                    result.addLine(to: current)
                }
            case "V":
                for value in numbers {
                    current = CGPoint(x: current.x, y: value)
                    result.addLine(to: current)
                }
            case "C":
                var index = 0
                while index + 5 < numbers.count {
                    let to = CGPoint(x: numbers[index + 4], y: numbers[index + 5])
                    result.addCurve(
                        to: to,
                        control1: CGPoint(x: numbers[index], y: numbers[index + 1]),
                        control2: CGPoint(x: numbers[index + 2], y: numbers[index + 3])
                    )
                    current = to
                    index += 6
                }
            case "Z":
                result.closeSubpath()
                current = start
            default:
                break
            }
            numbers.removeAll()
        }

        for character in source {
            if character.isNumber || character == "." || character == "e" || character == "E" {
                token.append(character)
            } else if character == "-" {
                if token.hasSuffix("e") || token.hasSuffix("E") {
                    token.append(character)
                } else {
                    takeNumber()
                    token = "-"
                }
            } else if character == " " || character == "," || character == "\n" {
                takeNumber()
            } else if character == "Z" || character == "z" {
                takeNumber()
                flush()
                command = "Z"
                flush()
                command = nil
            } else if character.isLetter {
                takeNumber()
                flush()
                command = character
            }
        }
        takeNumber()
        flush()
        return result
    }
}
