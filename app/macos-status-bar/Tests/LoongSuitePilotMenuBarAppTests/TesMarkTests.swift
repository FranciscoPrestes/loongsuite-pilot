import AppKit
import XCTest
@testable import LoongSuitePilotMenuBarApp

final class TesMarkTests: XCTestCase {

    /// Rows (top = 0) of the rendered icon that contain the blue "eye".
    private func blueEyeRows(side: Int = 64) -> [Int] {
        let image = TesMark.menuBarIcon(side: CGFloat(side))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return [] }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
        NSGraphicsContext.restoreGraphicsState()
        var rows = Set<Int>()
        for y in 0..<side {
            for x in 0..<side {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB) else { continue }
                if c.blueComponent > 0.9 && c.redComponent < 0.4 && c.alphaComponent > 0.9 { rows.insert(y) }
            }
        }
        return rows.sorted()
    }

    func testEyeIsDrawnInTheUpperHalf() {
        let rows = blueEyeRows()
        XCTAssertFalse(rows.isEmpty, "blue eye not rendered")
        // colorAt uses top-left origin: the eye (y 4..14 of 32) must sit in the top half.
        XCTAssertLessThan(rows.max() ?? 99, 32)
    }
}
