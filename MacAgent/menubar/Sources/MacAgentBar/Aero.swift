import SwiftUI

/// The app's Frutiger Aero look: sky-to-grass gradients, floating bubbles, glossy buttons and
/// frosted glass panels. Everything visual lives here; the other files only apply these styles.
enum Aero {
    static let sky = Color(red: 0.30, green: 0.70, blue: 0.98)
    static let aqua = Color(red: 0.52, green: 0.90, blue: 0.94)
    static let grass = Color(red: 0.47, green: 0.82, blue: 0.30)
    static let deep = Color(red: 0.05, green: 0.36, blue: 0.72)
    /// Text colour: a dark sea blue that reads on every surface of the theme.
    static let ink = Color(red: 0.04, green: 0.20, blue: 0.38)

    /// Lucida Grande is the humanist face macOS ships that is closest to Frutiger.
    static func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom("Lucida Grande", size: size).weight(weight)
    }
}

/// Sky fading down into aqua and grass, with a soft glossy arc across the top and a few bubbles.
struct AeroBackground: View {
    var cornerRadius: CGFloat = 0

    /// Bubbles as (x, y, diameter), x and y being fractions of the width and height.
    private let bubbles: [(CGFloat, CGFloat, CGFloat)] = [
        (0.06, 0.78, 46), (0.17, 0.30, 18), (0.33, 0.88, 26), (0.52, 0.16, 14),
        (0.68, 0.74, 60), (0.82, 0.26, 24), (0.93, 0.62, 34), (0.44, 0.58, 10),
    ]

    var body: some View {
        GeometryReader { geo in
            ZStack {
                LinearGradient(
                    stops: [
                        .init(color: Color(red: 0.84, green: 0.95, blue: 1.0), location: 0),
                        .init(color: Aero.sky, location: 0.42),
                        .init(color: Aero.aqua, location: 0.76),
                        .init(color: Color(red: 0.70, green: 0.93, blue: 0.58), location: 1),
                    ],
                    startPoint: .top, endPoint: .bottom)
                ForEach(bubbles.indices, id: \.self) { i in
                    let (x, y, d) = bubbles[i]
                    Bubble().frame(width: d, height: d).position(x: geo.size.width * x, y: geo.size.height * y)
                }
                Ellipse()
                    .fill(LinearGradient(colors: [.white.opacity(0.6), .white.opacity(0)], startPoint: .top, endPoint: .bottom))
                    .frame(width: geo.size.width * 1.5, height: geo.size.height * 0.9)
                    .position(x: geo.size.width / 2, y: 0)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(.white.opacity(0.7)))
        .allowsHitTesting(false)
    }
}

/// One see-through bubble: brighter at the rim, with a small highlight at the top left.
private struct Bubble: View {
    var body: some View {
        GeometryReader { geo in
            let d = geo.size.width
            Circle()
                .fill(RadialGradient(colors: [.white.opacity(0.04), .white.opacity(0.4)],
                                     center: .center, startRadius: d * 0.2, endRadius: d * 0.5))
                .overlay(Circle().strokeBorder(.white.opacity(0.55), lineWidth: 0.8))
                .overlay(alignment: .topLeading) {
                    Ellipse().fill(.white.opacity(0.75))
                        .frame(width: d * 0.28, height: d * 0.16)
                        .rotationEffect(.degrees(-35))
                        .offset(x: d * 0.16, y: d * 0.14)
                }
        }
    }
}

/// A glossy pill button: coloured gel for Run and Stop, clear glass for everything else.
struct AeroButtonStyle: ButtonStyle {
    enum Kind { case glass, sky, go, stop }
    var kind: Kind = .glass

    func makeBody(configuration: Configuration) -> some View {
        AeroButton(configuration: configuration, kind: kind)
    }
}

private struct AeroButton: View {
    let configuration: ButtonStyle.Configuration
    let kind: AeroButtonStyle.Kind
    @Environment(\.isEnabled) private var isEnabled

    /// Top and bottom of the gel, and its darker rim.
    private var colors: (Color, Color, Color) {
        switch kind {
        case .glass: return (.white.opacity(0.85), .white.opacity(0.45), Aero.deep.opacity(0.3))
        case .sky: return (Color(red: 0.42, green: 0.78, blue: 1.0), Aero.deep, Aero.deep)
        case .go: return (Color(red: 0.62, green: 0.90, blue: 0.36), Color(red: 0.16, green: 0.58, blue: 0.14),
                          Color(red: 0.10, green: 0.42, blue: 0.10))
        case .stop: return (Color(red: 1.0, green: 0.60, blue: 0.36), Color(red: 0.82, green: 0.18, blue: 0.10),
                            Color(red: 0.60, green: 0.12, blue: 0.08))
        }
    }

    var body: some View {
        let (top, bottom, rim) = colors
        configuration.label
            .font(Aero.font(12, .semibold))
            .foregroundStyle(kind == .glass ? Aero.ink : Color.white)
            .shadow(color: kind == .glass ? .clear : .black.opacity(0.35), radius: 0.5, y: 1)
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background {
                Capsule(style: .circular).fill(LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom))
                    .shadow(color: bottom.opacity(kind == .glass ? 0.25 : 0.5), radius: 2.5, y: 1)
                // The gloss: a bright band over the top half that ends in a hard edge.
                Capsule(style: .circular)
                    .fill(LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.75), location: 0),
                            .init(color: .white.opacity(0.18), location: 0.5),
                            .init(color: .clear, location: 0.5),
                        ],
                        startPoint: .top, endPoint: .bottom))
                    .padding(1.5)
                Capsule(style: .circular).strokeBorder(rim, lineWidth: 1)
            }
            .brightness(configuration.isPressed ? -0.08 : 0)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .saturation(isEnabled ? 1 : 0.35)
            .opacity(isEnabled ? 1 : 0.6)
            .contentShape(Capsule(style: .circular))
    }
}

extension View {
    /// A frosted glass panel behind this view.
    func aeroGlass(cornerRadius: CGFloat = 10) -> some View {
        background {
            RoundedRectangle(cornerRadius: cornerRadius)
                .fill(LinearGradient(colors: [.white.opacity(0.78), .white.opacity(0.42)], startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: cornerRadius).strokeBorder(.white.opacity(0.9)))
                .shadow(color: Aero.deep.opacity(0.2), radius: 3, y: 1)
        }
    }

    /// A white pill with an inset rim, for the task box.
    func aeroField() -> some View {
        textFieldStyle(.plain)
            .font(Aero.font(13))
            .foregroundStyle(Aero.ink)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(Capsule(style: .circular).fill(.white.opacity(0.9)))
            .overlay(Capsule(style: .circular).strokeBorder(
                LinearGradient(colors: [Aero.deep.opacity(0.5), .white], startPoint: .top, endPoint: .bottom)))
    }

    /// The theme's text colour and font, on a light scheme so system greys stay readable on the sky.
    func aeroText() -> some View {
        font(Aero.font(13)).foregroundStyle(Aero.ink).environment(\.colorScheme, .light)
    }
}
