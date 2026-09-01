import SwiftUI
import UIKit
import CompanionCore

public struct GitPRDiffCardView: View {
    public let filename: String
    public let diffText: String
    public let additions: Int
    public let deletions: Int
    public let work: WorkCardPresentation?
    
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.conversationTypography) private var typography
    @State private var showDiff: Bool = true
    @State private var showAllLines: Bool = false

    private var lines: [String] { diffText.components(separatedBy: "\n") }
    private var visibleLines: ArraySlice<String> {
        lines.prefix(showAllLines ? lines.count : 80)
    }
    
    public init(
        filename: String = "Changes",
        diffText: String,
        additions: Int = 0,
        deletions: Int = 0,
        work: WorkCardPresentation? = nil
    ) {
        self.filename = filename
        self.diffText = diffText
        self.work = work?.isRenderable == true ? work : nil
        
        if let workAdditions = work?.additions, let workDeletions = work?.deletions {
            self.additions = workAdditions
            self.deletions = workDeletions
        } else if additions == 0 && deletions == 0 {
            let lines = diffText.components(separatedBy: "\n")
            self.additions = lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
            self.deletions = lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
        } else {
            self.additions = additions
            self.deletions = deletions
        }
    }
    
    public var body: some View {
        let isDark = colorScheme == .dark
        
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.pull")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Color(hex: "#22C55E"))
                
                Text(work?.title ?? filename)
                    .font(typography.font(size: 12, relativeTo: .caption1, weight: .bold))
                    .foregroundColor(isDark ? Color(hex: "#F8FAFC") : Color(hex: "#0F172A"))
                    .lineLimit(2)
                
                Spacer()
                
                // Diff Delta (+ / -)
                HStack(spacing: 4) {
                    Text("+\(additions)")
                        .font(typography.font(size: 10.5, relativeTo: .caption2, weight: .bold, design: .monospaced))
                        .foregroundColor(Color(hex: "#22C55E"))
                    Text("-\(deletions)")
                        .font(typography.font(size: 10.5, relativeTo: .caption2, weight: .bold, design: .monospaced))
                        .foregroundColor(Color(hex: "#EF4444"))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2.5)
                .background(isDark ? Color.white.opacity(0.08) : Color.black.opacity(0.04))
                .clipShape(Capsule())
            }

            if let work {
                workMetadataView(work, isDark: isDark)
            }
            
            // Diff Content
            if !diffText.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Button {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                            showDiff.toggle()
                        }
                        Haptics.selection()
                    } label: {
                        HStack {
                            Image(systemName: showDiff ? "chevron.down" : "chevron.right")
                                .font(.system(size: 9, weight: .bold))
                            Text(showDiff ? "Hide Diff" : "View Diff")
                                .font(typography.font(size: 11, relativeTo: .caption2, weight: .semibold))
                            Spacer()
                        }
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                    .frame(minHeight: 44)
                    .accessibilityLabel(showDiff ? "Hide diff" : "View diff")
                    
                    if showDiff {
                        ScrollView(.horizontal, showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 1) {
                                ForEach(Array(visibleLines.enumerated()), id: \.offset) { _, line in
                                    diffLineView(line, isDark: isDark)
                                }
                            }
                            .padding(6)
                        }
                        .background(isDark ? Color.black.opacity(0.55) : Color(hex: "#0F172A"))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .transition(.opacity.combined(with: .move(edge: .top)))

                        if lines.count > 80 {
                            Button(showAllLines ? "Show first 80 lines" : "Show all \(lines.count) lines") {
                                withAnimation(.easeInOut(duration: 0.2)) { showAllLines.toggle() }
                                Haptics.selection()
                            }
                            .font(typography.font(size: 11, relativeTo: .caption2, weight: .semibold))
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                            .accessibilityLabel(showAllLines ? "Show first 80 lines" : "Show all diff lines")
                            .accessibilityHint("The copied diff always includes every line")
                        }
                    }
                }
            }
            
            Divider().background(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08))
            
            // Footer Actions
            HStack(spacing: 8) {
                if !diffText.isEmpty {
                    Button {
                        PlatformBridge.copyToPasteboard(diffText)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "doc.on.doc")
                            Text("Copy Diff")
                        }
                        .font(typography.font(size: 11, relativeTo: .caption2, weight: .medium))
                        .foregroundColor(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                    }
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Copy diff")
                }

                if let work, work.showsViewPR, let url = work.pullRequestURL {
                    Button {
                        UIApplication.shared.open(url)
                    } label: {
                        Label("View PR", systemImage: "arrow.up.right.square")
                            .font(typography.font(size: 11, relativeTo: .caption2, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("View pull request")
                }

                if let work, work.showsOpenInCursor, let url = work.openInCursorURL {
                    Button {
                        UIApplication.shared.open(url)
                    } label: {
                        Label("Open in Cursor", systemImage: "arrow.up.forward.app")
                            .font(typography.font(size: 11, relativeTo: .caption2, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityLabel("Open in Cursor")
                }
                
                Spacer()
            }
        }
        .padding(10)
        .background(
            LinearGradient(
                colors: isDark ? [
                    Color(hex: "#0D1117").opacity(0.96),
                    Color(hex: "#161B22").opacity(0.92)
                ] : [
                    Color.white.opacity(0.96),
                    Color(hex: "#F8FAFC").opacity(0.92)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(isDark ? Color.white.opacity(0.12) : Color.black.opacity(0.08), lineWidth: 0.75)
        )
        .shadow(color: Color.black.opacity(isDark ? 0.20 : 0.04), radius: 4, y: 1.5)
    }

    @ViewBuilder
    private func workMetadataView(_ work: WorkCardPresentation, isDark: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if let status = work.status {
                    Text(status)
                        .font(typography.font(size: 11, relativeTo: .caption2, weight: .semibold))
                        .foregroundStyle(isDark ? Color(hex: "#CBD5E1") : Color(hex: "#475569"))
                }
                if let branch = work.branch {
                    Label(branch, systemImage: "arrow.branch")
                        .font(typography.font(size: 10.5, relativeTo: .caption2, weight: .medium, design: .monospaced))
                        .foregroundStyle(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                        .lineLimit(1)
                }
                if let number = work.prNumber {
                    Text("PR #\(number)")
                        .font(typography.font(size: 10.5, relativeTo: .caption2, weight: .medium, design: .monospaced))
                        .foregroundStyle(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
                }
            }

            if let files = work.filesChanged {
                Text(files == 1 ? "1 file changed" : "\(files) files changed")
                    .font(typography.font(size: 10.5, relativeTo: .caption2, weight: .medium))
                    .foregroundStyle(isDark ? Color(hex: "#94A3B8") : Color(hex: "#64748B"))
            }
        }
    }
    
    @ViewBuilder
    private func diffLineView(_ line: String, isDark: Bool) -> some View {
        let isAddition = line.hasPrefix("+") && !line.hasPrefix("+++")
        let isDeletion = line.hasPrefix("-") && !line.hasPrefix("---")
        let isHeader = line.hasPrefix("@@") || line.hasPrefix("diff")
        
        Text(line)
            .font(typography.font(size: 10, relativeTo: .footnote, design: .monospaced))
            .foregroundColor(
                isAddition ? Color(hex: "#4ADE80") :
                isDeletion ? Color(hex: "#F87171") :
                isHeader ? Color(hex: "#38BDF8") :
                Color(hex: "#E2E8F0")
            )
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(
                isAddition ? Color(hex: "#22C55E").opacity(0.15) :
                isDeletion ? Color(hex: "#EF4444").opacity(0.15) :
                Color.clear
            )
            .clipShape(RoundedRectangle(cornerRadius: 2))
    }
}
