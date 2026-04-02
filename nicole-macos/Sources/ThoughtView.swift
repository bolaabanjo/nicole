import SwiftUI

struct ThoughtView: View {
    let thought: String
    let duration: Int?
    let isStreaming: Bool
    @Binding var isOpen: Bool
    
    @State private var shimmerOffset: CGFloat = -1.0
    @State private var dotOpacity: Double = 0.2
    
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                    isOpen.toggle()
                }
            }) {
                HStack(spacing: 0) {
                    Text(headerText)
                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                        .foregroundColor(.white.opacity(0.36)) // Base text color
                        .overlay(
                            shimmerOverlay
                                .mask(
                                    Text(headerText)
                                        .font(.system(size: 13, weight: .medium, design: .monospaced))
                                )
                        )
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            
            if isOpen {
                Text(thought)
                    .font(.system(size: 11, weight: .regular, design: .monospaced))
                    .foregroundColor(.white.opacity(0.32))
                    .lineSpacing(4)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                    .padding(.leading, 0)
                    .padding(.bottom, 8)
                    .textSelection(.enabled)
            }
        }
        .onAppear {
            if isStreaming {
                startAnimations()
            }
        }
        .onChange(of: isStreaming) { _, newValue in
            if newValue {
                startAnimations()
            }
        }
    }
    
    private var headerText: String {
        if isStreaming {
            return "Thinking"
        } else {
            return duration != nil ? "Thought for \(duration!)s" : "Thought"
        }
    }
    
    private var shimmerOverlay: some View {
        GeometryReader { geo in
            if isStreaming {
                let width = geo.size.width
                LinearGradient(
                    gradient: Gradient(stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .white.opacity(0.7), location: 0.5),
                        .init(color: .clear, location: 1)
                    ]),
                    startPoint: .leading,
                    endPoint: .trailing
                )
                .frame(width: width)
                .offset(x: (width * 2) * shimmerOffset)
            }
        }
    }
    
    // shimmerTrail removed as requested
    
    private func startAnimations() {
        shimmerOffset = -0.5
        withAnimation(.linear(duration: 2.5).repeatForever(autoreverses: false)) {
            shimmerOffset = 1.0
        }
    }
}
