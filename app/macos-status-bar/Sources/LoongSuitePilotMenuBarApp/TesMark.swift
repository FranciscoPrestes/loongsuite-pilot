import AppKit
import SwiftUI

/// Marca NT TES — geometria do favicon de tes.ntconsultlabs.com (viewBox 32x32),
/// com o "olho" recolorido de vermelho (#D92D20) para o azul NTConsult (#3354FF).
/// Fonte única da marca no app nativo: ícone da menu bar e cabeçalho do painel.
enum TesMark {
    /// Azul NTConsult (#3354FF) — o "olho" da marca.
    static let eyeColor = NSColor(srgbRed: 0.200, green: 0.329, blue: 1.000, alpha: 1)

    private static let bodyPoints: [CGPoint] = [
        CGPoint(x: 4, y: 2), CGPoint(x: 10, y: 2), CGPoint(x: 10, y: 16),
        CGPoint(x: 22, y: 16), CGPoint(x: 22, y: 2), CGPoint(x: 28, y: 2),
        CGPoint(x: 28, y: 22), CGPoint(x: 24, y: 22), CGPoint(x: 24, y: 26),
        CGPoint(x: 28, y: 26), CGPoint(x: 28, y: 30), CGPoint(x: 4, y: 30),
        CGPoint(x: 4, y: 26), CGPoint(x: 8, y: 26), CGPoint(x: 8, y: 22),
        CGPoint(x: 4, y: 22),
    ]

    private static let eyePoints: [CGPoint] = [
        CGPoint(x: 12, y: 4), CGPoint(x: 20, y: 4),
        CGPoint(x: 20, y: 14), CGPoint(x: 12, y: 14),
    ]

    static func bodyPath(in rect: CGRect) -> Path {
        polygon(bodyPoints, in: rect)
    }

    static func eyePath(in rect: CGRect) -> Path {
        polygon(eyePoints, in: rect)
    }

    /// Ícone colorido para a menu bar: o corpo acompanha o claro/escuro do
    /// sistema (labelColor) e o olho fica sempre azul.
    static func menuBarIcon(side: CGFloat = 16) -> NSImage {
        // flipped: true — a geometria da marca vem do favicon (y para baixo).
        let image = NSImage(size: NSSize(width: side, height: side), flipped: true) { rect in
            guard let context = NSGraphicsContext.current?.cgContext else { return false }
            context.addPath(bodyPath(in: rect).cgPath)
            context.setFillColor(NSColor.labelColor.cgColor)
            context.fillPath()
            context.addPath(eyePath(in: rect).cgPath)
            context.setFillColor(eyeColor.cgColor)
            context.fillPath()
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "NT TES"
        return image
    }

    private static func polygon(_ points: [CGPoint], in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 32
        let offsetX = rect.midX - 16 * scale
        let offsetY = rect.midY - 16 * scale
        var path = Path()
        for (index, point) in points.enumerated() {
            let mapped = CGPoint(x: offsetX + point.x * scale, y: offsetY + point.y * scale)
            if index == 0 {
                path.move(to: mapped)
            } else {
                path.addLine(to: mapped)
            }
        }
        path.closeSubpath()
        return path
    }
}

/// Corpo da marca NT TES (SwiftUI).
struct TesMarkShape: Shape {
    func path(in rect: CGRect) -> Path { TesMark.bodyPath(in: rect) }
}

/// O "olho" azul da marca NT TES (SwiftUI).
struct TesEyeShape: Shape {
    func path(in rect: CGRect) -> Path { TesMark.eyePath(in: rect) }
}

/// Marca NT TES em SwiftUI — corpo + olho azul.
struct TesMarkView: View {
    var bodyColor: Color = .white

    var body: some View {
        ZStack {
            TesMarkShape().fill(bodyColor)
            TesEyeShape().fill(Color(red: 0.200, green: 0.329, blue: 1.000))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityLabel("NT TES")
    }
}
