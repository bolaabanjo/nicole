import SwiftUI

struct FluidOrbView: View {
  let colors: [Color]
  let reactivity: CGFloat // 0.0 to 1.0 (audio level)
  
  var body: some View {
    TimelineView(.animation) { timeline in
      let t = timeline.date.timeIntervalSinceReferenceDate
      
      ZStack {
        // Deep diffuse background glow
        FluidBlob(
          color: colors.last?.opacity(0.15) ?? .blue.opacity(0.2),
          t: t * 0.4,
          offset: 40,
          scale: 2.2 + reactivity * 0.4,
          blur: 70
        )

        // Middle fluid layers
        FluidBlob(
          color: colors.indices.contains(1) ? colors[1].opacity(0.25) : .cyan.opacity(0.3),
          t: t * 0.7,
          offset: 25,
          scale: 1.6 + reactivity * 0.3,
          blur: 50
        )
        .blendMode(.plusLighter)

        FluidBlob(
          color: colors.first?.opacity(0.35) ?? .indigo.opacity(0.4),
          t: t * 0.6,
          offset: 35,
          scale: 1.4 + reactivity * 0.2,
          blur: 40
        )
        .blendMode(.plusLighter)

        // Reactive bright core
        ZStack {
          Circle()
            .fill(
              RadialGradient(
                colors: [Color.white.opacity(0.8), Color.white.opacity(0)],
                center: .center,
                startRadius: 0,
                endRadius: 60
              )
            )
            .frame(width: 120, height: 120)
            .scaleEffect(0.8 + reactivity * 0.6)
            .blur(radius: 12)
        }
        .blendMode(.plusLighter)
        
      }
      .frame(width: 300, height: 300)
    }
  }
}

private struct FluidBlob: View {
  let color: Color
  let t: Double
  let offset: CGFloat
  let scale: CGFloat
  let blur: CGFloat
  
  var body: some View {
    Circle()
      .fill(color)
      .frame(width: 140, height: 140)
      .offset(
        x: sin(t) * offset,
        y: cos(t * 0.7) * offset
      )
      .scaleEffect(scale + sin(t * 0.5) * 0.1)
      .blur(radius: blur)
  }
}
